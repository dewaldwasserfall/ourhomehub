/**
 * Reward plans for some children: the plans, their linked tasks, and each
 * plan's progress for the current day/week (from reward_progress()). Kept
 * live: refreshes when ticks, plans or given rewards change.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import type { RewardPlan, RewardPlanTask, RewardProgress } from "./rewards";
import { getSupabaseBrowserClient } from "./supabase/client";

export function useRewards(memberIds: string[], today: string) {
  const supabase = getSupabaseBrowserClient();
  const [plans, setPlans] = useState<RewardPlan[]>([]);
  const [tasks, setTasks] = useState<RewardPlanTask[]>([]);
  const [progress, setProgress] = useState<Record<string, RewardProgress>>({});
  const key = memberIds.join(",");

  // Step 1: plans (active), links and progress per child.
  const load = useCallback(async () => {
    if (!key) return;
    const ids = key.split(",");
    const [planRes, taskRes, ...progressRes] = await Promise.all([
      supabase.from("reward_plans").select("*").in("member_id", ids).eq("active", true).order("sort_order").order("created_at"),
      supabase.from("reward_plan_tasks").select("plan_id, kind, task_id"),
      ...ids.map((id) => supabase.rpc("reward_progress", { p_member_id: id, p_today: today })),
    ]);
    setPlans((planRes.data ?? []) as RewardPlan[]);
    setTasks((taskRes.data ?? []) as RewardPlanTask[]);
    const next: Record<string, RewardProgress> = {};
    for (const r of progressRes) for (const row of (r.data ?? []) as RewardProgress[]) next[row.plan_id] = row;
    setProgress(next);
  }, [supabase, key, today]);

  // Step 2: refresh (debounced) when anything that changes progress changes.
  useEffect(() => {
    load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(load, 400);
    };
    const channel = supabase
      .channel(`rewards:${key}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "completions" }, schedule)
      .on("postgres_changes", { event: "*", schema: "public", table: "list_entries" }, schedule)
      .on("postgres_changes", { event: "*", schema: "public", table: "reward_plans" }, schedule)
      .on("postgres_changes", { event: "*", schema: "public", table: "reward_periods" }, schedule)
      .subscribe();
    return () => {
      clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, [supabase, key, load]);

  /** A child's plans, in order. */
  const plansFor = (memberId: string) => plans.filter((p) => p.member_id === memberId);
  /** The plan to headline (Today, the board): the first one not given yet. */
  const headline = (memberId: string) => plansFor(memberId).find((p) => !progress[p.id]?.given) ?? plansFor(memberId)[0];
  const tasksFor = (planId: string) => tasks.filter((t) => t.plan_id === planId);

  return { plans, progress, plansFor, headline, tasksFor, reload: load };
}
