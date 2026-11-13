/**
 * Zones: the house split into areas that take turns, two weeks each.
 *
 *   * "Start rotation on" sets the Monday the first zone began; it can be
 *     moved to shift which zone is active.
 *   * The zones in order (drag to reorder); tap one to edit its tasks.
 */
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo } from "react";
import { useHousehold } from "@/components/household-context";
import { ChevronLeftIcon } from "@/components/icons";
import { Navbar } from "@/components/navbar";
import { DateField } from "@/components/plan-controls";
import { PlanItemList } from "@/components/plan-item-list";
import { useToast } from "@/components/toast";
import { dateKey } from "@/lib/calendar/time";
import { friendlyError } from "@/lib/errors";
import { describeDay, mondayOf, zoneFortnight } from "@/lib/plan";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { saveOrder, usePlanData } from "@/lib/use-plan-data";

export default function ZonesPage() {
  const router = useRouter();
  const supabase = getSupabaseBrowserClient();
  const { household, setHousehold } = useHousehold();
  const today = dateKey(new Date(), household.timezone);
  const { zones, zoneTasks, reload } = usePlanData(household.id, today);
  const toast = useToast();

  const items = useMemo(() => zones.map((z) => ({ ...z, title: z.name })), [zones]);
  const fortnight = household.zone_rotation_start
    ? zoneFortnight(household.zone_rotation_start, today, zones.length)
    : null;
  const activeZone = fortnight ? zones[fortnight.index] : undefined;

  // Step 1: the rotation always starts on a Monday, so snap the chosen date.
  async function setStart(date: string | null) {
    const start = date ? mondayOf(date) : null;
    const { error } = await supabase.from("households").update({ zone_rotation_start: start }).eq("id", household.id);
    if (error) return void toast.show(friendlyError(error));
    setHousehold({ ...household, zone_rotation_start: start });
  }

  // Step 2: zones themselves.
  async function addZone(name: string) {
    const { error } = await supabase.from("zones").insert({ household_id: household.id, name, sort_order: zones.length });
    if (error) {
      toast.show(friendlyError(error));
      return false;
    }
    // The first zone starts the rotation this week, unless one was chosen.
    if (!household.zone_rotation_start) await setStart(today);
    await reload();
    return true;
  }

  async function reorder(ids: string[]) {
    const error = await saveOrder("zones", ids, zones.map((z) => z.id));
    if (error) toast.show(friendlyError(error));
    await reload();
  }

  const taskCount = (zoneId: string) => zoneTasks.filter((t) => t.zone_id === zoneId).length;

  return (
    <main className="screen">
      <Navbar
        title="Zones"
        leading={
          <Link href="/household" className="nav-button" aria-label="Back to Household">
            <ChevronLeftIcon size={22} />
            Household
          </Link>
        }
        subtitle={
          activeZone && fortnight
            ? `${activeZone.name} until ${describeDay(fortnight.end, today)}, day ${fortnight.day} of 14`
            : "Each zone gets two weeks of attention, then the next one takes over."
        }
      />

      <section className="section">
        <div className="section__header">
          <span className="section__header-title">Zones, in order</span>
          {zones.length > 1 && <span>Drag to reorder</span>}
        </div>
        <PlanItemList
          items={items}
          describe={(z) => {
            const n = taskCount(z.id);
            const tasks = n === 1 ? "1 task" : `${n} tasks`;
            return z.id === activeZone?.id ? `${tasks}, this fortnight` : tasks;
          }}
          onOpen={(z) => router.push(`/household/zones/${z.id}`)}
          onAdd={addZone}
          onReorder={reorder}
          addPlaceholder="Add a zone, e.g. Kitchen"
        />
      </section>

      <section className="section">
        <DateField
          label="Rotation started"
          value={household.zone_rotation_start}
          onChange={(d) => d && setStart(d)}
          clearable={false}
        />
        <p className="section__footer">
          Fortnights run Monday to Sunday. Move this date to change which zone is active now.
        </p>
      </section>
      {toast.node}
    </main>
  );
}
