/**
 * Trip budget: pure helpers. Amounts are cents in their own currency;
 * totals are in the trip's home currency using the manual rates
 * (1 unit of currency = rate x home), like Voyage.
 *
 *   * toHome()          – one item's amount in the home currency (or null
 *                         when its rate is missing)
 *   * budgetSummary()   – total, paid, still to pay, vs the planned budget
 *   * missingRates()    – currencies used without a rate
 *   * byCategory()      – items grouped, categories in the standard order
 *   * money()           – "€1,234.50" / "£80.00"
 */
import { BUDGET_CATEGORIES, type BudgetCategory, type TripBudgetItem, type TripRate } from "./types";

export function rateMap(rates: TripRate[]): Map<string, number> {
  return new Map(rates.map((r) => [r.currency, Number(r.rate)]));
}

/** Cents in the home currency, or null when there's no rate for it. */
export function toHome(item: Pick<TripBudgetItem, "amount_cents" | "currency">, home: string, rates: Map<string, number>): number | null {
  if (item.currency === home) return item.amount_cents;
  const rate = rates.get(item.currency);
  return rate ? Math.round(item.amount_cents * rate) : null;
}

export function missingRates(items: TripBudgetItem[], home: string, rates: Map<string, number>): string[] {
  return [...new Set(items.map((i) => i.currency))].filter((c) => c !== home && !rates.has(c)).sort();
}

export interface BudgetSummary {
  totalCents: number;
  paidCents: number;
  unpaidCents: number;
  /** Planned budget minus total (negative = over). Null without a plan. */
  leftCents: number | null;
  /** Items left out of the totals because their rate is missing. */
  uncounted: number;
}

export function budgetSummary(items: TripBudgetItem[], home: string, rates: TripRate[], plannedCents: number | null): BudgetSummary {
  const map = rateMap(rates);
  let total = 0;
  let paid = 0;
  let uncounted = 0;
  for (const i of items) {
    const cents = toHome(i, home, map);
    if (cents === null) {
      uncounted += 1;
      continue;
    }
    total += cents;
    if (i.paid) paid += cents;
  }
  return { totalCents: total, paidCents: paid, unpaidCents: total - paid, leftCents: plannedCents === null ? null : plannedCents - total, uncounted };
}

export function byCategory(items: TripBudgetItem[]): Array<[BudgetCategory, TripBudgetItem[]]> {
  return BUDGET_CATEGORIES.map((c) => [c, items.filter((i) => i.category === c)] as [BudgetCategory, TripBudgetItem[]])
    .filter(([, list]) => list.length > 0)
    .map(([c, list]) => [c, [...list].sort((a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999") || a.created_at.localeCompare(b.created_at))]);
}

/** "€1,234.50" in any currency (falls back to "ABC 12.00" for unknown codes). */
export function money(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-IE", { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${currency} ${(cents / 100).toFixed(2)}`;
  }
}

/** "12,50" or "12.50" typed by a person -> cents, or null if it isn't money. */
export function parseAmount(text: string): number | null {
  const clean = text.trim().replace(/\s/g, "");
  if (!/^\d{1,9}([.,]\d{1,2})?$/.test(clean)) return null;
  return Math.round(Number(clean.replace(",", ".")) * 100);
}

/** Common currencies for the picker (Voyage's list). */
export const CURRENCIES = ["EUR", "USD", "GBP", "ZAR", "CHF", "JPY", "AUD", "CAD", "THB", "AED", "TRY", "SEK", "NOK", "DKK", "CZK", "PLN", "HUF", "MXN", "BRL", "SGD", "HKD", "NZD", "IDR", "INR"];
