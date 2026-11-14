/**
 * The Family board: what goes in each person's column today.
 *
 * Pure functions (no React, no Supabase), so the rules are unit-tested:
 *
 *   * boardColumns()   one column per person plus "Anyone" (unassigned), each
 *                      with today's steps, chores, to-dos and zone tasks
 *   * tickState()      open / waiting for a grown-up / done
 *   * boardTapAction() what a tap on a row does
 *
 * Same "what's due today" rules as the Today screen (src/lib/plan.ts), but
 * ticked items stay in place for the day so the kids see their progress.
 */
import { choreDueOn, stepApplies, zoneFortnight } from "./plan";
import type { PlanData } from "./use-plan-data";
import type { Completion, CompletionKind, DayMode, ListEntry, Member } from "./types";

/** A to-do as the board loads it (open, or done today). */
export type BoardTodo = Pick<ListEntry, "id" | "text" | "status" | "due_date" | "assigned_to" | "completed_at"> & {
  pending: boolean;
  via_board: boolean;
  done_for: string | null;
  confirmed_by: string | null;
};

export type TickState = "open" | "pending" | "done";

export interface BoardItem {
  key: string;
  kind: CompletionKind | "todo";
  id: string;
  title: string;
  /** Who it's for; null = anyone. */
  assignee: string | null;
  state: TickState;
  /** Who it was done for (once ticked). */
  doneFor: string | null;
  /** Ticked on the board and not yet confirmed: the board may undo it. */
  boardCanUndo: boolean;
  /** Overdue chore or to-do. */
  overdue: boolean;
}

export interface BoardColumn {
  /** Member id, or null for the "Anyone" column. */
  memberId: string | null;
  items: BoardItem[];
  doneCount: number;
}

// -----------------------------------------------------------------------------
// Step 1: the state of one tick
// -----------------------------------------------------------------------------

/** A completion row (or none) as open / pending / done. */
export function tickState(row: Pick<Completion, "pending"> | Pick<BoardTodo, "pending" | "status"> | undefined): TickState {
  if (!row) return "open";
  if ("status" in row && row.status === "open") return "open";
  return row.pending ? "pending" : "done";
}

/** May the board undo it? Only its own ticks that no adult has confirmed. */
function boardCanUndo(row: { via_board?: boolean; pending?: boolean; confirmed_by?: string | null } | undefined): boolean {
  return !!row?.via_board && (!!row.pending || !row.confirmed_by);
}

// -----------------------------------------------------------------------------
// Step 2: every person's column
// -----------------------------------------------------------------------------

/**
 * Columns in household order (children first, then adults), plus "Anyone"
 * at the end when something is unassigned. A column with nothing today is
 * left out.
 */
export function boardColumns(input: {
  plan: Pick<PlanData, "routines" | "steps" | "chores" | "zones" | "zoneTasks" | "completions">;
  todos: BoardTodo[];
  members: Pick<Member, "id" | "role">[];
  today: string;
  mode: DayMode | null;
  zoneRotationStart: string | null;
}): BoardColumn[] {
  const { plan, todos, members, today, mode, zoneRotationStart } = input;
  const items: BoardItem[] = [];
  const completionFor = (kind: CompletionKind, id: string, forDate: string) =>
    plan.completions.find((c) => c.kind === kind && c.item_id === id && c.for_date === forDate);

  // Step 2a: routine steps that apply today.
  if (mode) {
    for (const routine of plan.routines.filter((r) => r.active)) {
      for (const step of plan.steps.filter((s) => s.routine_id === routine.id && stepApplies(s, today, mode))) {
        const row = completionFor("step", step.id, today);
        items.push({
          key: `step:${step.id}`,
          kind: "step",
          id: step.id,
          title: step.title,
          assignee: step.assigned_to ?? routine.owner_member,
          state: tickState(row),
          doneFor: row?.done_for ?? null,
          boardCanUndo: boardCanUndo(row),
          overdue: false,
        });
      }
    }
  }

  // Step 2b: chores due today (or late), and chores ticked today (a tick
  //          moves next_due on, so they'd otherwise vanish).
  for (const chore of plan.chores) {
    const row = completionFor("chore", chore.id, today);
    const due = mode ? choreDueOn(chore, today, mode) : false;
    if (!row && !due) continue;
    items.push({
      key: `chore:${chore.id}`,
      kind: "chore",
      id: chore.id,
      title: chore.title,
      assignee: chore.assigned_to,
      state: tickState(row),
      doneFor: row?.done_for ?? null,
      boardCanUndo: boardCanUndo(row),
      overdue: !row && chore.next_due < today,
    });
  }

  // Step 2c: to-dos due today, late or undated; and those ticked today.
  for (const todo of todos) {
    if (todo.status === "open" && todo.due_date && todo.due_date > today) continue;
    items.push({
      key: `todo:${todo.id}`,
      kind: "todo",
      id: todo.id,
      title: todo.text,
      assignee: todo.assigned_to,
      state: tickState(todo),
      doneFor: todo.status === "open" ? null : (todo.done_for ?? todo.assigned_to),
      boardCanUndo: boardCanUndo(todo),
      overdue: todo.status === "open" && !!todo.due_date && todo.due_date < today,
    });
  }

  // Step 2d: this fortnight's zone tasks that are still open, or ticked today.
  if (zoneRotationStart) {
    const fortnight = zoneFortnight(zoneRotationStart, today, plan.zones.length);
    const zone = fortnight ? plan.zones[fortnight.index] : undefined;
    if (zone && fortnight) {
      for (const task of plan.zoneTasks.filter((t) => t.zone_id === zone.id)) {
        const row = completionFor("zone_task", task.id, fortnight.start);
        if (row && !row.done_at.startsWith(today) && tickState(row) === "done") continue; // done earlier this fortnight
        items.push({
          key: `zone:${task.id}`,
          kind: "zone_task",
          id: task.id,
          title: task.title,
          assignee: task.assigned_to,
          state: tickState(row),
          doneFor: row?.done_for ?? null,
          boardCanUndo: boardCanUndo(row),
          overdue: false,
        });
      }
    }
  }

  // Step 2e: into columns. A ticked unassigned item moves to the column of
  //          whoever did it, so their progress shows where they look.
  const order = [...members.filter((m) => m.role === "child"), ...members.filter((m) => m.role !== "child")];
  const columnOf = (item: BoardItem) => item.assignee ?? (item.state !== "open" ? item.doneFor : null);
  const columns: BoardColumn[] = [...order.map((m) => m.id), null].map((memberId) => {
    const mine = items
      .filter((i) => columnOf(i) === memberId)
      // Open first (late ones on top), then waiting, then done.
      .sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title));
    return { memberId, items: mine, doneCount: mine.filter((i) => i.state !== "open").length };
  });
  return columns.filter((c) => c.items.length > 0);
}

function rank(item: BoardItem): number {
  if (item.state === "open") return item.overdue ? 0 : 1;
  return item.state === "pending" ? 2 : 3;
}

// -----------------------------------------------------------------------------
// Step 3: what a tap does
// -----------------------------------------------------------------------------

export type BoardTapAction =
  | { type: "tick"; memberId: string }
  | { type: "ask_who" }
  | { type: "undo" }
  | { type: "ask_grown_up" };

/**
 *  - open and assigned: tick it for the assignee
 *  - open and unassigned: ask who did it
 *  - ticked on the board, not confirmed: undo (a mis-tap)
 *  - otherwise (confirmed, or ticked on a phone): only a grown-up can undo
 */
export function boardTapAction(item: Pick<BoardItem, "state" | "assignee" | "boardCanUndo">): BoardTapAction {
  if (item.state === "open") return item.assignee ? { type: "tick", memberId: item.assignee } : { type: "ask_who" };
  return item.boardCanUndo ? { type: "undo" } : { type: "ask_grown_up" };
}
