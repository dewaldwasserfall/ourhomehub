/**
 * Routines: every routine in the household, grouped by whose it is
 * (Household first, then each person's own). Tap one to edit its steps.
 */
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Avatar } from "@/components/avatar";
import { useHousehold } from "@/components/household-context";
import { ChevronLeftIcon, ChevronRightIcon, PlusIcon, RoutineIcon } from "@/components/icons";
import { Navbar } from "@/components/navbar";
import { RoutineSheet, type RoutineFields } from "@/components/routine-sheet";
import { useToast } from "@/components/toast";
import { dateKey } from "@/lib/calendar/time";
import { friendlyError } from "@/lib/errors";
import { TIME_OF_DAY_LABELS } from "@/lib/plan";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import type { Routine } from "@/lib/types";
import { usePlanData } from "@/lib/use-plan-data";

const TIME_ORDER = { morning: 0, afternoon: 1, evening: 2 } as const;

export default function RoutinesPage() {
  const router = useRouter();
  const supabase = getSupabaseBrowserClient();
  const { household, members, memberById } = useHousehold();
  const today = dateKey(new Date(), household.timezone);
  const { routines, steps, loading } = usePlanData(household.id, today);
  const [creating, setCreating] = useState(false);
  const toast = useToast();

  // Step 1: group by owner (Household first), each sorted by time of day.
  const groups = useMemo(() => {
    const owners: Array<string | null> = [null, ...members.map((m) => m.id)];
    return owners
      .map((owner) => ({
        owner,
        routines: routines
          .filter((r) => r.owner_member === owner)
          .sort((a, b) => TIME_ORDER[a.time_of_day] - TIME_ORDER[b.time_of_day] || a.sort_order - b.sort_order),
      }))
      .filter((g) => g.routines.length > 0);
  }, [routines, members]);

  const stepCount = (r: Routine) => steps.filter((s) => s.routine_id === r.id).length;

  // Step 2: create, then go straight to adding its steps.
  async function create(fields: RoutineFields) {
    const { data, error } = await supabase
      .from("routines")
      .insert({ household_id: household.id, ...fields, sort_order: routines.length })
      .select("id")
      .single<{ id: string }>();
    if (error || !data) return void toast.show(friendlyError(error));
    setCreating(false);
    router.push(`/household/routines/${data.id}`);
  }

  return (
    <main className="screen">
      <Navbar
        title="Routines"
        leading={
          <Link href="/household" className="nav-button" aria-label="Back to Household">
            <ChevronLeftIcon size={22} />
            Household
          </Link>
        }
        trailing={
          <button type="button" className="nav-button nav-button--icon" aria-label="New routine" onClick={() => setCreating(true)}>
            <PlusIcon size={24} />
          </button>
        }
      />

      {loading && (
        <section className="section">
          <div className="group" aria-busy="true">
            <div className="skeleton" />
            <div className="skeleton" />
          </div>
        </section>
      )}

      {/* Empty: explain what a routine is and offer the first one */}
      {!loading && routines.length === 0 && (
        <section className="section">
          <div className="group empty">
            <span className="empty__title">No routines yet</span>
            A routine is a short checklist that resets every day, like getting out of the door in the morning. Each step can
            show on certain weekdays, and only on school days, holidays or weekends.
            <div style={{ marginTop: 16 }}>
              <button type="button" className="button button--primary" onClick={() => setCreating(true)}>
                New routine
              </button>
            </div>
          </div>
        </section>
      )}

      {groups.map(({ owner, routines: list }) => {
        const person = memberById(owner);
        return (
          <section key={owner ?? "household"} className="section">
            <div className="section__header">
              <span className="section__header-title">{person ? person.display_name : "Household"}</span>
            </div>
            <div className="group">
              {list.map((r) => (
                <Link key={r.id} href={`/household/routines/${r.id}`} className="row row--link">
                  <span className="row__icon" style={{ background: "#ff9500" }}>
                    <RoutineIcon size={19} strokeWidth={2} />
                  </span>
                  <span className="row__body">
                    <span className="row__title">{r.name}</span>
                    <span className="row__subtitle">
                      {TIME_OF_DAY_LABELS[r.time_of_day]}, {stepCount(r) === 1 ? "1 step" : `${stepCount(r)} steps`}
                    </span>
                  </span>
                  {person && <Avatar member={person} size="mini" />}
                  <ChevronRightIcon className="row__chevron" size={16} />
                </Link>
              ))}
            </div>
          </section>
        );
      })}

      <RoutineSheet open={creating} routine={null} members={members} onClose={() => setCreating(false)} onSave={create} />
      {toast.node}
    </main>
  );
}
