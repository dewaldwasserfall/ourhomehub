/**
 * The notification job. SERVER ONLY (service-role client and the VAPID key).
 *
 * Called every 5 minutes by pg_cron (POST /api/cron/notify). For every person
 * with at least one device registered:
 *   1. work out what's due for them (src/lib/notify/due.ts)
 *   2. claim each notice in notification_log (unique per person and key);
 *      only notices this run managed to claim are sent, so overlapping runs
 *      never send twice
 *   3. send to each of their devices; devices the push service says are gone
 *      (HTTP 404/410) are removed
 */
import webpush from "web-push";
import type { BinDay } from "../bins";
import { expandForRange } from "../calendar/expand";
import { addDays, dateKey, wallTimeOf } from "../calendar/time";
import type { CalendarEventRow } from "../calendar/types";
import { idReminder } from "../member-ids";
import { isReviewDay, reviewWeeks, weeklyReviewNotice, type WeekCounts } from "../review";
import { checkinReminder } from "../trips";
import { getSupabaseAdminClient } from "../supabase/admin";
import type { Chore, Completion, DayMode, Member, MemberId, Routine, RoutineStep } from "../types";
import {
  binMorningReminder,
  binReminder,
  defaultPrefs,
  digest,
  dueEvents,
  isTimeFor,
  listAdditions,
  routineNudges,
  type AddedLine,
  type Notice,
  type Prefs,
  type TodoLine,
} from "./due";
import { VAPID_PUBLIC_KEY, VAPID_SUBJECT } from "./config";

/** The week review goes out on Sunday at this time. */
export const WEEKLY_REVIEW_TIME = "19:00";
/** "Check in tomorrow" goes out the evening before. */
export const TRIP_CHECKIN_TIME = "18:00";
/** Passport / ID expiry reminders go out in the morning. */
export const ID_EXPIRY_TIME = "09:00";

/** Trips reminders only go to adults the owner gave Trips access. */
const tripsAdult = (m: MemberRow) => m.role === "owner" || (m.role === "adult" && Boolean(m.can_see_trips));

interface Subscription {
  id: string;
  member_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

type MemberRow = Pick<Member, "id" | "household_id" | "role" | "display_name" | "can_see_trips">;

// -----------------------------------------------------------------------------
// Step 1: sending
// -----------------------------------------------------------------------------

let vapidReady = false;
function setupVapid() {
  if (vapidReady) return;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!privateKey) throw new Error("VAPID_PRIVATE_KEY must be set");
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, privateKey);
  vapidReady = true;
}

/** Send one notice to every device of one person. Returns devices reached. */
export async function sendToDevices(subscriptions: Subscription[], notice: Notice): Promise<number> {
  setupVapid();
  const admin = getSupabaseAdminClient();
  const payload = JSON.stringify({ title: notice.title, body: notice.body, url: notice.url, tag: notice.key });
  let reached = 0;
  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        // TTL: a reminder that arrives an hour late is useless.
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, {
          TTL: 3600,
          urgency: "high",
        });
        reached++;
        await admin.from("push_subscriptions").update({ last_used_at: new Date().toISOString() }).eq("id", sub.id);
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          // The browser or phone dropped this subscription: forget it.
          await admin.from("push_subscriptions").delete().eq("id", sub.id);
        } else {
          console.error("[notify] send failed", status, String(err).slice(0, 200));
        }
      }
    }),
  );
  return reached;
}

/** Claim keys in the log; returns the ones this run won (not sent before). */
async function claim(memberId: string, keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const { data, error } = await getSupabaseAdminClient()
    .from("notification_log")
    .upsert(
      keys.map((key) => ({ member_id: memberId, key })),
      { onConflict: "member_id,key", ignoreDuplicates: true },
    )
    .select("key");
  if (error) throw new Error(`notification_log: ${error.message}`);
  return new Set(((data ?? []) as Array<{ key: string }>).map((r) => r.key));
}

// -----------------------------------------------------------------------------
// Step 2: loading a household's data (only what its subscribers need)
// -----------------------------------------------------------------------------

async function loadCalendarRows(householdId: string): Promise<CalendarEventRow[]> {
  const admin = getSupabaseAdminClient();
  const rows: CalendarEventRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await admin
      .from("calendar_events")
      .select("*")
      .eq("household_id", householdId)
      .order("id")
      .range(from, from + 999);
    rows.push(...((data ?? []) as CalendarEventRow[]));
    if (!data || data.length < 1000) return rows;
  }
}

// -----------------------------------------------------------------------------
// Step 3: the run
// -----------------------------------------------------------------------------

export async function runNotifications(now = new Date()) {
  const admin = getSupabaseAdminClient();

  // 3a. Everyone with a device registered, their member rows and preferences.
  const { data: subRows } = await admin.from("push_subscriptions").select("id, member_id, endpoint, p256dh, auth");
  const subs = (subRows ?? []) as Subscription[];
  if (subs.length === 0) return { households: 0, sent: 0 };
  const memberIds = [...new Set(subs.map((s) => s.member_id))];

  const [{ data: memberRows }, { data: prefRows }] = await Promise.all([
    admin.from("members").select("id, household_id, role, display_name, can_see_trips").in("id", memberIds),
    admin.from("notification_prefs").select("*").in("member_id", memberIds),
  ]);
  const members = (memberRows ?? []) as MemberRow[];
  const prefsByMember = new Map(((prefRows ?? []) as Array<Prefs & { member_id: string }>).map((p) => [p.member_id, p]));
  const prefsOf = (m: MemberRow): Prefs => ({ ...defaultPrefs(m.role), ...prefsByMember.get(m.id) });

  let sent = 0;
  const householdIds = [...new Set(members.map((m) => m.household_id))];

  for (const householdId of householdIds) {
    try {
      // 3b. The household's clock and today's mode.
      const { data: household } = await admin.from("households").select("timezone").eq("id", householdId).single<{ timezone: string }>();
      const tz = household?.timezone ?? "Europe/Amsterdam";
      const today = dateKey(now, tz);
      const wall = wallTimeOf(now, tz);
      const nowMinutes = wall.hour * 60 + wall.minute;
      const { data: modeData } = await admin.rpc("day_mode", { p_household_id: householdId, p_date: today });
      const mode = (modeData as DayMode) ?? "school";

      const people = members.filter((m) => m.household_id === householdId);
      const wants = (pick: (p: Prefs, m: MemberRow) => boolean) => people.some((m) => pick(prefsOf(m), m));

      // 3c. Load only what someone here will use this run.
      const needEvents = wants((p) => p.events);
      const needDigest = wants((p) => p.digest && isTimeFor(nowMinutes, p.digest_time));
      const needNudge = wants((p) => p.routine_nudge && isTimeFor(nowMinutes, p.routine_nudge_time));
      const needLists = wants((p) => p.list_added);
      const needBins = wants(
        (p) => (p.bins && isTimeFor(nowMinutes, p.bins_time)) || (p.bins_morning && isTimeFor(nowMinutes, p.bins_morning_time)),
      );

      // Week review: Sunday evening, adults who kept it on.
      const reviewTime = isReviewDay(today) && isTimeFor(nowMinutes, WEEKLY_REVIEW_TIME);
      const needReview = reviewTime && wants((p, m) => p.weekly_review && m.role !== "child");

      // Trips: check-ins tomorrow (evening) and ID expiry (morning).
      const needCheckin = isTimeFor(nowMinutes, TRIP_CHECKIN_TIME) && wants((p, m) => p.trip_checkin && tripsAdult(m));
      const needIds = isTimeFor(nowMinutes, ID_EXPIRY_TIME) && wants((p, m) => p.id_expiry && tripsAdult(m));
      const tripNotices: Notice[] = [];
      if (needCheckin) {
        const tomorrow = addDays(today, 1);
        const { data: stayRows } = await admin
          .from("trip_stays")
          .select("id, trip_id, name, location, check_in, booking_ref, trip:trips!inner(id, name)")
          .eq("household_id", householdId)
          .eq("check_in", tomorrow);
        for (const s of (stayRows ?? []) as unknown as Array<Parameters<typeof checkinReminder>[1][number] & { trip: { id: string; name: string } }>) {
          const n = checkinReminder(s.trip, [s], today);
          if (n) tripNotices.push(n);
        }
      }
      if (needIds) {
        const [{ data: idRows }, { data: nameRows }] = await Promise.all([
          admin.from("member_ids").select("*").eq("household_id", householdId),
          admin.from("members").select("id, display_name").eq("household_id", householdId),
        ]);
        const names = new Map(((nameRows ?? []) as Array<{ id: string; display_name: string }>).map((m) => [m.id, m.display_name.split(" ")[0]]));
        for (const id of (idRows ?? []) as MemberId[]) {
          const n = idReminder(id, names.get(id.member_id) ?? "Someone", today);
          if (n) tripNotices.push(n);
        }
      }

      let binDays: BinDay[] = [];
      if (needBins) {
        const { data } = await admin.from("bin_days").select("*").eq("household_id", householdId).gte("date", today).lte("date", addDays(today, 1));
        binDays = (data ?? []) as BinDay[];
      }

      let review: ReturnType<typeof weeklyReviewNotice> = null;
      if (needReview) {
        const weeks = reviewWeeks(today);
        const [{ data: counts }, { data: nextBins }, { data: allMembers }] = await Promise.all([
          admin.rpc("week_counts", { p_household_id: householdId, p_from: weeks.from, p_to: weeks.to }),
          admin.from("bin_days").select("*").eq("household_id", householdId).gte("date", weeks.nextFrom).lte("date", weeks.nextTo),
          admin.from("members").select("id, display_name").eq("household_id", householdId),
        ]);
        if (counts) {
          review = weeklyReviewNotice(
            counts as WeekCounts,
            (allMembers ?? []) as Array<Pick<Member, "id" | "display_name">>,
            (nextBins ?? []) as BinDay[],
            today,
          );
        }
      }

      const occurrences = needEvents ? expandForRange(await loadCalendarRows(householdId), today, addDays(today, 1), tz) : [];

      let todos: TodoLine[] = [];
      let chores: Chore[] = [];
      if (needDigest) {
        const [todoRes, choreRes] = await Promise.all([
          admin
            .from("list_entries")
            .select("id, text, due_date, assigned_to, list:lists!inner(type)")
            .eq("household_id", householdId)
            .eq("status", "open")
            .eq("list.type", "todo"),
          admin.from("chores").select("*").eq("household_id", householdId),
        ]);
        todos = (todoRes.data ?? []) as TodoLine[];
        chores = (choreRes.data ?? []) as Chore[];
      }

      let routines: Routine[] = [];
      let steps: RoutineStep[] = [];
      let completions: Completion[] = [];
      if (needNudge) {
        const [r, s, c] = await Promise.all([
          admin.from("routines").select("*").eq("household_id", householdId),
          admin.from("routine_steps").select("*").eq("household_id", householdId),
          admin.from("completions").select("*").eq("household_id", householdId).eq("for_date", today),
        ]);
        routines = (r.data ?? []) as Routine[];
        steps = (s.data ?? []) as RoutineStep[];
        completions = (c.data ?? []) as Completion[];
      }

      let added: AddedLine[] = [];
      if (needLists) {
        // Lines added to shopping lists in the last 15 minutes.
        const since = new Date(now.getTime() - 15 * 60_000).toISOString();
        const [{ data: lines }, { data: allMembers }] = await Promise.all([
          admin
            .from("list_entries")
            .select("id, list_id, text, added_by, source, list:lists!inner(name, type)")
            .eq("household_id", householdId)
            .eq("status", "open")
            .eq("source", "manual")
            .eq("list.type", "shopping")
            .gte("added_at", since),
          admin.from("members").select("id, user_id, display_name").eq("household_id", householdId),
        ]);
        const byUser = new Map(((allMembers ?? []) as Array<{ id: string; user_id: string; display_name: string }>).map((m) => [m.user_id, m]));
        added = ((lines ?? []) as unknown as Array<{ id: string; list_id: string; text: string; added_by: string | null; list: { name: string } }>).map(
          (l) => ({
            id: l.id,
            list_id: l.list_id,
            list_name: l.list.name,
            text: l.text,
            added_by_member: l.added_by ? (byUser.get(l.added_by) ?? null) : null,
          }),
        );
      }

      // 3d. Per person: work out, claim, send.
      for (const member of people) {
        const prefs = prefsOf(member);
        const devices = subs.filter((s) => s.member_id === member.id);
        const notices: Notice[] = [];

        if (prefs.events) notices.push(...dueEvents(occurrences, now, prefs.event_lead_minutes, tz));
        if (prefs.digest && isTimeFor(nowMinutes, prefs.digest_time)) {
          const d = digest(member, todos, chores, today, mode);
          if (d) notices.push(d);
        }
        if (prefs.bins && isTimeFor(nowMinutes, prefs.bins_time)) {
          const b = binReminder(binDays, today);
          if (b) notices.push(b);
        }
        if (prefs.bins_morning && isTimeFor(nowMinutes, prefs.bins_morning_time)) {
          const b = binMorningReminder(binDays, today);
          if (b) notices.push(b);
        }
        if (review && prefs.weekly_review && member.role !== "child") notices.push(review);
        if (tripsAdult(member)) {
          for (const n of tripNotices) {
            const isCheckin = n.key.startsWith("checkin:");
            if ((isCheckin && prefs.trip_checkin) || (!isCheckin && prefs.id_expiry)) notices.push(n);
          }
        }
        if (prefs.routine_nudge && isTimeFor(nowMinutes, prefs.routine_nudge_time)) {
          notices.push(...routineNudges(member, routines, steps, completions, today, mode));
        }

        // Simple notices: one log key each.
        const won = await claim(member.id, notices.map((n) => n.key));
        for (const n of notices) if (won.has(n.key) && (await sendToDevices(devices, n))) sent++;

        // List additions: claim line by line, then send one notice per list
        // covering only the lines this run won.
        if (prefs.list_added && added.length) {
          const wonLines = await claim(member.id, added.map((l) => `list:${l.id}`));
          const fresh = added.filter((l) => wonLines.has(`list:${l.id}`));
          for (const n of listAdditions(member, fresh)) if (await sendToDevices(devices, n)) sent++;
        }
      }
    } catch (err) {
      console.error("[notify] household failed", householdId, err);
    }
  }
  return { households: householdIds.length, sent };
}
