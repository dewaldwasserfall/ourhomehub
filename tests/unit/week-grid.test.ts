/** The week grid: cells by day, totals, and what a parent can do with a day. */
import { describe, expect, it } from "vitest";
import { buildWeekGrid, dayActions, paidTickIds, weekStart, type GridTask } from "@/lib/week-grid";

const today = "2026-11-18"; // a Wednesday
const tasks: GridTask[] = [
  { kind: "chore", id: "gft", title: "GFT zakkie", everyDay: true, nextDue: today },
  { kind: "chore", id: "table", title: "Tafel dekken", everyDay: true, nextDue: today },
  { kind: "step", id: "bag", title: "Pack bag", weekdays: [1, 3] },
];
const tick = (id: string, item_id: string, for_date: string, extra: { pending?: boolean; done_for?: string } = {}) => ({
  id,
  kind: (item_id === "bag" ? "step" : "chore") as "step" | "chore",
  item_id,
  for_date,
  done_for: extra.done_for ?? "lennon",
  pending: extra.pending ?? false,
});

describe("buildWeekGrid", () => {
  const grid = buildWeekGrid({
    tasks,
    memberId: "lennon",
    days: [5, 1, 2, 3, 4],
    monday: weekStart(today),
    today,
    ticks: [
      tick("c1", "gft", "2026-11-16"),
      tick("c2", "table", "2026-11-16"),
      tick("c3", "gft", "2026-11-17"),
      tick("c4", "gft", today, { pending: true }),
      tick("c5", "table", "2026-11-17", { done_for: "dewald" }), // not his: doesn't count
    ],
    paidIds: new Set(["c1", "c2"]),
  });

  it("shows Monday to Friday of this week", () => {
    expect(grid.dates).toEqual(["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20"]);
  });

  it("marks paid, done, waiting, missed, today and future cells", () => {
    const states = (i: number) => grid.rows[i].cells.map((c) => c.state);
    expect(states(0)).toEqual(["paid", "done", "pending", "future", "future"]);
    expect(states(1)).toEqual(["paid", "missed", "empty", "future", "future"]);
    // Pack bag runs Mon and Wed only.
    expect(states(2)).toEqual(["missed", "na", "empty", "na", "na"]);
  });

  it("totals the stars per day", () => {
    expect(grid.totals.map((t) => t.stars)).toEqual([2, 1, 0, 0, 0]);
    expect(grid.totals[1].possible).toBe(2);
  });

  it("lists what a parent can confirm or pay out for a day", () => {
    expect(dayActions(grid, today)).toEqual({ waiting: ["c4"], payable: ["c4"] });
    expect(dayActions(grid, "2026-11-17")).toEqual({ waiting: [], payable: ["c3"] });
    expect(dayActions(grid, "2026-11-16").payable).toEqual([]); // already paid
  });
});

describe("helpers", () => {
  it("finds the week's Monday and the used tick ids", () => {
    expect(weekStart("2026-11-22")).toBe("2026-11-16");
    expect(weekStart("2026-11-16")).toBe("2026-11-16");
    expect([...paidTickIds([{ ticks: [{ id: "a" }, { saved: 2 }] }, { ticks: null }, { ticks: [{ id: "b" }] }])]).toEqual(["a", "b"]);
  });
});
