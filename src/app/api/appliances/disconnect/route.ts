/**
 * POST /api/appliances/disconnect   (owner only)
 *
 * Revokes the Electrolux tokens (best effort) and forgets them and the
 * dishwasher's state. To-dos it added stay on the list.
 */
import { NextResponse } from "next/server";
import { getCaller, jsonError } from "@/lib/calendar/caller";
import { revokeTokens } from "@/lib/electrolux/api";
import { credentialsFor } from "@/lib/electrolux/poll";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function POST() {
  const result = await getCaller({ ownerOnly: true });
  if (!result.ok) return result.response;
  const householdId = result.caller.householdId;

  // Step 1: tell Electrolux (ignore failures: we forget it either way).
  try {
    await revokeTokens(await credentialsFor(householdId));
  } catch {
    // already invalid
  }

  // Step 2: forget everything here.
  const { error } = await getSupabaseAdminClient().rpc("appliance_remove", { p_household_id: householdId });
  if (error) return jsonError(500, "disconnect_failed", "Couldn't disconnect. Try again.");
  return NextResponse.json({ ok: true });
}
