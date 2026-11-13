/**
 * Data hook for supplies: each tracked product with its name, and which tasks
 * use it. Reloads when the screen comes back into view and when a supply
 * changes (realtime), so counts follow ticks made on other phones.
 */
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { isNetworkError, readCache, writeCache } from "./offline";
import { getSupabaseBrowserClient } from "./supabase/client";
import type { Supply, SupplyUse } from "./types";

export type SupplyWithName = Supply & { item: { display_name: string; category: string } | null };

export function useSupplies(householdId: string) {
  const supabase = getSupabaseBrowserClient();
  const [supplies, setSupplies] = useState<SupplyWithName[]>([]);
  const [uses, setUses] = useState<SupplyUse[]>([]);
  const [loading, setLoading] = useState(true);

  // Step 1: load both tables (offline: the last copy).
  const reload = useCallback(async () => {
    const [s, u] = await Promise.all([
      supabase.from("supplies").select("*, item:items(display_name, category)").eq("household_id", householdId),
      supabase.from("supply_uses").select("*").eq("household_id", householdId),
    ]);
    if (s.error && isNetworkError(s.error)) {
      const cached = readCache<{ supplies: SupplyWithName[]; uses: SupplyUse[] }>(`supplies:${householdId}`);
      if (cached) {
        setSupplies(cached.supplies);
        setUses(cached.uses);
      }
      setLoading(false);
      return;
    }
    const next = {
      supplies: ((s.data ?? []) as SupplyWithName[]).sort((a, b) =>
        (a.item?.display_name ?? "").localeCompare(b.item?.display_name ?? ""),
      ),
      uses: (u.data ?? []) as SupplyUse[],
    };
    setSupplies(next.supplies);
    setUses(next.uses);
    writeCache(`supplies:${householdId}`, next);
    setLoading(false);
  }, [supabase, householdId]);

  // Step 2: keep it current.
  useEffect(() => {
    reload();
    const onVisible = () => document.visibilityState === "visible" && reload();
    document.addEventListener("visibilitychange", onVisible);
    const channel = supabase
      .channel(`supplies:${householdId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "supplies", filter: `household_id=eq.${householdId}` }, () => reload())
      .subscribe();
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      supabase.removeChannel(channel);
    };
  }, [supabase, householdId, reload]);

  /** supply id -> product name */
  const names = useMemo(() => new Map(supplies.map((s) => [s.id, s.item?.display_name ?? "Product"])), [supplies]);

  return { supplies, uses, names, loading, reload };
}
