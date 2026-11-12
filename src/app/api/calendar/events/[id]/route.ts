/**
 * PATCH  /api/calendar/events/:id   edit a one-off event
 * DELETE /api/calendar/events/:id   delete a one-off event
 *
 * `:id` is our row id. Repeating events (series and their single
 * occurrences) are read-only in the app and must be changed in Google.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getCaller, jsonError, type Caller } from "@/lib/calendar/caller";
import { buildGoogleEventBody, EVENT_INPUT_MESSAGES, EventInputError, planChanges } from "@/lib/calendar/mapping";
import { loadConnection, withAccessToken } from "@/lib/calendar/sync";
import type { CalendarEventRow, EventInput } from "@/lib/calendar/types";
import { deleteEvent, GoogleApiError, patchEvent } from "@/lib/google/calendar-api";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** Step 1 (both verbs): load the row, checking it's this household's and editable. */
async function loadEditable(caller: Caller, id: string) {
  const { data: row } = await getSupabaseAdminClient()
    .from("calendar_events")
    .select("*")
    .eq("id", id)
    .eq("household_id", caller.householdId)
    .maybeSingle<CalendarEventRow>();
  if (!row) return { error: jsonError(404, "event_not_found", "That event no longer exists. Pull down to refresh.") };
  if (row.recurrence?.length || row.recurring_event_id) {
    return { error: jsonError(409, "recurring_read_only", "Repeating events are edited in Google Calendar.") };
  }
  const connection = await loadConnection(caller.householdId);
  if (!connection) return { error: jsonError(409, "calendar_not_connected", "The family calendar isn't connected yet.") };
  return { row, connection };
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const result = await getCaller();
  if (!result.ok) return result.response;
  const { caller } = result;
  const { id } = await params;
  const loaded = await loadEditable(caller, id);
  if ("error" in loaded) return loaded.error;
  const { row, connection } = loaded;

  // Step 2: validate (keep whoever originally added it).
  let body: Record<string, unknown>;
  try {
    body = buildGoogleEventBody((await request.json()) as EventInput, caller.timeZone);
  } catch (err) {
    if (err instanceof EventInputError) return jsonError(400, err.message, EVENT_INPUT_MESSAGES[err.message] ?? "Check the event details.");
    return jsonError(400, "invalid_request", "Check the event details.");
  }

  // Step 3: update in Google, then locally.
  try {
    const updated = await withAccessToken(caller.householdId, (token) =>
      patchEvent(token, connection.calendar_id, row.google_event_id, body),
    );
    const memberIds = new Set([caller.memberId, ...(row.added_by_member ? [row.added_by_member] : [])]);
    const { upserts } = planChanges([updated], caller.householdId, caller.timeZone, memberIds);
    const { data, error } = await getSupabaseAdminClient()
      .from("calendar_events")
      .upsert(upserts, { onConflict: "household_id,google_event_id" })
      .select()
      .single();
    if (error) throw new Error(error.message);
    return NextResponse.json({ event: data });
  } catch (err) {
    console.error("[calendar] update failed", err);
    if (err instanceof GoogleApiError && err.status === 404) {
      return jsonError(404, "event_not_found", "That event was deleted in Google Calendar.");
    }
    return jsonError(502, "google_failed", "Google Calendar didn't accept the change. Try again in a moment.");
  }
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  const result = await getCaller();
  if (!result.ok) return result.response;
  const { caller } = result;
  const { id } = await params;
  const loaded = await loadEditable(caller, id);
  if ("error" in loaded) return loaded.error;
  const { row, connection } = loaded;

  // Step 2: delete in Google (already gone there counts as success), then locally.
  try {
    await withAccessToken(caller.householdId, (token) => deleteEvent(token, connection.calendar_id, row.google_event_id)).catch(
      (err) => {
        if (err instanceof GoogleApiError && (err.status === 404 || err.status === 410)) return;
        throw err;
      },
    );
    await getSupabaseAdminClient().from("calendar_events").delete().eq("id", row.id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[calendar] delete failed", err);
    return jsonError(502, "google_failed", "Google Calendar didn't delete the event. Try again in a moment.");
  }
}
