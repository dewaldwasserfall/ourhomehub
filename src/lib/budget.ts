/**
 * Grocery budget arithmetic, as pure functions (dates are "YYYY-MM-DD"
 * household days; money is whole cents).
 *
 * The budget month runs from the top-up day (the 26th) to the day before the
 * next one. "On pace" compares what was spent with how far through the month
 * we are: by day 10 of 31, about 10/31 of the budget may be gone.
 */
import { addDays, daysBetweenKeys } from "./calendar/time";

export interface BudgetPayment {
  id: number;
  created_at: string; // ISO instant
  amount_cents: number;
  counterparty: string | null;
  description: string | null;
  kind: "spend" | "refund" | "topup";
}

// -----------------------------------------------------------------------------
// Step 1: the budget month
// -----------------------------------------------------------------------------

export interface BudgetPeriod {
  start: string;
  end: string; // inclusive
  /** 1-based day number of `today` in the period. */
  day: number;
  length: number;
}

/** The budget month containing `today`, starting on `startDay` (1..28). */
export function budgetPeriod(today: string, startDay: number): BudgetPeriod {
  const [y, m, d] = today.split("-").map(Number);
  // Start: this month's start day if we've reached it, else last month's.
  const startMonth = d >= startDay ? new Date(Date.UTC(y, m - 1, startDay)) : new Date(Date.UTC(y, m - 2, startDay));
  const start = startMonth.toISOString().slice(0, 10);
  const nextStart = new Date(Date.UTC(startMonth.getUTCFullYear(), startMonth.getUTCMonth() + 1, startDay)).toISOString().slice(0, 10);
  const end = addDays(nextStart, -1);
  return { start, end, day: daysBetweenKeys(start, today) + 1, length: daysBetweenKeys(start, nextStart) };
}

// -----------------------------------------------------------------------------
// Step 2: classifying a payment
// -----------------------------------------------------------------------------

/**
 * Money out is spending. Money in is either a refund from a shop or a top-up.
 * Top-ups come from your own accounts, so they're recognised by the sender's
 * name matching the account holder, or by being large (half the budget or
 * more), since no shop refunds that much in one go.
 */
export function classifyPayment(
  amountCents: number,
  counterpartyName: string | null,
  holderNames: string[],
  budgetCents: number,
): BudgetPayment["kind"] {
  if (amountCents < 0) return "spend";
  const name = (counterpartyName ?? "").toLowerCase();
  const fromHolder = holderNames.some((h) => h && name.includes(h.toLowerCase()));
  return fromHolder || amountCents >= budgetCents / 2 ? "topup" : "refund";
}

// -----------------------------------------------------------------------------
// Step 3: the month's figures
// -----------------------------------------------------------------------------

export interface BudgetSummary {
  period: BudgetPeriod;
  budgetCents: number;
  /** Spending minus refunds in this period. */
  spentCents: number;
  remainingCents: number;
  /** What could have been spent by today at an even pace. */
  paceCents: number;
  /** Positive = under pace (good), negative = over pace. */
  aheadCents: number;
  status: "under" | "on" | "over";
  /** Spending by the end of the period at the current daily rate. */
  projectedCents: number;
  /** What can still be spent per remaining day (today included). */
  perDayLeftCents: number;
}

/** Within EUR 10 of the pace counts as "on pace". */
const ON_PACE_MARGIN_CENTS = 1000;

export function summarise(payments: BudgetPayment[], today: string, startDay: number, budgetCents: number, timeZoneDay: (iso: string) => string): BudgetSummary {
  const period = budgetPeriod(today, startDay);

  // Step 3a: spending in this period, net of refunds (top-ups don't count).
  let spentCents = 0;
  for (const p of payments) {
    const day = timeZoneDay(p.created_at);
    if (day < period.start || day > period.end || p.kind === "topup") continue;
    spentCents -= p.amount_cents; // spend is negative, refunds positive
  }
  spentCents = Math.max(0, spentCents);

  // Step 3b: pace and projection.
  const paceCents = Math.round((budgetCents * period.day) / period.length);
  const aheadCents = paceCents - spentCents;
  const status = Math.abs(aheadCents) <= ON_PACE_MARGIN_CENTS ? "on" : aheadCents > 0 ? "under" : "over";
  const projectedCents = Math.round((spentCents / period.day) * period.length);
  const daysLeft = period.length - period.day + 1;
  const remainingCents = budgetCents - spentCents;

  return {
    period,
    budgetCents,
    spentCents,
    remainingCents,
    paceCents,
    aheadCents,
    status,
    projectedCents,
    perDayLeftCents: Math.max(0, Math.floor(remainingCents / daysLeft)),
  };
}

// -----------------------------------------------------------------------------
// Step 4: where it went
// -----------------------------------------------------------------------------

/**
 * A tidy shop name: card payments read like "ALBERT HEIJN 1234 BREDA NLD", so
 * cut at the first number and title-case the words.
 */
export function merchantName(counterparty: string | null): string {
  const raw = (counterparty ?? "").trim();
  if (!raw) return "Other";
  const cut = raw.split(/\s\d|\s\*|,/)[0].trim() || raw;
  return cut
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (w.length <= 2 && w !== "ah" ? w : w[0].toUpperCase() + w.slice(1)))
    .join(" ")
    .replace(/^Ah\b/i, "AH");
}

/** Spending per shop this period, biggest first (refunds reduce a shop's total). */
export function byMerchant(payments: BudgetPayment[], period: BudgetPeriod, timeZoneDay: (iso: string) => string) {
  const totals = new Map<string, { name: string; cents: number; count: number }>();
  for (const p of payments) {
    const day = timeZoneDay(p.created_at);
    if (day < period.start || day > period.end || p.kind === "topup") continue;
    const name = merchantName(p.counterparty);
    const entry = totals.get(name) ?? { name, cents: 0, count: 0 };
    entry.cents -= p.amount_cents;
    if (p.kind === "spend") entry.count++;
    totals.set(name, entry);
  }
  return [...totals.values()].filter((t) => t.cents > 0).sort((a, b) => b.cents - a.cents);
}

/** "€1,000" or "€12.34" (whole euros drop the cents). */
export function euros(cents: number): string {
  const whole = cents % 100 === 0;
  return new Intl.NumberFormat("en-IE", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(cents / 100);
}
