/**
 * Human-readable descriptions of what the engine has learned about an item.
 * All wording for "how often" and "when next" lives here so every screen
 * says it the same way.
 */
import type { ItemPattern } from "./types";

/** Same threshold as public.suggestion_min_confidence() in the database. */
export const MIN_CONFIDENCE = 0.45;

const DAY_MS = 86_400_000;

/** Whole days between two instants, rounded towards the nearest day. */
export function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / DAY_MS);
}

/** "every day", "every 5 days", "every week", "every 2 weeks", "every month". */
export function describeInterval(days: number): string {
  const d = Math.max(1, Math.round(days));
  if (d === 1) return "every day";
  if (d >= 6 && d <= 8) return "every week";
  if (d >= 12 && d <= 16) return "every 2 weeks";
  if (d >= 19 && d <= 23) return "every 3 weeks";
  if (d >= 27 && d <= 33) return "every month";
  if (d > 33) return `every ${Math.round(d / 7)} weeks`;
  return `every ${d} days`;
}

/** "today", "yesterday", "3 days ago", "2 weeks ago". */
export function describeAgo(iso: string, now = new Date()): string {
  const d = daysBetween(new Date(iso), now);
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  if (d < 14) return `${d} days ago`;
  return `${Math.round(d / 7)} weeks ago`;
}

/** "Due today", "Due tomorrow", "Due in 4 days", "Overdue by 2 days". */
export function describeDue(iso: string, now = new Date()): string {
  const d = daysBetween(now, new Date(iso));
  if (d === 0) return "Due today";
  if (d === 1) return "Due tomorrow";
  if (d > 1) return `Due in ${d} days`;
  if (d === -1) return "Due since yesterday";
  return `Due ${-d} days ago`;
}

export type RhythmState =
  | { kind: "learning"; purchases: number }
  | { kind: "irregular"; purchases: number }
  | { kind: "known"; intervalDays: number; nextDue: string; lastBought: string; progress: number };

/**
 * Classify a pattern for display.
 * progress = time since last purchase / usual gap (1 means "a full gap has passed").
 */
export function rhythmState(pattern: ItemPattern, now = new Date()): RhythmState {
  if (pattern.median_interval_days == null || pattern.next_expected_at == null || pattern.last_purchased_at == null) {
    return { kind: "learning", purchases: pattern.purchase_count };
  }
  if ((pattern.confidence ?? 0) < MIN_CONFIDENCE) {
    return { kind: "irregular", purchases: pattern.purchase_count };
  }
  const interval = Number(pattern.median_interval_days);
  const elapsed = (now.getTime() - new Date(pattern.last_purchased_at).getTime()) / DAY_MS;
  return {
    kind: "known",
    intervalDays: interval,
    nextDue: pattern.next_expected_at,
    lastBought: pattern.last_purchased_at,
    progress: Math.max(0, elapsed / interval),
  };
}

/** One-line reason shown under a suggested item. */
export function suggestionReason(pattern: ItemPattern | null, now = new Date()): string {
  if (!pattern?.median_interval_days || !pattern.last_purchased_at) return "Suggested from your shopping history";
  return `You buy this ${describeInterval(Number(pattern.median_interval_days))}. Last bought ${describeAgo(
    pattern.last_purchased_at,
    now,
  )}.`;
}
