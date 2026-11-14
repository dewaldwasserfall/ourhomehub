/**
 * SmartThings tokens and device sync. SERVER ONLY (service-role client,
 * Vault credentials).
 *
 *   * accessFor()          a valid access token for a household (refreshed
 *                          and saved first when it runs out within 10 min)
 *   * refreshDueTokens()   the cron job keeps every connection's token fresh
 *                          (SmartThings tokens last 24 hours; a refresh token
 *                          unused for 30 days dies)
 *   * syncDevices()        location, rooms, devices and their state into
 *                          home_devices; optionally (re)subscribe to events
 */
import { getSupabaseAdminClient } from "../supabase/admin";
import {
  SmartThingsError,
  deleteAllSubscriptions,
  getDeviceStatus,
  getInstalledApp,
  getLocation,
  listDevices,
  listRooms,
  refreshCredentials,
  subscribeToDevice,
  type StCredentials,
} from "./api";
import { classifyDevice, mainCapabilities, stateFromStatus } from "./devices";

/** SmartThings allows 20 subscriptions per installed app. */
const MAX_SUBSCRIPTIONS = 20;

// -----------------------------------------------------------------------------
// Step 1: tokens
// -----------------------------------------------------------------------------

async function saveCredentials(householdId: string, credentials: StCredentials, connectedBy: string | null) {
  const { error } = await getSupabaseAdminClient().rpc("home_save_credentials", {
    p_household_id: householdId,
    p_credentials: JSON.stringify(credentials),
    p_installed_app_id: credentials.installedAppId || null,
    p_expires_at: credentials.expiresAt,
    p_connected_by: connectedBy,
  });
  if (error) throw new Error(error.message);
}
export { saveCredentials };

/** Mark the connection broken, with a reason the Home screen shows. */
async function markError(householdId: string, message: string) {
  await getSupabaseAdminClient().from("home_connections").update({ status: "error", last_error: message }).eq("household_id", householdId);
}

/** A valid token for this household, refreshing it first if needed. */
export async function accessFor(householdId: string): Promise<StCredentials> {
  const { data } = await getSupabaseAdminClient().rpc("home_get_credentials", { p_household_id: householdId });
  if (!data) throw new SmartThingsError("SmartThings isn't connected", 404);
  const credentials = JSON.parse(data as string) as StCredentials;
  if (Date.parse(credentials.expiresAt) - Date.now() > 10 * 60_000) return credentials;

  try {
    const fresh = await refreshCredentials(credentials);
    await saveCredentials(householdId, fresh, null);
    return fresh;
  } catch (err) {
    await markError(householdId, "SmartThings needs reconnecting");
    throw err;
  }
}

/** Every connection whose token runs out within 2 hours. Returns how many. */
export async function refreshDueTokens(): Promise<number> {
  const admin = getSupabaseAdminClient();
  const { data } = await admin
    .from("home_connections")
    .select("household_id")
    .eq("status", "active")
    .lt("token_expires_at", new Date(Date.now() + 2 * 3600_000).toISOString());
  let refreshed = 0;
  for (const row of (data ?? []) as Array<{ household_id: string }>) {
    try {
      const { data: secret } = await admin.rpc("home_get_credentials", { p_household_id: row.household_id });
      if (!secret) continue;
      await saveCredentials(row.household_id, await refreshCredentials(JSON.parse(secret as string) as StCredentials), null);
      refreshed++;
    } catch (err) {
      console.error("[smartthings] refresh failed", row.household_id, err);
      await markError(row.household_id, "SmartThings needs reconnecting");
    }
  }
  return refreshed;
}

// -----------------------------------------------------------------------------
// Step 2: devices
// -----------------------------------------------------------------------------

/**
 * Read the location, rooms and devices (with their current state) and store
 * them. With subscribe: true, also ask SmartThings to send device changes to
 * the webhook (done when connecting, and from "Turn on live updates").
 * Returns the number of devices.
 */
export async function syncDevices(householdId: string, opts: { subscribe?: boolean } = {}): Promise<number> {
  const admin = getSupabaseAdminClient();
  const credentials = await accessFor(householdId);
  const token = credentials.accessToken;

  try {
    // 2a. Which home this connection is for.
    const { locationId } = await getInstalledApp(token, credentials.installedAppId);
    const [location, rooms, devices] = await Promise.all([getLocation(token, locationId), listRooms(token, locationId), listDevices(token, locationId)]);
    const roomName = new Map(rooms.map((r) => [r.roomId, r.name]));

    // 2b. Each device's current state (a handful of devices: all at once).
    const statuses = await Promise.all(devices.map((d) => getDeviceStatus(token, d.deviceId).catch(() => null)));
    const rows = devices.map((d, i) => ({
      household_id: householdId,
      external_id: d.deviceId,
      name: d.label || d.name || "Device",
      room: d.roomId ? (roomName.get(d.roomId) ?? null) : null,
      kind: classifyDevice(d),
      capabilities: mainCapabilities(d),
      state: statuses[i] ? stateFromStatus(statuses[i]!) : {},
      present: true,
      updated_at: new Date().toISOString(),
    }));

    // 2c. Store: upsert what's there, mark the rest as gone.
    if (rows.length) {
      const { error } = await admin.from("home_devices").upsert(rows, { onConflict: "household_id,external_id" });
      if (error) throw new Error(error.message);
    }
    const ids = rows.map((r) => r.external_id);
    let gone = admin.from("home_devices").update({ present: false }).eq("household_id", householdId);
    if (ids.length) gone = gone.not("external_id", "in", `(${ids.map((id) => `"${id}"`).join(",")})`);
    await gone;

    // 2d. Live updates: one subscription per device (up to 20).
    let eventsEnabled: boolean | undefined;
    if (opts.subscribe) {
      eventsEnabled = true;
      try {
        await deleteAllSubscriptions(token, credentials.installedAppId).catch(() => undefined);
        for (const d of devices.slice(0, MAX_SUBSCRIPTIONS)) {
          await subscribeToDevice(token, credentials.installedAppId, d.deviceId, `hh-${d.deviceId.slice(0, 20)}`);
        }
      } catch (err) {
        // Most likely the app's Target URL isn't confirmed yet.
        console.warn("[smartthings] subscribe failed", err);
        eventsEnabled = false;
      }
    }

    await admin
      .from("home_connections")
      .update({
        location_id: locationId,
        location_name: location.name,
        last_synced_at: new Date().toISOString(),
        status: "active",
        last_error: null,
        ...(eventsEnabled === undefined ? {} : { events_enabled: eventsEnabled }),
      })
      .eq("household_id", householdId);
    return rows.length;
  } catch (err) {
    if (err instanceof SmartThingsError && err.status === 401) await markError(householdId, "SmartThings needs reconnecting");
    throw err;
  }
}
