/**
 * What notifications are due, as pure functions (no database, no clock).
 *
 * The 5-minute job (src/lib/notify/run.ts) loads the data, passes it here
 * with "now", and sends whatever comes back. Every notification has a stable
 * key; the job records keys in notification_log, so each one goes out once.
 *
 * Who-sees-what follows Today: adults get things assigned to them or to
 * nobody; children only what is assigned to them.
 */
import { binList, binsAround, type BinDay } from "../bins";
import { choreDueOn, stepApplies } from "../plan";
import type { Occurrence } from "../calendar/types";
import { timeKey } from "../calendar/time";
import type { Chore, Completion, DayMode, Member, Routine, RoutineStep } from "../types";

export interface Notice {
  key: string;
  title: string;
  body: string;
  /** Page to open when the notification is tapped. */
  url: string;
}

export interface Prefs {
  events: boolean;
  event_lead_minutes: number;
  digest: boolean;
  digest_time: string; // "HH:MM" or "HH:MM:SS"
  routine_nudge: boolean;
  routine_nudge_time: string;
  list_added: boolean;
  /** Evening before collection. */
  bins: boolean;
  bins_time: string;
  /** Morning of collection. */
  bins_morning: boolean;
  bins_morning_time: string;
  /** Sunday 19:00: the week review (adults only). */
  weekly_review: boolean;
  /** 18:00 the day before: "check in tomorrow at …" (Trips access). */
  trip_checkin: boolean;
  /** 09:00: a passport or ID expiring in 6 / 3 / 1 month(s) (Trips access). */
  id_expiry: boolean;
}

/**
 * Defaults until someone saves their own. Children start with only the
 * morning digest of their own things; the family calendar would be noise.
 */
export function defaultPrefs(role: Member["role"]): Prefs {
  const child = role === "child";
  return {
    events: !child,
    event_lead_minutes: 30,
    digest: true,
    digest_time: "07:30",
    routine_nudge: false,
    routine_nudge_time: "07:45",
    list_added: false,
    bins: !child,
    bins_time: "19:00",
    bins_morning: !child,
    bins_morning_time: "07:00",
    weekly_review: !child,
    trip_checkin: !child,
    id_expiry: !child,
  };
}

// -----------------------------------------------------------------------------
// Step 1: time helpers
// -----------------------------------------------------------------------------

/** "07:30" or "07:30:00" -> minutes since midnight. */
export function minutesOf(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + (m || 0);
}

/**
 * Is it time? True from the target time until `windowMinutes` later. The
 * job runs every 5 minutes, so a 15-minute window survives one late or
 * missed run; the log stops a second send.
 */
export function isTimeFor(nowMinutes: number, target: string, windowMinutes = 15): boolean {
  const t = minutesOf(target);
  return nowMinutes >= t && nowMinutes < t + windowMinutes;
}

/** Shared assignment rule (same as Today). */
export function isForMember(assignee: string | null, member: Pick<Member, "id" | "role">): boolean {
  if (assignee === member.id) return true;
  return assignee === null && member.role !== "child";
}

/** "A", "A and B", "A, B and 2 more". */
export function listPreview(titles: string[], max = 2): string {
  if (titles.length <= 1) return titles.join("");
  if (titles.length <= max) return `${titles.slice(0, -1).join(", ")} and ${titles[titles.length - 1]}`;
  return `${titles.slice(0, max).join(", ")} and ${titles.length - max} more`;
}

// -----------------------------------------------------------------------------
// Step 2: calendar events, N minutes before
// -----------------------------------------------------------------------------

export function dueEvents(occurrences: Occurrence[], now: Date, leadMinutes: number, timeZone: string): Notice[] {
  const horizon = now.getTime() + leadMinutes * 60_000;
  return occurrences
    .filter((o) => !o.allDay && o.start && o.start.getTime() > now.getTime() && o.start.getTime() <= horizon)
    .map((o) => {
      const minutes = Math.max(1, Math.round((o.start!.getTime() - now.getTime()) / 60_000));
      const when = `${timeKey(o.start!, timeZone)}–${timeKey(o.end!, timeZone)}`;
      return {
        key: `event:${o.key}`,
        title: `In ${minutes} min: ${o.title || "(No title)"}`,
        body: o.row.location ? `${when} · ${o.row.location}` : when,
        url: "/calendar",
      };
    });
}

// -----------------------------------------------------------------------------
// Step 3: the morning digest (to-dos and chores due today)
// -----------------------------------------------------------------------------

export interface TodoLine {
  id: string;
  text: string;
  due_date: string | null;
  assigned_to: string | null;
}

export function digest(
  member: Pick<Member, "id" | "role">,
  todos: TodoLine[],
  chores: Chore[],
  today: string,
  mode: DayMode,
): Notice | null {
  // Step 3a: what's due or overdue (undated to-dos count, as on Today).
  const titles: string[] = [];
  let overdue = 0;
  for (const t of todos) {
    if ((t.due_date && t.due_date > today) || !isForMember(t.assigned_to, member)) continue;
    titles.push(t.text);
    if (t.due_date && t.due_date < today) overdue++;
  }
  for (const c of chores) {
    if (!choreDueOn(c, today, mode) || !isForMember(c.assigned_to, member)) continue;
    titles.push(c.title);
    if (c.next_due < today) overdue++;
  }
  if (titles.length === 0) return null;

  // Step 3b: one line per day.
  const count = titles.length === 1 ? "1 thing" : `${titles.length} things`;
  return {
    key: `digest:${today}`,
    title: `Today: ${count} to do${overdue ? `, ${overdue} overdue` : ""}`,
    body: listPreview(titles),
    url: "/",
  };
}

// -----------------------------------------------------------------------------
// Step 4: routine nudge (steps still open at the chosen time)
// -----------------------------------------------------------------------------

export function routineNudges(
  member: Pick<Member, "id" | "role">,
  routines: Routine[],
  steps: RoutineStep[],
  completions: Completion[],
  today: string,
  mode: DayMode,
): Notice[] {
  const done = new Set(completions.filter((c) => c.kind === "step" && c.for_date === today).map((c) => c.item_id));
  const notices: Notice[] = [];
  for (const routine of routines) {
    if (!routine.active) continue;
    const open = steps.filter(
      (s) =>
        s.routine_id === routine.id &&
        stepApplies(s, today, mode) &&
        isForMember(s.assigned_to ?? routine.owner_member, member) &&
        !done.has(s.id),
    );
    if (open.length === 0) continue;
    notices.push({
      key: `nudge:${routine.id}:${today}`,
      title: `${routine.name}: ${open.length === 1 ? "1 step" : `${open.length} steps`} left`,
      body: listPreview(open.map((s) => s.title), 3),
      url: "/",
    });
  }
  return notices;
}

// -----------------------------------------------------------------------------
// Step 4b: bins, the evening before and the morning of collection
// -----------------------------------------------------------------------------

export function binReminder(days: BinDay[], today: string): Notice | null {
  const { tomorrow } = binsAround(days, today);
  if (tomorrow.length === 0) return null;
  return {
    key: `bins:${today}`,
    title: `Bins tonight: ${binList(tomorrow)}`,
    body: "Collected tomorrow morning",
    url: "/household/bins",
  };
}

export function binMorningReminder(days: BinDay[], today: string): Notice | null {
  const kinds = binsAround(days, today).today;
  if (kinds.length === 0) return null;
  return {
    key: `bins-morning:${today}`,
    title: `Bins out this morning: ${binList(kinds)}`,
    body: "Collected today",
    url: "/household/bins",
  };
}

// -----------------------------------------------------------------------------
// Step 5: someone else added to a shopping list (bundled per list)
// -----------------------------------------------------------------------------

export interface AddedLine {
  id: string;
  list_id: string;
  list_name: string;
  text: string;
  added_by_member: Pick<Member, "id" | "display_name"> | null;
}

/**
 * One notice per list. Lines are logged one by one (`lineKeys`), so a line is
 * announced once even if more are added to the same list a minute later.
 */
export function listAdditions(member: Pick<Member, "id">, lines: AddedLine[]): Array<Notice & { lineKeys: string[] }> {
  const byList = new Map<string, AddedLine[]>();
  for (const line of lines) {
    if (!line.added_by_member || line.added_by_member.id === member.id) continue;
    byList.set(line.list_id, [...(byList.get(line.list_id) ?? []), line]);
  }
  return [...byList.values()].map((group) => {
    const people = [...new Set(group.map((l) => l.added_by_member!.display_name.split(" ")[0]))];
    return {
      key: `list:${group.map((l) => l.id).sort().join(",")}`,
      lineKeys: group.map((l) => `list:${l.id}`),
      title: group[0].list_name,
      body: `${listPreview(people)} added ${listPreview(group.map((l) => l.text), 3)}`,
      url: `/lists/${group[0].list_id}`,
    };
  });
}
