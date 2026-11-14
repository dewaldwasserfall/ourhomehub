/**
 * "Waiting for you" on an adult's Today: things the kids ticked on the
 * Family board that a grown-up still has to confirm.
 *
 * Any adult can confirm (stars and supplies count from then on) or say
 * "Not done" (the tick is undone; a chore gets its due date back). Hidden
 * when nothing is waiting.
 */
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Avatar } from "@/components/avatar";
import { useHousehold } from "@/components/household-context";
import { friendlyError } from "@/lib/errors";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import type { PlanData } from "@/lib/use-plan-data";

interface Waiting {
  key: string;
  /** A completions id, or a list_entries id for to-dos. */
  id: string;
  isTodo: boolean;
  title: string;
  memberId: string | null;
}

export function WaitingCard({
  plan,
  onChanged,
  onError,
}: {
  plan: Pick<PlanData, "completions" | "steps" | "chores" | "zoneTasks">;
  onChanged: () => Promise<void> | void;
  onError: (message: string) => void;
}) {
  const supabase = getSupabaseBrowserClient();
  const { household, memberById } = useHousehold();
  const [todos, setTodos] = useState<Array<{ id: string; text: string; done_for: string | null; assigned_to: string | null }>>([]);
  const [busy, setBusy] = useState(false);

  // Step 1: to-dos waiting (ticks come with the plan data already).
  const loadTodos = useCallback(async () => {
    const { data } = await supabase.from("list_entries").select("id, text, done_for, assigned_to").eq("pending", true);
    setTodos((data ?? []) as typeof todos);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase]);
  useEffect(() => {
    loadTodos();
    const channel = supabase
      .channel(`waiting:${household.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "list_entries", filter: `household_id=eq.${household.id}` }, () => loadTodos())
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase, household.id, loadTodos]);

  // Step 2: one list, oldest first.
  const waiting = useMemo<Waiting[]>(() => {
    const titleOf = (kind: string, itemId: string) =>
      (kind === "step"
        ? plan.steps.find((s) => s.id === itemId)?.title
        : kind === "chore"
          ? plan.chores.find((c) => c.id === itemId)?.title
          : plan.zoneTasks.find((t) => t.id === itemId)?.title) ?? "A task";
    const ticks = plan.completions
      .filter((c) => c.pending)
      .sort((a, b) => a.done_at.localeCompare(b.done_at))
      .map((c) => ({ key: `c:${c.id}`, id: c.id, isTodo: false, title: titleOf(c.kind, c.item_id), memberId: c.done_for }));
    const lines = todos.map((t) => ({ key: `t:${t.id}`, id: t.id, isTodo: true, title: t.text, memberId: t.done_for ?? t.assigned_to }));
    return [...ticks, ...lines];
  }, [plan.completions, plan.steps, plan.chores, plan.zoneTasks, todos]);

  // Step 3: confirm or reject some (or all).
  const act = async (rpc: "confirm_ticks" | "reject_ticks", items: Waiting[]) => {
    setBusy(true);
    const { error } = await supabase.rpc(rpc, {
      p_completion_ids: items.filter((i) => !i.isTodo).map((i) => i.id),
      p_entry_ids: items.filter((i) => i.isTodo).map((i) => i.id),
    });
    setBusy(false);
    if (error) return onError(friendlyError(error));
    await Promise.all([onChanged(), loadTodos()]);
  };

  if (waiting.length === 0) return null;

  return (
    <section className="section">
      <div className="section__header">
        <span className="section__header-title">Waiting for you</span>
        {waiting.length > 1 && (
          <button type="button" className="section__header-action" onClick={() => act("confirm_ticks", waiting)} disabled={busy}>
            Confirm all
          </button>
        )}
      </div>
      <div className="group">
        {waiting.map((w) => {
          const person = memberById(w.memberId);
          return (
            <div key={w.key} className="row waiting-row">
              {person && <Avatar member={person} size="mini" />}
              <span className="row__body">
                <span className="row__title">{w.title}</span>
                <span className="row__subtitle">{person ? `${person.display_name.split(" ")[0]} ticked this on the board` : "Ticked on the board"}</span>
              </span>
              <span className="row__trailing waiting-row__actions">
                <button type="button" className="chip-button" onClick={() => act("reject_ticks", [w])} disabled={busy}>
                  Not done
                </button>
                <button type="button" className="chip-button chip-button--strong" onClick={() => act("confirm_ticks", [w])} disabled={busy}>
                  Confirm
                </button>
              </span>
            </div>
          );
        })}
      </div>
      <p className="section__footer">Stars count once a grown-up confirms.</p>
    </section>
  );
}
