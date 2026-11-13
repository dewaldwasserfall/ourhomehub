/**
 * One zone: its tasks (each done once per fortnight), plus rename and delete.
 */
"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useHousehold } from "@/components/household-context";
import { ChevronLeftIcon } from "@/components/icons";
import { Navbar } from "@/components/navbar";
import { PlanItemList } from "@/components/plan-item-list";
import { StepSheet, type StepFields } from "@/components/step-sheet";
import { useToast } from "@/components/toast";
import { dateKey } from "@/lib/calendar/time";
import { friendlyError } from "@/lib/errors";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import type { ZoneTask } from "@/lib/types";
import { saveOrder, usePlanData } from "@/lib/use-plan-data";

export default function ZonePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const supabase = getSupabaseBrowserClient();
  const { household, members, memberById } = useHousehold();
  const today = dateKey(new Date(), household.timezone);
  const { zones, zoneTasks, loading, reload } = usePlanData(household.id, today);
  const [editing, setEditing] = useState<ZoneTask | null>(null);
  const [name, setName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const toast = useToast();

  const zone = zones.find((z) => z.id === id);
  const tasks = useMemo(() => zoneTasks.filter((t) => t.zone_id === id), [zoneTasks, id]);
  useEffect(() => setName(zone?.name ?? ""), [zone?.name]);

  // Step 1: tasks.
  async function addTask(title: string) {
    const { error } = await supabase.from("zone_tasks").insert({ zone_id: id, title, sort_order: tasks.length });
    if (error) {
      toast.show(friendlyError(error));
      return false;
    }
    await reload();
    return true;
  }

  async function saveTask(task: ZoneTask, fields: StepFields) {
    const { error } = await supabase.from("zone_tasks").update({ title: fields.title, assigned_to: fields.assigned_to }).eq("id", task.id);
    if (error) toast.show(friendlyError(error));
    await reload();
  }

  async function deleteTask(task: ZoneTask) {
    const { error } = await supabase.from("zone_tasks").delete().eq("id", task.id);
    if (error) toast.show(friendlyError(error));
    await reload();
  }

  async function reorder(ids: string[]) {
    const error = await saveOrder("zone_tasks", ids, tasks.map((t) => t.id));
    if (error) toast.show(friendlyError(error));
    await reload();
  }

  // Step 2: the zone itself.
  async function rename() {
    const trimmed = name.trim();
    if (!zone || !trimmed || trimmed === zone.name) return setName(zone?.name ?? "");
    const { error } = await supabase.from("zones").update({ name: trimmed }).eq("id", id);
    if (error) toast.show(friendlyError(error));
    await reload();
  }

  async function remove() {
    if (!confirmDelete) return setConfirmDelete(true);
    const { error } = await supabase.from("zones").delete().eq("id", id);
    if (error) return void toast.show(friendlyError(error));
    router.replace("/household/zones");
  }

  const back = (
    <Link href="/household/zones" className="nav-button" aria-label="Back to Zones">
      <ChevronLeftIcon size={22} />
      Zones
    </Link>
  );

  if (!loading && !zone) {
    return (
      <main className="screen">
        <Navbar title="Zone not found" leading={back} />
        <div className="group empty">
          <span className="empty__title">This zone was deleted</span>
          Go back to Zones to pick another one.
        </div>
      </main>
    );
  }

  return (
    <main className="screen">
      <Navbar title={zone?.name ?? " "} leading={back} subtitle="Each task is done once while this zone is active." />

      {zone && (
        <>
          <section className="section">
            <div className="section__header">
              <span className="section__header-title">Tasks</span>
              {tasks.length > 1 && <span>Drag to reorder</span>}
            </div>
            <PlanItemList
              items={tasks}
              assigneeOf={(t) => memberById(t.assigned_to)}
              onOpen={setEditing}
              onAdd={addTask}
              onReorder={reorder}
              addPlaceholder="Add a task, e.g. Clean the oven"
            />
          </section>

          <section className="section">
            <label className="field">
              <span className="field__label">Zone name</span>
              <input
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={rename}
                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                maxLength={60}
              />
            </label>
          </section>

          <section className="section">
            <button type="button" className="button button--danger" onClick={remove}>
              {confirmDelete ? "Tap again to delete the zone and its tasks" : "Delete zone"}
            </button>
          </section>
        </>
      )}

      <StepSheet
        item={editing}
        heading="Zone task"
        members={members}
        withSchedule={false}
        onClose={() => setEditing(null)}
        onSave={(fields) => saveTask(editing!, fields)}
        onDelete={() => deleteTask(editing!)}
      />
      {toast.node}
    </main>
  );
}
