/**
 * The dishwasher's last known state for this household (or null when it
 * isn't connected), kept live. Readable by everyone in the household and
 * by the Family board.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "./supabase/client";

export interface ApplianceRow {
  appliance_name: string | null;
  state: string | null;
  cycle_phase: string | null;
  door_state: string | null;
  online: boolean | null;
  ends_at: string | null;
  last_polled_at: string | null;
  last_run_ended_at: string | null;
  auto_task: boolean;
  status: "active" | "error";
  last_error: string | null;
}

const COLUMNS = "appliance_name, state, cycle_phase, door_state, online, ends_at, last_polled_at, last_run_ended_at, auto_task, status, last_error";

export function useAppliance(householdId: string) {
  const supabase = getSupabaseBrowserClient();
  const [appliance, setAppliance] = useState<ApplianceRow | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    const { data } = await supabase.from("appliance_connections").select(COLUMNS).maybeSingle<ApplianceRow>();
    setAppliance(data ?? null);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    reload();
    const channel = supabase
      .channel(`appliance:${householdId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "appliance_connections", filter: `household_id=eq.${householdId}` }, () => reload())
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase, householdId, reload]);

  return { appliance, loading, reload };
}
