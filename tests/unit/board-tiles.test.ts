/** Board tiles: groceries in shop order, the preview, upcoming bins. */
import { describe, expect, it } from "vitest";
import { groceryLabel, groceryPreview, grocerySections, upcomingBins } from "@/lib/board-tiles";
import type { BinDay } from "@/lib/bins";

const lists = [
  { id: "hw", name: "Hardware store", is_default: false, sort_order: 0 },
  { id: "g", name: "Groceries", is_default: true, sort_order: 1 },
];
const e = (id: string, list_id: string, text: string, category: string, quantity: string | null = null) => ({ id, list_id, text, category, quantity });

describe("grocery tiles", () => {
  const entries = [e("1", "g", "Milk", "Dairy & eggs", "2 L"), e("2", "g", "Apples", "Produce"), e("3", "g", "Bin bags", "Other"), e("4", "hw", "Screws", "Other")];

  it("puts the default list first and each list in shop order", () => {
    const sections = grocerySections(lists, entries);
    expect(sections.map((s) => [s.list.name, s.count])).toEqual([
      ["Groceries", 3],
      ["Hardware store", 1],
    ]);
    // Other is always last; known categories keep the shop order.
    expect(sections[0].categories.at(-1)?.name).toBe("Other");
    expect(sections[0].categories.map((c) => c.name)).toContain("Produce");
  });

  it("previews the first few items and counts the rest", () => {
    const [g] = grocerySections(lists, entries);
    expect(groceryPreview(g, 2).items).toHaveLength(2);
    expect(groceryPreview(g, 2).more).toBe(1);
    expect(groceryPreview(undefined)).toEqual({ items: [], more: 0 });
    expect(groceryLabel(entries[0])).toBe("2 L Milk");
  });
});

describe("upcomingBins", () => {
  it("groups the next collections by day, from today on", () => {
    const days = [
      { date: "2026-11-14", kind: "plastic" },
      { date: "2026-11-17", kind: "paper" },
      { date: "2026-11-17", kind: "plastic" },
      { date: "2026-11-20", kind: "gft" },
    ] as BinDay[];
    expect(upcomingBins(days, "2026-11-15")).toEqual([
      { date: "2026-11-17", kinds: ["paper", "plastic"] },
      { date: "2026-11-20", kinds: ["gft"] },
    ]);
  });
});
