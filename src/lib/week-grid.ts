/**
 * The week grid: a child's reward tasks by day (rows × days), as shown on the
 * board when their column opens, and on the parents' Stars page.
 *
 * buildWeekGrid() turns the tasks, the week's ticks and the paid-out ticks
 * into cells. Each cell is one of:
 *
 *   empty    today, not done yet        ☆  the child can tap it
 *   missed   an earlier day, not done   ☆  (faint) a parent can fill it in
 *   pending  ticked, waiting for a parent   ⏳
 *   done     confirmed: it counts       ★
 *   paid     confirmed and paid out (or used by a given reward)   ★ struck through
 *   future   a day still to come        ·
 *   na       not scheduled that day     –
 *
 * Which days a task applies to:
 *   * routine steps: their weekdays (all days when none are set);
 *   * chores every day: every day; other chores: their due day, and any day
 *     they were ticked;
 *   * zone tasks: any day.
 */
import { addDays } from "./calendar/time";
import { isoWeekday } from "./plan";
import type { Completion, CompletionKind } from "./types";

export type CellState = "empty" | "missed" | "pending" | "done" | "paid" | "future" | "na";

/** A task row: what it is and when it applies. */
export interface GridTask {
  kind: CompletionKind;
  id: string;
  title: string;
  /** Routine steps: ISO weekdays it runs on (null/empty: every day). */
  weekdays?: number[] | null;
  /** Chores: the schedule and the next due day. */
  everyDay?: boolean;
  nextDue?: string;
}

export interface GridCell {
  date: string;
  state: CellState;
  /** The tick behind the cell (for confirming, paying out, undoing). */
  completionId?: string;
}

export interface GridRow {
  task: GridTask;
  cells: GridCell[];
}

export interface WeekGrid {
  /** The days shown, as YYYY-MM-DD, in order. */
  dates: string[];
  rows: GridRow[];
  /** Per day: stars that count (done + paid) and the cells that could. */
  totals: { date: string; stars: number; possible: number }[];
}

/** Monday of the week that contains `date`. */
export const weekStart = (date: string) => addDays(date, -(isoWeekday(date) - 1));

/** Does a task apply on a day (before looking at ticks)? */
function applies(task: GridTask, date: string): boolean {
  if (task.kind === "step") return !task.weekdays || task.weekdays.length === 0 || task.weekdays.includes(isoWeekday(date));
  if (task.kind === "chore") return task.everyDay !== false ? true : task.nextDue === date;
  return true;
}

/**
 * Step 1: the grid for one child and one week.
 *
 * @param days      ISO weekdays to show (1 = Monday), e.g. [1,2,3,4,5]
 * @param monday    the week's Monday (YYYY-MM-DD)
 * @param today     today (YYYY-MM-DD), in the household's time zone
 * @param ticks     completions for these tasks (any member: only the
 *                  child's count)
 * @param paidIds   completion ids already paid out or used by a reward
 */
export function buildWeekGrid(input: {
  tasks: GridTask[];
  memberId: string;
  days: number[];
  monday: string;
  today: string;
  ticks: Pick<Completion, "id" | "kind" | "item_id" | "for_date" | "done_for" | "pending">[];
  paidIds: ReadonlySet<string>;
}): WeekGrid {
  const { tasks, memberId, days, monday, today, ticks, paidIds } = input;
  const dates = [...new Set(days)]
    .filter((d) => d >= 1 && d <= 7)
    .sort((a, b) => a - b)
    .map((d) => addDays(monday, d - 1));

  // 1a. The child's ticks, by task and day.
  const byKey = new Map<string, (typeof ticks)[number]>();
  for (const t of ticks) if (t.done_for === memberId) byKey.set(`${t.kind}:${t.item_id}:${t.for_date}`, t);

  // 1b. A cell per task per day.
  const rows: GridRow[] = tasks.map((task) => ({
    task,
    cells: dates.map((date): GridCell => {
      const tick = byKey.get(`${task.kind}:${task.id}:${date}`);
      if (tick) {
        const state: CellState = tick.pending ? "pending" : paidIds.has(tick.id) ? "paid" : "done";
        return { date, state, completionId: tick.id };
      }
      if (!applies(task, date) && date !== today) return { date, state: "na" };
      if (date > today) return { date, state: "future" };
      return { date, state: date === today ? "empty" : "missed" };
    }),
  }));

  // 1c. Day totals.
  const totals = dates.map((date, i) => {
    const cells = rows.map((r) => r.cells[i]);
    return {
      date,
      stars: cells.filter((c) => c.state === "done" || c.state === "paid").length,
      possible: cells.filter((c) => c.state !== "na").length,
    };
  });
  return { dates, rows, totals };
}

/** Step 2: the ticks of one day a parent can act on (confirm, pay out). */
export function dayActions(grid: WeekGrid, date: string): { waiting: string[]; payable: string[] } {
  const i = grid.dates.indexOf(date);
  if (i < 0) return { waiting: [], payable: [] };
  const cells = grid.rows.map((r) => r.cells[i]);
  return {
    waiting: cells.filter((c) => c.state === "pending" && c.completionId).map((c) => c.completionId!),
    // Paying out a waiting one confirms it too.
    payable: cells.filter((c) => (c.state === "done" || c.state === "pending") && c.completionId).map((c) => c.completionId!),
  };
}

/** Step 3: every tick id already used up, from payouts and given rewards. */
export function paidTickIds(rows: Array<{ ticks: unknown }>): Set<string> {
  const ids = new Set<string>();
  for (const r of rows) {
    if (!Array.isArray(r.ticks)) continue;
    for (const t of r.ticks) {
      const id = (t as { id?: unknown })?.id;
      if (typeof id === "string") ids.add(id);
    }
  }
  return ids;
}
