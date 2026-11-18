/**
 * Stars: each child's stars, streak and reward plans.
 *
 *   * A reward plan repeats daily, weekly or once (a savings goal), with a
 *     goal of N stars or "all linked tasks". Its linked tasks (the child
 *     objects) show underneath, ticked when done this day/week.
 *   * Children see their own plans and progress.
 *   * Parents (the owner, and adults marked as a parent) add, edit and pause
 *     plans, and mark an earned reward as Given.
 *
 * Progress comes from the database (reward_progress), from confirmed ticks.
 */
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Avatar } from "@/components/avatar";
import { useHousehold } from "@/components/household-context";
import { CheckIcon, PlusIcon } from "@/components/icons";
import { Navbar } from "@/components/navbar";
import { Segmented } from "@/components/segmented";
import { Sheet } from "@/components/sheet";
import { CelebrationLayer } from "@/components/celebration";
import { StarCard } from "@/components/star-card";
import { useToast } from "@/components/toast";
import { WeekGrid } from "@/components/week-grid";
import { addDays, dateKey } from "@/lib/calendar/time";
import { friendlyError } from "@/lib/errors";
import { PERIOD_LABELS, historyLines, linkedTaskDone, type RewardHistoryEntry, progressText, rewardStatus, type RewardPeriod, type RewardPlan, type RewardPlanTask } from "@/lib/rewards";
import { isParent } from "@/lib/roles";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { usePlanData } from "@/lib/use-plan-data";
import { useRewards } from "@/lib/use-rewards";
import { useStars } from "@/lib/use-stars";

/** A task a plan can link to, with a readable label. */
interface TaskOption {
  kind: RewardPlanTask["kind"];
  id: string;
  title: string;
  group: string;
}

/** What the plan editor holds. */
interface Draft {
  id: string | null;
  memberId: string;
  title: string;
  period: RewardPeriod;
  goal: "stars" | "all_tasks";
  starsNeeded: string;
  counts: "all" | "linked";
  carryOver: boolean;
  tasks: Set<string>; // "kind:id"
}

const taskKey = (kind: string, id: string) => `${kind}:${id}`;

export default function StarsPage() {
  const supabase = getSupabaseBrowserClient();
  const { household, members, me, memberById, updateMember } = useHousehold();
  const toast = useToast();
  const parent = isParent(me);
  const today = dateKey(new Date(), household.timezone);
  const kids = members.filter((m) => m.role === "child" && (me.role !== "child" || m.id === me.id));
  const kidIds = kids.map((k) => k.id);
  const { stats } = useStars(kidIds, today);
  const rewards = useRewards(kidIds, today);
  // Titles of linked tasks, and ticks since a week before the week began.
  const plan = usePlanData(household.id, addDays(today, -14));

  // Step 1b: rewards already given, with the ticks that earned each one
  //          (newest first; reloads when a reward is given).
  const [history, setHistory] = useState<RewardHistoryEntry[]>([]);
  const [openEntry, setOpenEntry] = useState<string | null>(null);
  const loadHistory = useCallback(async () => {
    const { data } = await supabase
      .from("reward_periods")
      .select("id, plan_id, period_start, given_at, given_by, stars_used, ticks, plan:reward_plans(title, member_id)")
      .order("given_at", { ascending: false })
      .limit(60);
    setHistory((data ?? []) as unknown as RewardHistoryEntry[]);
  }, [supabase]);
  useEffect(() => {
    void loadHistory();
  }, [loadHistory, rewards.progress]);
  const givenDay = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: household.timezone });

  // Step 1c: a child's board view (parents): List, or Week grid with its
  //          days and which reward's tasks make the rows.
  const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const [view, setView] = useState<{ memberId: string; style: "list" | "week_grid"; days: number[]; planId: string | null } | null>(null);
  const openView = (memberId: string) => {
    const m = memberById(memberId);
    setView({
      memberId,
      style: m?.board_style ?? "list",
      days: m?.board_days?.length ? m.board_days : [1, 2, 3, 4, 5],
      planId: m?.board_plan_id ?? null,
    });
  };
  const viewSummary = (memberId: string) => {
    const m = memberById(memberId);
    if (m?.board_style !== "week_grid") return "List of today's tasks";
    const days = m.board_days?.length ? m.board_days : [1, 2, 3, 4, 5];
    const range =
      days.join(",") === "1,2,3,4,5" ? "Mon–Fri" : days.join(",") === "1,2,3,4,5,6,7" ? "Every day" : days.map((d) => DAY_NAMES[d - 1]).join(", ");
    const planTitle = rewards.plans.find((p) => p.id === m.board_plan_id)?.title ?? rewards.plansFor(memberId)[0]?.title;
    return `Week grid, ${range}${planTitle ? ` · ${planTitle}` : ""}`;
  };
  async function saveView() {
    if (!view) return;
    const { error } = await supabase.rpc("set_board_view", {
      p_member_id: view.memberId,
      p_style: view.style,
      p_days: view.days,
      p_plan_id: view.planId,
    });
    if (error) return void toast.show(friendlyError(error));
    updateMember(view.memberId, { board_style: view.style, board_days: view.days, board_plan_id: view.planId });
    setView(null);
    toast.show("Board view saved");
  }

  // Step 1: the tasks a child's plan can link to (theirs, or anyone's).
  const optionsFor = (memberId: string): TaskOption[] => {
    const owned = (assignee: string | null) => assignee === null || assignee === memberId;
    const routineById = new Map(plan.routines.map((r) => [r.id, r]));
    return [
      ...plan.steps
        .filter((s) => {
          const r = routineById.get(s.routine_id);
          return r?.active && (s.assigned_to ?? r.owner_member) === memberId;
        })
        .map((s) => ({ kind: "step" as const, id: s.id, title: s.title, group: routineById.get(s.routine_id)?.name ?? "Routine" })),
      ...plan.chores.filter((c) => owned(c.assigned_to)).map((c) => ({ kind: "chore" as const, id: c.id, title: c.title, group: "Chores" })),
      ...plan.zoneTasks
        .filter((t) => owned(t.assigned_to))
        .map((t) => ({ kind: "zone_task" as const, id: t.id, title: t.title, group: plan.zones.find((z) => z.id === t.zone_id)?.name ?? "Zone" })),
    ];
  };
  const titleOf = (t: RewardPlanTask) =>
    (t.kind === "step"
      ? plan.steps.find((s) => s.id === t.task_id)?.title
      : t.kind === "chore"
        ? plan.chores.find((c) => c.id === t.task_id)?.title
        : plan.zoneTasks.find((z) => z.id === t.task_id)?.title) ?? "A task that was removed";

  // Step 2: the plan editor (parents).
  const [draft, setDraft] = useState<Draft | null>(null);
  const openNew = (memberId: string) =>
    setDraft({ id: null, memberId, title: "", period: "week", goal: "stars", starsNeeded: "20", counts: "all", carryOver: true, tasks: new Set() });
  const openEdit = (p: RewardPlan) =>
    setDraft({
      id: p.id,
      memberId: p.member_id,
      title: p.title,
      period: p.period,
      goal: p.goal,
      starsNeeded: String(p.stars_needed ?? 10),
      counts: p.counts,
      carryOver: p.carry_over,
      tasks: new Set(rewards.tasksFor(p.id).map((t) => taskKey(t.kind, t.task_id))),
    });

  async function save() {
    if (!draft || !draft.title.trim()) return;
    // Step 2a: "all tasks" only makes sense with linked tasks.
    const counts = draft.goal === "all_tasks" ? "linked" : draft.counts;
    if (counts === "linked" && draft.tasks.size === 0) return void toast.show("Pick at least one task.");
    const fields = {
      household_id: household.id,
      member_id: draft.memberId,
      title: draft.title.trim(),
      period: draft.period,
      goal: draft.goal,
      stars_needed: draft.goal === "stars" ? Math.max(1, Math.min(1000, parseInt(draft.starsNeeded, 10) || 1)) : null,
      counts,
      carry_over: draft.carryOver,
    };
    // Step 2b: the plan, then its links (replaced wholesale).
    const res = draft.id
      ? await supabase.from("reward_plans").update(fields).eq("id", draft.id).select("id").single()
      : await supabase.from("reward_plans").insert({ ...fields, counts_from: today }).select("id").single();
    if (res.error) return void toast.show(friendlyError(res.error));
    const planId = (res.data as { id: string }).id;
    await supabase.from("reward_plan_tasks").delete().eq("plan_id", planId);
    if (counts === "linked") {
      const rows = [...draft.tasks].map((k) => {
        const [kind, id] = k.split(":");
        return { plan_id: planId, household_id: household.id, kind, task_id: id };
      });
      const { error } = await supabase.from("reward_plan_tasks").insert(rows);
      if (error) return void toast.show(friendlyError(error));
    }
    setDraft(null);
    await rewards.reload();
  }

  // Step 3: pause (keeps history) or give.
  const [confirm, setConfirm] = useState<string | null>(null);
  async function pause(p: RewardPlan) {
    if (confirm !== `pause:${p.id}`) return setConfirm(`pause:${p.id}`);
    setConfirm(null);
    const { error } = await supabase.from("reward_plans").update({ active: false }).eq("id", p.id);
    if (error) return void toast.show(friendlyError(error));
    setDraft(null);
    await rewards.reload();
  }
  async function give(p: RewardPlan) {
    if (confirm !== `give:${p.id}`) return setConfirm(`give:${p.id}`);
    setConfirm(null);
    const { error } = await supabase.rpc("give_reward", { p_plan_id: p.id });
    if (error) return void toast.show(friendlyError(error));
    toast.show(`Given: ${p.title}`);
    await rewards.reload();
  }

  const draftOptions = useMemo(() => (draft ? optionsFor(draft.memberId) : []), [draft?.memberId, plan]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <main className="screen">
      <Navbar title="Stars" subtitle="Each reward counts its own stars: every tick, or only the tasks it lists" />

      {kids.length === 0 && (
        <section className="section">
          <div className="group empty">
            <span className="empty__title">No children in the household</span>
            Stars are for children&rsquo;s accounts.
          </div>
        </section>
      )}

      {kids.map((kid) => {
        const kidPlans = rewards.plansFor(kid.id);
        const headline = rewards.headline(kid.id);
        return (
          <section key={kid.id} className="section">
            <div className="section__header">
              <span className="section__header-title star-kid">
                <Avatar member={kid} size="mini" />
                {kid.display_name}
              </span>
              {parent && (
                <button type="button" className="section__header-action" onClick={() => openNew(kid.id)}>
                  Add reward
                </button>
              )}
            </div>
            <div className="group">
              <StarCard stats={stats[kid.id]} plan={headline} progress={headline ? rewards.progress[headline.id] : undefined} />
            </div>

            {/* Step 4: each plan, with its linked tasks underneath */}
            {kidPlans.map((p) => {
              const prog = rewards.progress[p.id];
              const status = rewardStatus(prog);
              const linked = p.counts === "linked" ? rewards.tasksFor(p.id) : [];
              const startIso = prog ? new Date(`${prog.period_start}T00:00:00`).toISOString() : new Date().toISOString();
              return (
                <div key={p.id} className="group reward-plan">
                  <div className="row">
                    <span className="row__body">
                      <span className="row__title">
                        {p.title}
                        <span className="reward-plan__period">{PERIOD_LABELS[p.period]}</span>
                      </span>
                      <span className="row__subtitle">
                        {status === "earned" ? "Earned! " : status === "given" ? "Given ✓ · " : ""}
                        {progressText(p, prog)}
                        {p.goal === "stars" && p.period !== "once" && !p.carry_over ? " · starts fresh each " + (p.period === "day" ? "day" : "week") : ""}
                      </span>
                    </span>
                    {parent && (
                      <span className="row__trailing">
                        {status === "earned" && (
                          <button type="button" className="chip-button chip-button--strong" onClick={() => give(p)}>
                            {confirm === `give:${p.id}` ? "Tap to confirm" : "Give"}
                          </button>
                        )}
                        <button type="button" className="chip-button" onClick={() => openEdit(p)}>
                          Edit
                        </button>
                      </span>
                    )}
                  </div>
                  {linked.map((t) => {
                    const done = linkedTaskDone(t, kid.id, startIso, plan.completions);
                    return (
                      <div key={taskKey(t.kind, t.task_id)} className="row reward-plan__task">
                        <span className={`reward-plan__check ${done ? "reward-plan__check--done" : ""}`} aria-hidden="true">
                          {done && <CheckIcon size={12} strokeWidth={3} />}
                        </span>
                        <span className="row__body">{titleOf(t)}</span>
                      </div>
                    );
                  })}
                </div>
              );
            })}
            {kidPlans.length === 0 && parent && (
              <p className="section__footer">No rewards yet. Add one: daily, weekly, or a savings goal.</p>
            )}

            {/* Step 4b: the week grid (children set to it): parents confirm,
                fill in and pay out stars here; the child sees it read-only. */}
            {kid.board_style === "week_grid" &&
              (() => {
                const gridPlan = kidPlans.find((p) => p.id === kid.board_plan_id) ?? kidPlans[0];
                if (!gridPlan) return null;
                return (
                  <div className="group week-grid-group">
                    <WeekGrid
                      child={kid}
                      plan={gridPlan}
                      planTasks={rewards.tasksFor(gridPlan.id)}
                      steps={plan.steps}
                      chores={plan.chores}
                      zoneTasks={plan.zoneTasks}
                      days={kid.board_days?.length ? kid.board_days : [1, 2, 3, 4, 5]}
                      today={today}
                      surface="phone"
                      admin={parent}
                      onMessage={(m) => toast.show(m)}
                    />
                  </div>
                );
              })()}

            {/* Step 4c: how this child's column opens on the board (parents) */}
            {parent && (
              <div className="group">
                <button type="button" className="row row--pressable" onClick={() => openView(kid.id)}>
                  <span className="row__body">
                    <span className="row__title">Board view</span>
                    <span className="row__subtitle">{viewSummary(kid.id)}</span>
                  </span>
                  <span className="row__trailing row__subtitle">Change</span>
                </button>
              </div>
            )}

            {/* Step 5: rewards given, newest first; tap one for what earned it */}
            {(() => {
              const given = history.filter((h) => h.plan?.member_id === kid.id).slice(0, 15);
              if (given.length === 0) return null;
              return (
                <>
                  <div className="section__header reward-history__header">
                    <span className="section__header-title">History</span>
                  </div>
                  <div className="group">
                    {given.map((h) => {
                      const lines = historyLines(h, household.timezone);
                      const open = openEntry === h.id;
                      const by = h.given_by ? memberById(h.given_by)?.display_name.split(" ")[0] : null;
                      return (
                        <div key={h.id}>
                          <button type="button" className="row row--pressable" aria-expanded={open} onClick={() => setOpenEntry(open ? null : h.id)}>
                            <span className="row__body">
                              <span className="row__title">{h.plan?.title ?? "A removed reward"}</span>
                              <span className="row__subtitle">
                                Given {givenDay.format(new Date(h.given_at))}
                                {by ? ` by ${by}` : ""}
                                {lines.length ? ` · ${lines.length} ${lines.length === 1 ? "thing" : "things"} earned it` : ""}
                              </span>
                            </span>
                            <span className="row__trailing reward-history__chevron" aria-hidden="true">
                              {open ? "▴" : "▾"}
                            </span>
                          </button>
                          {open && (
                            <ul className="reward-history__ticks">
                              {lines.length === 0 && <li className="row__subtitle">No record of the ticks for this one.</li>}
                              {lines.map((line, i) => (
                                <li key={i}>
                                  <span className="reward-history__star" aria-hidden="true">
                                    ★
                                  </span>
                                  {line}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </>
              );
            })()}
          </section>
        );
      })}

      {/* The plan editor */}
      <Sheet
        open={!!draft}
        onClose={() => setDraft(null)}
        title={draft?.id ? "Edit reward" : `New reward${draft ? ` for ${memberById(draft.memberId)?.display_name.split(" ")[0] ?? ""}` : ""}`}
        leading={
          <button type="button" className="nav-button" onClick={() => setDraft(null)}>
            Cancel
          </button>
        }
        trailing={
          <button type="button" className="nav-button nav-button--strong" onClick={save} disabled={!draft?.title.trim()}>
            Save
          </button>
        }
      >
        {draft && (
          <div className="sheet__stack">
            <input
              className="input"
              aria-label="Reward"
              placeholder="e.g. Screen time, Pizza Friday, €2"
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              maxLength={80}
              autoFocus={!draft.id}
            />
            <Segmented
              label="Repeats"
              value={draft.period}
              onChange={(period) => setDraft({ ...draft, period })}
              options={[
                { value: "day", label: "Daily" },
                { value: "week", label: "Weekly" },
                { value: "once", label: "Once" },
              ]}
            />
            <Segmented
              label="Goal"
              value={draft.goal}
              onChange={(goal) => setDraft({ ...draft, goal, counts: goal === "all_tasks" ? "linked" : draft.counts })}
              options={[
                { value: "stars", label: "Stars" },
                { value: "all_tasks", label: "All tasks done" },
              ]}
            />
            {draft.goal === "stars" && (
              <div className="group">
                <label className="form-row">
                  <span className="form-row__label">Stars needed</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    className="pill-input"
                    style={{ width: 80, textAlign: "center" }}
                    min={1}
                    max={1000}
                    value={draft.starsNeeded}
                    onChange={(e) => setDraft({ ...draft, starsNeeded: e.target.value })}
                  />
                </label>
                {draft.period !== "once" && (
                  <div className="form-row">
                    <span className="form-row__label">Leftover stars carry over</span>
                    <button
                      type="button"
                      role="switch"
                      className="switch"
                      aria-label="Leftover stars carry over"
                      aria-checked={draft.carryOver}
                      onClick={() => setDraft({ ...draft, carryOver: !draft.carryOver })}
                    />
                  </div>
                )}
              </div>
            )}
            {draft.goal === "stars" && (
              <Segmented
                label="Stars from"
                value={draft.counts}
                onChange={(counts) => setDraft({ ...draft, counts })}
                options={[
                  { value: "all", label: "Everything" },
                  { value: "linked", label: "Only these tasks" },
                ]}
              />
            )}

            {/* The child objects: tasks that count */}
            {draft.counts === "linked" && (
              <>
                <div className="section__header" style={{ padding: "0 4px" }}>
                  <span className="section__header-title">Tasks that count</span>
                  <span>{draft.tasks.size}</span>
                </div>
                <div className="group">
                  {draftOptions.length === 0 && <div className="row row__subtitle">No routine steps, chores or zone tasks for this child yet.</div>}
                  {draftOptions.map((o, i) => {
                    const k = taskKey(o.kind, o.id);
                    const on = draft.tasks.has(k);
                    const showGroup = i === 0 || draftOptions[i - 1].group !== o.group;
                    return (
                      <div key={k}>
                        {showGroup && (
                          <div className="row supply-task-group">
                            <span className="row__subtitle">{o.group}</span>
                          </div>
                        )}
                        <button
                          type="button"
                          className="row row--pressable"
                          aria-pressed={on}
                          onClick={() => {
                            const tasks = new Set(draft.tasks);
                            if (on) tasks.delete(k);
                            else tasks.add(k);
                            setDraft({ ...draft, tasks });
                          }}
                        >
                          <span className={`reward-plan__check ${on ? "reward-plan__check--done" : ""}`} aria-hidden="true">
                            {on && <CheckIcon size={12} strokeWidth={3} />}
                          </span>
                          <span className="row__body">{o.title}</span>
                        </button>
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            <p className="section__footer" style={{ padding: 0 }}>
              <PlusIcon size={12} style={{ verticalAlign: "-1px" }} /> Stars count once a grown-up has confirmed the tick. Weeks run Monday to Sunday.
            </p>

            {draft.id && (
              <div className="group">
                <button type="button" className="row row--pressable" onClick={() => pause(rewards.plans.find((p) => p.id === draft.id)!)}>
                  <span className="row__body row__title" style={{ color: "var(--red, #ff3b30)" }}>
                    {confirm === `pause:${draft.id}` ? "Tap again to remove" : "Remove reward"}
                  </span>
                </button>
              </div>
            )}
          </div>
        )}
      </Sheet>
      {/* The child's own phone celebrates an earned reward (once per period) */}
      {me.role === "child" && <CelebrationLayer plans={rewards.plans} progress={rewards.progress} />}
      {/* A child's board view */}
      <Sheet
        open={!!view}
        onClose={() => setView(null)}
        title={view ? `Board view for ${memberById(view.memberId)?.display_name.split(" ")[0] ?? ""}` : ""}
        leading={
          <button type="button" className="nav-button" onClick={() => setView(null)}>
            Cancel
          </button>
        }
        trailing={
          <button type="button" className="nav-button nav-button--strong" onClick={saveView} disabled={!view || view.days.length === 0}>
            Save
          </button>
        }
      >
        {view && (
          <div className="sheet__stack">
            <Segmented
              label="When their column is tapped on the board"
              value={view.style}
              onChange={(style) => setView({ ...view, style })}
              options={[
                { value: "list", label: "List" },
                { value: "week_grid", label: "Week grid" },
              ]}
            />
            {view.style === "week_grid" && (
              <>
                <div className="section__header" style={{ padding: "0 4px" }}>
                  <span className="section__header-title">Days</span>
                </div>
                <div className="weekday-picker">
                  {DAY_NAMES.map((name, i) => {
                    const d = i + 1;
                    const on = view.days.includes(d);
                    return (
                      <button
                        key={d}
                        type="button"
                        className={`chip-button ${on ? "chip-button--strong" : ""}`}
                        aria-pressed={on}
                        onClick={() => setView({ ...view, days: on ? view.days.filter((x) => x !== d) : [...view.days, d].sort((a, b) => a - b) })}
                      >
                        {name}
                      </button>
                    );
                  })}
                </div>
                <div className="section__header" style={{ padding: "0 4px" }}>
                  <span className="section__header-title">Rows: the tasks of</span>
                </div>
                <div className="group">
                  {rewards.plansFor(view.memberId).length === 0 && <div className="row row__subtitle">Add a reward with linked tasks first.</div>}
                  {rewards.plansFor(view.memberId).map((p, i) => {
                    const on = view.planId === p.id || (view.planId === null && i === 0);
                    return (
                      <button key={p.id} type="button" className="row row--pressable" aria-pressed={on} onClick={() => setView({ ...view, planId: p.id })}>
                        <span className={`reward-plan__check ${on ? "reward-plan__check--done" : ""}`} aria-hidden="true">
                          {on && <CheckIcon size={12} strokeWidth={3} />}
                        </span>
                        <span className="row__body">{p.title}</span>
                      </button>
                    );
                  })}
                </div>
                <p className="section__footer" style={{ padding: 0 }}>
                  Rewards that count only their own tasks work best: the grid shows those tasks.
                </p>
              </>
            )}
          </div>
        )}
      </Sheet>
      {toast.node}
    </main>
  );
}
