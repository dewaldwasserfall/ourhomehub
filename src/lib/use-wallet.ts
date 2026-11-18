/**
 * The wallets of some children (wallet_entries), live.
 *
 * Small tables (a line per star or payment), so every line is loaded and
 * summed here; reloads (debounced) whenever a line is added or removed.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getSupabaseBrowserClient } from "./supabase/client";
import type { WalletEntry } from "./wallet";

export function useWallet(memberIds: string[]) {
  const supabase = getSupabaseBrowserClient();
  const [entries, setEntries] = useState<WalletEntry[]>([]);
  const key = memberIds.join(",");

  // Step 1: load every line for these children, newest first.
  const reload = useCallback(async () => {
    const ids = key ? key.split(",") : [];
    if (ids.length === 0) return setEntries([]);
    const { data, error } = await supabase
      .from("wallet_entries")
      .select("id, member_id, unit, amount, kind, plan_id, note, created_by, created_at")
      .in("member_id", ids)
      .order("created_at", { ascending: false })
      .limit(2000);
    if (!error) setEntries((data ?? []) as WalletEntry[]);
  }, [supabase, key]);

  // Step 2: live.
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    void reload();
    const channel = supabase
      .channel(`wallet-${key}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "wallet_entries" }, () => {
        clearTimeout(timer.current);
        timer.current = setTimeout(() => void reload(), 300);
      })
      .subscribe();
    return () => {
      clearTimeout(timer.current);
      void supabase.removeChannel(channel);
    };
  }, [supabase, key, reload]);

  return { entries, reload };
}
