/**
 * The dishwasher on Today and the Family board:
 *
 *   running        "Dishwasher · Washing · 40 min left" (counts down)
 *   delayed start  "Dishwasher · Starts later"
 *   paused         "Dishwasher · Paused"
 *   finished       "Dishwasher · Done, ready to empty" (until the door opens
 *                  or the state changes)
 *
 * Nothing shows when it's idle, off or not connected.
 */
"use client";

import { useEffect, useState } from "react";
import { useHousehold } from "@/components/household-context";
import { minutesLeft, phaseLabel } from "@/lib/electrolux/state";
import { useAppliance } from "@/lib/use-appliance";

/** One line for the dishwasher's state, or null when there's nothing to say. */
export function dishwasherLine(state: string | null, phase: string | null, endsAt: string | null, now: Date): string | null {
  if (state === "RUNNING") {
    const left = minutesLeft(endsAt, now);
    const phaseText = phaseLabel(phase);
    return [phaseText, left !== null ? (left > 0 ? `${left} min left` : "almost done") : null].filter(Boolean).join(" · ") || "Running";
  }
  if (state === "PAUSED") return "Paused";
  if (state === "DELAYED_START") return "Starts later";
  if (state === "END_OF_CYCLE") return "Done, ready to empty";
  return null;
}

export function DishwasherCard({ variant = "today" }: { variant?: "today" | "board" }) {
  const { household } = useHousehold();
  const { appliance } = useAppliance(household.id);

  // Step 1: tick every 30 seconds so the countdown moves between checks.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);

  // Step 2: anything to show?
  if (!appliance) return null;
  const line = dishwasherLine(appliance.state, appliance.cycle_phase, appliance.ends_at, now);
  if (!line) return null;
  const done = appliance.state === "END_OF_CYCLE";

  if (variant === "board") {
    return (
      <div className={`board-card board-dishwasher ${done ? "board-dishwasher--done" : ""}`}>
        <span className="board-dishwasher__label">Dishwasher</span>
        <span className="board-dishwasher__state">{line}</span>
      </div>
    );
  }

  return (
    <section className="section">
      <div className="group">
        <div className="row">
          <span className="row__icon" style={{ background: done ? "#34c759" : "#0a84ff" }} aria-hidden="true">
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="4" y="3" width="16" height="18" rx="2.5" />
              <path d="M4 8h16" />
              <circle cx="12" cy="14.5" r="3.5" />
            </svg>
          </span>
          <span className="row__body">
            <span className="row__title">{appliance.appliance_name || "Dishwasher"}</span>
            <span className="row__subtitle">{line}</span>
          </span>
        </div>
      </div>
    </section>
  );
}
