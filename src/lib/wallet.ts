/**
 * A child's wallet: minutes of game time and euros, earned from rewards and
 * used or paid out by adults (wallet_entries; see 20261118000200_wallets.sql).
 *
 * The balance is the sum of the lines, so every number can be explained.
 * This file: the types, balances, how amounts read ("35 min", "€0.80"),
 * what each line says in the history, and the week's summary.
 */
import { euros } from "./budget";
import type { RewardPlan } from "./rewards";

export type WalletUnit = "minutes" | "euros";
export type WalletKind = "earned_star" | "earned_goal" | "used" | "paid" | "adjust";

export interface WalletEntry {
  id: string;
  member_id: string;
  unit: WalletUnit;
  /** Signed: + earned, − used / paid. Numeric comes back as text from the API. */
  amount: number | string;
  kind: WalletKind;
  plan_id: string | null;
  note: string | null;
  created_by: string | null;
  created_at: string;
}

/** The unit a reward pays in (one-offs have none). */
export function unitOf(type: RewardPlan["reward_type"]): WalletUnit | null {
  return type === "time" ? "minutes" : type === "cash" ? "euros" : null;
}

/** Step 1: one child's balances. */
export function balances(entries: Pick<WalletEntry, "member_id" | "unit" | "amount">[], memberId: string): Record<WalletUnit, number> {
  const out: Record<WalletUnit, number> = { minutes: 0, euros: 0 };
  for (const e of entries) if (e.member_id === memberId) out[e.unit] += Number(e.amount);
  // Sums of 2-decimal numbers: round away floating-point dust.
  return { minutes: Math.round(out.minutes * 100) / 100, euros: Math.round(out.euros * 100) / 100 };
}

/** Step 2: "35 min", "1 h 5 min", "€0.80". `signed` adds + / −. */
export function formatAmount(unit: WalletUnit, amount: number, signed = false): string {
  const sign = signed ? (amount > 0 ? "+" : amount < 0 ? "−" : "") : amount < 0 ? "−" : "";
  const n = Math.abs(amount);
  if (unit === "euros") return `${sign}${euros(Math.round(n * 100))}`;
  const mins = Math.round(n);
  const text = mins >= 60 ? `${Math.floor(mins / 60)} h${mins % 60 ? ` ${mins % 60} min` : ""}` : `${mins} min`;
  return `${sign}${text}`;
}

/** "5 min per star", "€2 when reached", "" for one-offs. */
export function valueText(plan: Pick<RewardPlan, "reward_type" | "value_amount" | "value_per">): string {
  const unit = unitOf(plan.reward_type);
  if (!unit || !plan.value_amount) return "";
  return `${formatAmount(unit, Number(plan.value_amount))} ${plan.value_per === "goal" ? "when reached" : "per star"}`;
}

/** Step 3: what a history line says. */
export function describeEntry(entry: Pick<WalletEntry, "kind" | "note" | "plan_id">, planTitle: (id: string | null) => string | undefined): string {
  switch (entry.kind) {
    case "earned_star":
      return `★ Star · ${planTitle(entry.plan_id) ?? "a reward"}`;
    case "earned_goal":
      return `Reward reached · ${planTitle(entry.plan_id) ?? "a reward"}`;
    case "used":
      return entry.note ? `Used · ${entry.note}` : "Used";
    case "paid":
      return entry.note ? `Paid out · ${entry.note}` : "Paid out";
    default:
      return entry.note ? `Adjusted · ${entry.note}` : "Adjusted";
  }
}

/** Step 4: this week (since `since`, an ISO instant): earned, spent, and the balance now. */
export function weekSummary(
  entries: Pick<WalletEntry, "member_id" | "unit" | "amount" | "created_at">[],
  memberId: string,
  unit: WalletUnit,
  since: string,
): { earned: number; spent: number; balance: number } {
  let earned = 0;
  let spent = 0;
  const from = Date.parse(since);
  for (const e of entries) {
    if (e.member_id !== memberId || e.unit !== unit || Date.parse(e.created_at) < from) continue;
    const n = Number(e.amount);
    if (n > 0) earned += n;
    else spent -= n;
  }
  return { earned: Math.round(earned * 100) / 100, spent: Math.round(spent * 100) / 100, balance: balances(entries, memberId)[unit] };
}
