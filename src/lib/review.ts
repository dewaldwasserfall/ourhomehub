/**
 * Weekly review: pure helpers (no database, no clock), shared by the /review
 * page and the Sunday-evening notification.
 *
 *   * reviewWeeks()    – which dates "this week" and "next week" cover
 *   * totalDone()      – one person's ticks added up
 *   * weekHeadline()   – "42 things done · most by Jana (15)"
 *   * nextWeekDays()   – per day of next week: bins, chores due, holiday
 *                        start/end, zone switch (events are added by the page)
 *   * weeklyReviewNotice() – the Sunday push notification
 */
import { binList, type BinDay, type BinKind } from "./bins";
import { addDays } from "./calendar/time";
import { isoWeekday, mondayOf, zoneFortnight } from "./plan";
import type { Chore, DayInfo, Member, Zone } from "./types";

// -----------------------------------------------------------------------------
// Step 1: the two weeks
// -----------------------------------------------------------------------------

export interface ReviewWeeks {
  /** Monday of this week. */
  from: string;
  /** Today (this week so far). */
  to: string;
  /** Next Monday to next Sunday. */
  nextFrom: string;
  nextTo: string;
}

export function reviewWeeks(today: string): ReviewWeeks {
  const from = mondayOf(today);
  const nextFrom = addDays(from, 7);
  return { from, to: today, nextFrom, nextTo: addDays(nextFrom, 6) };
}

/** Sunday: the day the review is "due" (Today card and notification). */
export function isReviewDay(today: string): boolean {
  return isoWeekday(today) === 7;
}

// -----------------------------------------------------------------------------
// Step 2: what got done (counts come from the weekly_review / week_counts RPC)
// -----------------------------------------------------------------------------

export interface PersonCounts {
  member_id: string;
  steps: number;
  chores: number;
  zone_tasks: number;
  todos: number;
}

export interface WeekCounts {
  people: PersonCounts[];
  shopping_bought: number;
}

export function totalDone(p: PersonCounts): number {
  return p.steps + p.chores + p.zone_tasks + p.todos;
}

/** People with something done, busiest first. */
export function ranked(counts: WeekCounts): PersonCounts[] {
  return counts.people.filter((p) => totalDone(p) > 0).sort((a, b) => totalDone(b) - totalDone(a));
}

/** "42 things done · most by Jana (15)" or "Nothing ticked off yet". */
export function weekHeadline(counts: WeekCounts, names: Map<string, string>): string {
  const people = ranked(counts);
  const total = people.reduce((sum, p) => sum + totalDone(p), 0);
  if (total === 0) return "Nothing ticked off yet";
  const top = people[0];
  const things = total === 1 ? "1 thing done" : `${total} things done`;
  // Only name a "most by" when more than one person did something.
  if (people.length < 2) return things;
  const name = (names.get(top.member_id) ?? "Someone").split(" ")[0];
  return `${things} · most by ${name} (${totalDone(top)})`;
}

// -----------------------------------------------------------------------------
// Step 3: next week, day by day
// -----------------------------------------------------------------------------

export type PreviewItem =
  | { type: "bins"; kinds: BinKind[] }
  | { type: "chore"; title: string; overdue: boolean; assignee: string | null }
  | { type: "mode"; text: string }
  | { type: "zone"; zone: string };

export interface PreviewDay {
  date: string;
  items: PreviewItem[];
}

/**
 * Builds next week's notes. `days` holds day_info for each date (from the
 * database, so school holidays and overrides match Today exactly).
 *
 *  - bins on their collection day
 *  - chores on their due day; anything already overdue shows on Monday
 *  - a "mode" note when the day's kind changes from the day before
 *    (holiday starts, school starts again) – weekends are left out
 *  - the zone on the Monday a new fortnight starts
 */
export function nextWeekDays(input: {
  nextFrom: string;
  days: Map<string, DayInfo>;
  /** day_info of this Friday (the last weekday before next week), to spot a change on Monday. */
  modeBefore: DayInfo | null;
  binDays: BinDay[];
  chores: Chore[];
  zones: Zone[];
  rotationStart: string | null;
}): PreviewDay[] {
  const { nextFrom, days, binDays, chores, zones, rotationStart } = input;
  const sortedZones = [...zones].sort((a, b) => a.sort_order - b.sort_order);
  const result: PreviewDay[] = [];
  // The last weekday's mode we've seen, to spot a change.
  let lastWeekdayMode = input.modeBefore?.mode ?? null;

  for (let i = 0; i < 7; i++) {
    const date = addDays(nextFrom, i);
    const items: PreviewItem[] = [];
    const info = days.get(date);

    // 3a. Holiday or school starting (weekdays only).
    if (info && info.mode !== "weekend") {
      if (lastWeekdayMode && lastWeekdayMode !== "weekend" && info.mode !== lastWeekdayMode) {
        items.push({ type: "mode", text: info.mode === "holiday" ? `${info.label ?? "Holiday"} starts` : "School again" });
      } else if (i === 0 && info.mode === "holiday" && info.label) {
        items.push({ type: "mode", text: info.label });
      }
      lastWeekdayMode = info.mode;
    }

    // 3b. A new zone fortnight starts.
    if (rotationStart && sortedZones.length) {
      const f = zoneFortnight(rotationStart, date, sortedZones.length);
      if (f && f.start === date) items.push({ type: "zone", zone: sortedZones[f.index].name });
    }

    // 3c. Bins.
    const kinds = binDays.filter((b) => b.date === date).map((b) => b.kind);
    if (kinds.length) items.push({ type: "bins", kinds });

    // 3d. Chores due that day (overdue ones on Monday).
    for (const c of chores) {
      if (!c.active) continue;
      const due = c.next_due === date || (i === 0 && c.next_due < date);
      if (due) items.push({ type: "chore", title: c.title, overdue: c.next_due < nextFrom, assignee: c.assigned_to });
    }

    result.push({ date, items });
  }
  return result;
}

// -----------------------------------------------------------------------------
// Step 4: the Sunday-evening notification
// -----------------------------------------------------------------------------

const WEEKDAY_ABBR = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * "Your week: 42 things done" / "Most by Jana (15) · Next week: Plastic Mon,
 * GFT Thu". Only on Sundays; the key makes it once per Sunday per person.
 */
export function weeklyReviewNotice(
  counts: WeekCounts,
  members: Array<Pick<Member, "id" | "display_name">>,
  nextWeekBins: BinDay[],
  today: string,
): { key: string; title: string; body: string; url: string } | null {
  if (!isReviewDay(today)) return null;
  const names = new Map(members.map((m) => [m.id, m.display_name]));
  const [first, ...rest] = weekHeadline(counts, names).split(" · ");

  // Next week's bins, grouped by day: "Plastic Mon, GFT and Paper Thu".
  const byDay = new Map<string, BinKind[]>();
  for (const b of [...nextWeekBins].sort((a, b) => a.date.localeCompare(b.date))) {
    byDay.set(b.date, [...(byDay.get(b.date) ?? []), b.kind]);
  }
  const bins = [...byDay.entries()].map(([date, kinds]) => `${binList(kinds)} ${WEEKDAY_ABBR[isoWeekday(date) - 1]}`);

  const parts = [...rest.map((s) => s.charAt(0).toUpperCase() + s.slice(1))];
  if (counts.shopping_bought) parts.push(`${counts.shopping_bought} bought`);
  if (bins.length) parts.push(`Next week: ${bins.join(", ")}`);
  return {
    key: `review:${today}`,
    title: `Your week: ${first.charAt(0).toLowerCase() + first.slice(1)}`,
    body: parts.join(" · ") || "Tap to see next week",
    url: "/review",
  };
}
