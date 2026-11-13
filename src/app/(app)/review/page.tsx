/**
 * Week review (adults): what got done this week and what's coming next week.
 *
 *   1. This week, Monday to today: per person, how many routine steps,
 *      chores, zone tasks and to-dos they ticked off (weekly_review RPC),
 *      plus shopping bought and, for those who can see it, grocery spending.
 *   2. Next week, day by day: calendar events, bins, chores due, holidays
 *      starting or ending, and a new zone fortnight.
 *
 * Works offline from the last copy (this week's counts) and the app's other
 * offline copies (calendar and plan).
 */
"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Avatar } from "@/components/avatar";
import { useHousehold } from "@/components/household-context";
import { Navbar } from "@/components/navbar";
import { binColour, binList } from "@/lib/bins";
import { euros, type BudgetPayment } from "@/lib/budget";
import { expandForRange, groupByDay } from "@/lib/calendar/expand";
import { addDays, dateKey, instantOf, timeKey } from "@/lib/calendar/time";
import { useCalendar } from "@/lib/calendar/use-calendar";
import { isNetworkError, readCache, writeCache } from "@/lib/offline";
import { describeDay } from "@/lib/plan";
import { nextWeekDays, ranked, reviewWeeks, totalDone, weekHeadline, type WeekCounts } from "@/lib/review";
import { canSeeFinances } from "@/lib/roles";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useBudget } from "@/lib/use-budget";
import { usePlanData } from "@/lib/use-plan-data";
import type { DayInfo } from "@/lib/types";

/** How many events to list per day before "and N more". */
const EVENTS_PER_DAY = 4;

const rangeFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const fmt = (date: string) => rangeFormat.format(new Date(`${date}T12:00:00Z`));

/** "12 routine steps · 3 chores · 1 to-do" (zero counts left out). */
function breakdown(p: { steps: number; chores: number; zone_tasks: number; todos: number }): string {
  const part = (n: number, one: string, many: string) => (n ? `${n} ${n === 1 ? one : many}` : null);
  return [
    part(p.steps, "routine step", "routine steps"),
    part(p.chores, "chore", "chores"),
    part(p.zone_tasks, "zone task", "zone tasks"),
    part(p.todos, "to-do", "to-dos"),
  ]
    .filter(Boolean)
    .join(" · ");
}

export default function ReviewPage() {
  const supabase = getSupabaseBrowserClient();
  const { household, members, me, meIsAdult } = useHousehold();
  const tz = household.timezone;
  const today = dateKey(new Date(), tz);
  const weeks = reviewWeeks(today);
  const financeOk = canSeeFinances(me);

  const plan = usePlanData(household.id, weeks.from);
  const calendar = useCalendar(household.id);
  const budget = useBudget(household.id, tz, financeOk);

  // Step 1: this week's counts (adults only; the RPC refuses children).
  const [counts, setCounts] = useState<WeekCounts | null>(null);
  useEffect(() => {
    if (!meIsAdult) return;
    const cacheKey = `review:${household.id}:${weeks.from}`;
    supabase.rpc("weekly_review", { p_from: weeks.from, p_to: weeks.to }).then(({ data, error }) => {
      if (error) {
        if (isNetworkError(error)) setCounts(readCache<WeekCounts>(cacheKey));
        return;
      }
      setCounts(data as WeekCounts);
      writeCache(cacheKey, data);
    });
  }, [supabase, meIsAdult, household.id, weeks.from, weeks.to]);

  // Step 2: day_info for this Friday and next week (holidays, school days).
  const [days, setDays] = useState<Map<string, DayInfo>>(new Map());
  useEffect(() => {
    if (!meIsAdult) return;
    const dates = [addDays(weeks.nextFrom, -3), ...Array.from({ length: 7 }, (_, i) => addDays(weeks.nextFrom, i))];
    Promise.all(dates.map((d) => supabase.rpc("day_info", { p_date: d }))).then((results) => {
      const map = new Map<string, DayInfo>();
      results.forEach(({ data }, i) => {
        const info = ((data ?? []) as DayInfo[])[0];
        if (info) map.set(dates[i], info);
      });
      setDays(map);
    });
  }, [supabase, meIsAdult, weeks.nextFrom]);

  // Step 3: groceries spent this week (finance members only; RLS agrees).
  const [weekSpent, setWeekSpent] = useState<number | null>(null);
  useEffect(() => {
    if (!financeOk || !budget.connection?.account_id) return;
    const since = instantOf(weeks.from, "00:00", tz).toISOString();
    supabase
      .from("bunq_payments")
      .select("amount_cents, kind")
      .gte("created_at", since)
      .then(({ data }) => {
        if (!data) return;
        // Spending is negative; refunds are positive and reduce it. Top-ups don't count.
        const rows = data as Array<Pick<BudgetPayment, "amount_cents" | "kind">>;
        setWeekSpent(rows.filter((p) => p.kind !== "topup").reduce((sum, p) => sum - p.amount_cents, 0));
      });
  }, [supabase, financeOk, budget.connection?.account_id, weeks.from, tz]);

  // Step 4: next week, day by day.
  const names = useMemo(() => new Map(members.map((m) => [m.id, m.display_name])), [members]);
  const preview = useMemo(
    () =>
      nextWeekDays({
        nextFrom: weeks.nextFrom,
        days,
        modeBefore: days.get(addDays(weeks.nextFrom, -3)) ?? null,
        binDays: plan.binDays,
        chores: plan.chores,
        zones: plan.zones,
        rotationStart: household.zone_rotation_start,
      }),
    [weeks.nextFrom, days, plan.binDays, plan.chores, plan.zones, household.zone_rotation_start],
  );
  const eventsByDay = useMemo(
    () => groupByDay(expandForRange(calendar.rows, weeks.nextFrom, weeks.nextTo, tz), weeks.nextFrom, weeks.nextTo),
    [calendar.rows, weeks.nextFrom, weeks.nextTo, tz],
  );

  if (!meIsAdult) {
    return (
      <main className="screen">
        <Navbar title="Week review" />
        <section className="section">
          <div className="group empty">
            <span className="empty__title">For grown-ups</span>
            Your stars are on the <Link href="/stars">Stars</Link> page.
          </div>
        </section>
      </main>
    );
  }

  const people = counts ? ranked(counts) : [];
  const quiet = members.filter((m) => counts && !people.some((p) => p.member_id === m.id));

  return (
    <main className="screen">
      <Navbar title="Week review" subtitle={`This week ${fmt(weeks.from)} – ${fmt(weeks.to)} · next week ${fmt(weeks.nextFrom)} – ${fmt(weeks.nextTo)}`} />

      {/* 1. This week */}
      <section className="section">
        <div className="section__header">
          <span className="section__header-title">This week</span>
        </div>
        <div className="group">
          <div className="row">
            <span className="row__body">
              <span className="row__title review-headline">{counts ? weekHeadline(counts, names) : "Loading…"}</span>
            </span>
          </div>
          {people.map((p) => {
            const member = members.find((m) => m.id === p.member_id);
            if (!member) return null;
            return (
              <div key={p.member_id} className="row">
                <Avatar member={member} size="mini" />
                <span className="row__body">
                  <span className="row__title">{member.display_name}</span>
                  <span className="row__subtitle">{breakdown(p)}</span>
                </span>
                <span className="row__trailing review-total">{totalDone(p)}</span>
              </div>
            );
          })}
          {counts && counts.shopping_bought > 0 && (
            <div className="row">
              <span className="row__body">
                <span className="row__title">Shopping</span>
                <span className="row__subtitle">Items ticked off the shopping lists</span>
              </span>
              <span className="row__trailing review-total">{counts.shopping_bought}</span>
            </div>
          )}
          {financeOk && weekSpent !== null && (
            <Link href="/budget" className="row row--link">
              <span className="row__body">
                <span className="row__title">Groceries</span>
                <span className="row__subtitle">
                  {budget.summary ? `${euros(budget.summary.remainingCents)} left this budget month` : "Spent this week"}
                </span>
              </span>
              <span className="row__trailing review-total">{euros(weekSpent)}</span>
            </Link>
          )}
        </div>
        {quiet.length > 0 && people.length > 0 && (
          <p className="section__footer">Nothing ticked off by {quiet.map((m) => m.display_name.split(" ")[0]).join(", ")}.</p>
        )}
      </section>

      {/* 2. Next week */}
      <section className="section">
        <div className="section__header">
          <span className="section__header-title">Next week</span>
          <Link href="/calendar" className="section__header-action">
            Calendar
          </Link>
        </div>
        <div className="group">
          {preview.map((day) => {
            const events = eventsByDay.get(day.date) ?? [];
            const nothing = events.length === 0 && day.items.length === 0;
            return (
              <div key={day.date} className="row review-day">
                <span className="review-day__date">{describeDay(day.date, today)}</span>
                <span className="row__body review-day__body">
                  {nothing && <span className="review-day__quiet">Nothing planned</span>}

                  {/* Notes first: holiday, zone, bins, chores */}
                  {day.items.map((item, i) => {
                    if (item.type === "mode") return <span key={i} className="review-note review-note--mode">{item.text}</span>;
                    if (item.type === "zone") return <span key={i} className="review-note">New zone: {item.zone}</span>;
                    if (item.type === "bins")
                      return (
                        <span key={i} className="review-note">
                          {item.kinds.map((k) => (
                            <span key={k} className="bin-dot" style={{ background: binColour(k) }} aria-hidden="true" />
                          ))}
                          Bins: {binList(item.kinds)}
                        </span>
                      );
                    const who = item.assignee ? names.get(item.assignee)?.split(" ")[0] : null;
                    return (
                      <span key={i} className="review-note">
                        {item.title}
                        {who ? ` · ${who}` : ""}
                        {item.overdue ? " · overdue" : ""}
                      </span>
                    );
                  })}

                  {/* Then the calendar */}
                  {events.slice(0, EVENTS_PER_DAY).map((occ) => (
                    <span key={occ.key} className="review-event">
                      <span className="review-event__time">{occ.allDay || !occ.start ? "All day" : timeKey(occ.start, tz)}</span>
                      {occ.title || "(No title)"}
                    </span>
                  ))}
                  {events.length > EVENTS_PER_DAY && (
                    <span className="review-day__quiet">and {events.length - EVENTS_PER_DAY} more</span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </section>
    </main>
  );
}
