/**
 * Pure conversions between Google Calendar events and our database rows.
 * No network or database access here, so all of it is unit-tested.
 */
import { addDays } from "./time";
import type { CalendarEventUpsert, EventInput, GoogleEvent } from "./types";

/** Private event property holding the household member who added it. */
export const ADDED_BY_PROPERTY = "householdHubAddedBy";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// -----------------------------------------------------------------------------
// Step 1: Google -> database
// -----------------------------------------------------------------------------

/**
 * What one changed Google event means for our table:
 *   - "delete": a whole event or series was cancelled -> remove it (and, for
 *     a series, its stored exceptions)
 *   - "upsert": store this row (one-off, series master, or an exception;
 *     a cancelled exception is kept so its slot is hidden)
 */
export type EventChange =
  | { kind: "delete"; googleEventId: string }
  | { kind: "upsert"; row: CalendarEventUpsert };

export function googleEventToChange(
  event: GoogleEvent,
  householdId: string,
  calendarTimeZone: string,
  knownMemberIds: Set<string>,
): EventChange {
  // Step 1a: a cancelled event that is not a single occurrence -> delete.
  if (event.status === "cancelled" && !event.recurringEventId) {
    return { kind: "delete", googleEventId: event.id };
  }

  // Step 1b: timed or all-day.
  const allDay = Boolean(event.start?.date);
  const addedBy = event.extendedProperties?.private?.[ADDED_BY_PROPERTY];

  return {
    kind: "upsert",
    row: {
      household_id: householdId,
      google_event_id: event.id,
      etag: event.etag ?? null,
      status: event.status ?? "confirmed",
      title: event.summary ?? "",
      description: event.description ?? null,
      location: event.location ?? null,
      all_day: allDay,
      start_at: allDay ? null : (event.start?.dateTime ?? null),
      end_at: allDay ? null : (event.end?.dateTime ?? null),
      start_date: allDay ? (event.start?.date ?? null) : null,
      end_date: allDay ? (event.end?.date ?? null) : null,
      time_zone: event.start?.timeZone ?? calendarTimeZone,
      recurrence: event.recurrence?.length ? event.recurrence : null,
      recurring_event_id: event.recurringEventId ?? null,
      original_start: event.originalStartTime?.dateTime ?? event.originalStartTime?.date ?? null,
      // Only link members that exist in this household (the property is
      // editable by anyone with the event, so never trust it blindly).
      added_by_member: addedBy && UUID.test(addedBy) && knownMemberIds.has(addedBy) ? addedBy : null,
      html_link: event.htmlLink ?? null,
      google_updated_at: event.updated ?? null,
    },
  };
}

/**
 * Turn a batch of Google events into the deletes and upserts to apply.
 * When a later item in the same batch touches the same event, it wins.
 */
export function planChanges(
  events: GoogleEvent[],
  householdId: string,
  calendarTimeZone: string,
  knownMemberIds: Set<string>,
): { upserts: CalendarEventUpsert[]; deletes: string[] } {
  const latest = new Map<string, EventChange>();
  for (const event of events) {
    latest.set(event.id, googleEventToChange(event, householdId, calendarTimeZone, knownMemberIds));
  }
  const upserts: CalendarEventUpsert[] = [];
  const deletes: string[] = [];
  for (const change of latest.values()) {
    if (change.kind === "delete") deletes.push(change.googleEventId);
    else upserts.push(change.row);
  }
  return { upserts, deletes };
}

// -----------------------------------------------------------------------------
// Step 2: event sheet -> Google
// -----------------------------------------------------------------------------

export class EventInputError extends Error {}

/**
 * Validate what the event sheet sent and build the Google request body.
 * All-day events: the sheet's end date is inclusive, Google's is exclusive.
 */
export function buildGoogleEventBody(
  input: EventInput,
  timeZone: string,
  addedByMemberId?: string,
): Record<string, unknown> {
  // Step 2a: validate.
  const title = input.title?.trim();
  if (!title) throw new EventInputError("title_required");
  if (title.length > 300) throw new EventInputError("title_too_long");
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const timeRe = /^\d{2}:\d{2}$/;
  if (!dateRe.test(input.startDate) || !dateRe.test(input.endDate)) throw new EventInputError("invalid_date");

  let start: Record<string, string | null>;
  let end: Record<string, string | null>;

  if (input.allDay) {
    // Step 2b: all-day -> date fields (and explicitly clear dateTime on edits).
    if (input.endDate < input.startDate) throw new EventInputError("end_before_start");
    start = { date: input.startDate, dateTime: null, timeZone: null };
    end = { date: addDays(input.endDate, 1), dateTime: null, timeZone: null };
  } else {
    // Step 2c: timed -> local wall time + the household's zone; Google does
    // the zone maths, so DST is always right.
    if (!input.startTime || !input.endTime || !timeRe.test(input.startTime) || !timeRe.test(input.endTime)) {
      throw new EventInputError("invalid_time");
    }
    const startKey = `${input.startDate}T${input.startTime}`;
    const endKey = `${input.endDate}T${input.endTime}`;
    if (endKey <= startKey) throw new EventInputError("end_before_start");
    start = { dateTime: `${startKey}:00`, timeZone, date: null };
    end = { dateTime: `${endKey}:00`, timeZone, date: null };
  }

  const body: Record<string, unknown> = {
    summary: title,
    location: input.location?.trim() || null,
    description: input.description?.trim() || null,
    start,
    end,
  };
  if (addedByMemberId) {
    body.extendedProperties = { private: { [ADDED_BY_PROPERTY]: addedByMemberId } };
  }
  return body;
}

/** Interface copy for EventInputError codes. */
export const EVENT_INPUT_MESSAGES: Record<string, string> = {
  title_required: "Give the event a title.",
  title_too_long: "That title is too long. Keep it under 300 characters.",
  invalid_date: "Pick a start and end date.",
  invalid_time: "Pick a start and end time, or switch on All day.",
  end_before_start: "The end has to be after the start.",
};
