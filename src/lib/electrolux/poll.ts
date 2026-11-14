/**
 * Keeping the dishwasher's state fresh. SERVER ONLY (service-role client,
 * Vault credentials).
 *
 *   * credentialsFor()   valid credentials, refreshed (and saved) first when
 *                        the access token is about to run out
 *   * pollAppliance()    read the state, store it, and when a run just ended
 *                        add "Empty the dishwasher" (appliance_run_finished)
 *   * pollDueAppliances() the 5-minute job: every connection not checked in
 *                        the last 4 minutes
 */
import { getSupabaseAdminClient } from "../supabase/admin";
import { ElectroluxError, getApplianceState, refreshTokens, tokenFresh, type ElectroluxCredentials } from "./api";
import { isRunning, readState, runFinished } from "./state";

interface ConnectionRow {
  household_id: string;
  appliance_id: string | null;
  state: string | null;
}

// -----------------------------------------------------------------------------
// Step 1: credentials
// -----------------------------------------------------------------------------

export async function saveCredentials(householdId: string, credentials: ElectroluxCredentials, connectedBy: string | null) {
  const { error } = await getSupabaseAdminClient().rpc("appliance_save_credentials", {
    p_household_id: householdId,
    p_credentials: JSON.stringify(credentials),
    p_connected_by: connectedBy,
  });
  if (error) throw new Error(error.message);
}

async function markError(householdId: string, message: string) {
  await getSupabaseAdminClient().from("appliance_connections").update({ status: "error", last_error: message }).eq("household_id", householdId);
}

export async function credentialsFor(householdId: string): Promise<ElectroluxCredentials> {
  const { data } = await getSupabaseAdminClient().rpc("appliance_get_credentials", { p_household_id: householdId });
  if (!data) throw new ElectroluxError("The dishwasher isn't connected", 404);
  const credentials = JSON.parse(data as string) as ElectroluxCredentials;
  if (tokenFresh(credentials.accessToken)) return credentials;
  try {
    const fresh = await refreshTokens(credentials);
    await saveCredentials(householdId, fresh, null);
    return fresh;
  } catch (err) {
    await markError(householdId, "The dishwasher needs reconnecting (new token)");
    throw err;
  }
}

// -----------------------------------------------------------------------------
// Step 2: one check
// -----------------------------------------------------------------------------

/** Returns true when a run just finished. */
export async function pollAppliance(householdId: string): Promise<boolean> {
  const admin = getSupabaseAdminClient();
  const { data: conn } = await admin
    .from("appliance_connections")
    .select("household_id, appliance_id, state")
    .eq("household_id", householdId)
    .single<ConnectionRow>();
  if (!conn?.appliance_id) return false;

  try {
    // 2a. Read the state.
    const credentials = await credentialsFor(householdId);
    const snap = readState(await getApplianceState(credentials, conn.appliance_id));

    // 2b. Store it (ends_at only while running, so screens can count down).
    const running = isRunning(snap.state);
    await admin
      .from("appliance_connections")
      .update({
        state: snap.state,
        cycle_phase: snap.cyclePhase,
        door_state: snap.doorState,
        online: snap.online,
        ends_at: running && snap.timeToEndSeconds !== null ? new Date(Date.now() + snap.timeToEndSeconds * 1000).toISOString() : null,
        last_polled_at: new Date().toISOString(),
        status: "active",
        last_error: null,
      })
      .eq("household_id", householdId);

    // 2c. A run just ended: "Empty the dishwasher".
    if (runFinished(conn.state, snap.state)) {
      const { error } = await admin.rpc("appliance_run_finished", { p_household_id: householdId });
      if (error) console.error("[dishwasher] run finished", error.message);
      return true;
    }
    return false;
  } catch (err) {
    if (err instanceof ElectroluxError && (err.status === 401 || err.status === 403)) {
      await markError(householdId, "The dishwasher needs reconnecting (new token)");
    }
    throw err;
  }
}

// -----------------------------------------------------------------------------
// Step 3: the 5-minute job
// -----------------------------------------------------------------------------

export async function pollDueAppliances(): Promise<number> {
  const { data } = await getSupabaseAdminClient()
    .from("appliance_connections")
    .select("household_id, last_polled_at")
    .eq("status", "active")
    .not("appliance_id", "is", null);
  const cutoff = Date.now() - 4 * 60_000;
  let polled = 0;
  for (const row of (data ?? []) as Array<{ household_id: string; last_polled_at: string | null }>) {
    if (row.last_polled_at && Date.parse(row.last_polled_at) > cutoff) continue;
    try {
      await pollAppliance(row.household_id);
      polled++;
    } catch (err) {
      console.error("[dishwasher] poll failed", row.household_id, err);
    }
  }
  return polled;
}
