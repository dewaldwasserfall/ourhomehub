/**
 * POST /api/smartthings/disconnect   (owner only)
 *
 * Removes HomeHub from the SmartThings home (best effort: SmartThings may
 * already have forgotten it), then forgets the tokens, devices and events.
 */
import { NextResponse } from "next/server";
import { getCaller, jsonError } from "@/lib/calendar/caller";
import { deleteInstalledApp } from "@/lib/smartthings/api";
import { accessFor } from "@/lib/smartthings/sync";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function POST() {
  // Step 1: owners only.
  const result = await getCaller({ ownerOnly: true });
  if (!result.ok) return result.response;
  const householdId = result.caller.householdId;

  // Step 2: tell SmartThings (ignore failures: we forget it either way).
  try {
    const credentials = await accessFor(householdId);
    await deleteInstalledApp(credentials.accessToken, credentials.installedAppId);
  } catch (err) {
    console.warn("[smartthings] uninstall on disconnect failed", err);
  }

  // Step 3: forget everything here.
  const { error } = await getSupabaseAdminClient().rpc("home_remove_connection", { p_household_id: householdId });
  if (error) return jsonError(500, "disconnect_failed", "Couldn't disconnect. Try again.");
  return NextResponse.json({ ok: true });
}
