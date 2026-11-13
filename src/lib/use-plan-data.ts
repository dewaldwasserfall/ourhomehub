/**
 * Data hook for Today and the planning screens (routines, zones, chores,
 * school holidays).
 *
 * The plan is small (tens of rows), so everything is loaded in one go and
 * kept live: any change on another phone (a tick, a new step) triggers a
 * debounced reload. RLS limits every query to the signed-in household.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getSupabaseBrowserClient } from "./supabase/client";
import type { Chore, Completion, DayOverride, Routine, RoutineStep, Zone, ZoneTask } from "./types";

export interface PlanData {
  routines: Routine[];
  steps: RoutineStep[];
  zones: Zone[];
  zoneTasks: ZoneTask[];
  chores: Chore[];
  overrides: DayOverride[];
  /** Ticks from `completionsFrom` onwards (enough for today and this fortnight). */
  completions: Completion[];
}

const EMPTY: PlanData = { routines: [], steps: [], zones: [], zoneTasks: [], chores: [], overrides: [], completions: [] };

/** Tables whose changes should refresh the screen. */
const LIVE_TABLES = ["routines", "routine_steps", "zones", "zone_tasks", "chores", "completions", "day_overrides"];

export function usePlanData(householdId: string, completionsFrom: string) {
  const supabase = getSupabaseBrowserClient();
  const [data, setData] = useState<PlanData>(EMPTY);
  const [loading, setLoading] = useState(true);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Step 1: load every plan table in parallel.
  const load = useCallback(async () => {
    const [routines, steps, zones, zoneTasks, chores, overrides, completions] = await Promise.all([
      supabase.from("routines").select("*").order("sort_order").order("created_at"),
      supabase.from("routine_steps").select("*").order("sort_order").order("created_at"),
      supabase.from("zones").select("*").order("sort_order").order("created_at"),
      supabase.from("zone_tasks").select("*").order("sort_order").order("created_at"),
      supabase.from("chores").select("*").order("next_due").order("created_at"),
      supabase.from("day_overrides").select("*").order("start_date"),
      supabase.from("completions").select("*").gte("for_date", completionsFrom),
    ]);
    setData({
      routines: (routines.data ?? []) as Routine[],
      steps: (steps.data ?? []) as RoutineStep[],
      zones: (zones.data ?? []) as Zone[],
      zoneTasks: (zoneTasks.data ?? []) as ZoneTask[],
      chores: (chores.data ?? []) as Chore[],
      overrides: (overrides.data ?? []) as DayOverride[],
      completions: (completions.data ?? []) as Completion[],
    });
    setLoading(false);
  }, [supabase, completionsFrom]);

  // Step 2: first load, live changes from other phones, and a catch-up when
  //         the app comes back to the foreground.
  useEffect(() => {
    load();
    const schedule = () => {
      clearTimeout(reloadTimer.current);
      reloadTimer.current = setTimeout(load, 250);
    };
    let channel = supabase.channel(`plan:${householdId}`);
    for (const table of LIVE_TABLES) {
      channel = channel.on("postgres_changes", { event: "*", schema: "public", table, filter: `household_id=eq.${householdId}` }, schedule);
      // Deletes carry only the primary key, so they can't match the filter.
      channel = channel.on("postgres_changes", { event: "DELETE", schema: "public", table }, schedule);
    }
    channel.subscribe();
    const onVisible = () => document.visibilityState === "visible" && schedule();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(reloadTimer.current);
      document.removeEventListener("visibilitychange", onVisible);
      supabase.removeChannel(channel);
    };
  }, [supabase, householdId, load]);

  return { ...data, loading, reload: load, setData };
}

/**
 * Save a new order after a drag: sort_order = position. Only rows whose
 * position changed are written.
 */
export async function saveOrder(table: string, ids: string[], previous: string[]) {
  const supabase = getSupabaseBrowserClient();
  const writes = ids
    .map((id, index) => ({ id, index }))
    .filter(({ id, index }) => previous[index] !== id)
    .map(({ id, index }) => supabase.from(table).update({ sort_order: index }).eq("id", id));
  const results = await Promise.all(writes);
  return results.find((r) => r.error)?.error ?? null;
}
