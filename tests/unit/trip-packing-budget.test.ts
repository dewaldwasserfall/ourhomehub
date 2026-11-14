/**
 * Unit tests for trip packing (groups, per-person views, templates), the
 * trip budget (currencies, totals) and the missed-school warning.
 */
import { describe, expect, it } from "vitest";
import { budgetSummary, byCategory, missingRates, money, parseAmount, rateMap, toHome } from "@/lib/trip-budget";
import { filterForPerson, groupToggle, packingProgress, packingTree, templateSize, toTemplate } from "@/lib/trip-packing";
import { missedSchool, namesList } from "@/lib/trips";
import type { TripBudgetItem, TripChecklistItem, TripParticipant } from "@/lib/types";

const item = (id: string, text: string, opts: Partial<TripChecklistItem> = {}): TripChecklistItem =>
  ({ id, text, parent_id: null, done: false, member_id: null, sort_order: 0, created_at: `2027-01-01T00:00:0${id.length}Z`, ...opts }) as TripChecklistItem;

describe("packing", () => {
  const items = [
    item("g", "Car rental", { sort_order: 1 }),
    item("g1", "Licence", { parent_id: "g", done: true, member_id: "dewald" }),
    item("g2", "Booking voucher", { parent_id: "g", sort_order: 1 }),
    item("s", "Sunscreen", { sort_order: 2 }),
    item("l", "Goggles", { sort_order: 3, member_id: "lennon" }),
  ];

  it("builds groups and counts items, not group headers", () => {
    const tree = packingTree(items);
    expect(tree.map((n) => n.item.text)).toEqual(["Car rental", "Sunscreen", "Goggles"]);
    expect(tree[0]).toMatchObject({ isGroup: true, done: false });
    expect(tree[0].children.map((c) => c.text)).toEqual(["Licence", "Booking voucher"]);
    expect(packingProgress(items)).toEqual({ done: 1, total: 4 });
  });

  it("shows one person's items (with their groups) or the shared ones", () => {
    expect(filterForPerson(items, "dewald").map((i) => i.id)).toEqual(["g", "g1"]);
    expect(filterForPerson(items, "lennon").map((i) => i.id)).toEqual(["l"]);
    expect(filterForPerson(items, "shared").map((i) => i.id)).toEqual(["g", "g2", "s"]);
  });

  it("ticks a whole group, or only the visible part of it", () => {
    const [group] = packingTree(items);
    expect(groupToggle(group, items)).toEqual({ ids: ["g1", "g2"], done: true });
    // Dewald's view: only his licence, already done -> untick it.
    expect(groupToggle(group, filterForPerson(items, "dewald"))).toEqual({ ids: ["g1"], done: false });
  });

  it("saves and sizes templates", () => {
    const t = toTemplate(items);
    expect(t).toEqual([{ text: "Car rental", children: ["Licence", "Booking voucher"] }, { text: "Sunscreen" }, { text: "Goggles" }]);
    expect(templateSize({ items: t })).toBe(4);
  });
});

describe("trip budget", () => {
  const cost = (id: string, cents: number, currency: string, paid = false, category: TripBudgetItem["category"] = "Other"): TripBudgetItem =>
    ({ id, title: id, amount_cents: cents, currency, paid, category, date: null, created_at: "2027-01-01T00:00:00Z" }) as TripBudgetItem;
  const items = [cost("Villa", 150000, "EUR", true, "Accommodation"), cost("Ferry", 10000, "GBP"), cost("Tours", 50000, "THB", false, "Activities")];
  const rates = [{ trip_id: "t", household_id: "h", currency: "GBP", rate: "1.17" }];

  it("converts with manual rates and flags missing ones", () => {
    const map = rateMap(rates);
    expect(toHome(items[1], "EUR", map)).toBe(11700);
    expect(toHome(items[2], "EUR", map)).toBeNull();
    expect(missingRates(items, "EUR", map)).toEqual(["THB"]);
  });

  it("totals what it can, paid and unpaid, against the plan", () => {
    expect(budgetSummary(items, "EUR", rates, 200000)).toEqual({
      totalCents: 161700,
      paidCents: 150000,
      unpaidCents: 11700,
      leftCents: 38300,
      uncounted: 1,
    });
    expect(budgetSummary(items, "EUR", rates, null).leftCents).toBeNull();
  });

  it("groups by category in the standard order", () => {
    expect(byCategory(items).map(([c]) => c)).toEqual(["Accommodation", "Activities", "Other"]);
  });

  it("reads and writes amounts", () => {
    expect(parseAmount("12,50")).toBe(1250);
    expect(parseAmount("1200")).toBe(120000);
    expect(parseAmount("12.555")).toBeNull();
    expect(parseAmount("abc")).toBeNull();
    expect(money(123450, "EUR")).toBe("€1,234.50");
  });
});

describe("missed school", () => {
  const members = [
    { id: "dewald", role: "owner" as const },
    { id: "shannon", role: "child" as const },
    { id: "lennon", role: "child" as const },
  ];
  const p = (member_id: string, join_date: string | null = null, leave_date: string | null = null) =>
    ({ trip_id: "t", household_id: "h", member_id, join_date, leave_date }) as TripParticipant;

  it("lists the school days each child going would miss", () => {
    const school = ["2027-07-01", "2027-07-02", "2027-07-05"];
    expect(missedSchool([p("dewald"), p("shannon"), p("lennon", "2027-07-03")], members, school)).toEqual([
      { memberId: "shannon", days: ["2027-07-01", "2027-07-02", "2027-07-05"] },
      { memberId: "lennon", days: ["2027-07-05"] },
    ]);
    expect(missedSchool([p("shannon")], members, [])).toEqual([]);
    expect(namesList(["Shannon", "Lennon"])).toBe("Shannon and Lennon");
  });
});
