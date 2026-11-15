/** Reward plans: wording, status, linked-task ticks and the parent push. */
import { describe, expect, it } from "vitest";
import { linkedTaskDone, progressShort, progressText, rewardEarnedNotice, rewardStatus, type RewardProgress } from "@/lib/rewards";

const prog = (over: Partial<RewardProgress> = {}): RewardProgress => ({
  plan_id: "p1",
  period_start: "2026-11-16",
  period_end: "2026-11-22",
  progress: 3,
  target: 5,
  given: false,
  ...over,
});

describe("rewardStatus", () => {
  it("is going without progress or below target", () => {
    expect(rewardStatus(undefined)).toBe("going");
    expect(rewardStatus(prog())).toBe("going");
  });
  it("is earned at the target and given once given", () => {
    expect(rewardStatus(prog({ progress: 5 }))).toBe("earned");
    expect(rewardStatus(prog({ progress: 7, given: true }))).toBe("given");
  });
  it("never counts an empty target as earned", () => {
    expect(rewardStatus(prog({ progress: 0, target: 0 }))).toBe("going");
  });
});

describe("progress wording", () => {
  it("star goals cap at the target", () => {
    expect(progressText({ goal: "stars", period: "day" }, prog({ progress: 9 }))).toBe("5 of 5 ★ today");
    expect(progressText({ goal: "stars", period: "once" }, prog())).toBe("3 of 5 ★");
    expect(progressShort({ goal: "stars" }, prog())).toBe("3/5 ★");
  });
  it("all-tasks goals count tasks", () => {
    expect(progressText({ goal: "all_tasks", period: "week" }, prog({ progress: 2, target: 4 }))).toBe("2 of 4 tasks this week");
    expect(progressText({ goal: "all_tasks", period: "day" }, prog({ progress: 4, target: 4 }))).toBe("All 4 tasks done today");
    expect(progressText({ goal: "all_tasks", period: "day" }, prog({ progress: 0, target: 0 }))).toBe("No linked tasks today");
  });
});

describe("linkedTaskDone", () => {
  const tick = { kind: "chore" as const, item_id: "c1", done_for: "kid", done_at: "2026-11-17T08:00:00Z", pending: false };
  const task = { kind: "chore" as const, task_id: "c1" };
  it("needs a confirmed tick for this child since the period began", () => {
    expect(linkedTaskDone(task, "kid", "2026-11-16T00:00:00Z", [tick])).toBe(true);
    expect(linkedTaskDone(task, "kid", "2026-11-18T00:00:00Z", [tick])).toBe(false);
    expect(linkedTaskDone(task, "other", "2026-11-16T00:00:00Z", [tick])).toBe(false);
    expect(linkedTaskDone(task, "kid", "2026-11-16T00:00:00Z", [{ ...tick, pending: true }])).toBe(false);
  });
});

describe("rewardEarnedNotice", () => {
  it("fires once per plan and period, only when earned", () => {
    const plan = { id: "p1", title: "Screen time" };
    expect(rewardEarnedNotice(plan, prog(), "Lennon")).toBeNull();
    expect(rewardEarnedNotice(plan, prog({ progress: 5, given: true }), "Lennon")).toBeNull();
    const n = rewardEarnedNotice(plan, prog({ progress: 5 }), "Lennon");
    expect(n).toEqual({ key: "reward:p1:2026-11-16", title: "Lennon earned Screen time 🎉", body: "Open Stars to mark it as given.", url: "/stars" });
  });
});
