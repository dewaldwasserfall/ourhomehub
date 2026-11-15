/**
 * Celebrations: when a child has earned a reward.
 *
 * A reward celebrates once per period (a daily reward each day it's earned,
 * a weekly one each week) on each screen: the board, and the child's own
 * phone. The screen remembers what it has celebrated in localStorage, so a
 * refresh doesn't repeat it. (Screens don't know about each other: seeing it
 * on the board and again on the phone is fine.)
 *
 * Also the small "1 more ★!" moment for star goals.
 */
import { rewardStatus, type RewardPlan, type RewardProgress } from "./rewards";

const STORAGE_KEY = "hh-celebrated";
/** Keep the remembered list short: old periods don't matter any more. */
const KEEP = 60;

/** One celebration to show. */
export interface Celebration {
  key: string;
  plan: RewardPlan;
}

/** The key for one plan's current period. */
export const celebrationKey = (planId: string, periodStart: string) => `${planId}:${periodStart}`;

/**
 * Step 1: which earned rewards haven't been celebrated on this screen yet,
 * in the plans' order (the queue shows them one after another).
 */
export function dueCelebrations(plans: RewardPlan[], progress: Record<string, RewardProgress | undefined>, seen: ReadonlySet<string>): Celebration[] {
  const due: Celebration[] = [];
  for (const plan of plans) {
    const p = progress[plan.id];
    if (!p || rewardStatus(p) !== "earned") continue;
    const key = celebrationKey(plan.id, p.period_start);
    if (!seen.has(key)) due.push({ key, plan });
  }
  return due;
}

/** Step 2: "1 more ★!" when a star goal is one star away. */
export function oneMoreStar(plan: Pick<RewardPlan, "goal">, progress: RewardProgress | undefined): boolean {
  return plan.goal === "stars" && !!progress && !progress.given && progress.target !== null && progress.target - progress.progress === 1;
}

/** Step 3: the remembered keys (storage can be missing or full: never throw). */
export function loadSeen(): Set<string> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(list) ? list.filter((k): k is string => typeof k === "string") : []);
  } catch {
    return new Set();
  }
}

export function rememberSeen(key: string): void {
  try {
    const list = [...loadSeen()].filter((k) => k !== key);
    list.push(key);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(-KEEP)));
  } catch {
    // Private mode or storage full: it may celebrate again, which is harmless.
  }
}
