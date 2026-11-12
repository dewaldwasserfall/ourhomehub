/**
 * Time-zone helpers for the family calendar.
 *
 * JavaScript Dates are instants; calendars think in "wall time in a zone"
 * (09:00 in Amsterdam). These helpers convert between the two using only the
 * built-in Intl API, so they work the same in the browser and on the server,
 * including across daylight-saving changes.
 */

export interface WallTime {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

// Step 1: one cached formatter per zone (creating them is slow).
const partFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = partFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/** The wall-clock time of an instant in a zone. */
export function wallTimeOf(instant: Date, timeZone: string): WallTime {
  const parts = Object.fromEntries(
    partsFormatter(timeZone)
      .formatToParts(instant)
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, Number(p.value)]),
  );
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

/**
 * The instant at which a zone's clocks show the given wall time.
 * Step 2: guess with UTC, measure the zone's offset at the guess, correct,
 * and correct once more in case the first correction crossed a DST change.
 */
export function instantOfWallTime(wall: WallTime, timeZone: string): Date {
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  let guess = asUtc;
  for (let i = 0; i < 2; i++) {
    const seen = wallTimeOf(new Date(guess), timeZone);
    const seenAsUtc = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second);
    guess += asUtc - seenAsUtc;
  }
  return new Date(guess);
}

/** "YYYY-MM-DD" of an instant in a zone. */
export function dateKey(instant: Date, timeZone: string): string {
  const w = wallTimeOf(instant, timeZone);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
}

/** "HH:MM" of an instant in a zone. */
export function timeKey(instant: Date, timeZone: string): string {
  const w = wallTimeOf(instant, timeZone);
  return `${pad(w.hour)}:${pad(w.minute)}`;
}

/** Instant for a "YYYY-MM-DD" date and "HH:MM" time in a zone. */
export function instantOf(date: string, time: string, timeZone: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  return instantOfWallTime({ year, month, day, hour, minute, second: 0 }, timeZone);
}

/** Add whole days to a "YYYY-MM-DD" string (calendar arithmetic, no zones). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Whole days from one "YYYY-MM-DD" to another. */
export function daysBetweenKeys(from: string, to: string): number {
  const [y1, m1, d1] = from.split("-").map(Number);
  const [y2, m2, d2] = to.split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}

export function pad(n: number): string {
  return String(n).padStart(2, "0");
}
