/**
 * Unit tests for the grocery budget: the budget month (26th to 25th), payment
 * classification, pace, projection and spending per shop.
 */
import { describe, expect, it } from "vitest";
import { budgetPeriod, byMerchant, classifyPayment, euros, merchantName, passThroughIds, shopKey, summarise, type BudgetPayment } from "@/lib/budget";

const dayOf = (iso: string) => iso.slice(0, 10);
const pay = (id: number, date: string, cents: number, who: string, kind: BudgetPayment["kind"]): BudgetPayment => ({
  id,
  created_at: `${date}T10:00:00Z`,
  amount_cents: cents,
  counterparty: who,
  description: null,
  kind,
});

describe("budget month", () => {
  it("runs from the 26th to the 25th", () => {
    expect(budgetPeriod("2026-11-13", 26)).toEqual({ start: "2026-10-26", end: "2026-11-25", day: 19, length: 31 });
    expect(budgetPeriod("2026-11-26", 26)).toEqual({ start: "2026-11-26", end: "2026-12-25", day: 1, length: 30 });
    expect(budgetPeriod("2027-01-05", 26)).toMatchObject({ start: "2026-12-26", end: "2027-01-25" });
    expect(budgetPeriod("2027-02-26", 26)).toMatchObject({ start: "2027-02-26", end: "2027-03-25", length: 28 });
  });
});

describe("classifying payments", () => {
  it("separates spending, refunds and top-ups", () => {
    const paidTo = new Set(["albert", "picnic", "dewald"]);
    expect(classifyPayment(-4512, "ALBERT HEIJN 1234", paidTo)).toBe("spend");
    // From a shop the account pays: a refund, however it's spelled.
    expect(classifyPayment(2190, "PICNIC BY BUCKAROO", paidTo)).toBe("refund");
    // Anyone else: money added (top-ups, Belastingdienst, a big transfer).
    expect(classifyPayment(10000, "D.M. Wasserfall", paidTo)).toBe("topup");
    expect(classifyPayment(90000, "A WASSERFALL", paidTo)).toBe("topup");
    expect(classifyPayment(9800, "Belastingdienst", paidTo)).toBe("topup");
    expect(shopKey("Picnic BV")).toBe("picnic");
    expect(shopKey(null)).toBe("");
  });
});

describe("the month's figures", () => {
  const payments = [
    pay(1, "2026-10-26", 100000, "D Wasserfall", "topup"),
    pay(2, "2026-10-28", -12000, "ALBERT HEIJN 1234 BREDA", "spend"),
    pay(3, "2026-11-05", -30000, "Picnic", "spend"),
    pay(4, "2026-11-06", 1500, "ALBERT HEIJN 1234 BREDA", "refund"),
    pay(5, "2026-11-10", -18500, "JUMBO BREDA", "spend"),
    pay(6, "2026-10-20", -50000, "Old month", "spend"), // previous period
  ];

  it("works out spent, pace, projection and what's left per day", () => {
    // EUR 410 still in the account.
    const s = summarise(payments, "2026-11-13", 26, 41000, dayOf);
    expect(s.spentCents).toBe(59000); // 120 + 300 - 15 + 185
    expect(s.remainingCents).toBe(41000); // the balance
    expect(s.budgetCents).toBe(100000); // balance + spent
    expect(s.paceCents).toBe(61290); // 1000 * 19/31
    expect(s.status).toBe("under"); // 22.90 under, beyond the 10 euro margin
    expect(s.projectedCents).toBe(96263); // 590 / 19 * 31
    expect(s.perDayLeftCents).toBe(3153); // 410 left over 13 days
  });

  it("calls it over pace when spending runs ahead", () => {
    const s = summarise([...payments, pay(7, "2026-11-12", -20000, "AH", "spend")], "2026-11-13", 26, 21000, dayOf);
    expect(s.status).toBe("over");
    expect(s.aheadCents).toBeLessThan(0);
  });

  it("counts last month's leftover in this month's money, and stops at an empty account", () => {
    // EUR 50 left over from October on top of the top-up: 460 in the account now.
    const s = summarise(payments, "2026-11-13", 26, 46000, dayOf);
    expect(s.budgetCents).toBe(105000);
    expect(s.remainingCents).toBe(46000);
    // Empty account: nothing left, nothing per day.
    const empty = summarise(payments, "2026-11-13", 26, 0, dayOf);
    expect(empty).toMatchObject({ remainingCents: 0, perDayLeftCents: 0, budgetCents: 59000 });
  });

  it("groups spending per shop", () => {
    const period = budgetPeriod("2026-11-13", 26);
    expect(byMerchant(payments, period, dayOf)).toEqual([
      { name: "Picnic", cents: 30000, count: 1 },
      { name: "Jumbo Breda", cents: 18500, count: 1 },
      { name: "Albert Heijn", cents: 10500, count: 1 },
    ]);
  });
});

describe("formatting", () => {
  it("tidies shop names and money", () => {
    expect(merchantName("ALBERT HEIJN 1234 BREDA NLD")).toBe("Albert Heijn");
    expect(merchantName("AH to go 5521")).toBe("AH to go");
    expect(merchantName(null)).toBe("Other");
    // One shop, whatever its legal form says.
    expect(merchantName("Picnic BV")).toBe("Picnic");
    expect(merchantName("PICNIC B.V.")).toBe("Picnic");
    expect(merchantName("Picnic")).toBe("Picnic");
    expect(merchantName("Lidl Nederland GmbH")).toBe("Lidl Nederland");
    expect(euros(100000)).toBe("€1,000");
    expect(euros(1234)).toBe("€12.34");
  });
});

describe("passThroughIds (toeslagen moved straight on to savings)", () => {
  const p = (id: number, at: string, cents: number, counterparty: string) => ({ id, created_at: at, amount_cents: cents, counterparty });
  const payments = [
    p(1, "2026-10-15T08:57:00Z", 28100, "Belastingdienst"),
    p(2, "2026-10-15T09:12:00Z", -28000, "Dewald"), // €1 less: still matched
    p(3, "2026-11-16T09:27:00Z", 28100, "Belastingdienst"),
    p(4, "2026-11-16T09:29:00Z", -28100, "Dewald"),
    p(5, "2026-11-20T11:40:00Z", 9800, "Belastingdienst"),
    p(6, "2026-11-20T20:10:00Z", -9800, "Dewald"),
    p(7, "2026-11-10T12:00:00Z", -4500, "Dewald"), // no toeslag before it: a reimbursement, still spending
    p(8, "2026-11-21T10:00:00Z", -9800, "Dewald"), // the €98 was already matched: spending
    p(9, "2026-11-16T09:30:00Z", -6000, "Albert Heijn 1234"), // a shop: untouched
  ];

  it("passes on the toeslag and the matching transfer out, nothing else", () => {
    expect([...passThroughIds(payments, ["belastingdienst"], ["dewald"])].sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("matches a back-payment split between two accounts (names as typed, accents and all)", () => {
    const split = [
      p(1, "2026-08-27T08:47:00Z", 261300, "Belastingdienst"),
      p(2, "2026-08-27T08:47:30Z", 51300, "Belastingdienst"),
      p(3, "2026-08-27T08:48:40Z", 382200, "Belastingdienst"),
      p(4, "2026-08-27T08:52:50Z", 23500, "Belastingdienst"),
      p(5, "2026-08-27T10:30:00Z", -359500, "Dewald"),
      p(6, "2026-08-27T15:32:00Z", -359500, "Anél ABN"), // €7 more than came in: within 1%
      p(7, "2026-08-28T09:00:00Z", -2000, "Dewald"), // the pot is empty now: spending
    ];
    expect([...passThroughIds(split, ["Belastingdienst"], ["Dewald", "Anél"])].sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("does nothing without a rule, and only matches within a week", () => {
    expect(passThroughIds(payments, [], ["dewald"]).size).toBe(0);
    const late = [p(1, "2026-11-01T08:00:00Z", 9800, "Belastingdienst"), p(2, "2026-11-12T08:00:00Z", -9800, "Dewald")];
    expect([...passThroughIds(late, ["belastingdienst"], ["dewald"])]).toEqual([1]);
  });

  it("leaves passed-through money out of the month's spending", () => {
    const base = { counterparty: "x", description: null };
    const list: BudgetPayment[] = [
      { ...base, id: 1, created_at: "2026-11-16T09:00:00Z", amount_cents: 28100, kind: "passthrough" },
      { ...base, id: 2, created_at: "2026-11-16T09:10:00Z", amount_cents: -28100, kind: "passthrough" },
      { ...base, id: 3, created_at: "2026-11-17T09:10:00Z", amount_cents: -5000, kind: "spend" },
    ];
    const s = summarise(list, "2026-11-20", 1, 10000, (iso) => iso.slice(0, 10));
    expect(s.spentCents).toBe(5000);
    expect(s.budgetCents).toBe(15000);
  });
});
