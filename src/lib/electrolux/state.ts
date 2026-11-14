/**
 * The dishwasher's state, as HomeHub uses it. Pure functions (unit-tested):
 *
 *   * readState()    the bits of Electrolux's state response we keep
 *   * runFinished()  did a run just end (between two checks)?
 *   * isRunning()    show the countdown?
 *   * minutesLeft()  "40 min left", counting down from ends_at
 *
 * Electrolux's applianceState values: OFF, IDLE, READY_TO_START,
 * DELAYED_START, RUNNING, PAUSED, END_OF_CYCLE. timeToEnd is in seconds.
 */

export interface ApplianceSnapshot {
  state: string | null;
  cyclePhase: string | null;
  doorState: string | null;
  online: boolean;
  /** Seconds left in the run (only meaningful while it runs). */
  timeToEndSeconds: number | null;
}

/** GET /appliances/{id}/state -> what we keep. */
export function readState(response: {
  connectionState?: string;
  properties?: { reported?: Record<string, unknown> };
}): ApplianceSnapshot {
  const reported = response.properties?.reported ?? {};
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const seconds = typeof reported.timeToEnd === "number" ? reported.timeToEnd : null;
  return {
    state: str(reported.applianceState),
    cyclePhase: str(reported.cyclePhase),
    doorState: str(reported.doorState),
    online: (response.connectionState ?? "").toLowerCase() === "connected",
    timeToEndSeconds: seconds !== null && seconds >= 0 ? seconds : null,
  };
}

/** Busy with a run (or about to finish one). */
const ACTIVE = new Set(["RUNNING", "PAUSED"]);

export function isRunning(state: string | null): boolean {
  return state !== null && (ACTIVE.has(state) || state === "DELAYED_START");
}

/**
 * A run ended between the previous check and this one: it was running (or
 * paused) and now it's at END_OF_CYCLE, or simply no longer running (some
 * models go straight to IDLE or OFF when the door opens). A delayed start
 * that's cancelled isn't a finished run.
 */
export function runFinished(previous: string | null, current: string | null): boolean {
  if (previous === null || !ACTIVE.has(previous)) return false;
  return current === "END_OF_CYCLE" || current === "IDLE" || current === "OFF";
}

/** Whole minutes left until endsAt (never negative), or null. */
export function minutesLeft(endsAt: string | null, now = new Date()): number | null {
  if (!endsAt) return null;
  const ms = Date.parse(endsAt) - now.getTime();
  return Number.isFinite(ms) ? Math.max(0, Math.ceil(ms / 60_000)) : null;
}

/** "Rinsing" from "RINSE"-style phase names; null when unknown. */
export function phaseLabel(phase: string | null): string | null {
  if (!phase || phase === "UNAVAILABLE") return null;
  const map: Record<string, string> = { PREWASH: "Prewash", WASH: "Washing", MAINWASH: "Washing", RINSE: "Rinsing", HOTRINSE: "Rinsing", DRYING: "Drying", DRY: "Drying" };
  return map[phase.replace(/[^A-Z]/gi, "").toUpperCase()] ?? null;
}
