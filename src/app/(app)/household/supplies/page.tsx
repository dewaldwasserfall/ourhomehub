/**
 * Supplies: products that run down with use (washing liquid, softener,
 * dishwasher tablets). Each has a number of uses per pack and the tasks that
 * use it; ticking one of those tasks uses one up. At the threshold it's
 * suggested on the shopping list, and ticking it off as bought tops it up.
 *
 * Adults set them up; everyone's ticks count. The counting happens in the
 * database, so this screen only edits the set-up and the count.
 */
"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useHousehold } from "@/components/household-context";
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, PlusIcon } from "@/components/icons";
import { Navbar } from "@/components/navbar";
import { Segmented } from "@/components/segmented";
import { Sheet } from "@/components/sheet";
import { useToast } from "@/components/toast";
import { dateKey } from "@/lib/calendar/time";
import { guessCategory } from "@/lib/categories";
import { friendlyError } from "@/lib/errors";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { supplyLevel, taskKey, taskOptions, type TaskOption } from "@/lib/supplies";
import { usePlanData } from "@/lib/use-plan-data";
import { useSupplies, type SupplyWithName } from "@/lib/use-supplies";

type Editing = { supply: SupplyWithName | null } | null; // { supply: null } = new

/** A number field's text as a whole number in a range, or null. */
function wholeNumber(text: string, min: number, max: number): number | null {
  const n = Number(text);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

export default function SuppliesPage() {
  const supabase = getSupabaseBrowserClient();
  const { household, meIsAdult } = useHousehold();
  const toast = useToast();
  const today = dateKey(new Date(), household.timezone);
  const plan = usePlanData(household.id, today);
  const { supplies, uses, loading, reload } = useSupplies(household.id);
  const [editing, setEditing] = useState<Editing>(null);

  // Step 1: tasks to pick from, grouped (Chores, each routine, each zone).
  const options = useMemo(
    () => taskOptions({ routines: plan.routines, steps: plan.steps, zones: plan.zones, zoneTasks: plan.zoneTasks, chores: plan.chores }),
    [plan.routines, plan.steps, plan.zones, plan.zoneTasks, plan.chores],
  );
  const optionByKey = useMemo(() => new Map(options.map((o) => [taskKey(o.kind, o.id), o])), [options]);
  const groups = useMemo(() => {
    const map = new Map<string, TaskOption[]>();
    for (const o of options) map.set(o.group, [...(map.get(o.group) ?? []), o]);
    return [...map.entries()];
  }, [options]);

  // Step 2: the sheet's fields.
  const [name, setName] = useState("");
  const [perPack, setPerPack] = useState("40");
  const [warnAt, setWarnAt] = useState("5");
  const [left, setLeft] = useState("40");
  const [countedBy, setCountedBy] = useState<"tasks" | "automations">("tasks");
  const [linked, setLinked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!editing) return;
    const s = editing.supply;
    setName(s?.item?.display_name ?? "");
    setPerPack(String(s?.uses_per_pack ?? 40));
    setWarnAt(String(s?.warn_at ?? 5));
    // A new product: assume a full pack is open now.
    setLeft(String(s?.uses_left ?? 40));
    setCountedBy(s?.counted_by ?? "tasks");
    setLinked(new Set(s ? uses.filter((u) => u.supply_id === s.id).map((u) => taskKey(u.kind, u.task_id)) : []));
    setConfirmDelete(false);
  }, [editing, uses]);

  const perPackN = wholeNumber(perPack, 1, 1000);
  const warnAtN = wholeNumber(warnAt, 0, 1000);
  const leftN = wholeNumber(left, 0, 100000);
  const valid = name.trim().length > 0 && perPackN !== null && warnAtN !== null && leftN !== null;

  // Step 3: save: the product (found or created by name), the supply, then
  // the task links (only what changed).
  async function save() {
    if (!editing || !valid) return;
    setBusy(true);
    try {
      const { data: itemId, error: itemError } = await supabase.rpc("ensure_item", {
        p_name: name.trim(),
        p_category: guessCategory(name.trim()),
      });
      if (itemError) throw itemError;

      const fields = { item_id: itemId as string, uses_per_pack: perPackN!, warn_at: warnAtN!, uses_left: leftN!, counted_by: countedBy };
      let supplyId = editing.supply?.id;
      if (supplyId) {
        // A changed count allows a new suggestion once it runs low again.
        const recount = editing.supply && leftN !== editing.supply.uses_left ? { suggested_at_uses: null } : {};
        const { error } = await supabase.from("supplies").update({ ...fields, ...recount }).eq("id", supplyId);
        if (error) throw error;
      } else {
        const { data, error } = await supabase.from("supplies").insert({ household_id: household.id, ...fields }).select("id").single();
        if (error) throw error;
        supplyId = (data as { id: string }).id;
      }

      const before = new Set(uses.filter((u) => u.supply_id === supplyId).map((u) => taskKey(u.kind, u.task_id)));
      const added = [...linked].filter((k) => !before.has(k));
      const removed = [...before].filter((k) => !linked.has(k));
      if (added.length) {
        const rows = added.map((k) => {
          const [kind, task_id] = k.split(":");
          return { supply_id: supplyId, household_id: household.id, kind, task_id };
        });
        const { error } = await supabase.from("supply_uses").insert(rows);
        if (error) throw error;
      }
      for (const k of removed) {
        const [kind, taskId] = k.split(":");
        const { error } = await supabase.from("supply_uses").delete().match({ supply_id: supplyId, kind, task_id: taskId });
        if (error) throw error;
      }
      setEditing(null);
    } catch (error) {
      toast.show(friendlyError(error as { message: string }));
    } finally {
      setBusy(false);
      await reload();
    }
  }

  async function remove() {
    if (!editing?.supply) return;
    if (!confirmDelete) return setConfirmDelete(true);
    const { error } = await supabase.from("supplies").delete().eq("id", editing.supply.id);
    if (error) return void toast.show(friendlyError(error));
    setEditing(null);
    await reload();
  }

  const toggle = (key: string) =>
    setLinked((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // Step 4: render.
  return (
    <main className="screen">
      <Navbar
        title="Supplies"
        leading={
          <Link href="/household" className="nav-button" aria-label="Back to Household">
            <ChevronLeftIcon size={22} />
            Household
          </Link>
        }
        trailing={
          meIsAdult ? (
            <button type="button" className="nav-button nav-button--icon" aria-label="New supply" onClick={() => setEditing({ supply: null })}>
              <PlusIcon size={24} />
            </button>
          ) : undefined
        }
      />

      {!loading && supplies.length === 0 && (
        <section className="section">
          <div className="group empty">
            <span className="empty__title">No supplies yet</span>
            Add things like washing liquid with how many uses a bottle has, and the tasks that use it. When it runs low it&rsquo;s
            suggested on the shopping list.
            {meIsAdult && (
              <div style={{ marginTop: 16 }}>
                <button type="button" className="button button--primary" onClick={() => setEditing({ supply: null })}>
                  New supply
                </button>
              </div>
            )}
          </div>
        </section>
      )}

      {supplies.length > 0 && (
        <section className="section">
          <div className="group">
            {supplies.map((s) => {
              const level = supplyLevel(s);
              const taskNames = uses
                .filter((u) => u.supply_id === s.id)
                .map((u) => optionByKey.get(taskKey(u.kind, u.task_id))?.title)
                .filter(Boolean);
              const body = (
                <>
                  <span className="row__body">
                    <span className="row__title">{s.item?.display_name ?? "Product"}</span>
                    <span className={`supply-bar supply-bar--${level.state}`} aria-hidden="true">
                      <span className="supply-bar__fill" style={{ width: `${level.fraction * 100}%` }} />
                    </span>
                    <span className="row__subtitle">
                      <span className={level.state === "ok" ? undefined : "due due--overdue"}>{level.label}</span>
                      {taskNames.length > 0 ? ` · ${taskNames.join(", ")}` : " · not linked to a task yet"}
                    </span>
                  </span>
                  {meIsAdult && <ChevronRightIcon className="row__chevron" size={16} />}
                </>
              );
              return meIsAdult ? (
                <button key={s.id} type="button" className="row row--pressable" onClick={() => setEditing({ supply: s })}>
                  {body}
                </button>
              ) : (
                <div key={s.id} className="row">
                  {body}
                </div>
              );
            })}
          </div>
          <p className="section__footer">
            Each tick of a linked task uses one. Ticking it off as bought adds a pack (or as many as the quantity says).
          </p>
        </section>
      )}

      <Sheet
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.supply ? "Supply" : "New supply"}
        leading={
          <button type="button" className="nav-button" onClick={() => setEditing(null)}>
            Cancel
          </button>
        }
        trailing={
          <button type="button" className="nav-button nav-button--strong" onClick={save} disabled={busy || !valid}>
            {editing?.supply ? "Done" : "Add"}
          </button>
        }
      >
        <div className="sheet__stack">
          <input
            className="input"
            aria-label="Product"
            placeholder="e.g. Washing liquid"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            style={{ fontWeight: 600 }}
            autoFocus={!editing?.supply}
          />

          {/* Numbers: per pack, threshold, and what's left now */}
          <div className="group">
            {(
              [
                ["Uses per pack", perPack, setPerPack, 1000],
                ["Suggest at", warnAt, setWarnAt, 1000],
                [editing?.supply ? "Uses left now" : "Uses left now (full pack)", left, setLeft, 100000],
              ] as const
            ).map(([label, value, set, max]) => (
              <label key={label} className="form-row">
                <span className="form-row__label">{label}</span>
                <input
                  type="number"
                  inputMode="numeric"
                  className="pill-input"
                  style={{ width: 80, textAlign: "center" }}
                  min={0}
                  max={max}
                  value={value}
                  onChange={(e) => set(e.target.value)}
                />
              </label>
            ))}
          </div>

          {/* How it runs down: ticks on tasks, or Home automations only
              (so a washer automation and a washing task never both count) */}
          <Segmented
            label="Counted by"
            value={countedBy}
            onChange={setCountedBy}
            options={[
              { value: "tasks", label: "Ticked tasks" },
              { value: "automations", label: "Automations" },
            ]}
          />
          {countedBy === "automations" && (
            <p className="section__footer" style={{ marginTop: -6 }}>
              Ticking the tasks below won&rsquo;t use it up; a Home automation (for example &ldquo;washer finished&rdquo;) does.
            </p>
          )}

          {/* Tasks that use it */}
          <div className="section__header" style={{ padding: "0 4px" }}>
            <span className="section__header-title">Used by</span>
          </div>
          {groups.length === 0 && <p className="section__footer">Add a routine step, zone task or chore first.</p>}
          {groups.map(([group, tasks]) => (
            <div key={group} className="group">
              <div className="row supply-task-group">
                <span className="row__subtitle">{group}</span>
              </div>
              {tasks.map((t) => {
                const key = taskKey(t.kind, t.id);
                const on = linked.has(key);
                return (
                  <button key={key} type="button" className="row row--pressable" role="checkbox" aria-checked={on} onClick={() => toggle(key)}>
                    <span className="row__body">
                      <span className="row__title">{t.title}</span>
                    </span>
                    {on && <CheckIcon size={18} className="supply-task-check" />}
                  </button>
                );
              })}
            </div>
          ))}

          {editing?.supply && (
            <button type="button" className="button button--danger" onClick={remove}>
              {confirmDelete ? "Tap again to stop tracking" : "Stop tracking"}
            </button>
          )}
        </div>
      </Sheet>
      {toast.node}
    </main>
  );
}
