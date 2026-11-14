/**
 * Today: the home screen. What each person needs to see and do today.
 *
 * Top to bottom:
 *   1. Header       greeting, the date and today's mode (School day /
 *                   "Autumn holiday, day 3 of 9" / Weekend)
 *   2. Up next      today's calendar events, the next one highlighted;
 *                   tomorrow's first event once today's are over
 *   3. Routines     the routines for this time of day open, others folded
 *   4. To do        to-dos and chores that are due, overdue or undated
 *   5. Zone         this fortnight's zone, progress and the next tasks
 *   6. Groceries    one line that opens the list
 *
 * Who sees what: things assigned to someone show only on their Today;
 * unassigned things show on every adult's Today and disappear for everyone
 * once ticked. Children see only what is theirs. Adults can switch on
 * "Everyone's" to see the whole household's day.
 */
"use client";

import { AnimatePresence, motion } from "framer-motion";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Avatar } from "@/components/avatar";
import { CheckCircle } from "@/components/check-circle";
import { useHousehold } from "@/components/household-context";
import { CartIcon, ChevronDownIcon, ChevronRightIcon, GlowSparkle, ReviewIcon } from "@/components/icons";
import { isReviewDay } from "@/lib/review";
import { Navbar } from "@/components/navbar";
import { useToast } from "@/components/toast";
import { expandForRange, groupByDay } from "@/lib/calendar/expand";
import { addDays, dateKey, daysBetweenKeys, timeKey, wallTimeOf } from "@/lib/calendar/time";
import type { Occurrence } from "@/lib/calendar/types";
import { useCalendar } from "@/lib/calendar/use-calendar";
import { friendlyError } from "@/lib/errors";
import { choreDueOn, describeDay, MODE_LABELS, stepApplies, TIME_OF_DAY_LABELS, timeOfDayAt, zoneFortnight } from "@/lib/plan";
import { BudgetBar, statusText } from "@/components/budget-bar";
import { euros } from "@/lib/budget";
import { binColour, binList, binsAround } from "@/lib/bins";
import { useBudget } from "@/lib/use-budget";
import { useStars } from "@/lib/use-stars";
import { enqueue, isNetworkError, readCache, SYNCED_EVENT, writeCache } from "@/lib/offline";
import { StarCard } from "@/components/star-card";
import { canSeeFinances, canTick } from "@/lib/roles";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import type { CompletionKind, DayInfo, ListEntry, Member, TimeOfDay } from "@/lib/types";
import { usePlanData } from "@/lib/use-plan-data";

/** How long a ticked row shows its check before it moves or disappears. */
const TICK_SETTLE_MS = 650;

const longDate = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
const TIME_ORDER: Record<TimeOfDay, number> = { morning: 0, afternoon: 1, evening: 2 };

/** Greeting that matches the household's time of day. */
function greeting(hour: number, name: string) {
  const part = hour < 5 ? "Good night" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  return `${part}, ${name.split(" ")[0]}`;
}

/** One thing to tick on Today (a step, a to-do, a chore or a zone task). */
interface TickItem {
  key: string;
  kind: CompletionKind | "todo";
  id: string;
  title: string;
  subtitle?: string;
  overdue?: boolean;
  assignee: string | null;
  done: boolean;
}

// -----------------------------------------------------------------------------
// Step 1: a tickable row
// -----------------------------------------------------------------------------

function TickRow({
  item,
  checked,
  canToggle,
  assignee,
  onToggle,
}: {
  item: TickItem;
  checked: boolean;
  canToggle: boolean;
  assignee?: Member;
  onToggle: () => void;
}) {
  return (
    <motion.div
      className="row-wrap"
      layout="position"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ type: "spring", stiffness: 500, damping: 42, opacity: { duration: 0.18 } }}
    >
      <div className={`row ${item.done ? "row--done" : ""}`}>
        {canToggle ? (
          <CheckCircle checked={checked} onToggle={onToggle} label={checked ? `Mark ${item.title} as not done` : `Tick off ${item.title}`} />
        ) : (
          <span className="check-placeholder" aria-hidden="true" />
        )}
        <span className="row__body">
          <span className="row__title">{item.title}</span>
          {item.subtitle && (
            <span className="row__subtitle">
              <span className={item.overdue ? "due due--overdue" : "due"}>{item.subtitle}</span>
            </span>
          )}
        </span>
        {assignee && (
          <span className="row__trailing">
            <Avatar member={assignee} size="mini" />
          </span>
        )}
      </div>
    </motion.div>
  );
}

// -----------------------------------------------------------------------------
// Step 2: the screen
// -----------------------------------------------------------------------------

export default function TodayPage() {
  const supabase = getSupabaseBrowserClient();
  const { household, me, meIsAdult, memberById } = useHousehold();
  const tz = household.timezone;
  const toast = useToast();

  // Step 2a: "now" in the household's zone. Re-evaluated every minute so the
  //          next event and the day itself roll over without a reload.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const today = dateKey(now, tz);
  const hour = wallTimeOf(now, tz).hour;

  // Step 2b: data. Completions from two weeks back cover this fortnight's zone.
  const plan = usePlanData(household.id, addDays(today, -14));
  const calendar = useCalendar(household.id);
  const [dayInfo, setDayInfo] = useState<DayInfo | null>(null);
  const [todos, setTodos] = useState<Array<ListEntry & { list: { name: string } }>>([]);
  const [groceries, setGroceries] = useState<{ id: string; name: string; open: number; suggested: number } | null>(null);
  const [showEveryone, setShowEveryone] = useState(false);
  // Grocery budget: only loads for members the owner gave access.
  const budget = useBudget(household.id, tz, canSeeFinances(me));
  // Children see their own stars on Today.
  const isChild = me.role === "child";
  const stars = useStars(isChild ? [me.id] : [], today);

  // Step 2c: today's mode, to-dos and the groceries line.
  const loadDay = useCallback(async () => {
    const [infoRes, todoRes, listRes, groceryRes] = await Promise.all([
      supabase.rpc("day_info", { p_date: today }),
      supabase
        .from("list_entries")
        .select("*, list:lists!inner(name, type)")
        .eq("status", "open")
        .eq("list.type", "todo"),
      supabase.from("lists").select("id, name").eq("is_default", true).maybeSingle<{ id: string; name: string }>(),
      supabase.from("list_entries").select("list_id, source, list:lists!inner(is_default)").eq("status", "open").eq("list.is_default", true),
    ]);
    // Offline: the copy from the last time Today loaded (same day only).
    if (infoRes.error && isNetworkError(infoRes.error)) {
      const cached = readCache<{ day: string; info: DayInfo; todos: typeof todos; groceries: typeof groceries }>(`today:${household.id}`);
      if (cached && cached.day === today) {
        setDayInfo(cached.info);
        setTodos(cached.todos);
        setGroceries(cached.groceries);
      }
      return;
    }
    const info = ((infoRes.data ?? []) as DayInfo[])[0] ?? null;
    const todoLines = (todoRes.data ?? []) as Array<ListEntry & { list: { name: string } }>;
    let grocery: typeof groceries = null;
    if (listRes.data) {
      const lines = (groceryRes.data ?? []) as Array<{ source: string }>;
      grocery = { ...listRes.data, open: lines.length, suggested: lines.filter((l) => l.source === "suggested").length };
    }
    setDayInfo(info);
    setTodos(todoLines);
    setGroceries(grocery);
    writeCache(`today:${household.id}`, { day: today, info, todos: todoLines, groceries: grocery });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, today, household.id]);

  // Reload when the day changes, when holidays change, and live on list changes.
  const overridesVersion = plan.overrides.map((o) => `${o.id}:${o.start_date}:${o.end_date}:${o.kind}`).join("|");
  useEffect(() => {
    loadDay();
  }, [loadDay, overridesVersion]);
  useEffect(() => {
    const channel = supabase
      .channel(`today:${household.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "list_entries", filter: `household_id=eq.${household.id}` }, () => loadDay())
      .subscribe();
    const onVisible = () => document.visibilityState === "visible" && (setNow(new Date()), loadDay());
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(SYNCED_EVENT, loadDay);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(SYNCED_EVENT, loadDay);
      supabase.removeChannel(channel);
    };
  }, [supabase, household.id, loadDay]);

  const mode = dayInfo?.mode ?? null;

  /**
   * Should a thing assigned to `assignee` show on my Today?
   *  - mine: always
   *  - adults also see unassigned things and the children's (the kids do
   *    their chores; a grown-up ticks them off)
   *  - "Everyone's" adds the other adults' things too
   */
  const isMine = useCallback(
    (assignee: string | null) => {
      if (assignee === me.id) return true;
      if (!meIsAdult) return false;
      if (showEveryone || assignee === null) return true;
      return memberById(assignee)?.role === "child";
    },
    [showEveryone, meIsAdult, me.id, memberById],
  );

  const isDone = useCallback(
    (kind: CompletionKind, id: string, forDate: string) =>
      plan.completions.some((c) => c.kind === kind && c.item_id === id && c.for_date === forDate),
    [plan.completions],
  );

  // ---------------------------------------------------------------------------
  // Step 3: work out each section
  // ---------------------------------------------------------------------------

  // 3a. Up next: today's events; tomorrow's first once today's are over.
  const events = useMemo(() => {
    const tomorrow = addDays(today, 1);
    const byDay = groupByDay(expandForRange(calendar.rows, today, tomorrow, tz), today, tomorrow);
    const todays = byDay.get(today) ?? [];
    const upcoming = todays.filter((o) => o.allDay || (o.end && o.end > now));
    const nextTimed = upcoming.find((o) => !o.allDay);
    return {
      today: todays,
      nextKey: nextTimed?.key,
      allPast: todays.length > 0 && upcoming.length === 0,
      tomorrowFirst: upcoming.length === 0 ? (byDay.get(tomorrow) ?? [])[0] : undefined,
    };
  }, [calendar.rows, today, tz, now]);

  // 3b. Routines: steps that apply today and are mine, grouped by routine.
  const routines = useMemo(() => {
    if (!mode) return [];
    return plan.routines
      .filter((r) => r.active)
      .map((routine) => {
        const items: TickItem[] = plan.steps
          .filter((s) => s.routine_id === routine.id && stepApplies(s, today, mode))
          .map((s) => {
            const assignee = s.assigned_to ?? routine.owner_member;
            return { key: `step:${s.id}`, kind: "step" as const, id: s.id, title: s.title, assignee, done: isDone("step", s.id, today) };
          })
          .filter((i) => isMine(i.assignee));
        return { routine, items };
      })
      .filter((r) => r.items.length > 0)
      .sort((a, b) => TIME_ORDER[a.routine.time_of_day] - TIME_ORDER[b.routine.time_of_day] || a.routine.sort_order - b.routine.sort_order);
  }, [plan.routines, plan.steps, mode, today, isDone, isMine]);

  // 3c. To do: to-dos (due, overdue or undated) and chores that are due.
  const toDo = useMemo(() => {
    const items: Array<TickItem & { sortKey: string }> = [];
    for (const t of todos) {
      if (t.due_date && t.due_date > today) continue;
      if (!isMine(t.assigned_to)) continue;
      items.push({
        key: `todo:${t.id}`,
        kind: "todo",
        id: t.id,
        title: t.text,
        subtitle: t.due_date ? (t.due_date < today ? `Due ${describeDay(t.due_date, today).toLowerCase()}` : "Due today") : t.list.name,
        overdue: !!t.due_date && t.due_date < today,
        assignee: t.assigned_to,
        done: false,
        sortKey: t.due_date ?? "9999",
      });
    }
    if (mode) {
      for (const c of plan.chores) {
        if (!choreDueOn(c, today, mode) || !isMine(c.assigned_to)) continue;
        const late = daysBetweenKeys(c.next_due, today);
        items.push({
          key: `chore:${c.id}`,
          kind: "chore",
          id: c.id,
          title: c.title,
          subtitle: late > 0 ? `Chore, due ${describeDay(c.next_due, today).toLowerCase()}` : "Chore",
          overdue: late > 0,
          assignee: c.assigned_to,
          done: false,
          sortKey: c.next_due,
        });
      }
    }
    return items.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  }, [todos, plan.chores, mode, today, isMine]);

  // 3d. This fortnight's zone.
  const zone = useMemo(() => {
    if (!household.zone_rotation_start) return null;
    const fortnight = zoneFortnight(household.zone_rotation_start, today, plan.zones.length);
    if (!fortnight) return null;
    const active = plan.zones[fortnight.index];
    const tasks = plan.zoneTasks.filter((t) => t.zone_id === active.id);
    const items: TickItem[] = tasks.map((t) => ({
      key: `zone:${t.id}`,
      kind: "zone_task" as const,
      id: t.id,
      title: t.title,
      assignee: t.assigned_to,
      done: isDone("zone_task", t.id, fortnight.start),
    }));
    return { zone: active, fortnight, total: items.length, doneCount: items.filter((i) => i.done).length, mine: items.filter((i) => isMine(i.assignee)) };
  }, [household.zone_rotation_start, today, plan.zones, plan.zoneTasks, isDone, isMine]);

  // ---------------------------------------------------------------------------
  // Step 4: ticking things off
  // ---------------------------------------------------------------------------

  // Rows show their check for a moment before the data catches up.
  const [settling, setSettling] = useState<Set<string>>(new Set());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const toggle = useCallback(
    (item: TickItem) => {
      // Second tap while settling cancels the tick.
      const pending = timers.current.get(item.key);
      if (pending) {
        clearTimeout(pending);
        timers.current.delete(item.key);
        setSettling((s) => new Set([...s].filter((k) => k !== item.key)));
        return;
      }
      const write = async () => {
        if (item.kind === "todo") {
          const status = item.done ? "open" : "done";
          const { error } = await supabase.from("list_entries").update({ status }).eq("id", item.id);
          if (error && isNetworkError(error)) {
            // Offline: send later; hide it from today's list now.
            enqueue({ type: "set_status", entryId: item.id, status });
            setTodos((current) => current.filter((t) => t.id !== item.id));
            return;
          }
          if (error) toast.show(friendlyError(error));
          await loadDay();
        } else {
          const { error } = await supabase.rpc("set_completion", {
            p_kind: item.kind,
            p_item_id: item.id,
            p_for_date: today,
            p_done: !item.done,
          });
          if (error && isNetworkError(error)) {
            // Offline: send later; show the tick now.
            enqueue({ type: "set_completion", kind: item.kind, itemId: item.id, forDate: today, done: !item.done });
            plan.setData((d) => ({
              ...d,
              completions: item.done
                ? d.completions.filter((c) => !(c.kind === item.kind && c.item_id === item.id && c.for_date === today))
                : [
                    ...d.completions,
                    { id: `pending-${item.id}`, household_id: household.id, kind: item.kind as "step", item_id: item.id, for_date: today, done_by: me.id, done_for: item.assignee ?? me.id, done_at: new Date().toISOString() },
                  ],
              chores: item.kind === "chore" ? d.chores.filter((c) => c.id !== item.id) : d.chores,
            }));
            return;
          }
          if (error) toast.show(friendlyError(error));
          await plan.reload();
        }
      };
      // Children earn a star for everything they tick off themselves.
      if (isChild && !item.done) toast.show("+1 star");
      // Unticking (or ticking a routine step, which stays in place) is instant;
      // to-dos, chores and zone tasks leave the list, so they show their tick first.
      if (item.done || item.kind === "step") return void write();
      setSettling((s) => new Set(s).add(item.key));
      timers.current.set(
        item.key,
        setTimeout(async () => {
          timers.current.delete(item.key);
          await write();
          setSettling((s) => new Set([...s].filter((k) => k !== item.key)));
        }, TICK_SETTLE_MS),
      );
    },
    [supabase, today, toast, loadDay, plan, isChild, household.id, me.id],
  );

  const tickRow = (item: TickItem) => (
    <TickRow
      key={item.key}
      item={item}
      checked={item.done || settling.has(item.key)}
      canToggle={canTick(me, item.assignee)}
      // Avatars only when it helps: someone else's, or everyone's view.
      assignee={item.assignee && (item.assignee !== me.id || showEveryone) ? memberById(item.assignee) : undefined}
      onToggle={() => toggle(item)}
    />
  );

  // Folded routines: by default the unfinished ones for this time of day are
  // open; once someone taps a header, their choice is kept.
  const [openRoutines, setOpenRoutines] = useState<Set<string> | null>(null);
  const currentTime = timeOfDayAt(hour);
  const openByDefault = (r: (typeof routines)[number]) =>
    r.routine.time_of_day === currentTime && !r.items.every((i) => i.done);
  const isOpen = (r: (typeof routines)[number]) => (openRoutines ? openRoutines.has(r.routine.id) : openByDefault(r));
  const toggleRoutine = (id: string) =>
    setOpenRoutines((prev) => {
      const next = new Set(prev ?? routines.filter(openByDefault).map((r) => r.routine.id));
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // ---------------------------------------------------------------------------
  // Step 5: render
  // ---------------------------------------------------------------------------

  const dayLabel = useMemo(() => {
    if (!dayInfo) return null;
    if (dayInfo.mode === "holiday" && dayInfo.label && dayInfo.period_start && dayInfo.period_end) {
      const length = daysBetweenKeys(dayInfo.period_start, dayInfo.period_end) + 1;
      return length > 1
        ? `${dayInfo.label}, day ${daysBetweenKeys(dayInfo.period_start, today) + 1} of ${length}`
        : dayInfo.label;
    }
    return MODE_LABELS[dayInfo.mode];
  }, [dayInfo, today]);

  const loading = plan.loading || !dayInfo;
  const nothingToDo = !loading && routines.length === 0 && toDo.length === 0 && (!zone || zone.mine.every((i) => i.done));

  const eventRow = (occ: Occurrence, isNext: boolean, past: boolean) => (
    <Link key={occ.key} href="/calendar" className={`row row--link today-event ${isNext ? "today-event--next" : ""} ${past ? "today-event--past" : ""}`}>
      <span className="event-row__time">
        {occ.allDay ? "All day" : timeKey(occ.start!, tz)}
        {!occ.allDay && <span className="event-row__time-end">{timeKey(occ.end!, tz)}</span>}
      </span>
      <span className={`event-row__bar ${occ.allDay ? "event-row__bar--allday" : ""}`} aria-hidden="true" />
      <span className="row__body">
        <span className="row__title">{occ.title || "(No title)"}</span>
        {isNext && <span className="row__subtitle today-event__label">Up next</span>}
        {!isNext && occ.row.location && <span className="row__subtitle">{occ.row.location}</span>}
      </span>
    </Link>
  );

  return (
    <main className="screen screen--wide">
      <Navbar
        title="Today"
        subtitle={greeting(hour, me.display_name)}
        trailing={
          meIsAdult && (
            <button
              type="button"
              className="nav-button"
              aria-pressed={showEveryone}
              onClick={() => setShowEveryone((v) => !v)}
            >
              {showEveryone ? "Just mine" : "Everyone’s"}
            </button>
          )
        }
      />

      {/* Desktop: three columns. Phones: one column, in this same order. */}
      <div className="today-grid">
      <div className="today-col">
      {/* 1. The day */}
      <section className="section">
        <div className="day-banner">
          <span className="day-banner__date">{longDate.format(new Date(`${today}T12:00:00Z`))}</span>
          {dayLabel && <span className={`day-banner__mode day-banner__mode--${dayInfo?.mode}`}>{dayLabel}</span>}
        </div>
      </section>

      {/* Bins. Many households put them out in the morning, so collection day
          gets the same weight as the evening before:
            morning of collection   "Plastic goes out this morning"
            later that day          "Plastic collected today" (quieter)
            evening before          "GFT goes out tonight" */}
      {(() => {
        const bins = binsAround(plan.binDays, today);
        if (!bins.today.length && !bins.tomorrow.length) return null;
        const dots = (kinds: typeof bins.today) => (
          <span className="bin-dots" aria-hidden="true">
            {kinds.map((k) => <span key={k} className="bin-dot" style={{ background: binColour(k) }} />)}
          </span>
        );
        const morning = hour < 12;
        return (
          <section className="section">
            <Link href="/household/bins" className="group bin-banner">
              {bins.today.length > 0 && (
                <span className={morning ? "bin-banner__line" : "bin-banner__line bin-banner__line--muted"}>
                  {dots(bins.today)}
                  {morning ? (
                    <span>
                      <strong>{binList(bins.today)}</strong> goes out this morning
                    </span>
                  ) : (
                    <span>{binList(bins.today)} collected today</span>
                  )}
                </span>
              )}
              {bins.tomorrow.length > 0 && (
                <span className="bin-banner__line">
                  {dots(bins.tomorrow)}
                  <span>
                    <strong>{binList(bins.tomorrow)}</strong> goes out tonight
                  </span>
                </span>
              )}
            </Link>
          </section>
        );
      })()}

      {/* Sunday: a nudge to look back at the week (adults) */}
      {!isChild && isReviewDay(today) && (
        <section className="section">
          <Link href="/review" className="group row row--link">
            <span className="row__icon" style={{ background: "#30b0c7" }}>
              <ReviewIcon size={19} strokeWidth={2} />
            </span>
            <span className="row__body">
              <span className="row__title">Week review</span>
              <span className="row__subtitle">What got done this week, and what&rsquo;s coming</span>
            </span>
            <ChevronRightIcon className="row__chevron" size={16} />
          </Link>
        </section>
      )}

      {/* Stars (children) */}
      {isChild && (
        <section className="section">
          <Link href="/stars" className="group" style={{ display: "block" }}>
            <StarCard stats={stars.stats[me.id]} next={stars.nextReward(me.id)} />
          </Link>
        </section>
      )}

      {/* 2. Up next */}
      {calendar.status && (
        <section className="section">
          <div className="section__header">
            <span className="section__header-title">Calendar</span>
            <Link href="/calendar" className="section__header-action">
              Open
            </Link>
          </div>
          <div className="group">
            {events.today.length === 0 && !events.tomorrowFirst && (
              <div className="row" style={{ color: "var(--ink-2)" }}>
                <span className="row__body">Nothing on the calendar today</span>
              </div>
            )}
            {events.today.map((occ) =>
              eventRow(occ, occ.key === events.nextKey, !occ.allDay && !!occ.end && occ.end <= now),
            )}
            {events.tomorrowFirst && (
              <Link href="/calendar" className="row row--link today-event">
                <span className="event-row__time">{events.tomorrowFirst.allDay ? "All day" : timeKey(events.tomorrowFirst.start!, tz)}</span>
                <span className="event-row__bar" aria-hidden="true" />
                <span className="row__body">
                  <span className="row__title">{events.tomorrowFirst.title || "(No title)"}</span>
                  <span className="row__subtitle">Tomorrow{events.allPast ? ", first up" : ""}</span>
                </span>
              </Link>
            )}
          </div>
        </section>
      )}

      </div>

      <div className="today-col">
      {loading && (
        <section className="section">
          <div className="group" aria-busy="true" aria-label="Loading today">
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton" />
            ))}
          </div>
        </section>
      )}

      {/* 3. Routines */}
      {routines.map((r) => {
        const { routine, items } = r;
        const doneCount = items.filter((i) => i.done).length;
        const complete = doneCount === items.length;
        const open = isOpen(r);
        const owner = memberById(routine.owner_member);
        return (
          <section key={routine.id} className="section">
            <div className="section__header">
              <button
                type="button"
                className="section__header-title routine-toggle"
                aria-expanded={open}
                onClick={() => toggleRoutine(routine.id)}
              >
                {routine.name}
                <ChevronDownIcon size={14} style={{ transform: open ? "none" : "rotate(-90deg)", transition: "transform .2s" }} />
              </button>
              <span className={complete ? "routine-progress routine-progress--done" : "routine-progress"}>
                {complete ? "All done" : `${doneCount} of ${items.length}`}
              </span>
            </div>
            {open ? (
              <div className="group">
                <AnimatePresence initial={false}>{items.map(tickRow)}</AnimatePresence>
              </div>
            ) : (
              <button
                type="button"
                className="group routine-folded"
                onClick={() => toggleRoutine(routine.id)}
              >
                <span className="progress-track" aria-hidden="true">
                  <span className="progress-fill" style={{ width: `${(doneCount / items.length) * 100}%` }} />
                </span>
                <span className="routine-folded__label">
                  {TIME_OF_DAY_LABELS[routine.time_of_day]}
                  {owner && owner.id !== me.id ? `, ${owner.display_name.split(" ")[0]}` : ""}
                </span>
              </button>
            )}
          </section>
        );
      })}

      {/* 4. To do */}
      {toDo.length > 0 && (
        <section className="section">
          <div className="section__header">
            <span className="section__header-title">To do</span>
            <span className="row__count">{toDo.length}</span>
          </div>
          <div className="group">
            <AnimatePresence initial={false}>{toDo.map(tickRow)}</AnimatePresence>
          </div>
        </section>
      )}

      {/* Nothing to do */}
      {nothingToDo && (
        <section className="section">
          <div className="group empty">
            <span className="empty__title">Nothing left to do today</span>
            {meIsAdult ? "Add routines, chores and zones on the Household tab." : "Enjoy your day."}
          </div>
        </section>
      )}
      </div>

      <div className="today-col">
      {/* 5. This fortnight's zone */}
      {zone && zone.mine.length > 0 && (
        <section className="section">
          <div className="section__header">
            <span className="section__header-title">Zone: {zone.zone.name}</span>
            <span>
              {zone.doneCount} of {zone.total} done
            </span>
          </div>
          <div className="group">
            <AnimatePresence initial={false}>
              {/* Next three not done, then anything ticked today stays visible */}
              {[...zone.mine.filter((i) => !i.done).slice(0, 3), ...zone.mine.filter((i) => i.done && settling.has(i.key))].map(tickRow)}
            </AnimatePresence>
            {zone.mine.every((i) => i.done) && (
              <div className="row" style={{ color: "var(--ink-2)" }}>
                <span className="row__body">All done for this fortnight</span>
              </div>
            )}
          </div>
          <p className="section__footer">
            Until {describeDay(zone.fortnight.end, today)}, day {zone.fortnight.day} of 14.
          </p>
        </section>
      )}

      {/* Grocery budget (only for those who can see finances) */}
      {budget.summary && (
        <section className="section">
          <Link href="/budget" className="group budget-card">
            <span className="budget-card__top">
              <span className="row__title">Groceries budget</span>
              <span className={`budget-status budget-status--${budget.summary.status}`}>{statusText(budget.summary)}</span>
            </span>
            <BudgetBar summary={budget.summary} />
            <span className="row__subtitle">
              {euros(budget.summary.spentCents)} of {euros(budget.summary.budgetCents)} · {euros(budget.summary.perDayLeftCents)} a day left
            </span>
          </Link>
        </section>
      )}

      {/* 6. Groceries */}
      {groceries && (
        <section className="section">
          <div className="group">
            <Link href={`/lists/${groceries.id}`} className="row row--link">
              <span className="row__icon" style={{ background: "var(--accent)" }}>
                <CartIcon size={19} strokeWidth={2} />
              </span>
              <span className="row__body">
                <span className="row__title">{groceries.name}</span>
                <span className="row__subtitle">{groceries.open === 0 ? "Nothing to buy" : `${groceries.open} to buy`}</span>
              </span>
              {groceries.suggested > 0 && (
                <span className="row__trailing" style={{ gap: 4, fontSize: 13 }} aria-label={`${groceries.suggested} suggested`}>
                  <GlowSparkle size={14} id="today-spark" />
                  <span className="glow-text">{groceries.suggested}</span>
                </span>
              )}
              <ChevronRightIcon className="row__chevron" size={16} />
            </Link>
          </div>
        </section>
      )}
      </div>
      </div>
      {toast.node}
    </main>
  );
}
