/**
 * Unit tests for supply helpers: the level shown on the Supplies screen and
 * the task picker's names.
 */
import { describe, expect, it } from "vitest";
import { suppliesForTask, supplyLevel, taskOptions } from "@/lib/supplies";
import type { Chore, Routine, RoutineStep, SupplyUse, Zone, ZoneTask } from "@/lib/types";

describe("supply level", () => {
  it("shows uses left of a pack, low at the threshold and run out at zero", () => {
    expect(supplyLevel({ uses_left: 12, uses_per_pack: 40, warn_at: 5 })).toEqual({ fraction: 0.3, state: "ok", label: "12 of 40 uses left" });
    expect(supplyLevel({ uses_left: 5, uses_per_pack: 40, warn_at: 5 }).state).toBe("low");
    expect(supplyLevel({ uses_left: 1, uses_per_pack: 1, warn_at: 0 }).label).toBe("1 of 1 use left");
    expect(supplyLevel({ uses_left: 0, uses_per_pack: 40, warn_at: 5 })).toEqual({ fraction: 0, state: "out", label: "Run out" });
    // Two packs in stock: full bar, plain count.
    expect(supplyLevel({ uses_left: 70, uses_per_pack: 40, warn_at: 5 })).toEqual({ fraction: 1, state: "ok", label: "70 uses left" });
  });
});

describe("task picker", () => {
  it("names tasks by their routine, zone or as a chore", () => {
    const options = taskOptions({
      routines: [{ id: "r1", name: "Evening" }] as Routine[],
      steps: [{ id: "s1", routine_id: "r1", title: "Start the dishwasher" }] as RoutineStep[],
      zones: [{ id: "z1", name: "Kitchen" }] as Zone[],
      zoneTasks: [{ id: "t1", zone_id: "z1", title: "Clean the oven" }] as ZoneTask[],
      chores: [{ id: "c1", title: "Do the washing" }] as Chore[],
    });
    expect(options).toEqual([
      { kind: "chore", id: "c1", title: "Do the washing", group: "Chores" },
      { kind: "step", id: "s1", title: "Start the dishwasher", group: "Evening" },
      { kind: "zone_task", id: "t1", title: "Clean the oven", group: "Kitchen zone" },
    ]);
  });

  it("lists what a task uses, sorted", () => {
    const uses = [
      { supply_id: "a", kind: "chore", task_id: "c1" },
      { supply_id: "b", kind: "chore", task_id: "c1" },
      { supply_id: "a", kind: "step", task_id: "c1" },
    ] as SupplyUse[];
    const names = new Map([
      ["a", "Washing liquid"],
      ["b", "Softener"],
    ]);
    expect(suppliesForTask("chore", "c1", uses, names)).toEqual(["Softener", "Washing liquid"]);
  });
});
