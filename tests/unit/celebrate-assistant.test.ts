/** Celebrations (what's due, "1 more ★") and the voice helper's pure parts. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { dueCelebrations, loadSeen, oneMoreStar, rememberSeen } from "@/lib/celebrate";
import { asksBack, cleanHistory, isIsoDate, matchList, matchMember, spokenError, systemPrompt, type AssistantList, type AssistantMember } from "@/lib/assistant/core";
import type { RewardPlan, RewardProgress } from "@/lib/rewards";

const plan = (id: string, over: Partial<RewardPlan> = {}): RewardPlan =>
  ({ id, member_id: "kid", title: id, period: "day", goal: "stars", stars_needed: 5, counts: "all", carry_over: true, active: true, ...over }) as RewardPlan;
const prog = (plan_id: string, progress: number, over: Partial<RewardProgress> = {}): RewardProgress => ({
  plan_id,
  period_start: "2026-11-16",
  period_end: "2026-11-16",
  progress,
  target: 5,
  given: false,
  ...over,
});

describe("dueCelebrations", () => {
  it("lists earned, not-yet-seen rewards in order, once per period", () => {
    const plans = [plan("a"), plan("b"), plan("c"), plan("d")];
    const progress = { a: prog("a", 5), b: prog("b", 3), c: prog("c", 6, { given: true }), d: prog("d", 5) };
    expect(dueCelebrations(plans, progress, new Set()).map((c) => c.key)).toEqual(["a:2026-11-16", "d:2026-11-16"]);
    expect(dueCelebrations(plans, progress, new Set(["a:2026-11-16"])).map((c) => c.key)).toEqual(["d:2026-11-16"]);
    // Tomorrow is a new period: celebrates again.
    expect(dueCelebrations([plan("a")], { a: prog("a", 5, { period_start: "2026-11-17" }) }, new Set(["a:2026-11-16"]))).toHaveLength(1);
  });
});

describe("oneMoreStar", () => {
  it("is true one star from a star goal only", () => {
    expect(oneMoreStar(plan("a"), prog("a", 4))).toBe(true);
    expect(oneMoreStar(plan("a"), prog("a", 3))).toBe(false);
    expect(oneMoreStar(plan("a", { goal: "all_tasks" }), prog("a", 4))).toBe(false);
    expect(oneMoreStar(plan("a"), undefined)).toBe(false);
  });
});

describe("remembering celebrations", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("keeps keys in storage and never throws", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) } });
    rememberSeen("a:1");
    rememberSeen("b:1");
    expect([...loadSeen()]).toEqual(["a:1", "b:1"]);
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("blocked");
        },
      },
    });
    expect(loadSeen().size).toBe(0);
    expect(() => rememberSeen("c:1")).not.toThrow();
  });
});

describe("voice helper", () => {
  const members: AssistantMember[] = [
    { id: "d", display_name: "Dewald Wasserfall", role: "owner" },
    { id: "a", display_name: "Anél", role: "adult" },
    { id: "s", display_name: "Shannon", role: "child" },
    { id: "l", display_name: "Lennon", role: "child" },
  ];
  const lists: AssistantList[] = [
    { id: "t", name: "To-dos", type: "todo", is_default: false },
    { id: "g", name: "Groceries", type: "shopping", is_default: true },
    { id: "h", name: "Hardware store", type: "shopping", is_default: false },
  ];

  it("finds people by spoken first name, accents and all", () => {
    expect(matchMember("anel", members)?.id).toBe("a");
    expect(matchMember("for Lennon", members)?.id).toBe("l");
    expect(matchMember("Shan", members)?.id).toBe("s");
    expect(matchMember("Le", members)).toBeNull(); // too short to guess
    expect(matchMember("Bob", members)).toBeNull();
  });

  it("finds lists by name, with sensible defaults", () => {
    expect(matchList(undefined, lists, "shopping")?.id).toBe("g");
    expect(matchList("the hardware list", lists, "shopping")?.id).toBe("h");
    expect(matchList("grocery list", lists)?.id).toBe("g");
    expect(matchList("to-dos", lists)?.id).toBe("t");
    expect(matchList("tasks", lists)?.id).toBe("t");
    expect(matchList(undefined, lists, "todo")?.id).toBe("t");
  });

  it("checks dates and turns refusals into sentences", () => {
    expect(isIsoDate("2026-11-21")).toBe(true);
    expect(isIsoDate("21-11-2026")).toBe(false);
    expect(spokenError('new row violates "board_locked"')).toMatch(/unlock/);
    expect(spokenError("adults_only")).toMatch(/grown-ups/);
  });

  it("tells Claude the date, the family and the lists", () => {
    const prompt = systemPrompt({ householdName: "Wasserfall", timeZone: "Europe/Amsterdam", today: "2026-11-15", speaker: "Dewald", isBoard: false, members, lists });
    expect(prompt).toMatch(/Sunday,? 15 November 2026/);
    expect(prompt).toContain("Lennon (child)");
    expect(prompt).toContain("Groceries (default shopping list)");
    expect(prompt).toContain("read aloud");
  });

  it("cleans the conversation history before it goes to Claude", () => {
    const u = (text: string) => ({ role: "user", text });
    const a = (text: string) => ({ role: "assistant", text });
    // Junk is dropped, turns alternate, start with a question, end with an answer.
    expect(cleanHistory([a("hi"), u("add eggs"), { role: "system", text: "x" }, a("Which list?"), u("dangling")])).toEqual([u("add eggs"), a("Which list?")]);
    expect(cleanHistory("nope")).toEqual([]);
    expect(cleanHistory([u("a"), u("b"), a("c")])).toEqual([u("b"), a("c")]);
    // Only the last three exchanges, each capped.
    const long = Array.from({ length: 10 }, (_, i) => [u(`q${i}`), a(`r${i}`)]).flat();
    const kept = cleanHistory(long);
    expect(kept).toHaveLength(6);
    expect(kept[0]).toEqual(u("q7"));
    expect(cleanHistory([u("x".repeat(900)), a("ok")])[0].text).toHaveLength(600);
  });

  it("notices when the helper asked something back", () => {
    expect(asksBack("Which list, Groceries or Hardware store?")).toBe(true);
    expect(asksBack("For Shannon or Lennon? ")).toBe(true);
    expect(asksBack("Added eggs to Groceries.")).toBe(false);
    expect(asksBack("Is it done? Yes, it's added.")).toBe(false);
  });
});
