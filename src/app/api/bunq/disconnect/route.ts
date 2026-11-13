/**
 * POST /api/bunq/disconnect
 *
 * Owner only: forget the bunq credentials and every copied payment. (To fully
 * revoke HomeHub's access, also remove it in the bunq app.)
 */
import { NextResponse } from "next/server";
import { getCaller, jsonError } from "@/lib/calendar/caller";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function POST() {
  const result = await getCaller({ ownerOnly: true });
  if (!result.ok) return result.response;
  const { error } = await getSupabaseAdminClient().rpc("bunq_remove_connection", { p_household_id: result.caller.householdId });
  if (error) return jsonError(500, "disconnect_failed", "Couldn't disconnect bunq.");
  return NextResponse.json({ ok: true });
}
