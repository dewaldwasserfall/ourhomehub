/**
 * One routine: its steps in order, each with its own rule (which weekdays,
 * and school days / holidays / weekends) and optionally a person.
 *
 * A preview line shows how the routine looks today, so a rule like
 * "School days, Mon" can be checked at a glance.
 */
"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useHousehold } from "@/components/household-context";
import { ChevronLeftIcon } from "@/components/icons";
import { Navbar } from "@/components/navbar";
import { PlanItemList } from "@/components/plan-item-list";
import { RoutineSheet, type RoutineFields } from "@/components/routine-sheet";
import { StepSheet, type StepFields } from "@/components/step-sheet";
import { useToast } from "@/components/toast";
import { dateKey } from "@/lib/calendar/time";
import { friendlyError } from "@/lib/errors";
import { describeRule, MODE_LABELS, stepApplies, TIME_OF_DAY_LABELS } from "@/lib/plan";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import type { DayInfo, RoutineStep } from "@/lib/types";
import { saveOrder, usePlanData } from "@/lib/use-plan-data";

export default function RoutinePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const supabase = getSupabaseBrowserClient();
  const { household, members, memberById } = useHousehold();
  const today = dateKey(new Date(), household.timezone);
  const { routines, steps: allSteps, loading, reload } = usePlanData(household.id, today);
  const [editingRoutine, setEditingRoutine] = useState(false);
  const [editingStep, setEditingStep] = useState<RoutineStep | null>(null);
  const [todayInfo, setTodayInfo] = useState<DayInfo | null>(null);
  const toast = useToast();

  const routine = routines.find((r) => r.id === id);
  const steps = useMemo(() => allSteps.filter((s) => s.routine_id === id), [allSteps, id]);
  const owner = memberById(routine?.owner_member ?? null);

  // Step 1: today's mode, for the "Today" preview line.
  useEffect(() => {
    supabase.rpc("day_info", { p_date: today }).then(({ data }) => setTodayInfo(((data ?? []) as DayInfo[])[0] ?? null));
  }, [supabase, today]);

  const showingToday = todayInfo ? steps.filter((s) => stepApplies(s, today, todayInfo.mode)) : null;

  // Step 2: writes. Each reloads so the list reflects the database.
  async function addStep(title: string) {
    const { error } = await supabase.from("routine_steps").insert({ routine_id: id, title, sort_order: steps.length });
    if (error) {
      toast.show(friendlyError(error));
      return false;
    }
    await reload();
    return true;
  }

  async function saveStep(step: RoutineStep, fields: StepFields) {
    const { error } = await supabase.from("routine_steps").update(fields).eq("id", step.id);
    if (error) toast.show(friendlyError(error));
    await reload();
  }

  async function deleteStep(step: RoutineStep) {
    const { error } = await supabase.from("routine_steps").delete().eq("id", step.id);
    if (error) toast.show(friendlyError(error));
    await reload();
  }

  async function reorder(ids: string[]) {
    const error = await saveOrder("routine_steps", ids, steps.map((s) => s.id));
    if (error) toast.show(friendlyError(error));
    await reload();
  }

  async function saveRoutine(fields: RoutineFields) {
    const { error } = await supabase.from("routines").update(fields).eq("id", id);
    if (error) return void toast.show(friendlyError(error));
    setEditingRoutine(false);
    await reload();
  }

  async function deleteRoutine() {
    const { error } = await supabase.from("routines").delete().eq("id", id);
    if (error) return void toast.show(friendlyError(error));
    router.replace("/household/routines");
  }

  // Step 3: render.
  const back = (
    <Link href="/household/routines" className="nav-button" aria-label="Back to Routines">
      <ChevronLeftIcon size={22} />
      Routines
    </Link>
  );

  if (!loading && !routine) {
    return (
      <main className="screen">
        <Navbar title="Routine not found" leading={back} />
        <div className="group empty">
          <span className="empty__title">This routine was deleted</span>
          Go back to Routines to pick another one.
        </div>
      </main>
    );
  }

  return (
    <main className="screen">
      <Navbar
        title={routine?.name ?? " "}
        leading={back}
        trailing={
          <button type="button" className="nav-button" onClick={() => setEditingRoutine(true)} disabled={!routine}>
            Edit
          </button>
        }
        subtitle={routine && `${TIME_OF_DAY_LABELS[routine.time_of_day]}, ${owner ? `${owner.display_name}'s routine` : "household routine"}`}
      />

      {routine && (
        <>
          <section className="section">
            <div className="section__header">
              <span className="section__header-title">Steps</span>
              {steps.length > 1 && <span>Drag to reorder</span>}
            </div>
            <PlanItemList
              items={steps}
              describe={(s) => describeRule(s.weekdays, s.modes)}
              assigneeOf={(s) => memberById(s.assigned_to)}
              onOpen={setEditingStep}
              onAdd={addStep}
              onReorder={reorder}
              addPlaceholder="Add a step"
            />
            <p className="section__footer">
              {showingToday && todayInfo
                ? showingToday.length === 0
                  ? `Nothing shows today (${MODE_LABELS[todayInfo.mode].toLowerCase()}), so the routine is hidden on Today.`
                  : `Today (${todayInfo.label ?? MODE_LABELS[todayInfo.mode].toLowerCase()}): ${showingToday.map((s) => s.title).join(", ")}.`
                : "Tap a step to choose its days and who it's for."}
            </p>
          </section>
        </>
      )}

      <RoutineSheet
        open={editingRoutine}
        routine={routine ?? null}
        members={members}
        onClose={() => setEditingRoutine(false)}
        onSave={saveRoutine}
        onDelete={deleteRoutine}
      />
      <StepSheet
        item={editingStep}
        heading="Step"
        members={members}
        withSchedule
        anyoneLabel={owner ? owner.display_name.split(" ")[0] : "Anyone"}
        onClose={() => setEditingStep(null)}
        onSave={(fields) => saveStep(editingStep!, fields)}
        onDelete={() => deleteStep(editingStep!)}
        supplyTask={editingStep ? { kind: "step", id: editingStep.id } : null}
      />
      {toast.node}
    </main>
  );
}
