/**
 * Supplies that run down with use: pure helpers for the Supplies screen and
 * the task sheets. The counting itself happens in the database (see
 * supabase/migrations/20261113001500_supplies.sql).
 */
import type { Chore, CompletionKind, Routine, RoutineStep, Supply, SupplyUse, Zone, ZoneTask } from "./types";

// -----------------------------------------------------------------------------
// Step 1: how full is it?
// -----------------------------------------------------------------------------

export interface SupplyLevel {
  /** 0..1 of one pack (more than one pack shows as full). */
  fraction: number;
  state: "ok" | "low" | "out";
  /** "12 of 40 uses left", "3 uses left", "Run out". */
  label: string;
}

export function supplyLevel(s: Pick<Supply, "uses_left" | "uses_per_pack" | "warn_at">): SupplyLevel {
  const fraction = Math.min(1, s.uses_left / Math.max(1, s.uses_per_pack));
  const state = s.uses_left === 0 ? "out" : s.uses_left <= s.warn_at ? "low" : "ok";
  const uses = (n: number) => `${n} ${n === 1 ? "use" : "uses"}`;
  const label =
    s.uses_left === 0
      ? "Run out"
      : s.uses_left <= s.uses_per_pack
        ? `${s.uses_left} of ${uses(s.uses_per_pack)} left`
        : `${uses(s.uses_left)} left`;
  return { fraction, state, label };
}

// -----------------------------------------------------------------------------
// Step 2: tasks that can use a supply, with readable names
// -----------------------------------------------------------------------------

export interface TaskOption {
  kind: CompletionKind;
  id: string;
  /** "Do the washing" */
  title: string;
  /** "Morning routine", "Kitchen zone", "Chore" */
  group: string;
}

/** Every step, zone task and chore, grouped for a picker. */
export function taskOptions(input: {
  routines: Routine[];
  steps: RoutineStep[];
  zones: Zone[];
  zoneTasks: ZoneTask[];
  chores: Chore[];
}): TaskOption[] {
  const routineName = new Map(input.routines.map((r) => [r.id, r.name]));
  const zoneName = new Map(input.zones.map((z) => [z.id, z.name]));
  return [
    ...input.chores.map((c) => ({ kind: "chore" as const, id: c.id, title: c.title, group: "Chores" })),
    ...input.steps.map((s) => ({ kind: "step" as const, id: s.id, title: s.title, group: routineName.get(s.routine_id) ?? "Routine" })),
    ...input.zoneTasks.map((t) => ({ kind: "zone_task" as const, id: t.id, title: t.title, group: `${zoneName.get(t.zone_id) ?? "Zone"} zone` })),
  ];
}

export const taskKey = (kind: CompletionKind, id: string) => `${kind}:${id}`;

/** Names of the supplies a task uses: ["Washing liquid", "Softener"]. */
export function suppliesForTask(
  kind: CompletionKind,
  taskId: string,
  uses: SupplyUse[],
  names: Map<string, string>, // supply id -> product name
): string[] {
  return uses
    .filter((u) => u.kind === kind && u.task_id === taskId)
    .map((u) => names.get(u.supply_id) ?? "")
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}
