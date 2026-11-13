/**
 * Data hook for the grocery budget: the bunq connection row and this budget
 * month's payments, live, plus the summary from src/lib/budget.ts.
 *
 * RLS only returns anything to members who can see finances; for everyone
 * else `connection` stays null and nothing shows.
 */
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { budgetPeriod, byMerchant, summarise, type BudgetPayment } from "./budget";
import { dateKey } from "./calendar/time";
import { getSupabaseBrowserClient } from "./supabase/client";

export interface BunqConnection {
  household_id: string;
  account_id: number | null;
  account_label: string | null;
  balance_cents: number | null;
  budget_cents: number;
  period_start_day: number;
  status: "active" | "error";
  last_error: string | null;
  last_synced_at: string | null;
}

export function useBudget(householdId: string, timeZone: string, enabled: boolean) {
  const supabase = getSupabaseBrowserClient();
  const [connection, setConnection] = useState<BunqConnection | null>(null);
  const [payments, setPayments] = useState<BudgetPayment[]>([]);
  const [loading, setLoading] = useState(enabled);
  const today = dateKey(new Date(), timeZone);

  // Step 1: the connection, then this month's payments.
  const load = useCallback(async () => {
    if (!enabled) return;
    const { data: conn } = await supabase.from("bunq_connections").select("*").maybeSingle<BunqConnection>();
    setConnection(conn ?? null);
    if (conn) {
      const period = budgetPeriod(today, conn.period_start_day);
      // A day of margin either side; summarise() trims to household days.
      const from = new Date(`${period.start}T00:00:00Z`).getTime() - 86_400_000;
      const { data } = await supabase
        .from("bunq_payments")
        .select("id, created_at, amount_cents, counterparty, description, kind")
        .gte("created_at", new Date(from).toISOString())
        .order("created_at", { ascending: false });
      setPayments((data ?? []) as BudgetPayment[]);
    }
    setLoading(false);
  }, [supabase, today, enabled]);

  // Step 2: live updates when the server stores new payments.
  useEffect(() => {
    if (!enabled) return;
    load();
    const onVisible = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVisible);
    const timer = setInterval(load, 5 * 60_000);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(timer);
    };
  }, [load, enabled]);

  // Step 3: the numbers.
  const dayOf = useCallback((iso: string) => dateKey(new Date(iso), timeZone), [timeZone]);
  const summary = useMemo(
    () => (connection?.account_id ? summarise(payments, today, connection.period_start_day, connection.budget_cents, dayOf) : null),
    [connection, payments, today, dayOf],
  );
  const merchants = useMemo(() => (summary ? byMerchant(payments, summary.period, dayOf) : []), [payments, summary, dayOf]);
  const periodPayments = useMemo(
    () => (summary ? payments.filter((p) => dayOf(p.created_at) >= summary.period.start && dayOf(p.created_at) <= summary.period.end) : []),
    [payments, summary, dayOf],
  );

  return { connection, summary, merchants, periodPayments, loading, reload: load, today };
}
