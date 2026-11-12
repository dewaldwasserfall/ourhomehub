/**
 * POST /api/calendar/events
 *
 * Any household member adds an event to the family calendar.
 *   1. Check the caller and that the calendar is connected
 *   2. Validate the sheet's input and build Google's request
 *   3. Create it in Google first (the source of truth)
 *   4. Store Google's copy locally so every phone updates straight away
 */
import { NextResponse, type NextRequest } from "next/server";
import { getCaller, jsonError } from "@/lib/calendar/caller";
import { buildGoogleEventBody, EVENT_INPUT_MESSAGES, EventInputError, planChanges } from "@/lib/calendar/mapping";
import { loadConnection, withAccessToken } from "@/lib/calendar/sync";
import type { EventInput } from "@/lib/calendar/types";
import { insertEvent } from "@/lib/google/calendar-api";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  // Step 1: who, and is there a calendar?
  const result = await getCaller();
  if (!result.ok) return result.response;
  const { caller } = result;
  const connection = await loadConnection(caller.householdId);
  if (!connection) return jsonError(409, "calendar_not_connected", "The family calendar isn't connected yet.");

  // Step 2: validate.
  let body: Record<string, unknown>;
  try {
    const input = (await request.json()) as EventInput;
    body = buildGoogleEventBody(input, caller.timeZone, caller.memberId);
  } catch (err) {
    if (err instanceof EventInputError) return jsonError(400, err.message, EVENT_INPUT_MESSAGES[err.message] ?? "Check the event details.");
    return jsonError(400, "invalid_request", "Check the event details.");
  }

  // Step 3: create in Google.
  try {
    const created = await withAccessToken(caller.householdId, (token) => insertEvent(token, connection.calendar_id, body));

    // Step 4: store locally (the webhook will confirm the same row later).
    const { upserts } = planChanges([created], caller.householdId, caller.timeZone, new Set([caller.memberId]));
    const admin = getSupabaseAdminClient();
    const { data, error } = await admin
      .from("calendar_events")
      .upsert(upserts, { onConflict: "household_id,google_event_id" })
      .select()
      .single();
    if (error) throw new Error(error.message);
    return NextResponse.json({ event: data }, { status: 201 });
  } catch (err) {
    console.error("[calendar] create failed", err);
    return jsonError(502, "google_failed", "Google Calendar didn't accept the event. Try again in a moment.");
  }
}
