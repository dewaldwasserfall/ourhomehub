/**
 * Unit tests for bin days: what's going out tonight, today's collection, and
 * the evening-before notification.
 */
import { describe, expect, it } from "vitest";
import { binList, binsAround, lastBinDate, type BinDay } from "@/lib/bins";
import { binReminder, defaultPrefs } from "@/lib/notify/due";

const day = (kind: BinDay["kind"], date: string): BinDay => ({ id: `${kind}-${date}`, household_id: "h", kind, date });
const days = [day("plastic", "2026-11-16"), day("gft", "2026-11-26"), day("paper", "2026-11-27"), day("plastic", "2026-11-30")];

describe("bins", () => {
  it("knows what goes out tonight and what's collected today", () => {
    expect(binsAround(days, "2026-11-15")).toEqual({ today: [], tomorrow: ["plastic"] });
    expect(binsAround(days, "2026-11-26")).toEqual({ today: ["gft"], tomorrow: ["paper"] });
    expect(binsAround(days, "2026-11-20")).toEqual({ today: [], tomorrow: [] });
  });

  it("names several bins naturally and finds the last date", () => {
    expect(binList(["plastic", "gft", "paper"])).toBe("Plastic, GFT and Paper");
    expect(lastBinDate(days)).toBe("2026-11-30");
    expect(lastBinDate([])).toBeNull();
  });

  it("reminds the evening before, once per evening", () => {
    expect(binReminder(days, "2026-11-15")).toEqual({
      key: "bins:2026-11-15",
      title: "Bins tonight: Plastic",
      body: "Collected tomorrow morning",
      url: "/household/bins",
    });
    expect(binReminder(days, "2026-11-16")).toBeNull();
    expect(defaultPrefs("adult")).toMatchObject({ bins: true, bins_time: "19:00" });
    expect(defaultPrefs("child").bins).toBe(false);
  });
});
