/**
 * Stars, streaks and rewards for children (see the stars migration for the
 * rules). Stars are counted by the database from what each child ticked off,
 * so this hook only asks for the totals and lists the rewards.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "./supabase/client";

export interface StarStats {
  earned: number;
  spent: number;
  balance: number;
  streak: number;
}

export interface Reward {
  id: string;
  household_id: string;
  member_id: string;
  title: string;
  stars_needed: number;
  given_at: string | null;
  created_at: string;
}

export function useStars(memberIds: string[], today: string) {
  const supabase = getSupabaseBrowserClient();
  const [stats, setStats] = useState<Record<string, StarStats>>({});
  const [rewards, setRewards] = useState<Reward[]>([]);
  const key = memberIds.join(",");

  // Step 1: totals per child (one small RPC each) and every reward.
  const load = useCallback(async () => {
    if (!key) return;
    const ids = key.split(",");
    const [results, rewardRes] = await Promise.all([
      Promise.all(ids.map((id) => supabase.rpc("member_stars", { p_member_id: id, p_today: today }))),
      supabase.from("rewards").select("*").in("member_id", ids).order("stars_needed"),
    ]);
    const next: Record<string, StarStats> = {};
    results.forEach((r, i) => {
      const row = ((r.data ?? []) as StarStats[])[0];
      if (row) next[ids[i]] = row;
    });
    setStats(next);
    setRewards((rewardRes.data ?? []) as Reward[]);
  }, [supabase, key, today]);

  // Step 2: refresh when ticks or rewards change anywhere.
  useEffect(() => {
    load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(load, 400);
    };
    const channel = supabase
      .channel(`stars:${key}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "completions" }, schedule)
      .on("postgres_changes", { event: "*", schema: "public", table: "list_entries" }, schedule)
      .on("postgres_changes", { event: "*", schema: "public", table: "rewards" }, schedule)
      .subscribe();
    return () => {
      clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, [supabase, key, load]);

  /** The cheapest reward not given yet: what they're saving for. */
  const nextReward = (memberId: string) => rewards.find((r) => r.member_id === memberId && !r.given_at);

  return { stats, rewards, nextReward, reload: load };
}
