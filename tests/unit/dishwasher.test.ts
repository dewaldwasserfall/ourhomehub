/**
 * Unit tests for the dishwasher: reading Electrolux's state, spotting a
 * finished run, the countdown line and token freshness.
 */
import { describe, expect, it } from "vitest";
import { dishwasherLine } from "@/components/dishwasher-card";
import { tokenExpiry, tokenFresh } from "@/lib/electrolux/api";
import { isRunning, minutesLeft, readState, runFinished } from "@/lib/electrolux/state";

describe("reading the state", () => {
  it("keeps the reported state, phase, door and seconds left", () => {
    const snap = readState({
      connectionState: "Connected",
      properties: { reported: { applianceState: "RUNNING", cyclePhase: "RINSE", doorState: "CLOSED", timeToEnd: 2400 } },
    });
    expect(snap).toEqual({ state: "RUNNING", cyclePhase: "RINSE", doorState: "CLOSED", online: true, timeToEndSeconds: 2400 });
    expect(readState({}).state).toBeNull();
  });
});

describe("finished runs", () => {
  it("counts running or paused -> done/idle/off as finished, nothing else", () => {
    expect(runFinished("RUNNING", "END_OF_CYCLE")).toBe(true);
    expect(runFinished("PAUSED", "IDLE")).toBe(true);
    expect(runFinished("RUNNING", "OFF")).toBe(true);
    expect(runFinished("RUNNING", "RUNNING")).toBe(false);
    expect(runFinished("DELAYED_START", "IDLE")).toBe(false); // a cancelled delayed start
    expect(runFinished("END_OF_CYCLE", "IDLE")).toBe(false); // already counted
    expect(runFinished(null, "END_OF_CYCLE")).toBe(false); // first check after connecting
    expect(isRunning("DELAYED_START")).toBe(true);
    expect(isRunning("IDLE")).toBe(false);
  });
});

describe("the countdown line", () => {
  const now = new Date("2026-11-14T20:00:00Z");
  it("shows phase and minutes left, and done", () => {
    expect(minutesLeft("2026-11-14T20:39:10Z", now)).toBe(40);
    expect(dishwasherLine("RUNNING", "RINSE", "2026-11-14T20:40:00Z", now)).toBe("Rinsing · 40 min left");
    expect(dishwasherLine("RUNNING", null, "2026-11-14T19:59:00Z", now)).toBe("almost done");
    expect(dishwasherLine("END_OF_CYCLE", null, null, now)).toBe("Done, ready to empty");
    expect(dishwasherLine("IDLE", null, null, now)).toBeNull();
  });
});

describe("tokens", () => {
  it("reads the JWT expiry and refreshes two minutes early", () => {
    const jwt = (exp: number) => `x.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.y`;
    expect(tokenExpiry(jwt(1000))).toBe(1000);
    expect(tokenFresh(jwt(1000), 800)).toBe(true);
    expect(tokenFresh(jwt(1000), 900)).toBe(false);
    expect(tokenFresh("not-a-jwt")).toBe(false);
  });
});
