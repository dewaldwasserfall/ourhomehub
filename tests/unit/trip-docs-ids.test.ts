/**
 * Unit tests for phase 3: passport/ID expiry (status, trip warnings,
 * reminders), the Booking.com search link and "check in tomorrow".
 */
import { describe, expect, it } from "vitest";
import { defaultPrefs } from "@/lib/notify/due";
import { expiryStatus, idLabel, idReminder, tripIdWarnings } from "@/lib/member-ids";
import { bookingSearchUrl, checkinReminder, firstGap } from "@/lib/trips";
import type { MemberId, TripParticipant, TripStay } from "@/lib/types";

const id = (member_id: string, expiry_date: string, kind: MemberId["kind"] = "passport"): MemberId =>
  ({ id: `${member_id}-${kind}`, household_id: "h", member_id, kind, country: "Netherlands", expiry_date, onepassword_url: null, created_at: "" }) as MemberId;
const p = (member_id: string) => ({ trip_id: "t", household_id: "h", member_id, join_date: null, leave_date: null }) as TripParticipant;

describe("passport and ID expiry", () => {
  it("labels and rates documents", () => {
    expect(idLabel(id("d", "2030-01-01"))).toBe("Passport (Netherlands)");
    expect(expiryStatus(id("d", "2026-11-01"), "2026-11-14").state).toBe("expired");
    expect(expiryStatus(id("d", "2027-03-01"), "2026-11-14").state).toBe("soon");
    expect(expiryStatus(id("d", "2028-01-01"), "2026-11-14").state).toBe("ok");
  });

  it("warns about people going whose documents don't cover the trip", () => {
    const trip = { end_date: "2027-07-10" };
    const ids = [
      id("dewald", "2030-01-01"),
      id("anel", "2027-07-05"), // runs out during the trip
      id("shannon", "2027-09-01"), // under 6 months after
      id("lennon", "2027-08-01"),
      id("lennon", "2031-01-01", "id_card"), // but his ID card is fine
    ];
    expect(tripIdWarnings(trip, [p("dewald"), p("anel"), p("shannon"), p("lennon"), p("jana")], ids)).toEqual([
      { memberId: "anel", id: ids[1], problem: "expires_during" },
      { memberId: "shannon", id: ids[2], problem: "under_six_months" },
      { memberId: "jana", id: null, problem: "missing" },
    ]);
    // Nothing recorded at all: no warnings yet.
    expect(tripIdWarnings(trip, [p("dewald")], [])).toEqual([]);
  });

  it("reminds once at 6, 3 and 1 month(s), keyed per step", () => {
    const doc = id("lennon", "2027-06-01");
    expect(idReminder(doc, "Lennon", "2026-11-01")).toBeNull();
    const six = idReminder(doc, "Lennon", "2026-12-01")!;
    expect(six.title).toBe("Lennon's passport expires in 6 months");
    const three = idReminder(doc, "Lennon", "2027-03-15")!;
    expect(three.title).toBe("Lennon's passport expires in 3 months");
    expect(three.key).not.toBe(six.key);
    expect(idReminder(doc, "Lennon", "2027-05-10")!.title).toBe("Lennon's passport expires in a month");
    expect(idReminder(doc, "Lennon", "2027-06-02")).toBeNull();
  });

  it("is on for adults by default", () => {
    expect(defaultPrefs("adult")).toMatchObject({ trip_checkin: true, id_expiry: true });
    expect(defaultPrefs("child")).toMatchObject({ trip_checkin: false, id_expiry: false });
  });
});

describe("Booking.com and check-in", () => {
  const trip = { id: "t", name: "Spain", destination: "Begur", start_date: "2027-07-01", end_date: "2027-07-10" };
  const members = [
    { id: "dewald", role: "owner" as const },
    { id: "anel", role: "adult" as const },
    { id: "shannon", role: "child" as const },
  ];

  it("fills in the search with destination, dates and guests", () => {
    const url = new URL(bookingSearchUrl(trip, [p("dewald"), p("anel"), p("shannon")], members, { checkIn: "2027-07-04", checkOut: "2027-07-10" }));
    expect(url.hostname).toBe("www.booking.com");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      ss: "Begur",
      checkin: "2027-07-04",
      checkout: "2027-07-10",
      group_adults: "2",
      group_children: "1",
    });
  });

  it("finds the first stretch of nights without a stay", () => {
    const stays = [{ id: "a", check_in: "2027-07-01", check_out: "2027-07-04" }] as TripStay[];
    expect(firstGap(trip, stays)).toEqual({ checkIn: "2027-07-04", checkOut: "2027-07-10" });
    expect(firstGap(trip, [{ id: "b", check_in: "2027-07-01", check_out: "2027-07-10" }] as TripStay[])).toBeNull();
  });

  it("reminds the evening before a check-in", () => {
    const stays = [{ id: "s", name: "Casa Mar", location: "Begur", check_in: "2027-07-01", booking_ref: "AB12" }];
    expect(checkinReminder(trip, stays, "2027-06-30")).toEqual({
      key: "checkin:s:2027-07-01",
      title: "Tomorrow: check in at Casa Mar",
      body: "Spain · Begur · ref AB12",
      url: "/trips/t",
    });
    expect(checkinReminder(trip, stays, "2027-06-29")).toBeNull();
  });
});
