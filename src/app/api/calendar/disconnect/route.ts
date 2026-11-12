/**
 * POST /api/calendar/disconnect
 *
 * Owner only. Stops Google's push channel, revokes the stored permission at
 * Google, and removes the connection, its Vault secret and the synced copy.
 * Nothing in the Google calendar itself is touched.
 */
import { NextResponse } from "next/server";
import { getCaller, jsonError } from "@/lib/calendar/caller";
import { stopHouseholdChannel } from "@/lib/calendar/sync";
import { revokeToken } from "@/lib/google/oauth";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function POST() {
  const result = await getCaller({ ownerOnly: true });
  if (!result.ok) return result.response;
  const { householdId } = result.caller;
  const admin = getSupabaseAdminClient();

  // Step 1: stop notifications while we still hold the token.
  await stopHouseholdChannel(householdId);

  // Step 2: revoke at Google (best effort; the token is deleted either way).
  const { data: refreshToken } = await admin.rpc("calendar_get_refresh_token", { p_household_id: householdId });
  if (refreshToken) await revokeToken(refreshToken as string);

  // Step 3: remove everything we stored.
  const { error } = await admin.rpc("calendar_remove_connection", { p_household_id: householdId });
  if (error) return jsonError(500, "disconnect_failed", "Couldn't disconnect the calendar. Try again.");

  return NextResponse.json({ ok: true });
}
