/**
 * Calendar types shared by the server routes, the sync engine and the UI.
 */

/** A row of public.calendar_events (see 20261112000600_calendar.sql). */
export interface CalendarEventRow {
  id: string;
  household_id: string;
  google_event_id: string;
  etag: string | null;
  status: string;
  title: string;
  description: string | null;
  location: string | null;
  all_day: boolean;
  start_at: string | null;
  end_at: string | null;
  start_date: string | null;
  end_date: string | null; // exclusive, as Google sends it
  time_zone: string | null;
  recurrence: string[] | null;
  recurring_event_id: string | null;
  original_start: string | null;
  added_by_member: string | null;
  html_link: string | null;
  google_updated_at: string | null;
  updated_at: string;
}

/** The fields the sync engine writes (database fills id/updated_at). */
export type CalendarEventUpsert = Omit<CalendarEventRow, "id" | "updated_at">;

/** The subset of a Google Calendar event resource we use. */
export interface GoogleEventTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

export interface GoogleEvent {
  id: string;
  etag?: string;
  status?: "confirmed" | "tentative" | "cancelled";
  summary?: string;
  description?: string;
  location?: string;
  start?: GoogleEventTime;
  end?: GoogleEventTime;
  recurrence?: string[];
  recurringEventId?: string;
  originalStartTime?: GoogleEventTime;
  htmlLink?: string;
  updated?: string;
  extendedProperties?: { private?: Record<string, string> };
}

/** What the event sheet sends to the server when creating or editing. */
export interface EventInput {
  title: string;
  location?: string | null;
  description?: string | null;
  allDay: boolean;
  startDate: string; // YYYY-MM-DD
  startTime?: string | null; // HH:MM, timed events only
  endDate: string; // YYYY-MM-DD, inclusive for all-day events
  endTime?: string | null;
}

/** One occurrence on screen (a one-off event or one slot of a series). */
export interface Occurrence {
  key: string;
  row: CalendarEventRow;
  title: string;
  allDay: boolean;
  start: Date | null; // timed events
  end: Date | null;
  startDate: string; // YYYY-MM-DD in the household zone (first day shown)
  endDate: string; // YYYY-MM-DD inclusive (last day shown)
  isRecurring: boolean;
}

/** Connection summary from calendar_connection_status(). */
export interface CalendarConnectionStatus {
  connected: boolean;
  google_email: string;
  status: "active" | "error";
  last_synced_at: string | null;
  connected_by: string | null;
}
