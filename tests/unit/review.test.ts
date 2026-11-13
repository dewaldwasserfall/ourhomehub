/**
 * Unit tests for the week review: the weeks, the headline, next week's notes
 * and the Sunday notification.
 */
import { describe, expect, it } from "vitest";
import type { BinDay } from "@/lib/bins";
import { defaultPrefs } from "@/lib/notify/due";
import { isReviewDay, nextWeekDays, reviewWeeks, weekHeadline, weeklyReviewNotice, type WeekCounts } from "@/lib/review";
import type { Chore, DayInfo, Zone } from "@/lib/types";

const person = (member_id: string, steps = 0, chores = 0, zone_tasks = 0, todos = 0) => ({ member_id, steps, chores, zone_tasks, todos });
const names = new Map([
  ["d", "Dewald Wasserfall"],
  ["a", "Anél"],
  ["j", "Jana"],
]);
const bin = (kind: BinDay["kind"], date: string): BinDay => ({ id: `${kind}-${date}`, household_id: "h", kind, date });
const info = (mode: DayInfo["mode"], label: string | null = null): DayInfo => ({ mode, label, period_start: null, period_end: null });

describe("review weeks", () => {
  it("runs Monday to today, then next Monday to Sunday", () => {
    // Fri 13 Nov 2026
    expect(reviewWeeks("2026-11-13")).toEqual({ from: "2026-11-09", to: "2026-11-13", nextFrom: "2026-11-16", nextTo: "2026-11-22" });
    // Sunday still belongs to its own week
    expect(reviewWeeks("2026-11-15").from).toBe("2026-11-09");
    expect(isReviewDay("2026-11-15")).toBe(true);
    expect(isReviewDay("2026-11-16")).toBe(false);
  });
});

describe("week headline", () => {
  it("adds everyone up and names the busiest only when several pitched in", () => {
    const counts: WeekCounts = { people: [person("d", 3, 1), person("j", 10, 2, 1, 2), person("a")], shopping_bought: 4 };
    expect(weekHeadline(counts, names)).toBe("19 things done · most by Jana (15)");
    expect(weekHeadline({ people: [person("d", 1)], shopping_bought: 0 }, names)).toBe("1 thing done");
    expect(weekHeadline({ people: [person("d")], shopping_bought: 0 }, names)).toBe("Nothing ticked off yet");
  });
});

describe("next week", () => {
  const chore = (title: string, next_due: string, active = true): Chore =>
    ({ id: title, title, next_due, active, assigned_to: null }) as unknown as Chore;
  const zones = [
    { id: "z1", name: "Kitchen", sort_order: 0 },
    { id: "z2", name: "Bathrooms", sort_order: 1 },
  ] as Zone[];
  const days = new Map<string, DayInfo>([
    ["2026-11-16", info("school")],
    ["2026-11-17", info("school")],
    ["2026-11-18", info("holiday", "Study day")],
    ["2026-11-19", info("school")],
    ["2026-11-20", info("school")],
    ["2026-11-21", info("weekend")],
    ["2026-11-22", info("weekend")],
  ]);

  it("puts bins, chores, holidays and the zone switch on their days", () => {
    const preview = nextWeekDays({
      nextFrom: "2026-11-16",
      days,
      modeBefore: info("school"),
      binDays: [bin("plastic", "2026-11-16"), bin("gft", "2026-11-26")],
      chores: [chore("Descale kettle", "2026-11-10"), chore("Windows", "2026-11-19"), chore("Paused", "2026-11-17", false)],
      zones,
      // Fortnights from 2 Nov: a new one starts on 16 Nov (zone 2).
      rotationStart: "2026-11-02",
    });
    expect(preview).toHaveLength(7);
    const monday = preview[0].items;
    expect(monday).toContainEqual({ type: "zone", zone: "Bathrooms" });
    expect(monday).toContainEqual({ type: "bins", kinds: ["plastic"] });
    expect(monday).toContainEqual({ type: "chore", title: "Descale kettle", overdue: true, assignee: null });
    expect(preview[1].items).toEqual([]); // paused chore left out
    expect(preview[2].items).toContainEqual({ type: "mode", text: "Study day starts" });
    expect(preview[3].items).toContainEqual({ type: "mode", text: "School again" });
    expect(preview[3].items).toContainEqual({ type: "chore", title: "Windows", overdue: false, assignee: null });
    // The weekend isn't announced as a change.
    expect(preview[5].items).toEqual([]);
  });

  it("names a holiday that is already running on Monday", () => {
    const holiday = new Map([["2026-12-21", info("holiday", "Christmas holiday")]]);
    const preview = nextWeekDays({ nextFrom: "2026-12-21", days: holiday, modeBefore: info("holiday", "Christmas holiday"), binDays: [], chores: [], zones: [], rotationStart: null });
    expect(preview[0].items).toEqual([{ type: "mode", text: "Christmas holiday" }]);
  });
});

describe("Sunday notification", () => {
  const counts: WeekCounts = { people: [person("d", 3), person("j", 6)], shopping_bought: 12 };
  const members = [...names].map(([id, display_name]) => ({ id, display_name }));

  it("goes out on Sundays with the week and next week's bins", () => {
    const n = weeklyReviewNotice(counts, members, [bin("gft", "2026-11-19"), bin("plastic", "2026-11-16"), bin("paper", "2026-11-19")], "2026-11-15");
    expect(n).toEqual({
      key: "review:2026-11-15",
      title: "Your week: 9 things done",
      body: "Most by Jana (6) · 12 bought · Next week: Plastic Mon, GFT and Paper Thu",
      url: "/review",
    });
    expect(weeklyReviewNotice(counts, members, [], "2026-11-14")).toBeNull();
  });

  it("is on for adults and off for children by default", () => {
    expect(defaultPrefs("adult").weekly_review).toBe(true);
    expect(defaultPrefs("child").weekly_review).toBe(false);
  });
});
