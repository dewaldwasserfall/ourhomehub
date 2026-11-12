/**
 * POST /api/calendar/sync
 *
 * Any member can ask for a sync now (pull-to-refresh on the Calendar tab).
 * Also renews the push channel if it's close to expiring.
 */
import { NextResponse } from "next/server";
import { getCaller, jsonError } from "@/lib/calendar/caller";
import { ensureChannel, loadConnection, syncHousehold } from "@/lib/calendar/sync";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST() {
  const result = await getCaller();
  if (!result.ok) return result.response;
  const { householdId } = result.caller;
  if (!(await loadConnection(householdId))) {
    return jsonError(409, "calendar_not_connected", "The family calendar isn't connected yet.");
  }
  try {
    const sync = await syncHousehold(householdId);
    await ensureChannel(householdId).catch((err) => console.error("[calendar] channel renew failed", err));
    return NextResponse.json(sync);
  } catch (err) {
    console.error("[calendar] manual sync failed", err);
    return jsonError(502, "sync_failed", "Couldn't reach Google Calendar. Try again in a moment.");
  }
}
