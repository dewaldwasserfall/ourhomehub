/**
 * POST /api/holidays/import
 *
 * An adult asks for the school and public holidays to be fetched now (the
 * School holidays screen does this on first open and from its Update button).
 */
import { NextResponse } from "next/server";
import { getCaller, jsonError } from "@/lib/calendar/caller";
import { importHolidays } from "@/lib/holidays-import";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST() {
  // Step 1: signed-in adult of an active household.
  const result = await getCaller({ adultOnly: true });
  if (!result.ok) return result.response;

  // Step 2: import and report.
  try {
    return NextResponse.json(await importHolidays(result.caller.householdId));
  } catch (err) {
    console.error("[holidays] import failed", err);
    return jsonError(502, "holiday_import_failed", "Couldn't reach the government holiday feed. Try again later.");
  }
}
