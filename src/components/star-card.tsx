/**
 * A child's stars at a glance: stars earned so far, their streak, and
 * progress on the reward plan they're working on (the first one not given
 * yet). On their Today, and per child on the Stars screen.
 */
"use client";

import { oneMoreStar } from "@/lib/celebrate";
import { progressText, rewardStatus, type RewardPlan, type RewardProgress } from "@/lib/rewards";
import type { StarStats } from "@/lib/use-stars";
import { FlameIcon, StarIcon } from "./icons";

export function StarCard({
  stats,
  plan,
  progress,
}: {
  stats: StarStats | undefined;
  plan?: RewardPlan;
  progress?: RewardProgress;
}) {
  const earned = stats?.earned ?? 0;
  const status = rewardStatus(progress);
  const target = progress?.target ?? 0;
  const pct = target > 0 ? Math.min(100, ((progress?.progress ?? 0) / target) * 100) : 0;
  return (
    <div className="star-card">
      <div className="star-card__numbers">
        <span className="star-card__stat">
          <StarIcon size={22} strokeWidth={2} className="star-card__star" />
          <strong>{earned}</strong> {earned === 1 ? "star" : "stars"}
        </span>
        <span className="star-card__stat">
          <FlameIcon size={20} strokeWidth={2} className="star-card__flame" />
          <strong>{stats?.streak ?? 0}</strong>-day streak
        </span>
      </div>
      {plan && (
        <div className="star-card__next">
          <div className="progress-track" aria-hidden="true">
            <span className="progress-fill star-fill" style={{ width: `${status === "going" ? pct : 100}%` }} />
          </div>
          <span className="row__subtitle">
            {status === "earned"
              ? `Earned: ${plan.title}!`
              : status === "given"
                ? `${plan.title}: given ✓`
                : oneMoreStar(plan, progress)
                  ? `${plan.title}: 1 more ★!`
                  : `${plan.title}: ${progressText(plan, progress)}`}
          </span>
        </div>
      )}
    </div>
  );
}
