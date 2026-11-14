/**
 * Unit tests for trip helpers: phases, the day-by-day timeline, nights
 * without a stay, participants, and which trip Today shows.
 */
import { describe, expect, it } from "vitest";
import {
  buildTripDays,
  isThere,
  nightsWithoutStay,
  participantDates,
  sortTrips,
  stayForNight,
  todayTrip,
  tripPhase,
  tripRange,
  tripsOnDay,
} from "@/lib/trips";
import type { TripPlan, TripStay } from "@/lib/types";

const trip = { start_date: "2027-07-01", end_date: "2027-07-05" };
const stay = (id: string, check_in: string, check_out: string): TripStay =>
  ({ id, name: id, check_in, check_out, location: "", booking_ref: "", notes: "" }) as TripStay;
const plan = (id: string, day: string, time: string | null, created_at = "2027-01-01T00:00:00Z"): TripPlan =>
  ({ id, day, time, title: id, details: "", created_at }) as TripPlan;

describe("trip phase", () => {
  it("counts down, then counts days, then is done", () => {
    expect(tripPhase(trip, "2027-06-20")).toEqual({ phase: "upcoming", daysUntil: 11, label: "In 11 days" });
    expect(tripPhase(trip, "2027-06-30").label).toBe("Tomorrow");
    expect(tripPhase(trip, "2027-07-03")).toEqual({ phase: "ongoing", day: 3, of: 5, label: "Day 3 of 5" });
    expect(tripPhase(trip, "2027-07-06").phase).toBe("past");
  });

  it("sorts coming trips soonest first and past ones latest first", () => {
    const a = { start_date: "2027-08-01", end_date: "2027-08-03" };
    const old1 = { start_date: "2026-01-01", end_date: "2026-01-02" };
    const old2 = { start_date: "2026-05-01", end_date: "2026-05-02" };
    expect(sortTrips([a, old1, trip, old2], "2027-06-01")).toEqual({ current: [trip, a], past: [old2, old1] });
  });

  it("writes the dates compactly", () => {
    expect(tripRange(trip, "2027-01-01")).toBe("1 – 5 Jul");
    expect(tripRange({ start_date: "2027-06-28", end_date: "2027-07-02" }, "2027-01-01")).toBe("28 Jun – 2 Jul");
    expect(tripRange(trip, "2026-11-14")).toBe("1 – 5 Jul 2027");
  });
});

describe("days", () => {
  const stays = [stay("Hotel A", "2027-07-01", "2027-07-03"), stay("Hotel B", "2027-07-03", "2027-07-05")];

  it("knows where you sleep each night (check-out morning is not a night)", () => {
    expect(stayForNight(stays, "2027-07-02")?.name).toBe("Hotel A");
    expect(stayForNight(stays, "2027-07-03")?.name).toBe("Hotel B");
    expect(stayForNight(stays, "2027-07-05")).toBeNull();
    expect(nightsWithoutStay(trip, [stays[0]])).toEqual(["2027-07-03", "2027-07-04"]);
    expect(nightsWithoutStay(trip, stays)).toEqual([]);
  });

  it("builds a timeline with check-ins, check-outs and plans in time order", () => {
    const plans = [
      plan("Dinner", "2027-07-03", "19:30:00"),
      plan("Beach", "2027-07-03", null),
      plan("Museum", "2027-07-03", "10:00:00"),
      // A plan the day before the trip still shows.
      plan("Pack the car", "2027-06-30", null),
    ];
    const days = buildTripDays(trip, stays, plans);
    expect(days.map((d) => d.date)).toEqual(["2027-06-30", "2027-07-01", "2027-07-02", "2027-07-03", "2027-07-04", "2027-07-05"]);
    const switchDay = days.find((d) => d.date === "2027-07-03")!;
    expect(switchDay.checkOuts.map((s) => s.name)).toEqual(["Hotel A"]);
    expect(switchDay.checkIns.map((s) => s.name)).toEqual(["Hotel B"]);
    expect(switchDay.stay?.name).toBe("Hotel B");
    expect(switchDay.plans.map((p) => p.title)).toEqual(["Museum", "Dinner", "Beach"]);
  });
});

describe("participants", () => {
  it("describes and checks partial dates", () => {
    expect(participantDates({ join_date: null, leave_date: null })).toBe("");
    expect(participantDates({ join_date: "2027-07-03", leave_date: "2027-07-04" })).toBe("joins 3 Jul, leaves 4 Jul");
    expect(isThere({ join_date: "2027-07-03", leave_date: null }, "2027-07-02")).toBe(false);
    expect(isThere({ join_date: "2027-07-03", leave_date: null }, "2027-07-05")).toBe(true);
  });
});

describe("trips elsewhere", () => {
  const later = { start_date: "2027-07-20", end_date: "2027-07-25" };
  it("finds trips on a day and the one for Today", () => {
    expect(tripsOnDay([trip, later], "2027-07-02")).toEqual([trip]);
    expect(todayTrip([trip, later], "2027-07-02")).toBe(trip);
    // A week ahead: shows; more than a week: doesn't.
    expect(todayTrip([later], "2027-07-13")).toBe(later);
    expect(todayTrip([later], "2027-07-12")).toBeNull();
  });
});
