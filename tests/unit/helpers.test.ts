/**
 * Unit tests for the browser-side helpers: input parsing, category guessing
 * and rhythm wording.
 */
import { describe, expect, it } from "vitest";
import { categoryRank, guessCategory } from "@/lib/categories";
import { parseEntryInput } from "@/lib/parse";
import { describeDue, describeInterval, rhythmState, suggestionReason } from "@/lib/rhythm";
import type { ItemPattern } from "@/lib/types";

// -----------------------------------------------------------------------------
// Step 1: composer input parsing
// -----------------------------------------------------------------------------
describe("parseEntryInput", () => {
  it.each([
    ["2 milk", "milk", "2"],
    ["2x milk", "milk", "2"],
    ["milk x2", "milk", "2"],
    ["milk 3", "milk", "3"],
    ["500g mince", "mince", "500 g"],
    ["1,5 kg potatoes", "potatoes", "1.5 kg"],
    ["Toilet paper", "Toilet paper", null],
    ["7up", "7up", null],
    ["Cola 0", "Cola 0", null],
    ["  coffee   beans ", "coffee beans", null],
  ])("%s", (input, name, quantity) => {
    expect(parseEntryInput(input)).toEqual({ name, quantity });
  });
});

// -----------------------------------------------------------------------------
// Step 2: aisle guessing (English and Dutch)
// -----------------------------------------------------------------------------
describe("guessCategory", () => {
  it.each([
    ["Coffee beans", "Pantry"],
    ["Toilet paper", "Household"],
    ["WC-papier", "Household"],
    ["Oat milk", "Dairy & eggs"],
    ["Peanut butter", "Pantry"],
    ["Ice cream", "Frozen"],
    ["Bananas", "Produce"],
    ["Uien", "Other"], // plural Dutch onion: not a whole-word match for "ui"
    ["ui", "Produce"],
    ["Biltong", "Meat & fish"],
    ["Tandpasta", "Personal care"],
    ["Something unusual", "Other"],
  ])("%s -> %s", (name, category) => {
    expect(guessCategory(name)).toBe(category);
  });

  it("orders aisles like a walk through the shop", () => {
    expect(categoryRank("Produce")).toBeLessThan(categoryRank("Household"));
    expect(categoryRank("Other")).toBeGreaterThan(categoryRank("Household"));
  });
});

// -----------------------------------------------------------------------------
// Step 3: rhythm wording
// -----------------------------------------------------------------------------
describe("rhythm wording", () => {
  const now = new Date("2026-11-12T12:00:00Z");
  const base: ItemPattern = {
    item_id: "x",
    household_id: "h",
    purchase_count: 4,
    median_interval_days: 7,
    interval_stddev: 0,
    last_purchased_at: "2026-11-03T10:00:00Z",
    next_expected_at: "2026-11-09T05:00:00Z",
    confidence: 0.9,
    threshold_factor: 0.85,
    updated_at: "2026-11-03T10:00:00Z",
  };

  it("describes intervals naturally", () => {
    expect(describeInterval(1)).toBe("every day");
    expect(describeInterval(4)).toBe("every 4 days");
    expect(describeInterval(7)).toBe("every week");
    expect(describeInterval(14)).toBe("every 2 weeks");
    expect(describeInterval(30)).toBe("every month");
  });

  it("describes due dates", () => {
    expect(describeDue("2026-11-12T18:00:00Z", now)).toBe("Due today");
    expect(describeDue("2026-11-13T12:00:00Z", now)).toBe("Due tomorrow");
    expect(describeDue("2026-11-16T12:00:00Z", now)).toBe("Due in 4 days");
    expect(describeDue("2026-11-09T12:00:00Z", now)).toBe("Due 3 days ago");
  });

  it("explains a suggestion", () => {
    expect(suggestionReason(base, now)).toBe("You buy this every week. Last bought 9 days ago.");
  });

  it("classifies patterns", () => {
    expect(rhythmState(base, now).kind).toBe("known");
    expect(rhythmState({ ...base, confidence: 0.2 }, now).kind).toBe("irregular");
    expect(
      rhythmState({ ...base, median_interval_days: null, next_expected_at: null, purchase_count: 2 }, now),
    ).toEqual({ kind: "learning", purchases: 2 });
  });
});
