/**
 * A board tile, full screen.
 *
 *   * A large "← Home" button top left takes you back to the board (so does
 *     Escape on a keyboard).
 *   * It goes back by itself after 2 minutes without a tap, so the board
 *     never stays stuck on a full-screen list when nobody's looking.
 *   * `actions` sit top right (e.g. "+ Grocery" while unlocked).
 */
"use client";

import { useEffect, useRef } from "react";

/** Back to the board after this long without a tap. */
const IDLE_MS = 2 * 60_000;

export function BoardExpanded({
  title,
  subtitle,
  onBack,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  onBack: () => void;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Step 1: idle → back to the board; any tap restarts the countdown.
  useEffect(() => {
    const arm = () => {
      clearTimeout(timer.current);
      timer.current = setTimeout(onBack, IDLE_MS);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onBack();
    };
    arm();
    window.addEventListener("pointerdown", arm, { passive: true });
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(timer.current);
      window.removeEventListener("pointerdown", arm);
      window.removeEventListener("keydown", onKey);
    };
  }, [onBack]);

  // Step 2: the screen.
  return (
    <div className="board-full" role="dialog" aria-modal="true" aria-label={title}>
      <header className="board-full__bar">
        <button type="button" className="board-full__back" onClick={onBack}>
          <span aria-hidden="true">←</span> Home
        </button>
        <div className="board-full__heading">
          <h1 className="board-full__title">{title}</h1>
          {subtitle && <p className="board-full__subtitle">{subtitle}</p>}
        </div>
        <div className="board-full__actions">{actions}</div>
      </header>
      <div className="board-full__body">{children}</div>
    </div>
  );
}
