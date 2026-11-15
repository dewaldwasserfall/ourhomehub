/**
 * The Family board's Today: everyone's day on one wall tablet.
 *
 *   Left:   today's mode (School day / holiday), bins, and the calendar.
 *   Right:  a column per person with today's routine steps, chores, to-dos
 *           and zone tasks, plus "Anyone" for unassigned things.
 *
 * Tapping a row ticks it for that person. Unassigned rows ask "Who did
 * this?". A child's tick shows as waiting until any adult confirms it on
 * their phone; an adult's counts straight away. A mis-tap can be undone on
 * the board until it's confirmed. The rules live in src/lib/board.ts.
 *
 * Admin mode (a parent unlocked the board with their PIN): "+ Grocery" and
 * "+ To-do" appear on the left, and tapping a waiting tick opens Confirm /
 * Not done. See board-admin.tsx and board-add.tsx.
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Avatar } from "@/components/avatar";
import { useHousehold } from "@/components/household-context";
import { BoardAddSheet, type AddKind } from "@/components/board/board-add";
import { useBoardAdmin } from "@/components/board/board-admin";
import { CelebrationLayer } from "@/components/celebration";
import { DishwasherCard } from "@/components/dishwasher-card";
import { Sheet } from "@/components/sheet";
import { useToast } from "@/components/toast";
import { binColour, binList, binsAround } from "@/lib/bins";
import { oneMoreStar } from "@/lib/celebrate";
import { unlockChime } from "@/lib/chime";
import { boardColumns, boardTapAction, type BoardItem, type BoardTodo } from "@/lib/board";
import { expandForRange, groupByDay } from "@/lib/calendar/expand";
import { addDays, dateKey, timeKey, wallTimeOf } from "@/lib/calendar/time";
import { useCalendar } from "@/lib/calendar/use-calendar";
import { friendlyError } from "@/lib/errors";
import { MODE_LABELS } from "@/lib/plan";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import type { DayInfo } from "@/lib/types";
import { usePlanData } from "@/lib/use-plan-data";
import { progressShort, rewardStatus } from "@/lib/rewards";
import { useRewards } from "@/lib/use-rewards";
import { useStars } from "@/lib/use-stars";

/** Friendly messages for the board RPCs' errors. */
function boardError(message: string): string {
  if (message.includes("ask_a_grown_up")) return "Ask a grown-up to undo that one.";
  if (message.includes("assigned_to_someone_else")) return "That one belongs to someone else.";
  return friendlyError({ message });
}

export default function BoardTodayPage() {
  const supabase = getSupabaseBrowserClient();
  const { household, members, memberById, me } = useHousehold();
  const tz = household.timezone;
  const toast = useToast();
  const { admin, adminError } = useBoardAdmin();

  // Step 1: today (rolls over at midnight without a reload).
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const today = dateKey(now, tz);
  const hour = wallTimeOf(now, tz).hour;

  // Step 2: data. The plan and calendar hooks keep themselves live.
  const plan = usePlanData(household.id, addDays(today, -14));
  const calendar = useCalendar(household.id);
  const [dayInfo, setDayInfo] = useState<DayInfo | null>(null);
  const [todos, setTodos] = useState<BoardTodo[]>([]);
  const kidIds = useMemo(() => members.filter((m) => m.role === "child").map((m) => m.id), [members]);
  const stars = useStars(kidIds, today);
  const rewards = useRewards(kidIds, today);

  // 1c. Celebrations: the chime is a per-board switch (me.id is the board's
  //     id here). Sound is only allowed after a tap, so unlock it on the first.
  const [chime, setChime] = useState(false);
  useEffect(() => {
    void supabase
      .from("boards")
      .select("celebrate_sound")
      .eq("id", me.id)
      .maybeSingle<{ celebrate_sound: boolean }>()
      .then(({ data }) => setChime(Boolean(data?.celebrate_sound)));
    window.addEventListener("pointerdown", unlockChime, { passive: true });
    return () => window.removeEventListener("pointerdown", unlockChime);
  }, [supabase, me.id]);

  // 1d. "+1 ★": when a child's headline progress goes up (a tick confirmed),
  //     pop a star on their column for a moment. Not on the first load.
  const lastProgress = useRef<Record<string, number>>({});
  const [pops, setPops] = useState<Record<string, number>>({});
  useEffect(() => {
    const popped: Record<string, number> = {};
    for (const plan of rewards.plans) {
      const now = rewards.progress[plan.id]?.progress;
      if (now === undefined) continue;
      const before = lastProgress.current[plan.id];
      if (before !== undefined && now > before && rewards.headline(plan.member_id)?.id === plan.id) popped[plan.member_id] = Date.now();
      lastProgress.current[plan.id] = now;
    }
    if (Object.keys(popped).length) setPops((p) => ({ ...p, ...popped }));
  }, [rewards.plans, rewards.progress]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (Object.keys(pops).length === 0) return;
    const timer = setTimeout(() => setPops({}), 1400);
    return () => clearTimeout(timer);
  }, [pops]);

  // 2a. Today's mode and to-dos: open ones, and those ticked today.
  const loadDay = useCallback(async () => {
    // Midnight on the tablet's clock (the tablet hangs in the household's time zone).
    const dayStart = new Date(`${today}T00:00:00`).toISOString();
    const [infoRes, todoRes] = await Promise.all([
      supabase.rpc("day_info", { p_date: today }),
      supabase
        .from("list_entries")
        .select("id, text, status, due_date, assigned_to, completed_at, pending, via_board, done_for, confirmed_by, list:lists!inner(type)")
        .eq("list.type", "todo")
        .or(`status.eq.open,and(status.eq.done,completed_at.gte.${dayStart})`),
    ]);
    if (!infoRes.error) setDayInfo(((infoRes.data ?? []) as DayInfo[])[0] ?? null);
    if (!todoRes.error) setTodos((todoRes.data ?? []) as unknown as BoardTodo[]);
  }, [supabase, today]);

  useEffect(() => {
    loadDay();
    const channel = supabase
      .channel(`board-todos:${household.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "list_entries", filter: `household_id=eq.${household.id}` }, () => loadDay())
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase, household.id, loadDay]);

  // Step 3: everyone's column.
  const columns = useMemo(
    () =>
      boardColumns({
        plan,
        todos,
        members,
        today,
        mode: dayInfo?.mode ?? null,
        zoneRotationStart: household.zone_rotation_start,
      }),
    [plan, todos, members, today, dayInfo?.mode, household.zone_rotation_start],
  );

  // Step 4: the calendar strip: today's events, tomorrow's first once they're over.
  const events = useMemo(() => {
    const tomorrow = addDays(today, 1);
    const byDay = groupByDay(expandForRange(calendar.rows, today, tomorrow, tz), today, tomorrow);
    const todays = byDay.get(today) ?? [];
    const upcoming = todays.filter((o) => o.allDay || (o.end && o.end > now));
    return { upcoming, tomorrow: upcoming.length === 0 ? (byDay.get(tomorrow) ?? []).slice(0, 3) : [] };
  }, [calendar.rows, today, tz, now]);
  const bins = binsAround(plan.binDays, today);

  // Step 5: taps.
  const [asking, setAsking] = useState<BoardItem | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const send = useCallback(
    async (item: BoardItem, done: boolean, memberId: string) => {
      setBusy(item.key);
      const { error } =
        item.kind === "todo"
          ? await supabase.rpc("board_set_entry", { p_entry_id: item.id, p_done: done, p_member_id: memberId })
          : await supabase.rpc("board_set_completion", {
              p_kind: item.kind,
              p_item_id: item.id,
              p_for_date: today,
              p_done: done,
              p_member_id: memberId,
            });
      setBusy(null);
      if (error) return void toast.show(boardError(error.message));
      // A child's tick waits for a grown-up: say so.
      if (done && memberById(memberId)?.role === "child") toast.show("Nice! A grown-up will check it.");
      await Promise.all([plan.reload(), loadDay()]);
    },
    [supabase, today, toast, memberById, plan, loadDay],
  );

  // 5a. Admin mode: confirm or reject a waiting tick, and add things.
  const [reviewing, setReviewing] = useState<BoardItem | null>(null);
  const [adding, setAdding] = useState<AddKind | null>(null);
  const review = useCallback(
    async (item: BoardItem, confirm: boolean) => {
      setReviewing(null);
      setBusy(item.key);
      const { error } = await supabase.rpc("board_review_tick", { p_kind: item.kind, p_item_id: item.id, p_confirm: confirm });
      setBusy(null);
      if (error) {
        // "board_locked": the screen locks too; anything else, the usual words.
        const locked = adminError(error.message);
        return void toast.show(locked !== error.message ? locked : boardError(error.message));
      }
      toast.show(confirm ? "Confirmed ★" : "Sent back as not done");
      await Promise.all([plan.reload(), loadDay()]);
    },
    [supabase, toast, adminError, plan, loadDay],
  );
  // Locking closes anything admin-only that was open.
  useEffect(() => {
    if (!admin) {
      setReviewing(null);
      setAdding(null);
    }
  }, [admin]);

  const tap = (item: BoardItem) => {
    if (busy) return;
    if (admin && item.state === "pending") return void setReviewing(item);
    const action = boardTapAction(item);
    if (action.type === "tick") return void send(item, true, action.memberId);
    if (action.type === "ask_who") return void setAsking(item);
    if (action.type === "undo") return void send(item, false, item.doneFor ?? item.assignee ?? "");
    toast.show("Ask a grown-up to undo that one.");
  };

  // Step 6: render.
  const modeLabel = dayInfo ? (dayInfo.mode === "holiday" && dayInfo.label ? dayInfo.label : MODE_LABELS[dayInfo.mode]) : null;

  return (
    <div className="board-today">
      {/* Left: the day, bins and calendar */}
      <aside className="board-side">
        {modeLabel && <div className={`board-mode board-mode--${dayInfo?.mode}`}>{modeLabel}</div>}

        {/* Admin mode: add things */}
        {admin && (
          <div className="board-card board-admin-add">
            <button type="button" className="board-admin-add__button" onClick={() => setAdding("grocery")}>
              <span aria-hidden="true">＋</span> Grocery
            </button>
            <button type="button" className="board-admin-add__button" onClick={() => setAdding("todo")}>
              <span aria-hidden="true">＋</span> To-do
            </button>
          </div>
        )}

        {/* The dishwasher, while it runs or when it's done */}
        <DishwasherCard variant="board" />

        {(bins.today.length > 0 || bins.tomorrow.length > 0) && (
          <div className="board-card board-bins">
            {bins.today.length > 0 && (
              <p className="board-bins__line">
                {bins.today.map((k) => <span key={k} className="bin-dot" style={{ background: binColour(k) }} aria-hidden="true" />)}
                {hour < 12 ? (
                  <span>
                    <strong>{binList(bins.today)}</strong> goes out this morning
                  </span>
                ) : (
                  <span>{binList(bins.today)} collected today</span>
                )}
              </p>
            )}
            {bins.tomorrow.length > 0 && (
              <p className="board-bins__line">
                {bins.tomorrow.map((k) => <span key={k} className="bin-dot" style={{ background: binColour(k) }} aria-hidden="true" />)}
                <span>
                  <strong>{binList(bins.tomorrow)}</strong> goes out tonight
                </span>
              </p>
            )}
          </div>
        )}

        <div className="board-card">
          <h2 className="board-card__title">{events.upcoming.length > 0 ? "Today" : "Tomorrow"}</h2>
          {events.upcoming.length === 0 && events.tomorrow.length === 0 && <p className="board-muted">Nothing on the calendar</p>}
          {[...events.upcoming, ...events.tomorrow].map((occ) => (
            <div key={occ.key} className="board-event">
              <span className="board-event__time">{occ.allDay ? "All day" : timeKey(occ.start!, tz)}</span>
              <span className="board-event__title">{occ.title || "(No title)"}</span>
            </div>
          ))}
        </div>
      </aside>

      {/* Right: a column per person */}
      <section className="board-columns" aria-busy={plan.loading}>
        {!plan.loading && columns.length === 0 && (
          <div className="board-card board-empty">
            <h2 className="board-card__title">All clear</h2>
            <p className="board-muted">Nothing to do today.</p>
          </div>
        )}
        {columns.map((col) => {
          const person = memberById(col.memberId);
          const star = person && person.role === "child" ? stars.stats[person.id] : undefined;
          // A child's headline reward plan: "3/5 ★ Screen time" (or the star total without one).
          const plan = person && person.role === "child" ? rewards.headline(person.id) : undefined;
          const planProgress = plan ? rewards.progress[plan.id] : undefined;
          const almost = !!plan && rewardStatus(planProgress) === "going" && oneMoreStar(plan, planProgress);
          return (
            <div key={col.memberId ?? "anyone"} className={`board-col ${almost ? "board-col--almost" : ""}`}>
              <header className="board-col__head">
                {person ? <Avatar member={person} /> : <span className="board-col__anyone" aria-hidden="true">?</span>}
                <span className="board-col__name">{person ? person.display_name.split(" ")[0] : "Anyone"}</span>
                {plan ? (
                  <span className="board-col__stars" title={plan.title}>
                    {rewardStatus(planProgress) === "going" ? progressShort(plan, planProgress) : "🎉"}
                  </span>
                ) : (
                  star && <span className="board-col__stars">★ {star.earned}</span>
                )}
                {person && pops[person.id] && (
                  <span key={pops[person.id]} className="board-col__pop" aria-hidden="true">
                    +1 ★
                  </span>
                )}
              </header>
              {plan && (
                <span className="board-col__goal">
                  {rewardStatus(planProgress) === "earned"
                    ? `Earned: ${plan.title}`
                    : rewardStatus(planProgress) === "given"
                      ? `${plan.title} ✓`
                      : almost
                        ? `1 more ★! ${plan.title}`
                        : plan.title}
                </span>
              )}
              <div className="board-col__progress" aria-label={`${col.doneCount} of ${col.items.length} done`}>
                <span style={{ width: `${(col.doneCount / col.items.length) * 100}%` }} />
              </div>
              <ul className="board-list">
                {col.items.map((item) => (
                  <li key={item.key}>
                    <button
                      type="button"
                      className={`board-item board-item--${item.state} ${item.overdue ? "board-item--late" : ""}`}
                      onClick={() => tap(item)}
                      disabled={busy === item.key}
                      aria-pressed={item.state !== "open"}
                    >
                      <span className="board-item__check" aria-hidden="true">
                        {item.state === "done" ? "✓" : item.state === "pending" ? "…" : ""}
                      </span>
                      <span className="board-item__text">
                        <span className="board-item__title">{item.title}</span>
                        {item.state === "pending" && (
                          <span className="board-item__note">{admin ? "Tap to confirm" : "Waiting for a grown-up"}</span>
                        )}
                        {item.state === "open" && item.overdue && <span className="board-item__note">Late</span>}
                        {col.memberId === null || item.assignee !== null || !item.doneFor ? null : (
                          <span className="board-item__note">Done by {memberById(item.doneFor)?.display_name.split(" ")[0]}</span>
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </section>

      {/* Who did an unassigned task? */}
      <Sheet open={!!asking} onClose={() => setAsking(null)} title="Who did this?">
        <div className="board-who">
          <p className="board-muted">{asking?.title}</p>
          <div className="board-who__people">
            {members.map((m) => (
              <button
                key={m.id}
                type="button"
                className="board-who__person"
                onClick={() => {
                  const item = asking;
                  setAsking(null);
                  if (item) void send(item, true, m.id);
                }}
              >
                <Avatar member={m} />
                <span>{m.display_name.split(" ")[0]}</span>
              </button>
            ))}
          </div>
        </div>
      </Sheet>
      {/* Admin mode: confirm or reject a waiting tick */}
      <Sheet open={!!reviewing} onClose={() => setReviewing(null)} title="Done?">
        {reviewing && (
          <div className="board-who">
            <p className="board-review__what">
              <Avatar member={memberById(reviewing.doneFor ?? reviewing.assignee ?? "")} />
              <span>
                <strong>{memberById(reviewing.doneFor ?? reviewing.assignee ?? "")?.display_name.split(" ")[0] ?? "Someone"}</strong> ticked{" "}
                <strong>{reviewing.title}</strong>
              </span>
            </p>
            <div className="board-review__actions">
              <button type="button" className="board-review__no" onClick={() => review(reviewing, false)}>
                Not done
              </button>
              <button type="button" className="board-review__yes" onClick={() => review(reviewing, true)}>
                Confirm ✓
              </button>
            </div>
          </div>
        )}
      </Sheet>

      {/* A child earned a reward: the big moment (once per period on this board) */}
      <CelebrationLayer plans={rewards.plans} progress={rewards.progress} sound={chime} />

      <BoardAddSheet kind={adding} today={today} onClose={() => setAdding(null)} onAdded={(m) => toast.show(m)} />
      {toast.node}
    </div>
  );
}
