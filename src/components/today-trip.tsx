/**
 * Today's trip card (people with access to Trips):
 *
 *   during a trip   "Spain · Day 3 of 10", tonight's stay, today's plans,
 *                   check-ins and check-outs
 *   the week before "Spain · In 4 days" with the first stay
 *
 * Tapping opens the trip.
 */
"use client";

import Link from "next/link";
import { useHousehold } from "@/components/household-context";
import { ChevronRightIcon, SuitcaseIcon } from "@/components/icons";
import { canSeeTrips } from "@/lib/roles";
import { buildTripDays, planTime, todayTrip, tripPhase } from "@/lib/trips";
import { useTrip, useTrips } from "@/lib/use-trips";

export function TodayTrip({ today }: { today: string }) {
  const { household, me } = useHousehold();
  const { trips } = useTrips(household.id, canSeeTrips(me));
  const trip = todayTrip(trips, today);
  return trip ? <TripCard tripId={trip.id} today={today} /> : null;
}

/** Separate so the trip's stays and plans load only when there's a card. */
function TripCard({ tripId, today }: { tripId: string; today: string }) {
  const { trip, stays, plans } = useTrip(tripId);
  if (!trip) return null;
  const phase = tripPhase(trip, today);

  // Step 1: today's lines during the trip; the first stay before it.
  const day = buildTripDays(trip, stays, plans).find((d) => d.date === today);
  const lines: string[] = [];
  if (phase.phase === "ongoing" && day) {
    for (const s of day.checkOuts) lines.push(`Check out of ${s.name}`);
    for (const p of day.plans) lines.push(planTime(p.time) ? `${planTime(p.time)} · ${p.title}` : p.title);
    for (const s of day.checkIns) lines.push(`Check in at ${s.name}`);
    if (day.stay && !day.checkIns.length) lines.push(`Tonight: ${day.stay.name}`);
  } else if (phase.phase === "upcoming") {
    const first = [...stays].sort((a, b) => a.check_in.localeCompare(b.check_in))[0];
    if (first) lines.push(`First stay: ${first.name}`);
  }

  // Step 2: render.
  return (
    <section className="section">
      <Link href={`/trips/${trip.id}`} className="group today-trip">
        <span className="today-trip__head">
          <span className="row__icon today-trip__icon">
            <SuitcaseIcon size={19} strokeWidth={2} />
          </span>
          <span className="row__body">
            <span className="row__title">{trip.name}</span>
            <span className="row__subtitle">
              {phase.label}
              {trip.destination && ` · ${trip.destination}`}
            </span>
          </span>
          <ChevronRightIcon className="row__chevron" size={16} />
        </span>
        {lines.length > 0 && (
          <span className="today-trip__lines">
            {lines.slice(0, 5).map((line, i) => (
              <span key={i} className="today-trip__line">
                {line}
              </span>
            ))}
          </span>
        )}
      </Link>
    </section>
  );
}
