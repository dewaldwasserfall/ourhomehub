/** Wallets: balances, how amounts read, history lines, the week's summary. */
import { describe, expect, it } from "vitest";
import { balances, describeEntry, formatAmount, unitOf, valueText, weekSummary } from "@/lib/wallet";

const e = (unit: "minutes" | "euros", amount: number | string, created_at = "2026-11-18T10:00:00Z", member_id = "lennon") => ({ member_id, unit, amount, created_at });

describe("wallet", () => {
  it("adds up balances per child and unit (amounts may arrive as text)", () => {
    const entries = [e("minutes", 5), e("minutes", "5.00"), e("minutes", -3), e("euros", "0.20"), e("euros", 0.1), e("minutes", 50, undefined, "shannon")];
    expect(balances(entries, "lennon")).toEqual({ minutes: 7, euros: 0.3 });
  });

  it("formats minutes and euros, signed for the history", () => {
    expect(formatAmount("minutes", 35)).toBe("35 min");
    expect(formatAmount("minutes", 65)).toBe("1 h 5 min");
    expect(formatAmount("minutes", 120)).toBe("2 h");
    expect(formatAmount("minutes", -15, true)).toBe("−15 min");
    expect(formatAmount("euros", 0.8)).toBe("€0.80");
    expect(formatAmount("euros", 10, true)).toBe("+€10");
  });

  it("describes rewards and history lines", () => {
    expect(unitOf("time")).toBe("minutes");
    expect(unitOf("one_off")).toBeNull();
    expect(valueText({ reward_type: "time", value_amount: 5, value_per: "star" })).toBe("5 min per star");
    expect(valueText({ reward_type: "cash", value_amount: 2, value_per: "goal" })).toBe("€2 when reached");
    expect(valueText({ reward_type: "one_off", value_amount: null, value_per: null })).toBe("");
    const title = () => "Screen time";
    expect(describeEntry({ kind: "earned_star", note: null, plan_id: "p" }, title)).toBe("★ Star · Screen time");
    expect(describeEntry({ kind: "used", note: "Minecraft", plan_id: null }, title)).toBe("Used · Minecraft");
    expect(describeEntry({ kind: "adjust", note: null, plan_id: null }, title)).toBe("Adjusted");
  });

  it("summarises the week: earned, spent and the balance now", () => {
    const entries = [e("minutes", 20, "2026-11-10T10:00:00Z"), e("minutes", 15, "2026-11-17T10:00:00Z"), e("minutes", -10, "2026-11-18T10:00:00Z")];
    expect(weekSummary(entries, "lennon", "minutes", "2026-11-16T00:00:00Z")).toEqual({ earned: 15, spent: 10, balance: 25 });
  });
});
