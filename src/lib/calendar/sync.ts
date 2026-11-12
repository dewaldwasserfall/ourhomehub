/**
 * The Google Calendar sync engine (server only).
 *
 *   syncHousehold   pull changes from Google into calendar_events
 *   ensureChannel   keep a push channel alive so Google tells us about changes
 *   withAccessToken run a Google call with a fresh access token
 *
 * Google is the source of truth. A full sync replaces the local copy; an
 * incremental sync applies only what changed since the stored sync token.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { GoogleApiError, listEvents, stopChannel, watchEvents, type EventsPage } from "@/lib/google/calendar-api";
import { GoogleAccessRevokedError, refreshAccessToken } from "@/lib/google/oauth";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { planChanges } from "./mapping";
import type { GoogleEvent } from "./types";

/** Where Google sends change notifications. */
export function webhookAddress(): string {
  const site = process.env.SITE_URL ?? "https://ourhomehub.nl";
  return `${site.replace(/\/$/, "")}/api/calendar/webhook`;
}

/** Renew a channel when it has less than this left. */
const RENEW_WITHIN_MS = 48 * 60 * 60 * 1000;

export interface ConnectionRow {
  household_id: string;
  google_email: string;
  calendar_id: string;
  sync_token: string | null;
  channel_id: string | null;
  channel_resource_id: string | null;
  channel_token: string | null;
  channel_expires_at: string | null;
}

export async function loadConnection(householdId: string): Promise<ConnectionRow | null> {
  const { data } = await getSupabaseAdminClient()
    .from("calendar_connections")
    .select("*")
    .eq("household_id", householdId)
    .maybeSingle<ConnectionRow>();
  return data ?? null;
}

async function markError(householdId: string, message: string) {
  await getSupabaseAdminClient()
    .from("calendar_connections")
    .update({ status: "error", last_error: message.slice(0, 500), updated_at: new Date().toISOString() })
    .eq("household_id", householdId);
}

// -----------------------------------------------------------------------------
// Step 1: access tokens
// -----------------------------------------------------------------------------

/**
 * Run `fn` with a fresh access token for the household's family account.
 * If Google has revoked access, the connection is flagged so the owner sees
 * "Reconnect" on the Household tab.
 */
export async function withAccessToken<T>(householdId: string, fn: (accessToken: string) => Promise<T>): Promise<T> {
  const { data: refreshToken, error } = await getSupabaseAdminClient().rpc("calendar_get_refresh_token", {
    p_household_id: householdId,
  });
  if (error || !refreshToken) throw new Error("calendar_not_connected");
  try {
    const accessToken = await refreshAccessToken(refreshToken as string);
    return await fn(accessToken);
  } catch (err) {
    if (err instanceof GoogleAccessRevokedError) {
      await markError(householdId, "Google access was revoked. Reconnect the family calendar.");
    }
    throw err;
  }
}

// -----------------------------------------------------------------------------
// Step 2: pull changes
// -----------------------------------------------------------------------------

/** All pages of one list call. */
async function listAll(accessToken: string, calendarId: string, syncToken: string | null) {
  const events: GoogleEvent[] = [];
  let pageToken: string | undefined;
  let page: EventsPage;
  do {
    page = await listEvents(accessToken, calendarId, { syncToken, pageToken });
    events.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return { events, nextSyncToken: page.nextSyncToken ?? null };
}

/**
 * Bring calendar_events in line with Google.
 * Returns how many events were written and removed.
 */
export async function syncHousehold(householdId: string, opts: { full?: boolean } = {}) {
  const admin = getSupabaseAdminClient();
  const connection = await loadConnection(householdId);
  if (!connection) throw new Error("calendar_not_connected");

  return withAccessToken(householdId, async (accessToken) => {
    // Step 2a: incremental if we can, full otherwise (or when Google says
    // the sync token expired: HTTP 410).
    let full = opts.full || !connection.sync_token;
    let result: { events: GoogleEvent[]; nextSyncToken: string | null };
    try {
      result = await listAll(accessToken, connection.calendar_id, full ? null : connection.sync_token);
    } catch (err) {
      if (err instanceof GoogleApiError && err.status === 410) {
        full = true;
        result = await listAll(accessToken, connection.calendar_id, null);
      } else {
        throw err;
      }
    }

    // Step 2b: context for mapping: the household's zone and its members.
    const [{ data: household }, { data: members }] = await Promise.all([
      admin.from("households").select("timezone").eq("id", householdId).single<{ timezone: string }>(),
      admin.from("members").select("id").eq("household_id", householdId),
    ]);
    const timeZone = household?.timezone ?? "Europe/Amsterdam";
    const memberIds = new Set(((members ?? []) as Array<{ id: string }>).map((m) => m.id));
    const { upserts, deletes } = planChanges(result.events, householdId, timeZone, memberIds);

    // Step 2c: apply. A full sync also removes anything Google no longer has.
    if (upserts.length) {
      const { error } = await admin
        .from("calendar_events")
        .upsert(
          upserts.map((u) => ({ ...u, updated_at: new Date().toISOString() })),
          { onConflict: "household_id,google_event_id" },
        );
      if (error) throw new Error(`calendar_upsert_failed: ${error.message}`);
    }
    let removed = 0;
    if (full) {
      const keep = new Set(upserts.map((u) => u.google_event_id));
      const { data: existing } = await admin.from("calendar_events").select("google_event_id").eq("household_id", householdId);
      const stale = ((existing ?? []) as Array<{ google_event_id: string }>)
        .map((e) => e.google_event_id)
        .filter((id) => !keep.has(id));
      deletes.push(...stale);
    }
    if (deletes.length) {
      // Removing a series also removes its stored exceptions.
      const list = deletes.map((id) => `"${id.replace(/"/g, "")}"`).join(",");
      await admin
        .from("calendar_events")
        .delete()
        .eq("household_id", householdId)
        .or(`google_event_id.in.(${list}),recurring_event_id.in.(${list})`);
      removed = deletes.length;
    }

    // Step 2d: remember where we got to.
    await admin
      .from("calendar_connections")
      .update({
        sync_token: result.nextSyncToken,
        last_synced_at: new Date().toISOString(),
        status: "active",
        last_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("household_id", householdId);

    return { written: upserts.length, removed, full };
  });
}

// -----------------------------------------------------------------------------
// Step 3: push channel
// -----------------------------------------------------------------------------

/**
 * Make sure Google will notify us about changes. Registers a new channel if
 * there is none or it expires within 48 hours (channels last about a week).
 */
export async function ensureChannel(householdId: string, opts: { force?: boolean } = {}) {
  const connection = await loadConnection(householdId);
  if (!connection) throw new Error("calendar_not_connected");

  const expiresAt = connection.channel_expires_at ? new Date(connection.channel_expires_at).getTime() : 0;
  if (!opts.force && connection.channel_id && expiresAt - Date.now() > RENEW_WITHIN_MS) {
    return { renewed: false };
  }

  return withAccessToken(householdId, async (accessToken) => {
    // Step 3a: stop the old channel so we don't get duplicate pings.
    if (connection.channel_id && connection.channel_resource_id) {
      await stopChannel(accessToken, connection.channel_id, connection.channel_resource_id);
    }

    // Step 3b: register a new one with a secret token we can check.
    const channelId = randomUUID();
    const channelToken = randomBytes(24).toString("base64url");
    const channel = await watchEvents(accessToken, connection.calendar_id, {
      id: channelId,
      token: channelToken,
      address: webhookAddress(),
    });

    await getSupabaseAdminClient()
      .from("calendar_connections")
      .update({
        channel_id: channelId,
        channel_resource_id: channel.resourceId,
        channel_token: channelToken,
        channel_expires_at: channel.expiration ? new Date(Number(channel.expiration)).toISOString() : null,
        updated_at: new Date().toISOString(),
      })
      .eq("household_id", householdId);

    return { renewed: true };
  });
}

/** Stop the household's channel (used before disconnecting). */
export async function stopHouseholdChannel(householdId: string) {
  const connection = await loadConnection(householdId);
  if (!connection?.channel_id || !connection.channel_resource_id) return;
  await withAccessToken(householdId, (accessToken) =>
    stopChannel(accessToken, connection.channel_id!, connection.channel_resource_id!),
  ).catch(() => undefined);
}
