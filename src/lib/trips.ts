/**
 * Trips: pure helpers (no database, no clock) for the Trips screens, Today
 * and the calendar.
 *
 *   * tripPhase()       – upcoming / ongoing / past, with "in 12 days" and
 *                         "day 3 of 10"
 *   * tripDates()       – every date of a trip
 *   * stayForNight()    – where you sleep on a given night
 *   * buildTripDays()   – the day-by-day timeline: the night's stay,
 *                         check-ins and check-outs, plans in time order
 *   * participantDates()– "joins 3 Jul" / "leaves 8 Jul"
 *   * tripsOnDay()      – trips covering a date (calendar)
 *   * todayTrip()       – the trip to show on Today (during, or within a week)
 *   * missedSchool()    – children on the trip, with the school days they'd miss
 */
import { addDays, daysBetweenKeys } from "./calendar/time";
import type { Member, Trip, TripParticipant, TripPlan, TripStay } from "./types";

const dayMonthFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const noon = (date: string) => new Date(`${date}T12:00:00Z`);

/** "3 Jul" */
export const shortDate = (date: string) => dayMonthFormat.format(noon(date));

/** "1 – 10 Jul" or "28 Jun – 5 Jul" (year added when it isn't this year's). */
export function tripRange(trip: Pick<Trip, "start_date" | "end_date">, today: string): string {
  const [sy, sm] = trip.start_date.split("-");
  const [ey, em] = trip.end_date.split("-");
  const year = sy !== today.slice(0, 4) || ey !== sy ? ` ${ey}` : "";
  if (trip.start_date === trip.end_date) return `${shortDate(trip.start_date)}${year}`;
  const start = sm === em && sy === ey ? String(Number(trip.start_date.slice(8))) : shortDate(trip.start_date);
  return `${start} – ${shortDate(trip.end_date)}${year}`;
}

// -----------------------------------------------------------------------------
// Step 1: where a trip is in time
// -----------------------------------------------------------------------------

export type TripPhase =
  | { phase: "upcoming"; daysUntil: number; label: string }
  | { phase: "ongoing"; day: number; of: number; label: string }
  | { phase: "past"; label: string };

export function tripPhase(trip: Pick<Trip, "start_date" | "end_date">, today: string): TripPhase {
  const of = daysBetweenKeys(trip.start_date, trip.end_date) + 1;
  if (today < trip.start_date) {
    const daysUntil = daysBetweenKeys(today, trip.start_date);
    return { phase: "upcoming", daysUntil, label: daysUntil === 1 ? "Tomorrow" : `In ${daysUntil} days` };
  }
  if (today > trip.end_date) return { phase: "past", label: "Done" };
  const day = daysBetweenKeys(trip.start_date, today) + 1;
  return { phase: "ongoing", day, of, label: `Day ${day} of ${of}` };
}

/** Upcoming and ongoing first (soonest first), then past (latest first). */
export function sortTrips<T extends Pick<Trip, "start_date" | "end_date">>(trips: T[], today: string): { current: T[]; past: T[] } {
  const current = trips.filter((t) => t.end_date >= today).sort((a, b) => a.start_date.localeCompare(b.start_date));
  const past = trips.filter((t) => t.end_date < today).sort((a, b) => b.start_date.localeCompare(a.start_date));
  return { current, past };
}

// -----------------------------------------------------------------------------
// Step 2: the days of a trip
// -----------------------------------------------------------------------------

/** Every date from the first to the last day. */
export function tripDates(trip: Pick<Trip, "start_date" | "end_date">): string[] {
  const n = daysBetweenKeys(trip.start_date, trip.end_date) + 1;
  return Array.from({ length: Math.max(0, n) }, (_, i) => addDays(trip.start_date, i));
}

/** A stay covers the nights from check-in up to the night before check-out. */
export function stayForNight(stays: TripStay[], night: string): TripStay | null {
  return stays.find((s) => s.check_in <= night && night < s.check_out) ?? null;
}

/** Nights in a stay. */
export const stayNights = (s: Pick<TripStay, "check_in" | "check_out">) => daysBetweenKeys(s.check_in, s.check_out);

export interface TripDay {
  date: string;
  /** Where you sleep tonight (null on the last day, or when not set yet). */
  stay: TripStay | null;
  checkIns: TripStay[];
  checkOuts: TripStay[];
  /** Timed plans first in time order, then untimed in the order added. */
  plans: TripPlan[];
}

/**
 * The day-by-day timeline. Includes days outside the trip's dates when
 * something is planned or booked there (a stay booked a day early still
 * shows).
 */
export function buildTripDays(trip: Pick<Trip, "start_date" | "end_date">, stays: TripStay[], plans: TripPlan[]): TripDay[] {
  const dates = new Set(tripDates(trip));
  for (const p of plans) dates.add(p.day);
  for (const s of stays) {
    dates.add(s.check_in);
    dates.add(s.check_out);
  }
  return [...dates].sort().map((date) => ({
    date,
    stay: stayForNight(stays, date),
    checkIns: stays.filter((s) => s.check_in === date),
    checkOuts: stays.filter((s) => s.check_out === date),
    plans: plans
      .filter((p) => p.day === date)
      .sort((a, b) => {
        if (a.time && b.time) return a.time.localeCompare(b.time);
        if (a.time) return -1;
        if (b.time) return 1;
        return a.created_at.localeCompare(b.created_at);
      }),
  }));
}

/** Nights in the trip with no stay booked (not counting the last day). */
export function nightsWithoutStay(trip: Pick<Trip, "start_date" | "end_date">, stays: TripStay[]): string[] {
  return tripDates(trip)
    .slice(0, -1)
    .filter((night) => !stayForNight(stays, night));
}

/** "07:30:00" -> "07:30" */
export const planTime = (time: string | null) => (time ? time.slice(0, 5) : null);

// -----------------------------------------------------------------------------
// Step 3: who's going
// -----------------------------------------------------------------------------

/** "" for the whole trip, else "joins 3 Jul", "leaves 8 Jul" or both. */
export function participantDates(p: Pick<TripParticipant, "join_date" | "leave_date">): string {
  const parts: string[] = [];
  if (p.join_date) parts.push(`joins ${shortDate(p.join_date)}`);
  if (p.leave_date) parts.push(`leaves ${shortDate(p.leave_date)}`);
  return parts.join(", ");
}

/** Is this person there on that date? */
export function isThere(p: Pick<TripParticipant, "join_date" | "leave_date">, date: string): boolean {
  return (!p.join_date || date >= p.join_date) && (!p.leave_date || date <= p.leave_date);
}

// -----------------------------------------------------------------------------
// Step 4: trips elsewhere in the app
// -----------------------------------------------------------------------------

/** Trips covering a date (for the calendar). */
export function tripsOnDay<T extends Pick<Trip, "start_date" | "end_date">>(trips: T[], date: string): T[] {
  return trips.filter((t) => t.start_date <= date && date <= t.end_date);
}

/** The trip Today should show: one that's on, else one starting within a week. */
export function todayTrip<T extends Pick<Trip, "start_date" | "end_date">>(trips: T[], today: string): T | null {
  const on = trips.find((t) => t.start_date <= today && today <= t.end_date);
  if (on) return on;
  const soon = trips
    .filter((t) => t.start_date > today && daysBetweenKeys(today, t.start_date) <= 7)
    .sort((a, b) => a.start_date.localeCompare(b.start_date));
  return soon[0] ?? null;
}

// -----------------------------------------------------------------------------
// Step 5: school
// -----------------------------------------------------------------------------

/**
 * Children going on the trip and the school days they'd miss (only the days
 * they're there, so "joins later" counts). `schoolDays` comes from the
 * school_days() RPC: the same holiday rules as Today.
 */
export function missedSchool(
  participants: TripParticipant[],
  members: Pick<Member, "id" | "role">[],
  schoolDays: string[],
): Array<{ memberId: string; days: string[] }> {
  const children = new Set(members.filter((m) => m.role === "child").map((m) => m.id));
  return participants
    .filter((p) => children.has(p.member_id))
    .map((p) => ({ memberId: p.member_id, days: schoolDays.filter((d) => isThere(p, d)).sort() }))
    .filter((x) => x.days.length > 0);
}

/** "Shannon and Lennon", "Shannon, Lennon and Jana" */
export function namesList(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
