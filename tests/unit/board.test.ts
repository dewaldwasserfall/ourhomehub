/**
 * Unit tests for the Family board: who gets which column, what "waiting"
 * looks like, and what a tap does.
 */
import { describe, expect, it } from "vitest";
import { boardColumns, boardTapAction, tickState, type BoardTodo } from "@/lib/board";
import type { Chore, Completion, Member, Routine, RoutineStep } from "@/lib/types";

const today = "2026-11-16"; // a Monday
const members = [
  { id: "dewald", role: "owner" },
  { id: "shannon", role: "child" },
  { id: "lennon", role: "child" },
] as Pick<Member, "id" | "role">[];

const routine = { id: "r1", active: true, owner_member: "shannon", time_of_day: "morning", sort_order: 0 } as Routine;
const step = (id: string, assigned_to: string | null = null) =>
  ({ id, routine_id: "r1", title: id, assigned_to, weekdays: null, modes: ["school"] }) as unknown as RoutineStep;
const chore = (id: string, next_due: string, assigned_to: string | null) =>
  ({ id, title: id, next_due, assigned_to, active: true, modes: ["school", "holiday", "weekend"] }) as unknown as Chore;
const tick = (kind: Completion["kind"], item_id: string, extra: Partial<Completion> = {}) =>
  ({ id: `c-${item_id}`, kind, item_id, for_date: today, done_at: `${today}T08:00:00Z`, done_by: null, done_for: null, pending: false, ...extra }) as Completion;
const todo = (id: string, extra: Partial<BoardTodo> = {}): BoardTodo => ({
  id,
  text: id,
  status: "open",
  due_date: null,
  assigned_to: null,
  completed_at: null,
  pending: false,
  via_board: false,
  done_for: null,
  confirmed_by: null,
  ...extra,
});

function columns(opts: { completions?: Completion[]; todos?: BoardTodo[]; chores?: Chore[] }) {
  return boardColumns({
    plan: { routines: [routine], steps: [step("Brush teeth"), step("Pack bag", "lennon")], chores: opts.chores ?? [], zones: [], zoneTasks: [], completions: opts.completions ?? [] },
    todos: opts.todos ?? [],
    members,
    today,
    mode: "school",
    zoneRotationStart: null,
  });
}

describe("board columns", () => {
  it("puts children first, then adults, then Anyone; empty columns are left out", () => {
    const cols = columns({ todos: [todo("Feed the fish")], chores: [chore("Bins out", today, "dewald")] });
    expect(cols.map((c) => c.memberId)).toEqual(["shannon", "lennon", "dewald", null]);
    // A step falls back to the routine owner.
    expect(cols[0].items.map((i) => i.title)).toEqual(["Brush teeth"]);
    expect(cols[1].items.map((i) => i.title)).toEqual(["Pack bag"]);
  });

  it("keeps ticked chores for the day and shows waiting ones as pending", () => {
    // Ticked today: next_due has moved to tomorrow, but it still shows.
    const cols = columns({
      chores: [chore("Make bed", "2026-11-17", "shannon"), chore("Old one", "2026-11-14", "lennon")],
      completions: [tick("chore", "Make bed", { pending: true, done_for: "shannon", via_board: true })],
    });
    const shannon = cols.find((c) => c.memberId === "shannon")!;
    expect(shannon.items.find((i) => i.title === "Make bed")).toMatchObject({ state: "pending", boardCanUndo: true });
    expect(shannon.doneCount).toBe(1);
    // A late chore sorts first and is marked late.
    const lennon = cols.find((c) => c.memberId === "lennon")!;
    expect(lennon.items[0]).toMatchObject({ title: "Old one", overdue: true });
  });

  it("moves an unassigned to-do to the column of whoever did it", () => {
    const cols = columns({ todos: [todo("Feed the fish", { status: "done", pending: true, via_board: true, done_for: "lennon" })] });
    expect(cols.find((c) => c.memberId === null)).toBeUndefined();
    expect(cols.find((c) => c.memberId === "lennon")!.items.find((i) => i.title === "Feed the fish")).toMatchObject({ state: "pending" });
  });

  it("hides to-dos due later", () => {
    const cols = columns({ todos: [todo("Dentist", { due_date: "2026-11-20" })] });
    expect(cols.find((c) => c.memberId === null)).toBeUndefined();
  });
});

describe("board taps", () => {
  it("ticks for the assignee, asks who for unassigned, and only undoes its own unconfirmed ticks", () => {
    expect(boardTapAction({ state: "open", assignee: "shannon", boardCanUndo: false })).toEqual({ type: "tick", memberId: "shannon" });
    expect(boardTapAction({ state: "open", assignee: null, boardCanUndo: false })).toEqual({ type: "ask_who" });
    expect(boardTapAction({ state: "pending", assignee: "shannon", boardCanUndo: true })).toEqual({ type: "undo" });
    expect(boardTapAction({ state: "done", assignee: "shannon", boardCanUndo: false })).toEqual({ type: "ask_grown_up" });
  });

  it("reads tick states", () => {
    expect(tickState(undefined)).toBe("open");
    expect(tickState({ pending: true })).toBe("pending");
    expect(tickState({ pending: false })).toBe("done");
    expect(tickState({ pending: false, status: "open" })).toBe("open");
  });
});
