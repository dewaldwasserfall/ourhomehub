/**
 * Reward plans: repeating rewards per child (see the reward_plans
 * migration for the rules). The database works out progress; this file has
 * the types, the wording, and which linked tasks are done this period.
 */
import type { Completion } from "./types";

export type RewardPeriod = "day" | "week" | "once";

export interface RewardPlan {
  id: string;
  household_id: string;
  member_id: string;
  title: string;
  period: RewardPeriod;
  goal: "stars" | "all_tasks";
  stars_needed: number | null;
  counts: "all" | "linked";
  carry_over: boolean;
  counts_from: string;
  start_stars: number;
  active: boolean;
  sort_order: number;
  created_at: string;
}

export interface RewardPlanTask {
  plan_id: string;
  kind: "step" | "chore" | "zone_task";
  task_id: string;
}

/** One row of reward_progress(): this day/week for one plan. */
export interface RewardProgress {
  plan_id: string;
  period_start: string;
  period_end: string | null;
  progress: number;
  target: number | null;
  given: boolean;
}

// -----------------------------------------------------------------------------
// Step 1: wording
// -----------------------------------------------------------------------------

export const PERIOD_LABELS: Record<RewardPeriod, string> = { day: "Daily", week: "Weekly", once: "Once" };

/** "today", "this week", "savings goal". */
export function periodPhrase(period: RewardPeriod): string {
  return period === "day" ? "today" : period === "week" ? "this week" : "savings goal";
}

/** Earned (not given yet), given, or still going. */
export function rewardStatus(p: RewardProgress | undefined): "given" | "earned" | "going" {
  if (!p) return "going";
  if (p.given) return "given";
  return p.target && p.target > 0 && p.progress >= p.target ? "earned" : "going";
}

/** "3 of 5 ★ today", "All 4 tasks done", "2 of 4 tasks this week". */
export function progressText(plan: Pick<RewardPlan, "goal" | "period">, p: RewardProgress | undefined): string {
  const done = p?.progress ?? 0;
  const target = p?.target ?? 0;
  const when = plan.period === "once" ? "" : ` ${periodPhrase(plan.period)}`;
  if (plan.goal === "all_tasks") {
    if (target === 0) return `No linked tasks${when}`;
    return done >= target ? `All ${target} tasks done${when}` : `${done} of ${target} tasks${when}`;
  }
  return `${Math.min(done, target)} of ${target} ★${when}`;
}

/** The short version for the board header: "3/5 ★". */
export function progressShort(plan: Pick<RewardPlan, "goal">, p: RewardProgress | undefined): string {
  const done = p?.progress ?? 0;
  const target = p?.target ?? 0;
  return plan.goal === "all_tasks" ? `${done}/${target} tasks` : `${Math.min(done, target)}/${target} ★`;
}

// -----------------------------------------------------------------------------
// Step 2: which linked tasks count as done this period
// -----------------------------------------------------------------------------

/**
 * A linked task is done for this period when the child has a confirmed tick
 * on it since the period began (day or week; "once" since the plan began).
 */
export function linkedTaskDone(
  task: Pick<RewardPlanTask, "kind" | "task_id">,
  memberId: string,
  periodStartIso: string,
  completions: Pick<Completion, "kind" | "item_id" | "done_for" | "done_at" | "pending">[],
): boolean {
  return completions.some(
    (c) => c.kind === task.kind && c.item_id === task.task_id && c.done_for === memberId && !c.pending && c.done_at >= periodStartIso,
  );
}

/**
 * The push sent to parents when a child earns a reward, or null when this
 * plan's reward isn't earned (or was already given). The key is per plan
 * and period, so a daily reward notifies once a day at most.
 */
export function rewardEarnedNotice(
  plan: Pick<RewardPlan, "id" | "title">,
  progress: RewardProgress | undefined,
  childName: string,
): { key: string; title: string; body: string; url: string } | null {
  if (rewardStatus(progress) !== "earned" || !progress) return null;
  return {
    key: `reward:${plan.id}:${progress.period_start}`,
    title: `${childName} earned ${plan.title} 🎉`,
    body: "Open Stars to mark it as given.",
    url: "/stars",
  };
}

/** One given reward, with what earned it (reward_periods + the plan's title). */
export interface RewardHistoryEntry {
  id: string;
  plan_id: string;
  period_start: string;
  given_at: string;
  given_by: string | null;
  stars_used: number;
  ticks: Array<{ id: string; kind: string; title: string; done_at: string } | { saved: number }>;
  plan: { title: string; member_id: string } | null;
}

/**
 * The lines under a given reward in the history: "Feed the cat · Mon 16 Nov",
 * and "3 stars saved from before" for stars that predate reward plans.
 */
export function historyLines(entry: Pick<RewardHistoryEntry, "ticks">, timeZone: string): string[] {
  const day = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone });
  return entry.ticks.map((t) =>
    "saved" in t ? `${t.saved} ${t.saved === 1 ? "star" : "stars"} saved from before` : `${t.title} · ${day.format(new Date(t.done_at))}`,
  );
}
