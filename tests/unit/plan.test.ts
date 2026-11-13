/**
 * Unit tests for the Phase 3 rules: weekdays and modes, routine step
 * matching, the zone rotation, chore scheduling, roles, and the holiday
 * feed / public holiday calculations.
 */
import { describe, expect, it } from "vitest";
import {
  dutchPublicHolidays,
  easterSunday,
  nextSchoolYear,
  parseSchoolHolidays,
  schoolYearOf,
} from "@/lib/holidays";
import {
  choreDueOn,
  describeDay,
  describeEvery,
  describeRule,
  isoWeekday,
  mondayOf,
  nextDueAfter,
  stepApplies,
  timeOfDayAt,
  zoneFortnight,
} from "@/lib/plan";
import { canTick, isAdult } from "@/lib/roles";

describe("weekdays", () => {
  it("numbers days ISO style and finds the Monday", () => {
    expect(isoWeekday("2026-11-16")).toBe(1); // Monday
    expect(isoWeekday("2026-11-22")).toBe(7); // Sunday
    expect(mondayOf("2026-11-22")).toBe("2026-11-16");
    expect(mondayOf("2026-11-16")).toBe("2026-11-16");
  });
});

describe("routine steps", () => {
  const sportsKit = { weekdays: [1], modes: ["school" as const] };
  const lunches = { weekdays: [1, 2, 3, 4, 5], modes: ["school" as const] };
  const sunscreen = { weekdays: null, modes: ["holiday" as const] };

  it("shows a step only on its weekdays and modes", () => {
    expect(stepApplies(sportsKit, "2026-11-16", "school")).toBe(true); // school Monday
    expect(stepApplies(sportsKit, "2026-11-17", "school")).toBe(false); // Tuesday
    expect(stepApplies(sportsKit, "2026-10-19", "holiday")).toBe(false); // Monday in the autumn holiday
    expect(stepApplies(lunches, "2026-11-20", "school")).toBe(true);
    expect(stepApplies(sunscreen, "2026-10-19", "holiday")).toBe(true);
    expect(stepApplies(sunscreen, "2026-11-21", "weekend")).toBe(false);
  });

  it("describes rules in plain words", () => {
    expect(describeRule(null, ["school", "holiday", "weekend"])).toBe("Every day");
    expect(describeRule([1], ["school"])).toBe("School days, Mon");
    expect(describeRule([1, 2, 3, 4, 5], ["school", "holiday"])).toBe("School days & Holidays, Mon–Fri");
    expect(describeRule([6, 7], ["school", "holiday", "weekend"])).toBe("Sat, Sun");
  });

  it("picks the routine time from the hour", () => {
    expect(timeOfDayAt(7)).toBe("morning");
    expect(timeOfDayAt(15)).toBe("afternoon");
    expect(timeOfDayAt(19)).toBe("evening");
  });
});

describe("zone rotation", () => {
  it("moves to the next zone every two weeks and wraps round", () => {
    expect(zoneFortnight("2026-11-02", "2026-11-02", 3)).toEqual({ index: 0, start: "2026-11-02", end: "2026-11-15", day: 1 });
    expect(zoneFortnight("2026-11-02", "2026-11-15", 3)?.index).toBe(0);
    expect(zoneFortnight("2026-11-02", "2026-11-16", 3)).toEqual({ index: 1, start: "2026-11-16", end: "2026-11-29", day: 1 });
    expect(zoneFortnight("2026-11-02", "2026-12-14", 3)?.index).toBe(0); // 3rd fortnight later
  });

  it("works for dates before the start and with no zones", () => {
    expect(zoneFortnight("2026-11-02", "2026-11-01", 3)).toMatchObject({ index: 2, start: "2026-10-19" });
    expect(zoneFortnight("2026-11-02", "2026-11-05", 0)).toBeNull();
  });
});

describe("chores", () => {
  it("is due from its date until ticked, only in its modes", () => {
    const chore = { next_due: "2026-11-13", modes: ["school" as const, "weekend" as const], active: true };
    expect(choreDueOn(chore, "2026-11-12", "school")).toBe(false);
    expect(choreDueOn(chore, "2026-11-13", "school")).toBe(true);
    expect(choreDueOn(chore, "2026-11-20", "school")).toBe(true); // overdue
    expect(choreDueOn(chore, "2026-11-20", "holiday")).toBe(false);
    expect(choreDueOn({ ...chore, active: false }, "2026-11-13", "school")).toBe(false);
  });

  it("schedules the next one like the database does", () => {
    expect(nextDueAfter("2026-11-14", 2, "week")).toBe("2026-11-28");
    expect(nextDueAfter("2026-11-14", 3, "day")).toBe("2026-11-17");
    expect(nextDueAfter("2026-01-31", 1, "month")).toBe("2026-02-28");
    expect(nextDueAfter("2026-12-15", 1, "month")).toBe("2027-01-15");
  });

  it("describes intervals and dates", () => {
    expect(describeEvery(1, "week")).toBe("Every week");
    expect(describeEvery(2, "week")).toBe("Every 2 weeks");
    expect(describeEvery(1, "day")).toBe("Every day");
    expect(describeDay("2026-11-13", "2026-11-13")).toBe("Today");
    expect(describeDay("2026-11-11", "2026-11-13")).toBe("2 days ago");
    expect(describeDay("2026-11-20", "2026-11-13")).toBe("Fri 20 Nov");
  });
});

describe("roles", () => {
  const kid = { id: "kid", role: "child" as const };
  const mum = { id: "mum", role: "adult" as const };
  it("lets adults tick anything and children only their own", () => {
    expect(isAdult(mum)).toBe(true);
    expect(isAdult(kid)).toBe(false);
    expect(canTick(mum, null)).toBe(true);
    expect(canTick(mum, "kid")).toBe(true);
    expect(canTick(kid, "kid")).toBe(true);
    expect(canTick(kid, null)).toBe(false);
    expect(canTick(kid, "mum")).toBe(false);
  });
});

describe("holidays", () => {
  it("knows the school year and the next one", () => {
    expect(schoolYearOf("2026-11-13")).toBe("2026-2027");
    expect(schoolYearOf("2027-03-01")).toBe("2026-2027");
    expect(schoolYearOf("2027-08-20")).toBe("2027-2028");
    expect(nextSchoolYear("2026-2027")).toBe("2027-2028");
  });

  it("reads the government feed for one region, with nationwide holidays", () => {
    const feed = {
      content: [
        {
          schoolyear: "\n 2026-2027 \n",
          vacations: [
            {
              type: "\n Herfstvakantie \n",
              regions: [
                { region: "noord", startdate: "2026-10-10T00:00:00.000Z", enddate: "2026-10-18T21:59:00.000Z" },
                { region: "zuid", startdate: "2026-10-17T00:00:00.000Z", enddate: "2026-10-25T22:59:00.000Z" },
              ],
            },
            {
              type: " Kerstvakantie ",
              regions: [{ region: "heel Nederland", startdate: "2026-12-19T00:00:00.000Z", enddate: "2027-01-03T22:59:00.000Z" }],
            },
            { type: "Broken", regions: [{ region: "zuid" }] },
          ],
        },
      ],
    };
    expect(parseSchoolHolidays(feed, "zuid")).toEqual([
      {
        start_date: "2026-10-17",
        end_date: "2026-10-25",
        kind: "holiday",
        name: "Autumn holiday",
        source: "rijksoverheid",
        external_key: "school:zuid:2026-2027:herfstvakantie",
      },
      {
        start_date: "2026-12-19",
        end_date: "2027-01-03",
        kind: "holiday",
        name: "Christmas holiday",
        source: "rijksoverheid",
        external_key: "school:zuid:2026-2027:kerstvakantie",
      },
    ]);
    expect(parseSchoolHolidays(null, "zuid")).toEqual([]);
  });

  it("works out Easter and the Dutch public holidays", () => {
    expect(easterSunday(2026)).toBe("2026-04-05");
    expect(easterSunday(2027)).toBe("2027-03-28");
    expect(easterSunday(2025)).toBe("2025-04-20");

    const y2027 = Object.fromEntries(dutchPublicHolidays(2027).map((h) => [h.name, h.start_date]));
    expect(y2027).toMatchObject({
      "Good Friday": "2027-03-26",
      "Easter Monday": "2027-03-29",
      "King's Day": "2027-04-27",
      "Ascension Day": "2027-05-06",
      "Whit Monday": "2027-05-17",
    });
    // 27 April 2025 was a Sunday, so King's Day moved to Saturday the 26th.
    expect(dutchPublicHolidays(2025).find((h) => h.name === "King's Day")?.start_date).toBe("2025-04-26");
    expect(new Set(dutchPublicHolidays(2027).map((h) => h.external_key)).size).toBe(11);
  });
});
