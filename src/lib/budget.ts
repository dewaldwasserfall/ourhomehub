/**
 * Grocery budget arithmetic, as pure functions (dates are "YYYY-MM-DD"
 * household days; money is whole cents).
 *
 * The budget month runs from the 26th to the 25th. There's no fixed amount:
 * what's left is the account's live balance, and when it's empty the budget
 * is finished. What the month "started with" is worked out backwards as
 * balance + this month's spending (net of refunds), which includes the
 * monthly top-up and anything left over from last month.
 *
 * "On pace" compares what was spent with how far through the month we are:
 * by day 10 of 31, about 10/31 of the month's money may be gone.
 */
import { addDays, daysBetweenKeys } from "./calendar/time";

export interface BudgetPayment {
  id: number;
  created_at: string; // ISO instant
  amount_cents: number;
  counterparty: string | null;
  description: string | null;
  /**
   * spend / refund / topup as before; passthrough: money that only passes
   * through the account (a toeslag paid in and moved straight on to
   * savings). Passed-on money counts as neither income nor spending.
   */
  kind: "spend" | "refund" | "topup" | "passthrough";
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
 * A short key to recognise the same shop on payments in and out: the first
 * word, letters and digits only ("PICNIC BY BUCKAROO" and "Picnic BV" are
 * both "picnic").
 */
export function shopKey(counterpartyName: string | null): string {
  const first = (counterpartyName ?? "").trim().split(/\s+/)[0] ?? "";
  return first.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Money out is spending. Money in is a refund only when it comes from
 * somewhere the account has paid (Picnic refunding a missing item);
 * everything else coming in (the monthly top-up from either of you, a
 * Belastingdienst payment, interest) is money added. The difference matters:
 * a refund lowers this month's spending, money added doesn't.
 *
 * `paidTo` holds shopKey() of every counterparty the account has paid.
 */
export function classifyPayment(amountCents: number, counterpartyName: string | null, paidTo: Set<string>): BudgetPayment["kind"] {
  if (amountCents < 0) return "spend";
  const key = shopKey(counterpartyName);
  return key && paidTo.has(key) ? "refund" : "topup";
}

/**
 * Step 2b: money passed straight through (bunq_connections.passthrough_from
 * / passthrough_to: names, as typed; compared by shopKey()).
 *
 *   * Money in from a "from" payer (e.g. Belastingdienst) is passed through.
 *   * Money out to a "to" account (e.g. Dewald, Anél: moving it to savings)
 *     is passed through only when it's covered by such money in from the
 *     last 7 days: the money in forms a pot, and each transfer out takes
 *     from it (oldest first). So one toeslag moved on in one go matches,
 *     and so does a large back-payment split between two accounts. A small
 *     difference is allowed (€5, or 1% of the transfer). Any other transfer
 *     to those accounts stays spending (it might be a reimbursement for
 *     groceries).
 *
 * Returns the ids of the payments that are passed through.
 */
export const PASSTHROUGH_DAYS = 7;
export const PASSTHROUGH_TOLERANCE_CENTS = 500;

export function passThroughIds(
  payments: Array<{ id: number; created_at: string; amount_cents: number; counterparty: string | null }>,
  from: string[],
  to: string[],
): Set<number> {
  const ids = new Set<number>();
  const fromKeys = new Set(from.map((n) => shopKey(n)).filter(Boolean));
  const toKeys = new Set(to.map((n) => shopKey(n)).filter(Boolean));
  if (fromKeys.size === 0) return ids;
  const sorted = [...payments].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));

  // The pot: money in from a pass-through payer, still to be moved on.
  const pot: Array<{ at: number; cents: number }> = [];
  for (const p of sorted) {
    const key = shopKey(p.counterparty);
    const at = Date.parse(p.created_at);

    // 2b-1. Money in from a pass-through payer: passed through; into the pot.
    if (p.amount_cents > 0 && fromKeys.has(key)) {
      ids.add(p.id);
      pot.push({ at, cents: p.amount_cents });
      continue;
    }

    // 2b-2. Money out to a pass-through account: passed through when the
    //       pot from the last 7 days covers it (within the tolerance).
    if (p.amount_cents < 0 && toKeys.has(key)) {
      const fresh = pot.filter((x) => at >= x.at && at - x.at <= PASSTHROUGH_DAYS * 86_400_000 && x.cents > 0);
      const available = fresh.reduce((sum, x) => sum + x.cents, 0);
      const out = -p.amount_cents;
      const tolerance = Math.max(PASSTHROUGH_TOLERANCE_CENTS, Math.round(out * 0.01));
      if (available > 0 && out <= available + tolerance) {
        ids.add(p.id);
        // Take it from the oldest money in first.
        let left = out;
        for (const x of fresh) {
          const take = Math.min(x.cents, left);
          x.cents -= take;
          left -= take;
          if (left <= 0) break;
        }
        // Anything within the tolerance empties what's left.
        if (left > 0) for (const x of fresh) x.cents = 0;
      }
    }
  }
  return ids;
}

// -----------------------------------------------------------------------------
// Step 3: the month's figures
// -----------------------------------------------------------------------------

export interface BudgetSummary {
  period: BudgetPeriod;
  /** What the month had to spend: balance + spent so far. */
  budgetCents: number;
  /** Spending minus refunds in this period. */
  spentCents: number;
  /** The account balance: what's left. */
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

export function summarise(
  payments: BudgetPayment[],
  today: string,
  startDay: number,
  balanceCents: number,
  timeZoneDay: (iso: string) => string,
): BudgetSummary {
  const period = budgetPeriod(today, startDay);

  // Step 3a: spending in this period, net of refunds (top-ups and money
  //          passed straight through don't count).
  let spentCents = 0;
  for (const p of payments) {
    const day = timeZoneDay(p.created_at);
    if (day < period.start || day > period.end || p.kind === "topup" || p.kind === "passthrough") continue;
    spentCents -= p.amount_cents; // spend is negative, refunds positive
  }
  spentCents = Math.max(0, spentCents);

  // Step 3b: what's left is the balance; the month had that plus what's gone.
  const remainingCents = Math.max(0, balanceCents);
  const budgetCents = remainingCents + spentCents;

  // Step 3c: pace and projection.
  const paceCents = Math.round((budgetCents * period.day) / period.length);
  const aheadCents = paceCents - spentCents;
  const status = Math.abs(aheadCents) <= ON_PACE_MARGIN_CENTS ? "on" : aheadCents > 0 ? "under" : "over";
  const projectedCents = Math.round((spentCents / period.day) * period.length);
  const daysLeft = period.length - period.day + 1;

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

/** Legal-form endings that make one shop look like two ("Picnic B.V." vs "Picnic"). */
const LEGAL_SUFFIX = /\s+(b\.?\s?v\.?|n\.?\s?v\.?|v\.?o\.?f\.?|gmbh|ltd\.?|inc\.?)$/i;

/**
 * A tidy shop name: card payments read like "ALBERT HEIJN 1234 BREDA NLD", so
 * cut at the first number, drop a legal-form ending (B.V., N.V., GmbH, ...)
 * and title-case the words.
 */
export function merchantName(counterparty: string | null): string {
  const raw = (counterparty ?? "").trim();
  if (!raw) return "Other";
  const cut = raw.split(/\s\d|\s\*|,/)[0].trim() || raw;
  const plain = cut.replace(LEGAL_SUFFIX, "").trim() || cut;
  return plain
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
    if (day < period.start || day > period.end || p.kind === "topup" || p.kind === "passthrough") continue;
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
