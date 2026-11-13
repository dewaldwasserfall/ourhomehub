/**
 * POST /api/bunq/sync
 *
 * "Update now" on the budget screen (anyone who can see the budget).
 */
import { NextResponse } from "next/server";
import { syncBudget } from "@/lib/bunq/sync";
import { getCaller, jsonError } from "@/lib/calendar/caller";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST() {
  const result = await getCaller({ financeOnly: true });
  if (!result.ok) return result.response;
  try {
    return NextResponse.json({ stored: await syncBudget(result.caller.householdId) });
  } catch {
    return jsonError(502, "bunq_failed", "Couldn't update from bunq. Try again in a moment.");
  }
}
