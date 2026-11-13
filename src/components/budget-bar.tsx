/**
 * The budget at a glance: a bar filled to what's been spent, with a tick
 * where an even pace would be today. Shared by Today and the Budget screen.
 */
"use client";

import { euros, type BudgetSummary } from "@/lib/budget";

export function statusText(s: BudgetSummary): string {
  if (s.status === "on") return "On pace";
  return s.status === "under" ? `${euros(s.aheadCents)} under pace` : `${euros(-s.aheadCents)} over pace`;
}

export function BudgetBar({ summary }: { summary: BudgetSummary }) {
  const pct = (cents: number) => `${Math.min(100, Math.max(0, (cents / Math.max(summary.budgetCents, 1)) * 100))}%`;
  return (
    <div
      className={`budget-bar budget-bar--${summary.status}`}
      role="img"
      aria-label={`${euros(summary.spentCents)} of ${euros(summary.budgetCents)} spent. ${statusText(summary)}.`}
    >
      <span className="budget-bar__fill" style={{ width: pct(summary.spentCents) }} />
      <span className="budget-bar__pace" style={{ left: pct(summary.paceCents) }} />
    </div>
  );
}
