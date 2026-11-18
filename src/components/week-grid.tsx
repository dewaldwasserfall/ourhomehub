/**
 * The week grid (see src/lib/week-grid.ts for the cell rules).
 *
 * One child, one reward: its tasks down the left, the chosen days across the
 * top, a star per cell. Used:
 *   * on the board, when a week-grid child's column opens full screen;
 *   * on the Stars page on phones (parents act from there).
 *
 * Taps:
 *   * the child (board, locked): today's ☆ ticks it (⏳, a parent reviews
 *     it); tapping ⏳ again takes it back;
 *   * a parent (board unlocked, or on their phone):
 *       - a cell: mark done (counts at once, any day up to today),
 *         confirm / not done, pay out this star, or undo;
 *       - a day's header: confirm all waiting, or pay out all that day's stars.
 *   * ‹ › moves between weeks (not past this one).
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Sheet } from "@/components/sheet";
import { addDays } from "@/lib/calendar/time";
import type { RewardPlan, RewardPlanTask } from "@/lib/rewards";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import type { Chore, Member, RoutineStep, ZoneTask } from "@/lib/types";
import { buildWeekGrid, dayActions, paidTickIds, weekStart, type GridCell, type GridRow, type GridTask } from "@/lib/week-grid";

type Tick = { id: string; kind: GridTask["kind"]; item_id: string; for_date: string; done_for: string | null; pending: boolean };

export function WeekGrid({
  child,
  plan,
  planTasks,
  steps,
  chores,
  zoneTasks,
  days,
  today,
  surface,
  admin,
  onMessage,
  adminError = (m) => m,
}: {
  child: Member;
  plan: RewardPlan;
  planTasks: RewardPlanTask[];
  steps: RoutineStep[];
  chores: Chore[];
  zoneTasks: ZoneTask[];
  days: number[];
  today: string;
  /** Which RPCs to use: the board's (as the parent who unlocked it) or a phone's. */
  surface: "board" | "phone";
  /** A parent can act: board unlocked, or a parent on their phone. */
  admin: boolean;
  /** Show a short message (toast). */
  onMessage: (message: string) => void;
  /** Board: turns "board_locked" into a message and locks the screen. */
  adminError?: (message: string) => string;
}) {
  const supabase = getSupabaseBrowserClient();

  // Step 1: the rows: this reward's tasks, in the order they were linked.
  const tasks = useMemo<GridTask[]>(
    () =>
      planTasks.flatMap((t): GridTask[] => {
        if (t.kind === "step") {
          const s = steps.find((x) => x.id === t.task_id);
          return s ? [{ kind: "step", id: s.id, title: s.title, weekdays: s.weekdays }] : [];
        }
        if (t.kind === "chore") {
          const c = chores.find((x) => x.id === t.task_id);
          return c ? [{ kind: "chore", id: c.id, title: c.title, everyDay: c.unit === "day" && c.every_n === 1, nextDue: c.next_due }] : [];
        }
        const z = zoneTasks.find((x) => x.id === t.task_id);
        return z ? [{ kind: "zone_task", id: z.id, title: z.title }] : [];
      }),
    [planTasks, steps, chores, zoneTasks],
  );

  // Step 2: the week shown (this week, or an earlier one).
  const [weeksBack, setWeeksBack] = useState(0);
  const monday = addDays(weekStart(today), -7 * weeksBack);
  const sunday = addDays(monday, 6);

  // Step 3: the week's ticks and what's already been paid out; live.
  const [ticks, setTicks] = useState<Tick[]>([]);
  const [paid, setPaid] = useState<Set<string>>(new Set());
  const load = useCallback(async () => {
    const ids = tasks.map((t) => t.id);
    if (ids.length === 0) return;
    const [tickRes, payoutRes, periodRes] = await Promise.all([
      supabase
        .from("completions")
        .select("id, kind, item_id, for_date, done_for, pending")
        .in("item_id", ids)
        .gte("for_date", monday)
        .lte("for_date", sunday),
      supabase.from("reward_payouts").select("ticks").eq("plan_id", plan.id),
      supabase.from("reward_periods").select("ticks").eq("plan_id", plan.id),
    ]);
    if (!tickRes.error) setTicks((tickRes.data ?? []) as Tick[]);
    setPaid(paidTickIds([...((payoutRes.data ?? []) as Array<{ ticks: unknown }>), ...((periodRes.data ?? []) as Array<{ ticks: unknown }>)]));
  }, [supabase, tasks, monday, sunday, plan.id]);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    void load();
    const later = () => {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void load(), 300);
    };
    const channel = supabase
      .channel(`week-grid-${child.id}-${plan.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "completions" }, later)
      .on("postgres_changes", { event: "*", schema: "public", table: "reward_payouts" }, later)
      .on("postgres_changes", { event: "*", schema: "public", table: "reward_periods" }, later)
      .subscribe();
    return () => {
      clearTimeout(timer.current);
      void supabase.removeChannel(channel);
    };
  }, [supabase, load, child.id, plan.id]);

  const grid = useMemo(
    () => buildWeekGrid({ tasks, memberId: child.id, days, monday, today, ticks, paidIds: paid }),
    [tasks, child.id, days, monday, today, ticks, paid],
  );

  // Step 4: actions. Each one through the board's or the phone's RPC.
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => PromiseLike<{ error: { message: string } | null }>, done?: string) => {
    setBusy(true);
    const { error } = await fn();
    setBusy(false);
    if (error) return onMessage(adminError(error.message).replace(/^.*(parents_only).*$/, "Only a parent can do that."));
    if (done) onMessage(done);
    await load();
  };
  const credit = (task: GridTask, date: string, on: boolean) =>
    run(
      () =>
        supabase.rpc(surface === "board" ? "board_credit_completion" : "credit_completion", {
          p_kind: task.kind,
          p_item_id: task.id,
          p_for_date: date,
          p_member_id: child.id,
          p_done: on,
        }),
      on ? "Done ★" : "Taken back",
    );
  const review = (ids: string[], confirm: boolean) =>
    run(
      () =>
        surface === "board"
          ? supabase.rpc("board_review_ticks", { p_completion_ids: ids, p_confirm: confirm })
          : supabase.rpc(confirm ? "confirm_ticks" : "reject_ticks", { p_completion_ids: ids, p_entry_ids: null }),
      confirm ? (ids.length > 1 ? `Confirmed ${ids.length} ★` : "Confirmed ★") : "Sent back as not done",
    );
  const payOut = (ids: string[]) =>
    run(
      () => supabase.rpc(surface === "board" ? "board_pay_out_stars" : "pay_out_stars", { p_plan_id: plan.id, p_completion_ids: ids }),
      ids.length > 1 ? `Paid out ${ids.length} stars` : "Paid out ★",
    );
  // The child, on the board: today's cell only, through the usual board tick.
  const childTick = (task: GridTask, cell: GridCell) =>
    run(() =>
      supabase.rpc("board_set_completion", {
        p_kind: task.kind,
        p_item_id: task.id,
        p_for_date: today,
        p_done: cell.state === "empty",
        p_member_id: child.id,
      }),
    );

  // Step 5: taps.
  const [cellMenu, setCellMenu] = useState<{ row: GridRow; cell: GridCell } | null>(null);
  const [dayMenu, setDayMenu] = useState<string | null>(null);
  const tapCell = (row: GridRow, cell: GridCell) => {
    if (busy || cell.state === "na" || cell.state === "future") return;
    if (admin) return setCellMenu({ row, cell });
    if (surface === "board" && cell.date === today && (cell.state === "empty" || cell.state === "pending")) return void childTick(row.task, cell);
    if (cell.state === "missed") onMessage("Ask a grown-up to fill in an earlier day.");
  };

  const dayLabel = (iso: string) =>
    new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${iso}T12:00:00Z`));
  const symbol: Record<GridCell["state"], string> = { empty: "☆", missed: "☆", pending: "⏳", done: "★", paid: "★", future: "·", na: "–" };
  const cellLabel: Record<GridCell["state"], string> = {
    empty: "not done yet",
    missed: "not done",
    pending: "waiting for a parent",
    done: "done",
    paid: "paid out",
    future: "still to come",
    na: "not on this day",
  };
  const actions = dayMenu ? dayActions(grid, dayMenu) : { waiting: [], payable: [] };
  // Time / cash rewards earned per star pay through the wallet instead
  // (My Wallet: use time, pay out): no paying out single stars here.
  const canPayStars = !((plan.reward_type === "time" || plan.reward_type === "cash") && plan.value_per === "star");

  return (
    <div className={`week-grid week-grid--${surface}`}>
      {/* Week switcher */}
      <div className="week-grid__nav">
        <button type="button" className="week-grid__arrow" onClick={() => setWeeksBack((w) => w + 1)} aria-label="Previous week">
          ‹
        </button>
        <span className="week-grid__week">{weeksBack === 0 ? "This week" : weeksBack === 1 ? "Last week" : `Week of ${dayLabel(monday)}`}</span>
        <button
          type="button"
          className="week-grid__arrow"
          onClick={() => setWeeksBack((w) => Math.max(0, w - 1))}
          disabled={weeksBack === 0}
          aria-label="Next week"
        >
          ›
        </button>
      </div>

      {tasks.length === 0 ? (
        <p className="board-muted">This reward has no tasks linked. A parent can add them under Stars → Edit.</p>
      ) : (
        <div className="week-grid__scroll">
          <table className="week-grid__table">
            <thead>
              <tr>
                <th scope="col" className="week-grid__corner">
                  {plan.title}
                </th>
                {grid.dates.map((d) => (
                  <th key={d} scope="col" className={d === today ? "week-grid__today" : undefined}>
                    {admin && d <= today ? (
                      <button
                        type="button"
                        className="week-grid__day"
                        onClick={() => setDayMenu(d)}
                        aria-label={`${dayLabel(d)}: confirm or pay out`}
                      >
                        {dayLabel(d)}
                      </button>
                    ) : (
                      dayLabel(d)
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grid.rows.map((row) => (
                <tr key={`${row.task.kind}:${row.task.id}`}>
                  <th scope="row" className="week-grid__task">
                    {row.task.title}
                  </th>
                  {row.cells.map((cell) => (
                    <td key={cell.date} className={cell.date === today ? "week-grid__today" : undefined}>
                      <button
                        type="button"
                        className={`week-grid__cell week-grid__cell--${cell.state}`}
                        onClick={() => tapCell(row, cell)}
                        disabled={busy || cell.state === "na" || cell.state === "future"}
                        aria-label={`${row.task.title}, ${dayLabel(cell.date)}: ${cellLabel[cell.state]}`}
                      >
                        {symbol[cell.state]}
                      </button>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" className="week-grid__task">
                  Stars
                </th>
                {grid.totals.map((t) => (
                  <td key={t.date} className={t.date === today ? "week-grid__today" : undefined}>
                    {t.date <= today ? `${t.stars}/${t.possible}` : ""}
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      <p className="week-grid__legend">
        ☆ to do · ⏳ waiting for a parent · ★ counts · <span className="week-grid__paid-sample">★</span> paid out
      </p>

      {/* A parent: one cell */}
      <Sheet
        open={!!cellMenu}
        onClose={() => setCellMenu(null)}
        title={cellMenu ? `${cellMenu.row.task.title}, ${dayLabel(cellMenu.cell.date)}` : ""}
      >
        {cellMenu && (
          <div className="week-grid__menu">
            {(cellMenu.cell.state === "empty" || cellMenu.cell.state === "missed") && (
              <button
                type="button"
                className="week-grid__action week-grid__action--go"
                onClick={() => {
                  setCellMenu(null);
                  void credit(cellMenu.row.task, cellMenu.cell.date, true);
                }}
              >
                ★ Mark done for {child.display_name.split(" ")[0]}
              </button>
            )}
            {cellMenu.cell.state === "pending" && (
              <>
                <button
                  type="button"
                  className="week-grid__action week-grid__action--go"
                  onClick={() => {
                    setCellMenu(null);
                    void review([cellMenu.cell.completionId!], true);
                  }}
                >
                  Confirm ✓
                </button>
                {canPayStars && (
                  <button
                    type="button"
                    className="week-grid__action week-grid__action--pay"
                    onClick={() => {
                      setCellMenu(null);
                      void payOut([cellMenu.cell.completionId!]);
                    }}
                  >
                    Confirm and pay out
                  </button>
                )}
                <button
                  type="button"
                  className="week-grid__action"
                  onClick={() => {
                    setCellMenu(null);
                    void review([cellMenu.cell.completionId!], false);
                  }}
                >
                  Not done
                </button>
              </>
            )}
            {cellMenu.cell.state === "done" && (
              <>
                {canPayStars && (
                  <button
                    type="button"
                    className="week-grid__action week-grid__action--pay"
                    onClick={() => {
                      setCellMenu(null);
                      void payOut([cellMenu.cell.completionId!]);
                    }}
                  >
                    Pay out this star
                  </button>
                )}
                <button
                  type="button"
                  className="week-grid__action"
                  onClick={() => {
                    setCellMenu(null);
                    void credit(cellMenu.row.task, cellMenu.cell.date, false);
                  }}
                >
                  Undo: not done
                </button>
              </>
            )}
            {cellMenu.cell.state === "paid" && <p className="board-muted">This star has been paid out.</p>}
          </div>
        )}
      </Sheet>

      {/* A parent: a whole day */}
      <Sheet open={!!dayMenu} onClose={() => setDayMenu(null)} title={dayMenu ? dayLabel(dayMenu) : ""}>
        {dayMenu && (
          <div className="week-grid__menu">
            <button
              type="button"
              className="week-grid__action week-grid__action--go"
              disabled={actions.waiting.length === 0}
              onClick={() => {
                setDayMenu(null);
                void review(actions.waiting, true);
              }}
            >
              Confirm all waiting ({actions.waiting.length})
            </button>
            {canPayStars && (
              <button
                type="button"
                className="week-grid__action week-grid__action--pay"
                disabled={actions.payable.length === 0}
                onClick={() => {
                  setDayMenu(null);
                  void payOut(actions.payable);
                }}
              >
                Pay out all stars ({actions.payable.length})
              </button>
            )}
            {!canPayStars && (
              <p className="board-muted">
                Each confirmed star goes into {child.display_name.split(" ")[0]}&rsquo;s wallet: use or pay it out from My Wallet.
              </p>
            )}
            {canPayStars && actions.waiting.length === 0 && actions.payable.length === 0 && (
              <p className="board-muted">Nothing to confirm or pay out on this day.</p>
            )}
          </div>
        )}
      </Sheet>
    </div>
  );
}
