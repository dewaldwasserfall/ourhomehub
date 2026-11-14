/**
 * Trips: every trip, upcoming and ongoing first, then past ones. Private to
 * the people the owner chooses (the database enforces it; this screen just
 * explains when you don't have access).
 *
 *   1. The list: name, dates, destination, who's going, countdown.
 *   2. New trip (adults with access).
 *   3. Who can see trips (owner only): one switch per person.
 */
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Avatar } from "@/components/avatar";
import { useHousehold } from "@/components/household-context";
import { ChevronRightIcon, PlusIcon } from "@/components/icons";
import { Navbar } from "@/components/navbar";
import { useToast } from "@/components/toast";
import { TripSheet, type TripFields } from "@/components/trip-sheets";
import { dateKey } from "@/lib/calendar/time";
import { friendlyError } from "@/lib/errors";
import { canEditTrips, canSeeTrips, roleLabel } from "@/lib/roles";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { sortTrips, tripPhase, tripRange } from "@/lib/trips";
import type { Trip } from "@/lib/types";
import { useTrips } from "@/lib/use-trips";

export default function TripsPage() {
  const supabase = getSupabaseBrowserClient();
  const router = useRouter();
  const toast = useToast();
  const { household, members, me, memberById } = useHousehold();
  const today = dateKey(new Date(), household.timezone);
  const allowed = canSeeTrips(me);
  const canEdit = canEditTrips(me);
  const isOwner = me.role === "owner";
  const { trips, participants, loading } = useTrips(household.id, allowed);
  const [creating, setCreating] = useState(false);
  // Who can see trips (owner's switches), kept locally after each change.
  const [access, setAccessState] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(members.map((m) => [m.id, m.role === "owner" || m.can_see_trips])),
  );

  // Step 1: create a trip with who's going, then open it.
  async function create(fields: TripFields): Promise<boolean> {
    const { data, error } = await supabase
      .from("trips")
      .insert({
        household_id: household.id,
        name: fields.name,
        destination: fields.destination,
        start_date: fields.start_date,
        end_date: fields.end_date,
        notes: fields.notes,
        created_by: me.id,
      })
      .select("id")
      .single();
    if (error) {
      toast.show(friendlyError(error));
      return false;
    }
    const tripId = (data as { id: string }).id;
    if (fields.participantIds.length) {
      const { error: pError } = await supabase
        .from("trip_participants")
        .insert(fields.participantIds.map((member_id) => ({ trip_id: tripId, member_id })));
      if (pError) toast.show(friendlyError(pError));
    }
    router.push(`/trips/${tripId}`);
    return true;
  }

  // Step 2: owner turns access on or off for someone.
  async function setAccess(memberId: string, on: boolean) {
    setAccessState((cur) => ({ ...cur, [memberId]: on }));
    const { error } = await supabase.rpc("set_trips_access", { p_member_id: memberId, p_allowed: on });
    if (error) {
      setAccessState((cur) => ({ ...cur, [memberId]: !on }));
      toast.show(friendlyError(error));
    }
  }

  // Step 3: render.
  if (!allowed) {
    return (
      <main className="screen">
        <Navbar title="Trips" />
        <section className="section">
          <div className="group empty">
            <span className="empty__title">Trips are private</span>
            Ask {members.find((m) => m.role === "owner")?.display_name.split(" ")[0] ?? "the owner"} to give you access.
          </div>
        </section>
      </main>
    );
  }

  const { current, past } = sortTrips(trips, today);
  const tripRow = (t: Trip) => {
    const phase = tripPhase(t, today);
    const going = participants
      .filter((p) => p.trip_id === t.id)
      .map((p) => memberById(p.member_id))
      .filter((m): m is NonNullable<typeof m> => Boolean(m));
    return (
      <Link key={t.id} href={`/trips/${t.id}`} className="row row--link trip-row">
        <span className="row__body">
          <span className="row__title">{t.name}</span>
          <span className="row__subtitle">
            {tripRange(t, today)}
            {t.destination && ` · ${t.destination}`}
          </span>
          {going.length > 0 && (
            <span className="trip-row__people" aria-label={`Going: ${going.map((m) => m.display_name).join(", ")}`}>
              {going.map((m) => (
                <Avatar key={m.id} member={m} size="mini" />
              ))}
            </span>
          )}
        </span>
        {phase.phase !== "past" && <span className={`trip-badge trip-badge--${phase.phase}`}>{phase.label}</span>}
        <ChevronRightIcon className="row__chevron" size={16} />
      </Link>
    );
  };

  return (
    <main className="screen">
      <Navbar
        title="Trips"
        trailing={
          canEdit ? (
            <button type="button" className="nav-button nav-button--icon" aria-label="New trip" onClick={() => setCreating(true)}>
              <PlusIcon size={24} />
            </button>
          ) : undefined
        }
      />

      {!loading && trips.length === 0 && (
        <section className="section">
          <div className="group empty">
            <span className="empty__title">No trips yet</span>
            Plan where you&rsquo;re going, where you&rsquo;re staying each night and what&rsquo;s on each day.
            {canEdit && (
              <div style={{ marginTop: 16 }}>
                <button type="button" className="button button--primary" onClick={() => setCreating(true)}>
                  New trip
                </button>
              </div>
            )}
          </div>
        </section>
      )}

      {current.length > 0 && (
        <section className="section">
          <div className="section__header">
            <span className="section__header-title">Coming up</span>
          </div>
          <div className="group">{current.map(tripRow)}</div>
        </section>
      )}

      {past.length > 0 && (
        <section className="section">
          <div className="section__header">
            <span className="section__header-title">Past trips</span>
          </div>
          <div className="group">{past.map(tripRow)}</div>
        </section>
      )}

      {/* Passports and IDs (adults with access) */}
      {canEdit && (
        <section className="section">
          <div className="group">
            <Link href="/trips/ids" className="row row--link">
              <span className="row__body">
                <span className="row__title">Passports and ID cards</span>
                <span className="row__subtitle">Expiry dates and 1Password links</span>
              </span>
              <ChevronRightIcon className="row__chevron" size={16} />
            </Link>
          </div>
        </section>
      )}

      {/* Owner: who can see trips */}
      {isOwner && (
        <section className="section">
          <div className="section__header">
            <span className="section__header-title">Who can see trips</span>
          </div>
          <div className="group">
            {members.map((m) => {
              const on = !!access[m.id];
              return (
                <div key={m.id} className="row">
                  <Avatar member={m} size="mini" />
                  <span className="row__body">
                    <span className="row__title">{m.display_name}</span>
                    <span className="row__subtitle">
                      {roleLabel(m.role)}
                      {m.role === "child" && on ? " · can look, not change" : ""}
                    </span>
                  </span>
                  <button
                    type="button"
                    role="switch"
                    className="switch"
                    aria-label={`${m.display_name} can see trips`}
                    aria-checked={on}
                    disabled={m.role === "owner"}
                    onClick={() => setAccess(m.id, !on)}
                  />
                </div>
              );
            })}
          </div>
          <p className="section__footer">Trips stay hidden from everyone else, including on the calendar.</p>
        </section>
      )}

      <TripSheet
        open={creating}
        trip={null}
        participantIds={[]}
        members={members}
        today={today}
        onClose={() => setCreating(false)}
        onSave={create}
      />
      {toast.node}
    </main>
  );
}
