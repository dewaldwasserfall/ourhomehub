/**
 * One trip.
 *
 *   Overview – dates and countdown, who's going (with join/leave dates),
 *              nights still without a place to sleep, the emergency card,
 *              notes. Edit or delete the trip.
 *   Days     – the day-by-day timeline: check-outs, check-ins, plans in time
 *              order, and where you sleep that night.
 *   Packing  – groups, per-person items, saved lists (components/trip-packing)
 *   Budget   – costs in several currencies, paid or not (adults only;
 *              components/trip-budget)
 *
 * Adults with access edit; children with access only read. (Documents
 * arrive in the next phase.)
 */
"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Avatar } from "@/components/avatar";
import { useHousehold } from "@/components/household-context";
import { ChevronLeftIcon, ChevronRightIcon, PlusIcon } from "@/components/icons";
import { Navbar } from "@/components/navbar";
import { Segmented } from "@/components/segmented";
import { useToast } from "@/components/toast";
import { TripBudget } from "@/components/trip-budget";
import { TripPacking } from "@/components/trip-packing";
import {
  EMERGENCY_LABELS,
  EmergencySheet,
  ParticipantSheet,
  PlanSheet,
  StaySheet,
  TripSheet,
  type PlanFields,
  type StayFields,
  type TripFields,
} from "@/components/trip-sheets";
import { addDays, dateKey } from "@/lib/calendar/time";
import { friendlyError } from "@/lib/errors";
import { canEditTrips } from "@/lib/roles";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import {
  buildTripDays,
  missedSchool,
  namesList,
  nightsWithoutStay,
  participantDates,
  planTime,
  shortDate,
  stayNights,
  tripDates,
  tripPhase,
  tripRange,
} from "@/lib/trips";
import type { TripEmergency, TripParticipant, TripPlan, TripStay } from "@/lib/types";
import { useTrip } from "@/lib/use-trips";

type Section = "overview" | "days" | "packing" | "budget";

const dayHeading = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const heading = (date: string) => dayHeading.format(new Date(`${date}T12:00:00Z`));

export default function TripPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const supabase = getSupabaseBrowserClient();
  const toast = useToast();
  const { household, members, me, memberById } = useHousehold();
  const today = dateKey(new Date(), household.timezone);
  const canEdit = canEditTrips(me);
  const { trip, participants, stays, plans, checklist, budget, rates, loading, missing, reload } = useTrip(id);
  const [section, setSection] = useState<Section>("overview");

  // Which sheet is open.
  const [editingTrip, setEditingTrip] = useState(false);
  const [editingEmergency, setEditingEmergency] = useState(false);
  const [stay, setStay] = useState<{ stay: TripStay | null } | null>(null);
  const [plan, setPlan] = useState<{ plan: TripPlan | null; day: string } | null>(null);
  const [person, setPerson] = useState<TripParticipant | null>(null);

  const days = useMemo(() => (trip ? buildTripDays(trip, stays, plans) : []), [trip, stays, plans]);

  // School days during the trip (same holiday rules as Today), to warn when
  // a child going would miss school.
  const [schoolDays, setSchoolDays] = useState<string[]>([]);
  useEffect(() => {
    if (!trip) return;
    supabase.rpc("school_days", { p_from: trip.start_date, p_to: trip.end_date }).then(({ data }) => {
      setSchoolDays(((data ?? []) as string[]).map((d) => String(d).slice(0, 10)));
    });
  }, [supabase, trip?.start_date, trip?.end_date]); // eslint-disable-line react-hooks/exhaustive-deps
  const missed = useMemo(() => missedSchool(participants, members, schoolDays), [participants, members, schoolDays]);

  /** Run a write; show any error; reload. Returns whether it worked. */
  async function run(write: PromiseLike<{ error: { message: string } | null }>): Promise<boolean> {
    const { error } = await write;
    if (error) {
      toast.show(friendlyError(error));
      return false;
    }
    await reload();
    return true;
  }

  // ---------------------------------------------------------------------------
  // Step 1: the trip itself (and who's going)
  // ---------------------------------------------------------------------------
  async function saveTrip(f: TripFields): Promise<boolean> {
    if (!trip) return false;
    const ok = await run(
      supabase
        .from("trips")
        .update({ name: f.name, destination: f.destination, start_date: f.start_date, end_date: f.end_date, notes: f.notes })
        .eq("id", trip.id),
    );
    if (!ok) return false;
    // Who's going: add the new ones, remove the dropped ones (keeping dates).
    const before = participants.map((p) => p.member_id);
    const added = f.participantIds.filter((m) => !before.includes(m));
    const removed = before.filter((m) => !f.participantIds.includes(m));
    if (added.length) await run(supabase.from("trip_participants").insert(added.map((member_id) => ({ trip_id: trip.id, member_id }))));
    if (removed.length) await run(supabase.from("trip_participants").delete().eq("trip_id", trip.id).in("member_id", removed));
    return true;
  }

  async function deleteTrip() {
    if (!trip) return;
    const { error } = await supabase.from("trips").delete().eq("id", trip.id);
    if (error) return void toast.show(friendlyError(error));
    router.replace("/trips");
  }

  const saveEmergency = (value: TripEmergency) => run(supabase.from("trips").update({ emergency: value }).eq("id", id));

  const saveParticipant = (join: string | null, leave: string | null) =>
    person
      ? run(supabase.from("trip_participants").update({ join_date: join, leave_date: leave }).match({ trip_id: id, member_id: person.member_id }))
      : Promise.resolve(false);

  // ---------------------------------------------------------------------------
  // Step 2: stays and plans
  // ---------------------------------------------------------------------------
  const saveStay = (f: StayFields) =>
    stay?.stay
      ? run(supabase.from("trip_stays").update(f).eq("id", stay.stay.id))
      : run(supabase.from("trip_stays").insert({ trip_id: id, ...f }));
  const deleteStay = async () => {
    if (stay?.stay && (await run(supabase.from("trip_stays").delete().eq("id", stay.stay.id)))) setStay(null);
  };

  const savePlan = (f: PlanFields) =>
    plan?.plan
      ? run(supabase.from("trip_plans").update(f).eq("id", plan.plan.id))
      : run(supabase.from("trip_plans").insert({ trip_id: id, ...f }));
  const deletePlan = async () => {
    if (plan?.plan && (await run(supabase.from("trip_plans").delete().eq("id", plan.plan.id)))) setPlan(null);
  };

  // ---------------------------------------------------------------------------
  // Step 3: render
  // ---------------------------------------------------------------------------
  const back = (
    <Link href="/trips" className="nav-button" aria-label="Back to Trips">
      <ChevronLeftIcon size={22} />
      Trips
    </Link>
  );

  if (missing) {
    return (
      <main className="screen">
        <Navbar title="Trip" leading={back} />
        <section className="section">
          <div className="group empty">
            <span className="empty__title">This trip isn&rsquo;t here</span>
            It may have been deleted, or you don&rsquo;t have access to Trips.
          </div>
        </section>
      </main>
    );
  }
  if (loading || !trip) {
    return (
      <main className="screen">
        <Navbar title="Trip" leading={back} />
        <section className="section">
          <div className="group" aria-busy="true">
            <div className="skeleton" style={{ height: 60 }} />
            <div className="skeleton" style={{ height: 60 }} />
          </div>
        </section>
      </main>
    );
  }

  const phase = tripPhase(trip, today);
  const noStay = nightsWithoutStay(trip, stays);
  const emergencyKeys = (Object.keys(EMERGENCY_LABELS) as Array<keyof TripEmergency>).filter((k) => trip.emergency?.[k]);
  // A new stay starts on the first night without one (or the first day).
  const defaultCheckIn = noStay[0] ?? trip.start_date;
  const defaultCheckOut = stays.length ? trip.end_date : trip.end_date > defaultCheckIn ? trip.end_date : addDays(defaultCheckIn, 1);

  return (
    <main className="screen">
      <Navbar
        title={trip.name}
        subtitle={`${tripRange(trip, today)}${trip.destination ? ` · ${trip.destination}` : ""}`}
        leading={back}
        trailing={
          canEdit ? (
            <button type="button" className="nav-button" onClick={() => setEditingTrip(true)}>
              Edit
            </button>
          ) : undefined
        }
      />

      <section className="section">
        <Segmented
          label="Trip section"
          value={section}
          onChange={setSection}
          options={[
            { value: "overview", label: "Overview" },
            { value: "days", label: "Days" },
            { value: "packing", label: "Packing" },
            // Money is for adults with access only (children see the rest).
            ...(canEdit ? [{ value: "budget" as const, label: "Budget" }] : []),
          ]}
        />
      </section>

      {/* ------------------------------------------------------------- */}
      {/* Overview                                                      */}
      {/* ------------------------------------------------------------- */}
      {section === "overview" && (
        <>
          {/* When */}
          <section className="section">
            <div className="group">
              <div className="row">
                <span className="row__body">
                  <span className="row__title">{tripRange(trip, today)}</span>
                  <span className="row__subtitle">
                    {tripDates(trip).length === 1 ? "1 day" : `${tripDates(trip).length} days`} ·{" "}
                    {tripDates(trip).length - 1 === 1 ? "1 night" : `${tripDates(trip).length - 1} nights`}
                  </span>
                </span>
                {phase.phase !== "past" && <span className={`trip-badge trip-badge--${phase.phase}`}>{phase.label}</span>}
              </div>
              {missed.length > 0 && (
                <div className="row">
                  <span className="row__body">
                    <span className="row__title trip-warning">
                      {(() => {
                        // Same days for everyone: one line; otherwise per child.
                        const same = missed.every((m) => m.days.join() === missed[0].days.join());
                        const name = (id: string) => memberById(id)?.display_name.split(" ")[0] ?? "";
                        const n = (d: string[]) => (d.length === 1 ? "1 school day" : `${d.length} school days`);
                        return same
                          ? `${namesList(missed.map((m) => name(m.memberId)))} would miss ${n(missed[0].days)}`
                          : missed.map((m) => `${name(m.memberId)} ${n(m.days)}`).join(" · ") + " missed";
                      })()}
                    </span>
                    <span className="row__subtitle">
                      {[...new Set(missed.flatMap((m) => m.days))].sort().slice(0, 6).map(shortDate).join(", ")}
                      {new Set(missed.flatMap((m) => m.days)).size > 6 ? "…" : ""}
                    </span>
                  </span>
                </div>
              )}
              {noStay.length > 0 && (
                <button type="button" className="row row--pressable" onClick={() => canEdit && setStay({ stay: null })} disabled={!canEdit}>
                  <span className="row__body">
                    <span className="row__title trip-warning">
                      {noStay.length === 1 ? "1 night" : `${noStay.length} nights`} without a place to stay
                    </span>
                    <span className="row__subtitle">{noStay.slice(0, 4).map(shortDate).join(", ")}{noStay.length > 4 ? "…" : ""}</span>
                  </span>
                  {canEdit && <PlusIcon size={20} className="trip-add-icon" />}
                </button>
              )}
            </div>
          </section>

          {/* Who's going */}
          <section className="section">
            <div className="section__header">
              <span className="section__header-title">Who&rsquo;s going</span>
            </div>
            <div className="group">
              {participants.length === 0 && (
                <div className="row">
                  <span className="row__body row__subtitle">Nobody yet. Edit the trip to choose who&rsquo;s going.</span>
                </div>
              )}
              {participants
                .map((p) => ({ p, m: memberById(p.member_id) }))
                .filter((x): x is { p: TripParticipant; m: NonNullable<typeof x.m> } => Boolean(x.m))
                .sort((a, b) => members.indexOf(a.m) - members.indexOf(b.m))
                .map(({ p, m }) => (
                  <button
                    key={p.member_id}
                    type="button"
                    className={`row ${canEdit ? "row--pressable" : ""}`}
                    onClick={canEdit ? () => setPerson(p) : undefined}
                  >
                    <Avatar member={m} size="mini" />
                    <span className="row__body">
                      <span className="row__title">{m.display_name}</span>
                      <span className="row__subtitle">{participantDates(p) || "The whole trip"}</span>
                    </span>
                    {canEdit && <ChevronRightIcon className="row__chevron" size={16} />}
                  </button>
                ))}
            </div>
          </section>

          {/* Emergency card */}
          <section className="section">
            <div className="section__header">
              <span className="section__header-title">Emergency card</span>
              {canEdit && (
                <button type="button" className="section__header-action" onClick={() => setEditingEmergency(true)}>
                  Edit
                </button>
              )}
            </div>
            <div className="group">
              {emergencyKeys.length === 0 ? (
                <div className="row">
                  <span className="row__body row__subtitle">Embassy, travel insurance and who to call, ready when you need them.</span>
                </div>
              ) : (
                emergencyKeys.map((k) => (
                  <div key={k} className="row">
                    <span className="row__body">
                      <span className="row__subtitle">{EMERGENCY_LABELS[k]}</span>
                      <span className="row__title trip-multiline">{trip.emergency[k]}</span>
                    </span>
                  </div>
                ))
              )}
            </div>
          </section>

          {/* Notes */}
          {trip.notes && (
            <section className="section">
              <div className="section__header">
                <span className="section__header-title">Notes</span>
              </div>
              <div className="group">
                <div className="row">
                  <span className="row__body trip-multiline">{trip.notes}</span>
                </div>
              </div>
            </section>
          )}
        </>
      )}

      {/* ------------------------------------------------------------- */}
      {/* Days                                                          */}
      {/* ------------------------------------------------------------- */}
      {section === "days" && (
        <>
          {canEdit && (
            <section className="section">
              <div className="trip-actions">
                <button type="button" className="button" onClick={() => setStay({ stay: null })}>
                  Add a stay
                </button>
                <button type="button" className="button" onClick={() => setPlan({ plan: null, day: today >= trip.start_date && today <= trip.end_date ? today : trip.start_date })}>
                  Add a plan
                </button>
              </div>
            </section>
          )}

          {days.map((d) => {
            const inTrip = d.date >= trip.start_date && d.date <= trip.end_date;
            const dayNumber = inTrip ? Math.round((Date.parse(d.date) - Date.parse(trip.start_date)) / 86400000) + 1 : null;
            const nothing = !d.checkOuts.length && !d.checkIns.length && !d.plans.length && !d.stay;
            return (
              <section key={d.date} className="section">
                <div className={`agenda-day ${d.date === today ? "agenda-day--today" : ""}`}>
                  <span className="agenda-day__name">{heading(d.date)}</span>
                  <span className="agenda-day__date">{dayNumber ? `Day ${dayNumber}` : "Outside the trip dates"}</span>
                </div>
                <div className="group">
                  {/* Leaving first: check-outs happen in the morning */}
                  {d.checkOuts.map((s) => (
                    <button key={`out-${s.id}`} type="button" className={`row ${canEdit ? "row--pressable" : ""}`} onClick={canEdit ? () => setStay({ stay: s }) : undefined}>
                      <span className="trip-time">Out</span>
                      <span className="row__body">
                        <span className="row__title">Check out · {s.name}</span>
                      </span>
                    </button>
                  ))}

                  {d.plans.map((p) => (
                    <button key={p.id} type="button" className={`row ${canEdit ? "row--pressable" : ""}`} onClick={canEdit ? () => setPlan({ plan: p, day: p.day }) : undefined}>
                      <span className="trip-time">{planTime(p.time) ?? ""}</span>
                      <span className="row__body">
                        <span className="row__title">{p.title}</span>
                        {p.details && <span className="row__subtitle trip-multiline">{p.details}</span>}
                      </span>
                    </button>
                  ))}

                  {d.checkIns.map((s) => (
                    <button key={`in-${s.id}`} type="button" className={`row ${canEdit ? "row--pressable" : ""}`} onClick={canEdit ? () => setStay({ stay: s }) : undefined}>
                      <span className="trip-time">In</span>
                      <span className="row__body">
                        <span className="row__title">Check in · {s.name}</span>
                        <span className="row__subtitle">
                          {stayNights(s) === 1 ? "1 night" : `${stayNights(s)} nights`}
                          {s.location && ` · ${s.location}`}
                          {s.booking_ref && ` · ref ${s.booking_ref}`}
                        </span>
                      </span>
                    </button>
                  ))}

                  {/* Where you sleep tonight (unless you just checked in there) */}
                  {d.stay && !d.checkIns.some((s) => s.id === d.stay!.id) && (
                    <button type="button" className={`row trip-night ${canEdit ? "row--pressable" : ""}`} onClick={canEdit ? () => setStay({ stay: d.stay }) : undefined}>
                      <span className="trip-time" aria-hidden="true">☾</span>
                      <span className="row__body">
                        <span className="row__subtitle">Night at {d.stay.name}</span>
                      </span>
                    </button>
                  )}

                  {nothing && (
                    <div className="row">
                      <span className="row__body row__subtitle">Nothing planned</span>
                    </div>
                  )}

                  {canEdit && (
                    <button type="button" className="row row--pressable trip-add-row" onClick={() => setPlan({ plan: null, day: d.date })}>
                      <PlusIcon size={18} />
                      <span className="row__body">Add a plan</span>
                    </button>
                  )}
                </div>
              </section>
            );
          })}
        </>
      )}

      {/* ------------------------------------------------------------- */}
      {/* Packing and budget                                            */}
      {/* ------------------------------------------------------------- */}
      {section === "packing" && (
        <TripPacking
          tripId={trip.id}
          householdId={household.id}
          items={checklist}
          going={members.filter((m) => participants.some((p) => p.member_id === m.id))}
          memberById={memberById}
          canEdit={canEdit}
          reload={reload}
        />
      )}
      {section === "budget" && canEdit && <TripBudget trip={trip} items={budget} rates={rates} reload={reload} />}

      {/* Sheets */}
      <TripSheet
        open={editingTrip}
        trip={trip}
        participantIds={participants.map((p) => p.member_id)}
        members={members}
        today={today}
        onClose={() => setEditingTrip(false)}
        onSave={saveTrip}
        onDelete={deleteTrip}
      />
      <EmergencySheet open={editingEmergency} value={trip.emergency} onClose={() => setEditingEmergency(false)} onSave={saveEmergency} />
      <StaySheet
        open={!!stay}
        stay={stay?.stay ?? null}
        defaultCheckIn={defaultCheckIn}
        defaultCheckOut={defaultCheckOut}
        onClose={() => setStay(null)}
        onSave={saveStay}
        onDelete={deleteStay}
      />
      <PlanSheet open={!!plan} plan={plan?.plan ?? null} defaultDay={plan?.day ?? trip.start_date} onClose={() => setPlan(null)} onSave={savePlan} onDelete={deletePlan} />
      <ParticipantSheet
        open={!!person}
        participant={person}
        member={person ? (memberById(person.member_id) ?? null) : null}
        trip={trip}
        onClose={() => setPerson(null)}
        onSave={saveParticipant}
      />
      {toast.node}
    </main>
  );
}
