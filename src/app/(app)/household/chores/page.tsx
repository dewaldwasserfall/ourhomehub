/**
 * Chores: jobs that come round on a schedule (bed linen every 2 weeks,
 * descale the kettle monthly). Each shows on Today from its due date until
 * ticked; ticking schedules the next one from that day.
 */
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Avatar } from "@/components/avatar";
import { useHousehold } from "@/components/household-context";
import { ChevronLeftIcon, ChevronRightIcon, PlusIcon } from "@/components/icons";
import { Navbar } from "@/components/navbar";
import { DateField, MemberChips, ModeChips } from "@/components/plan-controls";
import { Segmented } from "@/components/segmented";
import { Sheet } from "@/components/sheet";
import { TaskSupplies } from "@/components/task-supplies";
import { useToast } from "@/components/toast";
import { dateKey } from "@/lib/calendar/time";
import { friendlyError } from "@/lib/errors";
import { ALL_MODES, describeDay, describeEvery, describeRule } from "@/lib/plan";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import type { Chore, ChoreUnit, DayMode } from "@/lib/types";
import { usePlanData } from "@/lib/use-plan-data";

type Editing = { chore: Chore | null } | null; // { chore: null } = new

/** "today", "tomorrow", "2 days ago", "Fri 20 Nov", to follow "due" / "next". */
function dueText(date: string, today: string): string {
  const label = describeDay(date, today);
  return /^(Today|Tomorrow|Yesterday)$/.test(label) ? label.toLowerCase() : label;
}

export default function ChoresPage() {
  const supabase = getSupabaseBrowserClient();
  const { household, members, memberById } = useHousehold();
  const today = dateKey(new Date(), household.timezone);
  const { chores, loading, reload } = usePlanData(household.id, today);
  const [editing, setEditing] = useState<Editing>(null);
  const toast = useToast();

  // Step 1: the edit sheet's fields.
  const [title, setTitle] = useState("");
  const [everyN, setEveryN] = useState(1);
  const [unit, setUnit] = useState<ChoreUnit>("week");
  const [modes, setModes] = useState<DayMode[]>(ALL_MODES);
  const [assignedTo, setAssignedTo] = useState<string | null>(null);
  const [nextDue, setNextDue] = useState<string | null>(today);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!editing) return;
    const c = editing.chore;
    setTitle(c?.title ?? "");
    setEveryN(c?.every_n ?? 1);
    setUnit(c?.unit ?? "week");
    setModes(c?.modes ?? ALL_MODES);
    setAssignedTo(c?.assigned_to ?? null);
    setNextDue(c?.next_due ?? today);
    setConfirmDelete(false);
  }, [editing, today]);

  // Step 2: save (insert or update) and delete.
  async function save() {
    if (!editing || !title.trim()) return;
    setBusy(true);
    const fields = {
      title: title.trim(),
      every_n: Math.min(365, Math.max(1, everyN || 1)),
      unit,
      modes,
      assigned_to: assignedTo,
      next_due: nextDue ?? today,
    };
    const { error } = editing.chore
      ? await supabase.from("chores").update(fields).eq("id", editing.chore.id)
      : await supabase.from("chores").insert({ household_id: household.id, ...fields });
    setBusy(false);
    if (error) return void toast.show(friendlyError(error));
    setEditing(null);
    await reload();
  }

  async function remove() {
    if (!editing?.chore) return;
    if (!confirmDelete) return setConfirmDelete(true);
    const { error } = await supabase.from("chores").delete().eq("id", editing.chore.id);
    if (error) return void toast.show(friendlyError(error));
    setEditing(null);
    await reload();
  }

  // Step 3: render.
  return (
    <main className="screen">
      <Navbar
        title="Chores"
        leading={
          <Link href="/household" className="nav-button" aria-label="Back to Household">
            <ChevronLeftIcon size={22} />
            Household
          </Link>
        }
        trailing={
          <button type="button" className="nav-button nav-button--icon" aria-label="New chore" onClick={() => setEditing({ chore: null })}>
            <PlusIcon size={24} />
          </button>
        }
      />

      {!loading && chores.length === 0 && (
        <section className="section">
          <div className="group empty">
            <span className="empty__title">No chores yet</span>
            Add jobs that come round every few days, weeks or months. They appear on Today when they&rsquo;re due.
            <div style={{ marginTop: 16 }}>
              <button type="button" className="button button--primary" onClick={() => setEditing({ chore: null })}>
                New chore
              </button>
            </div>
          </div>
        </section>
      )}

      {chores.length > 0 && (
        <section className="section">
          <div className="section__header">
            <span className="section__header-title">By next due date</span>
          </div>
          <div className="group">
            {chores.map((c) => {
              const assignee = memberById(c.assigned_to);
              const rule = describeRule(null, c.modes);
              return (
                <button key={c.id} type="button" className="row row--pressable" onClick={() => setEditing({ chore: c })}>
                  <span className="row__body">
                    <span className="row__title">{c.title}</span>
                    <span className="row__subtitle">
                      {describeEvery(c.every_n, c.unit)}
                      {rule !== "Every day" && `, ${rule.toLowerCase()}`}
                      {" · "}
                      <span className={c.next_due < today ? "due due--overdue" : "due"}>
                        {c.next_due <= today ? "due " : "next "}
                        {dueText(c.next_due, today)}
                      </span>
                    </span>
                  </span>
                  {assignee && <Avatar member={assignee} size="mini" />}
                  <ChevronRightIcon className="row__chevron" size={16} />
                </button>
              );
            })}
          </div>
        </section>
      )}

      <Sheet
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.chore ? "Chore" : "New chore"}
        leading={
          <button type="button" className="nav-button" onClick={() => setEditing(null)}>
            Cancel
          </button>
        }
        trailing={
          <button type="button" className="nav-button nav-button--strong" onClick={save} disabled={busy || !title.trim()}>
            {editing?.chore ? "Done" : "Add"}
          </button>
        }
      >
        <div className="sheet__stack">
          <input
            className="input"
            aria-label="Chore"
            placeholder="e.g. Change bed linen"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={120}
            style={{ fontWeight: 600 }}
            autoFocus={!editing?.chore}
          />
          <div className="group">
            <label className="form-row">
              <span className="form-row__label">Every</span>
              <span className="form-row__controls">
                <input
                  type="number"
                  inputMode="numeric"
                  className="pill-input"
                  style={{ width: 64, textAlign: "center" }}
                  min={1}
                  max={365}
                  value={everyN}
                  onChange={(e) => setEveryN(Number(e.target.value))}
                  aria-label="How many"
                />
              </span>
            </label>
          </div>
          <Segmented
            label="Unit"
            value={unit}
            onChange={setUnit}
            options={[
              { value: "day", label: everyN === 1 ? "Day" : "Days" },
              { value: "week", label: everyN === 1 ? "Week" : "Weeks" },
              { value: "month", label: everyN === 1 ? "Month" : "Months" },
            ]}
          />
          <DateField label={editing?.chore ? "Next due" : "First due"} value={nextDue} onChange={setNextDue} clearable={false} />
          <ModeChips value={modes} onChange={setModes} />
          <MemberChips members={members} value={assignedTo} onChange={setAssignedTo} />
          {editing?.chore && <TaskSupplies kind="chore" taskId={editing.chore.id} />}
          {editing?.chore && (
            <button type="button" className="button button--danger" onClick={remove}>
              {confirmDelete ? "Tap again to delete" : "Delete chore"}
            </button>
          )}
        </div>
      </Sheet>
      {toast.node}
    </main>
  );
}
