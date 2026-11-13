/**
 * Unit tests for what the notification job sends: calendar reminders, the
 * morning summary, routine reminders, shopping list changes and the timing
 * window.
 */
import { describe, expect, it } from "vitest";
import type { Occurrence } from "@/lib/calendar/types";
import { defaultPrefs, digest, dueEvents, isTimeFor, listAdditions, listPreview, routineNudges } from "@/lib/notify/due";
import type { Chore, Routine, RoutineStep } from "@/lib/types";

const TZ = "Europe/Amsterdam";
const dad = { id: "dad", role: "owner" as const };
const kid = { id: "kid", role: "child" as const };

function occ(key: string, title: string, startIso: string, minutes = 60, allDay = false): Occurrence {
  const start = new Date(startIso);
  return {
    key,
    title,
    allDay,
    start: allDay ? null : start,
    end: allDay ? null : new Date(start.getTime() + minutes * 60_000),
    startDate: startIso.slice(0, 10),
    endDate: startIso.slice(0, 10),
    isRecurring: false,
    row: { location: key === "swim" ? "De Wisselaar" : null } as Occurrence["row"],
  };
}

describe("timing", () => {
  it("fires from the chosen time for 15 minutes", () => {
    expect(isTimeFor(7 * 60 + 29, "07:30")).toBe(false);
    expect(isTimeFor(7 * 60 + 30, "07:30:00")).toBe(true);
    expect(isTimeFor(7 * 60 + 44, "07:30")).toBe(true);
    expect(isTimeFor(7 * 60 + 45, "07:30")).toBe(false);
  });

  it("previews lists in plain English", () => {
    expect(listPreview(["Milk"])).toBe("Milk");
    expect(listPreview(["Milk", "Eggs"])).toBe("Milk and Eggs");
    expect(listPreview(["Milk", "Eggs", "Tea"], 3)).toBe("Milk, Eggs and Tea");
    expect(listPreview(["A", "B", "C", "D"])).toBe("A, B and 2 more");
  });

  it("gives children only the morning summary by default", () => {
    expect(defaultPrefs("child")).toMatchObject({ events: false, digest: true, list_added: false });
    expect(defaultPrefs("adult").events).toBe(true);
  });
});

describe("calendar reminders", () => {
  const now = new Date("2026-11-13T16:05:00Z"); // 17:05 in Amsterdam
  const events = [
    occ("swim", "Swimming", "2026-11-13T16:30:00Z"), // in 25 min
    occ("late", "Movie night", "2026-11-13T18:00:00Z"), // in 115 min
    occ("past", "Lunch", "2026-11-13T11:00:00Z"),
    occ("bday", "Birthday", "2026-11-13T00:00:00Z", 0, true),
  ];

  it("reminds about timed events starting within the lead time", () => {
    expect(dueEvents(events, now, 30, TZ)).toEqual([
      { key: "event:swim", title: "In 25 min: Swimming", body: "17:30–18:30 · De Wisselaar", url: "/calendar" },
    ]);
    expect(dueEvents(events, now, 120, TZ).map((n) => n.key)).toEqual(["event:swim", "event:late"]);
  });
});

describe("morning summary", () => {
  const todos = [
    { id: "t1", text: "Book dentist", due_date: "2026-11-12", assigned_to: null },
    { id: "t2", text: "Tidy room", due_date: null, assigned_to: "kid" },
    { id: "t3", text: "Later", due_date: "2026-11-20", assigned_to: null },
  ];
  const chores = [
    { id: "c1", title: "Bed linen", next_due: "2026-11-13", modes: ["school"], active: true, assigned_to: null },
  ] as unknown as Chore[];

  it("lists what's due for each person, with overdue counted", () => {
    expect(digest(dad, todos, chores, "2026-11-13", "school")).toEqual({
      key: "digest:2026-11-13",
      title: "Today: 2 things to do, 1 overdue",
      body: "Book dentist and Bed linen",
      url: "/",
    });
    expect(digest(kid, todos, chores, "2026-11-13", "school")?.body).toBe("Tidy room");
    expect(digest(kid, [], [], "2026-11-13", "school")).toBeNull();
  });
});

describe("routine reminders", () => {
  const routines = [{ id: "r1", name: "Morning", active: true, owner_member: "kid" }] as Routine[];
  const steps = [
    { id: "s1", routine_id: "r1", title: "Brush teeth", weekdays: null, modes: ["school", "holiday", "weekend"], assigned_to: null },
    { id: "s2", routine_id: "r1", title: "Pack sports kit", weekdays: [1], modes: ["school"], assigned_to: null },
  ] as RoutineStep[];

  it("nudges only about open steps that apply today", () => {
    // Friday 13 Nov: the Monday-only step doesn't count.
    expect(routineNudges(kid, routines, steps, [], "2026-11-13", "school")).toEqual([
      { key: "nudge:r1:2026-11-13", title: "Morning: 1 step left", body: "Brush teeth", url: "/" },
    ]);
    const done = [{ kind: "step", item_id: "s1", for_date: "2026-11-13" }] as never;
    expect(routineNudges(kid, routines, steps, done, "2026-11-13", "school")).toEqual([]);
    // Someone else's personal routine isn't mine.
    expect(routineNudges(dad, routines, steps, [], "2026-11-13", "school")).toEqual([]);
  });
});

describe("shopping list changes", () => {
  it("bundles lines per list and skips your own", () => {
    const anel = { id: "anel", display_name: "Anél Wasserfall" };
    const lines = [
      { id: "l1", list_id: "g", list_name: "Groceries", text: "Coffee", added_by_member: anel },
      { id: "l2", list_id: "g", list_name: "Groceries", text: "Milk", added_by_member: anel },
      { id: "l3", list_id: "g", list_name: "Groceries", text: "Eggs", added_by_member: { id: "dad", display_name: "Dewald" } },
    ];
    const [notice] = listAdditions({ id: "dad" }, lines);
    expect(notice).toMatchObject({ title: "Groceries", body: "Anél added Coffee and Milk", url: "/lists/g" });
    expect(notice.lineKeys).toEqual(["list:l1", "list:l2"]);
    expect(listAdditions({ id: "anel" }, lines.slice(0, 2))).toEqual([]);
  });
});
