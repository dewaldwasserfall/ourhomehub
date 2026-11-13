/**
 * Grocery budget (only for members the owner gave access: Dewald and Anél).
 *
 *   * this budget month: spent of budget, on / under / over pace, projection,
 *     what's left per day
 *   * where it went: spending per shop and the latest payments (can be hidden
 *     on this device)
 */
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { BudgetBar, statusText } from "@/components/budget-bar";
import { useHousehold } from "@/components/household-context";
import { RefreshIcon } from "@/components/icons";
import { Navbar } from "@/components/navbar";
import { useToast } from "@/components/toast";
import { euros, merchantName } from "@/lib/budget";
import { calendarApi } from "@/lib/calendar/use-calendar";
import { describeDay } from "@/lib/plan";
import { canSeeFinances } from "@/lib/roles";
import { useBudget } from "@/lib/use-budget";

const SHOW_KEY = "hh-budget-show-where";
const dayMonth = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const short = (d: string) => dayMonth.format(new Date(`${d}T12:00:00Z`));

export default function BudgetPage() {
  const { household, me } = useHousehold();
  const allowed = canSeeFinances(me);
  const { connection, summary, merchants, periodPayments, loading, reload, today } = useBudget(household.id, household.timezone, allowed);
  const [syncing, setSyncing] = useState(false);
  const toast = useToast();

  // Step 1: "Where it went" can be hidden on this device (remembered here).
  const [showWhere, setShowWhere] = useState(true);
  useEffect(() => {
    try {
      setShowWhere(localStorage.getItem(SHOW_KEY) !== "0");
    } catch {
      // Storage unavailable: just show it.
    }
  }, []);
  const toggleWhere = () => {
    const next = !showWhere;
    setShowWhere(next);
    try {
      localStorage.setItem(SHOW_KEY, next ? "1" : "0");
    } catch {
      // Not remembered; fine.
    }
  };

  async function syncNow() {
    setSyncing(true);
    const r = await calendarApi("/api/bunq/sync", "POST");
    setSyncing(false);
    if (!r.ok) toast.show(r.message ?? "Couldn't update from bunq.");
    await reload();
  }

  const settingsLink =
    me.role === "owner" ? (
      <Link href="/budget/settings" className="nav-button">
        Settings
      </Link>
    ) : undefined;

  // Step 2: not for everyone.
  if (!allowed) {
    return (
      <main className="screen">
        <Navbar title="Budget" />
        <div className="group empty">
          <span className="empty__title">Not available</span>
          The grocery budget is only shown to the people the owner chose.
        </div>
      </main>
    );
  }

  return (
    <main className="screen">
      <Navbar
        title="Groceries budget"
        subtitle={summary ? `${short(summary.period.start)} – ${short(summary.period.end)}` : undefined}
        trailing={
          <>
            {connection?.account_id && (
              <button type="button" className="nav-button nav-button--icon" aria-label="Update from bunq" onClick={syncNow} disabled={syncing}>
                <RefreshIcon size={21} style={syncing ? { animation: "spin 0.8s linear infinite" } : undefined} />
              </button>
            )}
            {settingsLink}
          </>
        }
      />

      {/* Step 3: not set up yet */}
      {!loading && !connection?.account_id && (
        <section className="section">
          <div className="group empty">
            <span className="empty__title">{connection ? "Choose the groceries account" : "Connect bunq"}</span>
            {me.role === "owner"
              ? "Connect your bunq groceries account in Settings to see the budget here."
              : "Dewald needs to connect the bunq groceries account first."}
            {me.role === "owner" && (
              <div style={{ marginTop: 16 }}>
                <Link href="/budget/settings" className="button button--primary">
                  Open settings
                </Link>
              </div>
            )}
          </div>
        </section>
      )}

      {connection?.status === "error" && connection.last_error && (
        <section className="section">
          <div className="notice">{connection.last_error}</div>
        </section>
      )}

      {/* Step 4: this month */}
      {summary && (
        <>
          <section className="section">
            <div className="group budget-hero">
              <div className="budget-hero__numbers">
                <span className="budget-hero__spent">{euros(summary.spentCents)}</span>
                <span className="budget-hero__of">of {euros(summary.budgetCents)}</span>
              </div>
              <BudgetBar summary={summary} />
              <div className="budget-hero__meta">
                <span className={`budget-status budget-status--${summary.status}`}>{statusText(summary)}</span>
                <span>
                  Day {summary.period.day} of {summary.period.length}
                </span>
              </div>
            </div>
          </section>

          <section className="section">
            <div className="group">
              <div className="row">
                <span className="row__body">
                  <span className="row__title">Left to spend</span>
                </span>
                <span className="row__trailing budget-figure">{euros(Math.max(0, summary.remainingCents))}</span>
              </div>
              <div className="row">
                <span className="row__body">
                  <span className="row__title">Per day until {short(summary.period.end)}</span>
                </span>
                <span className="row__trailing budget-figure">{euros(summary.perDayLeftCents)}</span>
              </div>
              <div className="row">
                <span className="row__body">
                  <span className="row__title">At this rate, by the end</span>
                  <span className="row__subtitle">If spending carries on like this month so far</span>
                </span>
                <span className={`row__trailing budget-figure ${summary.projectedCents > summary.budgetCents ? "due--overdue" : ""}`}>
                  {euros(summary.projectedCents)}
                </span>
              </div>
              {connection?.balance_cents != null && (
                <div className="row">
                  <span className="row__body">
                    <span className="row__title">Balance on {connection.account_label ?? "the account"}</span>
                  </span>
                  <span className="row__trailing budget-figure">{euros(connection.balance_cents)}</span>
                </div>
              )}
            </div>
            {connection?.last_synced_at && (
              <p className="section__footer">Updated {new Date(connection.last_synced_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} · updates every hour</p>
            )}
          </section>

          {/* Step 5: where it went (can be hidden) */}
          <section className="section">
            <div className="section__header">
              <span className="section__header-title">Where it went</span>
              <button type="button" className="section__header-action" onClick={toggleWhere}>
                {showWhere ? "Hide" : "Show"}
              </button>
            </div>
            {showWhere && (
              <>
                <div className="group">
                  {merchants.length === 0 && (
                    <div className="row" style={{ color: "var(--ink-2)" }}>
                      <span className="row__body">No spending yet this month</span>
                    </div>
                  )}
                  {merchants.map((m) => (
                    <div key={m.name} className="row merchant-row">
                      <span className="row__body">
                        <span className="row__title">{m.name}</span>
                        <span className="merchant-bar" style={{ width: `${(m.cents / Math.max(summary.spentCents, 1)) * 100}%` }} />
                      </span>
                      <span className="row__trailing budget-figure">{euros(m.cents)}</span>
                    </div>
                  ))}
                </div>

                {periodPayments.length > 0 && (
                  <div className="group" style={{ marginTop: 12 }}>
                    {periodPayments.slice(0, 15).map((p) => (
                      <div key={p.id} className="row">
                        <span className="row__body">
                          <span className="row__title">{p.kind === "topup" ? "Top-up" : merchantName(p.counterparty)}</span>
                          <span className="row__subtitle">{describeDay(p.created_at.slice(0, 10), today)}</span>
                        </span>
                        <span className={`row__trailing budget-figure ${p.amount_cents > 0 ? "budget-in" : ""}`}>
                          {p.amount_cents > 0 ? "+" : "−"}
                          {euros(Math.abs(p.amount_cents))}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </section>
        </>
      )}
      {toast.node}
    </main>
  );
}
