/**
 * A child's stars at a glance: balance, streak and progress to the reward
 * they're saving for. On their Today, and per child on the Stars screen.
 */
"use client";

import type { Reward, StarStats } from "@/lib/use-stars";
import { FlameIcon, StarIcon } from "./icons";

export function StarCard({ stats, next }: { stats: StarStats | undefined; next: Reward | undefined }) {
  const balance = stats?.balance ?? 0;
  const toGo = next ? Math.max(0, next.stars_needed - balance) : 0;
  return (
    <div className="star-card">
      <div className="star-card__numbers">
        <span className="star-card__stat">
          <StarIcon size={22} strokeWidth={2} className="star-card__star" />
          <strong>{balance}</strong> {balance === 1 ? "star" : "stars"}
        </span>
        <span className="star-card__stat">
          <FlameIcon size={20} strokeWidth={2} className="star-card__flame" />
          <strong>{stats?.streak ?? 0}</strong>-day streak
        </span>
      </div>
      {next && (
        <div className="star-card__next">
          <div className="progress-track" aria-hidden="true">
            <span className="progress-fill star-fill" style={{ width: `${Math.min(100, (balance / next.stars_needed) * 100)}%` }} />
          </div>
          <span className="row__subtitle">
            {toGo === 0 ? `Ready for: ${next.title}!` : `${toGo} more for: ${next.title}`}
          </span>
        </div>
      )}
    </div>
  );
}
