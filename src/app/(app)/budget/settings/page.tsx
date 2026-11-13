/**
 * Budget settings (owner only): connect bunq, choose the groceries account,
 * set the monthly amount and start day, and choose who can see the budget.
 */
"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { Avatar } from "@/components/avatar";
import { useHousehold } from "@/components/household-context";
import { ChevronLeftIcon } from "@/components/icons";
import { Navbar } from "@/components/navbar";
import { useToast } from "@/components/toast";
import { euros } from "@/lib/budget";
import { calendarApi } from "@/lib/calendar/use-calendar";
import { friendlyError } from "@/lib/errors";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useBudget } from "@/lib/use-budget";

interface Account {
  id: number;
  label: string;
  iban: string | null;
  balanceCents: number;
}

const CONNECT_MESSAGES: Record<string, string> = {
  connected: "bunq is connected. Now choose the groceries account.",
  cancelled: "Connecting bunq was cancelled.",
  failed: "Couldn't connect bunq. Try again.",
  state_mismatch: "That connection link expired. Try again.",
  owner_only: "Only the owner can connect bunq.",
};

function Settings() {
  const supabase = getSupabaseBrowserClient();
  const params = useSearchParams();
  const { household, me, members } = useHousehold();
  const { connection, reload } = useBudget(household.id, household.timezone, me.role === "owner");
  const toast = useToast();

  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [budget, setBudget] = useState("");
  const [startDay, setStartDay] = useState(26);
  const [access, setAccess] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(members.map((m) => [m.id, m.role === "owner" || m.can_see_finances])),
  );
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  // Step 1: the result of connecting, shown once.
  useEffect(() => {
    const status = params.get("bunq");
    if (status && CONNECT_MESSAGES[status]) toast.show(CONNECT_MESSAGES[status]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  useEffect(() => {
    if (!connection) return;
    setBudget(String(connection.budget_cents / 100));
    setStartDay(connection.period_start_day);
  }, [connection]);

  // Step 2: the accounts to choose from (asks bunq).
  const loadAccounts = useCallback(async () => {
    const r = await calendarApi<{ accounts: Account[] }>("/api/bunq/accounts", "GET");
    if (r.ok && r.data) setAccounts(r.data.accounts);
    else toast.show(r.message ?? "Couldn't load your bunq accounts.");
  }, [toast]);
  useEffect(() => {
    if (connection) loadAccounts();
  }, [connection?.household_id, loadAccounts]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save(update: Record<string, unknown>, message = "Saved") {
    const r = await calendarApi("/api/bunq/settings", "POST", update);
    toast.show(r.ok ? message : (r.message ?? "Couldn't save."));
    await reload();
  }

  async function setFinanceAccess(memberId: string, allowed: boolean) {
    setAccess((a) => ({ ...a, [memberId]: allowed }));
    const { error } = await supabase.rpc("set_finance_access", { p_member_id: memberId, p_allowed: allowed });
    if (error) {
      setAccess((a) => ({ ...a, [memberId]: !allowed }));
      toast.show(friendlyError(error));
    }
  }

  async function disconnect() {
    if (!confirmDisconnect) return setConfirmDisconnect(true);
    const r = await calendarApi("/api/bunq/disconnect", "POST");
    toast.show(r.ok ? "bunq disconnected. Also remove HomeHub in the bunq app to revoke its access fully." : (r.message ?? "Couldn't disconnect."));
    setConfirmDisconnect(false);
    setAccounts(null);
    await reload();
  }

  if (me.role !== "owner") {
    return (
      <main className="screen">
        <Navbar title="Budget settings" />
        <div className="group empty">
          <span className="empty__title">Owner only</span>
          Only the household owner can change the budget settings.
        </div>
      </main>
    );
  }

  const adults = members.filter((m) => m.role !== "child");

  return (
    <main className="screen">
      <Navbar
        title="Budget settings"
        leading={
          <Link href="/budget" className="nav-button" aria-label="Back to Budget">
            <ChevronLeftIcon size={22} />
            Budget
          </Link>
        }
      />

      {/* Step 3: the bunq connection */}
      <section className="section">
        <div className="section__header">
          <span className="section__header-title">bunq</span>
        </div>
        {!connection ? (
          <>
            <a href="/api/bunq/connect" className="button button--primary">
              Connect bunq
            </a>
            <p className="section__footer">
              You&rsquo;ll approve HomeHub in the bunq app. HomeHub only reads the account you choose next; it never moves money.
            </p>
          </>
        ) : (
          <>
            <div className="group">
              {accounts === null && <div className="skeleton" />}
              {accounts?.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className="row row--pressable"
                  aria-pressed={connection.account_id === a.id}
                  onClick={() => save({ accountId: a.id, accountLabel: a.label }, `Using ${a.label} for groceries`)}
                >
                  <span className="row__body">
                    <span className="row__title">{a.label}</span>
                    <span className="row__subtitle">
                      {a.iban ? `…${a.iban.slice(-4)} · ` : ""}
                      {euros(a.balanceCents)}
                    </span>
                  </span>
                  {connection.account_id === a.id && <span className="row__trailing" style={{ color: "var(--accent)", fontWeight: 600 }}>Groceries</span>}
                </button>
              ))}
            </div>
            <p className="section__footer">Tap the groceries account. Only its payments are copied to HomeHub.</p>
          </>
        )}
      </section>

      {/* Step 4: the budget */}
      {connection && (
        <section className="section">
          <div className="section__header">
            <span className="section__header-title">Budget</span>
          </div>
          <div className="group">
            <label className="form-row">
              <span className="form-row__label">Per month (€)</span>
              <input
                type="number"
                inputMode="decimal"
                className="pill-input"
                style={{ width: 110, textAlign: "right" }}
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                onBlur={() => {
                  const cents = Math.round(parseFloat(budget) * 100);
                  if (Number.isFinite(cents) && cents !== connection.budget_cents) save({ budgetCents: cents });
                }}
              />
            </label>
            <label className="form-row">
              <span className="form-row__label">Month starts on day</span>
              <select
                className="pill-input"
                value={startDay}
                onChange={(e) => {
                  setStartDay(Number(e.target.value));
                  save({ periodStartDay: Number(e.target.value) });
                }}
              >
                {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="section__footer">The day you top up the account. The month runs until the day before.</p>
        </section>
      )}

      {/* Step 5: who can see it */}
      <section className="section">
        <div className="section__header">
          <span className="section__header-title">Who can see the budget</span>
        </div>
        <div className="group">
          {adults.map((m) => (
            <div key={m.id} className="row" style={{ ["--separator-inset" as string]: "70px" }}>
              <Avatar member={m} />
              <span className="row__body">
                <span className="row__title">{m.display_name}</span>
              </span>
              <button
                type="button"
                role="switch"
                className="switch"
                aria-label={`${m.display_name} can see the budget`}
                aria-checked={!!access[m.id]}
                disabled={m.id === me.id}
                onClick={() => setFinanceAccess(m.id, !access[m.id])}
              />
            </div>
          ))}
        </div>
        <p className="section__footer">Children never see the budget.</p>
      </section>

      {connection && (
        <section className="section">
          <button type="button" className="button button--danger" onClick={disconnect}>
            {confirmDisconnect ? "Tap again to disconnect bunq" : "Disconnect bunq"}
          </button>
        </section>
      )}
      {toast.node}
    </main>
  );
}

export default function BudgetSettingsPage() {
  // useSearchParams needs a Suspense boundary in the App Router.
  return (
    <Suspense>
      <Settings />
    </Suspense>
  );
}
