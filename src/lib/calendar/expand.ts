/**
 * Turns stored calendar rows into the occurrences shown on screen for a date
 * range: one-off events as they are, repeating series expanded slot by slot.
 *
 * How repeating series are expanded:
 *   1. The series' first start is converted to wall time in its own zone
 *      ("Monday 09:00 Amsterdam") and treated as a floating time, so the
 *      repeat rule steps through wall times and DST never shifts it.
 *   2. Each generated wall time is converted back to a real instant.
 *   3. Slots listed in EXDATE lines, and slots replaced by stored exceptions
 *      (a moved or cancelled single occurrence), are removed. Moved
 *      occurrences then appear as their own rows.
 */
import { RRule } from "rrule";
import { addDays, dateKey, daysBetweenKeys, instantOfWallTime, pad, wallTimeOf, type WallTime } from "./time";
import type { CalendarEventRow, Occurrence } from "./types";

/** Hard stop so a broken rule can never hang the screen. */
const MAX_OCCURRENCES_PER_SERIES = 1000;

// -----------------------------------------------------------------------------
// Step 1: small helpers
// -----------------------------------------------------------------------------

/** A wall time stored in a UTC Date ("floating"), the form rrule steps through. */
function floating(w: WallTime): Date {
  return new Date(Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second));
}

function wallFromFloating(d: Date): WallTime {
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
  };
}

function floatingDateKey(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Parse "20261116T090000", "20261116T080000Z" or "20261116" in a zone. */
function parseICalStamp(value: string, timeZone: string): { instantMs: number | null; date: string } {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return { instantMs: null, date: "" };
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  if (!m[4]) return { instantMs: null, date };
  const wall: WallTime = {
    year: +m[1],
    month: +m[2],
    day: +m[3],
    hour: +m[4],
    minute: +m[5],
    second: +m[6],
  };
  const instant = m[7]
    ? Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second)
    : instantOfWallTime(wall, timeZone).getTime();
  return { instantMs: instant, date };
}

/** EXDATE lines -> excluded instants (timed) and dates (all-day). */
function parseExDates(lines: string[], timeZone: string): { instants: Set<number>; dates: Set<string> } {
  const instants = new Set<number>();
  const dates = new Set<string>();
  for (const line of lines) {
    if (!line.toUpperCase().startsWith("EXDATE")) continue;
    const [head, values = ""] = line.split(":");
    const tzid = head.match(/TZID=([^;:]+)/i)?.[1] ?? timeZone;
    for (const value of values.split(",")) {
      const parsed = parseICalStamp(value.trim(), tzid);
      if (parsed.instantMs !== null) instants.add(parsed.instantMs);
      if (parsed.date) dates.add(parsed.date);
    }
  }
  return { instants, dates };
}

/** Is this row a cancelled single occurrence of a series? */
function isCancelledException(row: CalendarEventRow): boolean {
  return row.status === "cancelled" && Boolean(row.recurring_event_id);
}

// -----------------------------------------------------------------------------
// Step 2: one-off events and exceptions
// -----------------------------------------------------------------------------

function oneOff(row: CalendarEventRow, timeZone: string, isRecurring: boolean): Occurrence | null {
  if (row.all_day) {
    if (!row.start_date || !row.end_date) return null;
    return {
      key: row.id,
      row,
      title: row.title,
      allDay: true,
      start: null,
      end: null,
      startDate: row.start_date,
      endDate: addDays(row.end_date, -1),
      isRecurring,
    };
  }
  if (!row.start_at || !row.end_at) return null;
  const start = new Date(row.start_at);
  const end = new Date(row.end_at);
  return {
    key: row.id,
    row,
    title: row.title,
    allDay: false,
    start,
    end,
    startDate: dateKey(start, timeZone),
    endDate: dateKey(new Date(end.getTime() - 1), timeZone),
    isRecurring,
  };
}

// -----------------------------------------------------------------------------
// Step 3: repeating series
// -----------------------------------------------------------------------------

function expandSeries(
  master: CalendarEventRow,
  exceptions: CalendarEventRow[],
  rangeStartKey: string,
  rangeEndKey: string,
  householdTimeZone: string,
): Occurrence[] {
  const lines = master.recurrence ?? [];
  const ruleLine = lines.find((l) => l.toUpperCase().startsWith("RRULE:"));
  if (!ruleLine) {
    const single = oneOff(master, householdTimeZone, false);
    return single ? [single] : [];
  }
  const zone = master.time_zone || householdTimeZone;
  const exdates = parseExDates(lines, zone);

  // Step 3a: slots replaced by stored exceptions (moved or cancelled).
  const replacedInstants = new Set<number>();
  const replacedDates = new Set<string>();
  for (const ex of exceptions) {
    if (!ex.original_start) continue;
    if (/^\d{4}-\d{2}-\d{2}$/.test(ex.original_start)) replacedDates.add(ex.original_start);
    else replacedInstants.add(new Date(ex.original_start).getTime());
  }

  // Step 3b: build the rule in floating time from the series' first slot.
  const options = RRule.parseString(ruleLine.slice("RRULE:".length));
  let dtstart: Date;
  let durationMs = 0;
  let durationDays = 0;
  if (master.all_day) {
    if (!master.start_date || !master.end_date) return [];
    const [y, m, d] = master.start_date.split("-").map(Number);
    dtstart = new Date(Date.UTC(y, m - 1, d));
    durationDays = Math.max(1, daysBetweenKeys(master.start_date, master.end_date));
  } else {
    if (!master.start_at || !master.end_at) return [];
    const start = new Date(master.start_at);
    dtstart = floating(wallTimeOf(start, zone));
    durationMs = new Date(master.end_at).getTime() - start.getTime();
  }
  // A UNTIL in UTC is a real instant: move it to the same floating frame.
  if (options.until && !master.all_day) {
    options.until = floating(wallTimeOf(options.until, zone));
  }
  const rule = new RRule({ ...options, dtstart });

  // Step 3c: generate slots in the visible range (padded so a slot that
  // started before the range but is still running is included).
  const [ry, rm, rd] = rangeStartKey.split("-").map(Number);
  const [ey, em, ed] = rangeEndKey.split("-").map(Number);
  const padDays = master.all_day ? durationDays : Math.ceil(durationMs / 86_400_000);
  const from = new Date(Date.UTC(ry, rm - 1, rd - padDays - 1));
  const to = new Date(Date.UTC(ey, em - 1, ed + 1));
  const slots = rule.between(from, to, true).slice(0, MAX_OCCURRENCES_PER_SERIES);

  // Step 3d: turn slots into occurrences, skipping excluded or replaced ones.
  const occurrences: Occurrence[] = [];
  for (const slot of slots) {
    if (master.all_day) {
      const day = floatingDateKey(slot);
      if (exdates.dates.has(day) || replacedDates.has(day)) continue;
      const lastDay = addDays(day, durationDays - 1);
      if (lastDay < rangeStartKey || day > rangeEndKey) continue;
      occurrences.push({
        key: `${master.id}:${day}`,
        row: master,
        title: master.title,
        allDay: true,
        start: null,
        end: null,
        startDate: day,
        endDate: lastDay,
        isRecurring: true,
      });
    } else {
      const start = instantOfWallTime(wallFromFloating(slot), zone);
      if (exdates.instants.has(start.getTime()) || replacedInstants.has(start.getTime())) continue;
      const end = new Date(start.getTime() + durationMs);
      const startDay = dateKey(start, householdTimeZone);
      const endDay = dateKey(new Date(end.getTime() - 1), householdTimeZone);
      if (endDay < rangeStartKey || startDay > rangeEndKey) continue;
      occurrences.push({
        key: `${master.id}:${start.toISOString()}`,
        row: master,
        title: master.title,
        allDay: false,
        start,
        end,
        startDate: startDay,
        endDate: endDay,
        isRecurring: true,
      });
    }
  }
  return occurrences;
}

// -----------------------------------------------------------------------------
// Step 4: everything in a range, sorted
// -----------------------------------------------------------------------------

/**
 * All occurrences touching the days rangeStartKey..rangeEndKey (inclusive,
 * "YYYY-MM-DD" in the household zone), sorted with all-day events first on
 * their day, then by start time.
 */
export function expandForRange(
  rows: CalendarEventRow[],
  rangeStartKey: string,
  rangeEndKey: string,
  householdTimeZone: string,
): Occurrence[] {
  // Step 4a: group exceptions under their series.
  const exceptionsBySeries = new Map<string, CalendarEventRow[]>();
  for (const row of rows) {
    if (row.recurring_event_id) {
      const list = exceptionsBySeries.get(row.recurring_event_id) ?? [];
      list.push(row);
      exceptionsBySeries.set(row.recurring_event_id, list);
    }
  }

  const result: Occurrence[] = [];
  for (const row of rows) {
    if (row.status === "cancelled" && !row.recurring_event_id) continue;

    if (row.recurrence?.length) {
      // Step 4b: a series.
      result.push(
        ...expandSeries(row, exceptionsBySeries.get(row.google_event_id) ?? [], rangeStartKey, rangeEndKey, householdTimeZone),
      );
    } else if (row.recurring_event_id) {
      // Step 4c: a moved single occurrence shows on its own; a cancelled one only hides its slot.
      if (isCancelledException(row)) continue;
      const occ = oneOff(row, householdTimeZone, true);
      if (occ && occ.endDate >= rangeStartKey && occ.startDate <= rangeEndKey) result.push(occ);
    } else {
      // Step 4d: a one-off event.
      const occ = oneOff(row, householdTimeZone, false);
      if (occ && occ.endDate >= rangeStartKey && occ.startDate <= rangeEndKey) result.push(occ);
    }
  }

  return result.sort((a, b) => {
    if (a.startDate !== b.startDate) return a.startDate < b.startDate ? -1 : 1;
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    return (a.start?.getTime() ?? 0) - (b.start?.getTime() ?? 0) || a.title.localeCompare(b.title);
  });
}

/**
 * Occurrences grouped by the days they appear on (multi-day events appear on
 * every day they cover), limited to the range.
 */
export function groupByDay(occurrences: Occurrence[], rangeStartKey: string, rangeEndKey: string): Map<string, Occurrence[]> {
  const days = new Map<string, Occurrence[]>();
  for (const occ of occurrences) {
    let day = occ.startDate < rangeStartKey ? rangeStartKey : occ.startDate;
    const last = occ.endDate > rangeEndKey ? rangeEndKey : occ.endDate;
    // Guard against bad data producing an endless loop.
    for (let i = 0; day <= last && i < 62; i++, day = addDays(day, 1)) {
      const list = days.get(day) ?? [];
      list.push(occ);
      days.set(day, list);
    }
  }
  return days;
}
