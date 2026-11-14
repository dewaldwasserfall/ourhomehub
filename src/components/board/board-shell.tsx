/**
 * Frame around every Family board screen.
 *
 *   * Top bar: the clock and date, and the two tabs (Today, Calendar).
 *   * Dims after 2 minutes without a touch; a tap wakes it (the tap that
 *     wakes it does nothing else, so nobody ticks something by accident).
 *   * "Charge me" banner when the battery is low and not charging (Chrome on
 *     Android reports the battery; other browsers just don't show it).
 *   * Shifts everything by a few pixels every 10 minutes, so a static layout
 *     can't burn into an OLED screen.
 */
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useHousehold } from "@/components/household-context";
import { dateKey, timeKey } from "@/lib/calendar/time";

const IDLE_MS = 2 * 60_000;
const LOW_BATTERY = 0.15;
const SHIFT_EVERY_MS = 10 * 60_000;
/** Pixel offsets cycled through for burn-in protection. */
const SHIFTS: Array<[number, number]> = [[0, 0], [3, 2], [-2, 3], [2, -3], [-3, -2]];

const dateLabel = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });

/** The bits of the Battery Status API we use (not in TypeScript's DOM types). */
interface BatteryManagerLike extends EventTarget {
  level: number;
  charging: boolean;
}

export function BoardShell({ boardName, children }: { boardName: string; children: React.ReactNode }) {
  const { household } = useHousehold();
  const pathname = usePathname();

  // Step 1: the clock, once a minute.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const today = dateKey(now, household.timezone);

  // Step 2: dim when idle; the first tap after that only wakes it.
  const [dimmed, setDimmed] = useState(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    const restart = () => {
      clearTimeout(idleTimer.current);
      idleTimer.current = setTimeout(() => setDimmed(true), IDLE_MS);
    };
    restart();
    window.addEventListener("pointerdown", restart, { passive: true });
    return () => {
      clearTimeout(idleTimer.current);
      window.removeEventListener("pointerdown", restart);
    };
  }, []);

  // Step 3: battery (where the browser tells us).
  const [lowBattery, setLowBattery] = useState(false);
  useEffect(() => {
    const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryManagerLike> };
    if (!nav.getBattery) return;
    let battery: BatteryManagerLike | undefined;
    const update = () => battery && setLowBattery(battery.level <= LOW_BATTERY && !battery.charging);
    nav.getBattery().then((b) => {
      battery = b;
      update();
      b.addEventListener("levelchange", update);
      b.addEventListener("chargingchange", update);
    });
    return () => {
      battery?.removeEventListener("levelchange", update);
      battery?.removeEventListener("chargingchange", update);
    };
  }, []);

  // Step 4: burn-in shift.
  const [shift, setShift] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setShift((s) => (s + 1) % SHIFTS.length), SHIFT_EVERY_MS);
    return () => clearInterval(timer);
  }, []);
  const [dx, dy] = SHIFTS[shift];

  const tab = (href: string, label: string) => (
    <Link href={href} className="board-tab" aria-current={pathname === href ? "page" : undefined}>
      {label}
    </Link>
  );

  return (
    <div className="board" style={{ transform: `translate(${dx}px, ${dy}px)` }}>
      <header className="board-top">
        <div className="board-top__when">
          <span className="board-top__time">{timeKey(now, household.timezone)}</span>
          <span className="board-top__date">{dateLabel.format(new Date(`${today}T12:00:00Z`))}</span>
        </div>
        <nav className="board-tabs" aria-label={boardName}>
          {tab("/board", "Today")}
          {tab("/board/calendar", "Calendar")}
        </nav>
      </header>

      {lowBattery && (
        <div className="board-battery" role="status">
          Battery low: please charge the board tonight.
        </div>
      )}

      <div className="board-body">{children}</div>

      {/* The dim layer swallows the waking tap. */}
      {dimmed && (
        <button type="button" className="board-dim" aria-label="Wake the board" onClick={() => setDimmed(false)} />
      )}
    </div>
  );
}
