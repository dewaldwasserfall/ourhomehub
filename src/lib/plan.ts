/**
 * Rules for routines, zones and chores, as pure functions.
 *
 * Dates are household calendar days as "YYYY-MM-DD" strings (see
 * calendar/time.ts dateKey), so nothing here depends on the device's time zone.
 * The day's mode itself (school / holiday / weekend) comes from the database
 * (day_info), so Today and the database always agree on it.
 */
import { addDays, daysBetweenKeys } from "./calendar/time";
import type { Chore, ChoreUnit, DayMode, RoutineStep, TimeOfDay } from "./types";

// -----------------------------------------------------------------------------
// Step 1: weekdays and modes
// -----------------------------------------------------------------------------

/** ISO weekday of a date key: 1 = Monday .. 7 = Sunday. */
export function isoWeekday(date: string): number {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay(); // 0 = Sunday
  return day === 0 ? 7 : day;
}

/** The Monday on or before a date. */
export function mondayOf(date: string): string {
  return addDays(date, 1 - isoWeekday(date));
}

export const WEEKDAY_SHORT = ["M", "T", "W", "T", "F", "S", "S"]; // index 0 = Monday
export const WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
export const ALL_MODES: DayMode[] = ["school", "holiday", "weekend"];
export const MODE_LABELS: Record<DayMode, string> = { school: "School day", holiday: "Holiday", weekend: "Weekend" };

/** Does a routine step show on this date in this mode? */
export function stepApplies(step: Pick<RoutineStep, "weekdays" | "modes">, date: string, mode: DayMode): boolean {
  const weekdayOk = !step.weekdays || step.weekdays.length === 0 || step.weekdays.includes(isoWeekday(date));
  return weekdayOk && step.modes.includes(mode);
}

/**
 * Short description of a step's rule, e.g. "School days, Mon" or "Every day".
 * Empty rules read as "Every day".
 */
export function describeRule(weekdays: number[] | null, modes: DayMode[]): string {
  const sorted = [...(weekdays ?? [])].sort((a, b) => a - b);
  const days =
    sorted.length === 0 || sorted.length === 7
      ? null
      : sorted.join(",") === "1,2,3,4,5"
        ? "Mon–Fri"
        : sorted.join(",") === "6,7"
          ? "Sat, Sun"
          : sorted.map((d) => WEEKDAY_NAMES[d - 1].slice(0, 3)).join(", ");
  const allModes = ALL_MODES.every((m) => modes.includes(m));
  const modeText = allModes
    ? null
    : ALL_MODES.filter((m) => modes.includes(m))
        .map((m) => (m === "school" ? "School days" : m === "holiday" ? "Holidays" : "Weekends"))
        .join(" & ");
  if (!days && !modeText) return "Every day";
  return [modeText, days].filter(Boolean).join(", ");
}

// -----------------------------------------------------------------------------
// Step 2: time of day
// -----------------------------------------------------------------------------

export const TIME_OF_DAY_LABELS: Record<TimeOfDay, string> = {
  morning: "Morning",
  afternoon: "After school",
  evening: "Evening",
};

/** Which routines to open on Today, from the household's wall-clock hour. */
export function timeOfDayAt(hour: number): TimeOfDay {
  return hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
}

// -----------------------------------------------------------------------------
// Step 3: the fortnightly zone rotation
// -----------------------------------------------------------------------------

export interface ZoneFortnight {
  /** Index into the zones (sorted by sort_order) that is active. */
  index: number;
  /** Monday the fortnight started; zone task ticks are stored on this date. */
  start: string;
  /** Sunday it ends. */
  end: string;
  /** 1..14 */
  day: number;
}

/**
 * The active zone for a date. Fortnights run Monday to Sunday from the
 * rotation start, and the zones take turns in order, wrapping round.
 * Matches zone_period_start() in the database.
 */
export function zoneFortnight(rotationStart: string, date: string, zoneCount: number): ZoneFortnight | null {
  if (zoneCount <= 0) return null;
  const days = daysBetweenKeys(rotationStart, date);
  const period = Math.floor(days / 14);
  const start = addDays(rotationStart, period * 14);
  return {
    index: ((period % zoneCount) + zoneCount) % zoneCount,
    start,
    end: addDays(start, 13),
    day: days - period * 14 + 1,
  };
}

// -----------------------------------------------------------------------------
// Step 4: chores
// -----------------------------------------------------------------------------

/** Does a chore belong on Today's list? (Due or overdue, and allowed today.) */
export function choreDueOn(chore: Pick<Chore, "next_due" | "modes" | "active">, date: string, mode: DayMode): boolean {
  return chore.active && chore.next_due <= date && chore.modes.includes(mode);
}

/** "Every week", "Every 2 weeks", "Every day", "Every 3 months". */
export function describeEvery(everyN: number, unit: ChoreUnit): string {
  if (everyN === 1) return unit === "day" ? "Every day" : `Every ${unit}`;
  return `Every ${everyN} ${unit}s`;
}

/** The next due date after ticking a chore off on `date` (same rule as the database). */
export function nextDueAfter(date: string, everyN: number, unit: ChoreUnit): string {
  if (unit === "day") return addDays(date, everyN);
  if (unit === "week") return addDays(date, everyN * 7);
  // Months: same day of month, clamped to the month's last day (Jan 31 -> Feb 28).
  const [y, m, d] = date.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + everyN, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

// -----------------------------------------------------------------------------
// Step 5: friendly dates
// -----------------------------------------------------------------------------

const shortDate = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

/** "Today", "Tomorrow", "Yesterday", "3 days ago", "Fri 20 Nov". */
export function describeDay(date: string, today: string): string {
  const diff = daysBetweenKeys(today, date);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  if (diff < 0 && diff > -7) return `${-diff} days ago`;
  return shortDate.format(new Date(`${date}T12:00:00Z`));
}
