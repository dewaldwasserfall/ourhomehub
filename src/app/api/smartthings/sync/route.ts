/**
 * POST /api/smartthings/sync   { subscribe?: boolean }
 *
 * "Update devices" on the Home screen (anyone who manages Home): read the
 * devices and their state again. subscribe: true also (re)starts live
 * updates, e.g. after the Target URL was added to the SmartThings app.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getCaller, jsonError } from "@/lib/calendar/caller";
import { syncDevices } from "@/lib/smartthings/sync";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: NextRequest) {
  // Step 1: signed in, and allowed to manage Home (the database decides).
  const result = await getCaller({ adultOnly: true });
  if (!result.ok) return result.response;
  const { data: allowed } = await (await getSupabaseServerClient()).rpc("can_manage_home");
  if (!allowed) return jsonError(403, "not_allowed", "Ask the owner to give you access to Home.");

  // Step 2: sync.
  const body = (await request.json().catch(() => ({}))) as { subscribe?: boolean };
  try {
    const devices = await syncDevices(result.caller.householdId, { subscribe: body.subscribe === true });
    return NextResponse.json({ devices });
  } catch (err) {
    console.error("[smartthings] sync failed", err);
    return jsonError(502, "sync_failed", "Couldn't reach SmartThings. Try again in a moment.");
  }
}
