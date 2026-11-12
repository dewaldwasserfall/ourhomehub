/**
 * Unit tests for the calendar logic: time zones, Google <-> row mapping,
 * the event sheet's validation, and repeating-event expansion.
 */
import { describe, expect, it } from "vitest";
import { expandForRange, groupByDay } from "@/lib/calendar/expand";
import { ADDED_BY_PROPERTY, buildGoogleEventBody, EventInputError, planChanges } from "@/lib/calendar/mapping";
import { addDays, dateKey, instantOf, timeKey } from "@/lib/calendar/time";
import type { CalendarEventRow, GoogleEvent } from "@/lib/calendar/types";

const TZ = "Europe/Amsterdam";
const HH = "hh-1";
const MEMBER = "11111111-1111-4111-8111-111111111111";

/** A row with sensible defaults, overridden per test. */
function row(partial: Partial<CalendarEventRow>): CalendarEventRow {
  return {
    id: partial.google_event_id ?? "r",
    household_id: HH,
    google_event_id: "g",
    etag: null,
    status: "confirmed",
    title: "Event",
    description: null,
    location: null,
    all_day: false,
    start_at: null,
    end_at: null,
    start_date: null,
    end_date: null,
    time_zone: TZ,
    recurrence: null,
    recurring_event_id: null,
    original_start: null,
    added_by_member: null,
    html_link: null,
    google_updated_at: null,
    updated_at: "2026-11-12T00:00:00Z",
    ...partial,
  };
}

// -----------------------------------------------------------------------------
// Step 1: time zones
// -----------------------------------------------------------------------------
describe("time helpers", () => {
  it("converts Amsterdam wall time to instants on both sides of DST", () => {
    expect(instantOf("2026-07-01", "09:00", TZ).toISOString()).toBe("2026-07-01T07:00:00.000Z"); // CEST
    expect(instantOf("2026-11-16", "09:00", TZ).toISOString()).toBe("2026-11-16T08:00:00.000Z"); // CET
  });

  it("reads dates and times back in the zone", () => {
    const d = new Date("2026-11-15T23:30:00Z");
    expect(dateKey(d, TZ)).toBe("2026-11-16");
    expect(timeKey(d, TZ)).toBe("00:30");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});

// -----------------------------------------------------------------------------
// Step 2: Google -> rows
// -----------------------------------------------------------------------------
describe("planChanges", () => {
  const members = new Set([MEMBER]);

  it("maps timed, all-day and recurring events", () => {
    const events: GoogleEvent[] = [
      {
        id: "a",
        summary: "Dentist",
        start: { dateTime: "2026-11-20T10:00:00+01:00", timeZone: TZ },
        end: { dateTime: "2026-11-20T10:30:00+01:00", timeZone: TZ },
        extendedProperties: { private: { [ADDED_BY_PROPERTY]: MEMBER } },
      },
      { id: "b", summary: "Sinterklaas", start: { date: "2026-12-05" }, end: { date: "2026-12-06" } },
      {
        id: "c",
        summary: "Swimming",
        recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=WE"],
        start: { dateTime: "2026-11-18T16:00:00+01:00", timeZone: TZ },
        end: { dateTime: "2026-11-18T17:00:00+01:00", timeZone: TZ },
      },
    ];
    const { upserts, deletes } = planChanges(events, HH, TZ, members);
    expect(deletes).toEqual([]);
    expect(upserts.find((r) => r.google_event_id === "a")).toMatchObject({
      all_day: false,
      start_at: "2026-11-20T10:00:00+01:00",
      added_by_member: MEMBER,
    });
    expect(upserts.find((r) => r.google_event_id === "b")).toMatchObject({
      all_day: true,
      start_date: "2026-12-05",
      end_date: "2026-12-06",
      start_at: null,
    });
    expect(upserts.find((r) => r.google_event_id === "c")?.recurrence).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=WE"]);
  });

  it("deletes cancelled events but keeps cancelled single occurrences", () => {
    const { upserts, deletes } = planChanges(
      [
        { id: "gone", status: "cancelled" },
        { id: "c_20261125", status: "cancelled", recurringEventId: "c", originalStartTime: { dateTime: "2026-11-25T16:00:00+01:00" } },
      ],
      HH,
      TZ,
      members,
    );
    expect(deletes).toEqual(["gone"]);
    expect(upserts[0]).toMatchObject({ google_event_id: "c_20261125", status: "cancelled", recurring_event_id: "c" });
  });

  it("ignores an added-by value that isn't a member of this household", () => {
    const { upserts } = planChanges(
      [{ id: "x", start: { date: "2026-12-01" }, end: { date: "2026-12-02" }, extendedProperties: { private: { [ADDED_BY_PROPERTY]: "22222222-2222-4222-8222-222222222222" } } }],
      HH,
      TZ,
      members,
    );
    expect(upserts[0].added_by_member).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// Step 3: event sheet -> Google
// -----------------------------------------------------------------------------
describe("buildGoogleEventBody", () => {
  it("builds a timed event in the household zone", () => {
    const body = buildGoogleEventBody(
      { title: " Parents evening ", allDay: false, startDate: "2026-11-20", startTime: "19:00", endDate: "2026-11-20", endTime: "20:30", location: "School" },
      TZ,
      MEMBER,
    );
    expect(body).toMatchObject({
      summary: "Parents evening",
      location: "School",
      start: { dateTime: "2026-11-20T19:00:00", timeZone: TZ },
      end: { dateTime: "2026-11-20T20:30:00", timeZone: TZ },
      extendedProperties: { private: { [ADDED_BY_PROPERTY]: MEMBER } },
    });
  });

  it("makes the all-day end date exclusive", () => {
    const body = buildGoogleEventBody({ title: "Holiday", allDay: true, startDate: "2026-12-24", endDate: "2026-12-26" }, TZ);
    expect(body).toMatchObject({ start: { date: "2026-12-24" }, end: { date: "2026-12-27" } });
  });

  it("rejects missing titles and ends before starts", () => {
    expect(() => buildGoogleEventBody({ title: " ", allDay: true, startDate: "2026-12-01", endDate: "2026-12-01" }, TZ)).toThrow(
      EventInputError,
    );
    expect(() =>
      buildGoogleEventBody({ title: "X", allDay: false, startDate: "2026-12-01", startTime: "10:00", endDate: "2026-12-01", endTime: "09:00" }, TZ),
    ).toThrow(/end_before_start/);
  });
});

// -----------------------------------------------------------------------------
// Step 4: repeating events
// -----------------------------------------------------------------------------
describe("expandForRange", () => {
  const weekly = row({
    id: "series",
    google_event_id: "c",
    title: "Swimming",
    recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=WE"],
    start_at: "2026-10-21T16:00:00+02:00", // first one in summer time
    end_at: "2026-10-21T17:00:00+02:00",
  });

  it("keeps the wall time across the DST change", () => {
    const occ = expandForRange([weekly], "2026-10-20", "2026-11-05", TZ);
    expect(occ.map((o) => `${o.startDate} ${timeKey(o.start!, TZ)}`)).toEqual([
      "2026-10-21 16:00",
      "2026-10-28 16:00", // after the clocks went back
      "2026-11-04 16:00",
    ]);
    expect(occ.every((o) => o.isRecurring)).toBe(true);
  });

  it("applies EXDATEs, moved and cancelled occurrences", () => {
    const series = { ...weekly, recurrence: [...weekly.recurrence!, "EXDATE;TZID=Europe/Amsterdam:20261104T160000"] };
    const moved = row({
      id: "moved",
      google_event_id: "c_20261111",
      title: "Swimming (moved)",
      recurring_event_id: "c",
      original_start: "2026-11-11T16:00:00+01:00",
      start_at: "2026-11-12T16:00:00+01:00",
      end_at: "2026-11-12T17:00:00+01:00",
    });
    const cancelled = row({
      id: "cancelled",
      google_event_id: "c_20261118",
      status: "cancelled",
      recurring_event_id: "c",
      original_start: "2026-11-18T16:00:00+01:00",
    });
    const occ = expandForRange([series, moved, cancelled], "2026-11-01", "2026-11-26", TZ);
    expect(occ.map((o) => `${o.startDate} ${o.title}`)).toEqual([
      "2026-11-12 Swimming (moved)",
      "2026-11-25 Swimming",
    ]);
  });

  it("expands all-day series, honours COUNT and UNTIL", () => {
    const bins = row({
      id: "bins",
      google_event_id: "bins",
      title: "Bins out",
      all_day: true,
      start_date: "2026-11-02",
      end_date: "2026-11-03",
      recurrence: ["RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=3"],
    });
    const until = row({
      id: "u",
      google_event_id: "u",
      title: "Daily standup",
      recurrence: ["RRULE:FREQ=DAILY;UNTIL=20261103T225959Z"],
      start_at: "2026-11-01T09:00:00+01:00",
      end_at: "2026-11-01T09:15:00+01:00",
    });
    const occ = expandForRange([bins, until], "2026-11-01", "2026-12-31", TZ);
    expect(occ.filter((o) => o.title === "Bins out").map((o) => o.startDate)).toEqual(["2026-11-02", "2026-11-16", "2026-11-30"]);
    expect(occ.filter((o) => o.title === "Daily standup").map((o) => o.startDate)).toEqual([
      "2026-11-01",
      "2026-11-02",
      "2026-11-03",
    ]);
  });

  it("puts all-day events first and multi-day events on every day", () => {
    const trip = row({ id: "trip", google_event_id: "trip", title: "Ski trip", all_day: true, start_date: "2026-12-27", end_date: "2026-12-30" });
    const dinner = row({ id: "dinner", google_event_id: "dinner", title: "Dinner", start_at: "2026-12-28T18:00:00+01:00", end_at: "2026-12-28T20:00:00+01:00" });
    const occ = expandForRange([dinner, trip], "2026-12-26", "2026-12-31", TZ);
    const days = groupByDay(occ, "2026-12-26", "2026-12-31");
    expect([...days.keys()]).toEqual(["2026-12-27", "2026-12-28", "2026-12-29"]);
    expect(days.get("2026-12-28")!.map((o) => o.title)).toEqual(["Ski trip", "Dinner"]);
  });
});
