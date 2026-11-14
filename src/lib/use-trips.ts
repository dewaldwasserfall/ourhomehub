/**
 * Data hooks for Trips.
 *
 *   * useTrips(householdId, enabled) – every trip with who's going (the
 *     Trips list, the calendar and Today)
 *   * useTrip(tripId)               – one trip with its stays and plans
 *
 * Both keep an offline copy and reload on realtime changes and when the
 * screen comes back into view. `enabled` is false for people without access
 * (RLS would return nothing anyway; this just skips the requests).
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { isNetworkError, readCache, SYNCED_EVENT, writeCache } from "./offline";
import { getSupabaseBrowserClient } from "./supabase/client";
import type { Trip, TripParticipant, TripPlan, TripStay } from "./types";

// -----------------------------------------------------------------------------
// Step 1: all trips
// -----------------------------------------------------------------------------

export function useTrips(householdId: string, enabled: boolean) {
  const supabase = getSupabaseBrowserClient();
  const [trips, setTrips] = useState<Trip[]>([]);
  const [participants, setParticipants] = useState<TripParticipant[]>([]);
  const [loading, setLoading] = useState(enabled);

  const reload = useCallback(async () => {
    if (!enabled) return;
    const [t, p] = await Promise.all([
      supabase.from("trips").select("*").eq("household_id", householdId).order("start_date"),
      supabase.from("trip_participants").select("*").eq("household_id", householdId),
    ]);
    if (t.error && isNetworkError(t.error)) {
      const cached = readCache<{ trips: Trip[]; participants: TripParticipant[] }>(`trips:${householdId}`);
      if (cached) {
        setTrips(cached.trips);
        setParticipants(cached.participants);
      }
      setLoading(false);
      return;
    }
    const next = { trips: (t.data ?? []) as Trip[], participants: (p.data ?? []) as TripParticipant[] };
    setTrips(next.trips);
    setParticipants(next.participants);
    writeCache(`trips:${householdId}`, next);
    setLoading(false);
  }, [supabase, householdId, enabled]);

  useEffect(() => {
    if (!enabled) return;
    reload();
    const onVisible = () => document.visibilityState === "visible" && reload();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(SYNCED_EVENT, reload);
    const channel = supabase
      .channel(`trips:${householdId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "trips", filter: `household_id=eq.${householdId}` }, () => reload())
      .on("postgres_changes", { event: "*", schema: "public", table: "trip_participants", filter: `household_id=eq.${householdId}` }, () => reload())
      .subscribe();
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(SYNCED_EVENT, reload);
      supabase.removeChannel(channel);
    };
  }, [supabase, householdId, enabled, reload]);

  return { trips, participants, loading, reload };
}

// -----------------------------------------------------------------------------
// Step 2: one trip in full
// -----------------------------------------------------------------------------

export interface TripDetail {
  trip: Trip | null;
  participants: TripParticipant[];
  stays: TripStay[];
  plans: TripPlan[];
}

const EMPTY: TripDetail = { trip: null, participants: [], stays: [], plans: [] };

export function useTrip(tripId: string) {
  const supabase = getSupabaseBrowserClient();
  const [data, setData] = useState<TripDetail>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);

  const reload = useCallback(async () => {
    const [t, p, s, pl] = await Promise.all([
      supabase.from("trips").select("*").eq("id", tripId).maybeSingle(),
      supabase.from("trip_participants").select("*").eq("trip_id", tripId),
      supabase.from("trip_stays").select("*").eq("trip_id", tripId).order("check_in"),
      supabase.from("trip_plans").select("*").eq("trip_id", tripId).order("day"),
    ]);
    if (t.error && isNetworkError(t.error)) {
      const cached = readCache<TripDetail>(`trip:${tripId}`);
      if (cached) setData(cached);
      setLoading(false);
      return;
    }
    // Not found, or no access (RLS hides it).
    if (!t.data) {
      setMissing(true);
      setLoading(false);
      return;
    }
    const next: TripDetail = {
      trip: t.data as Trip,
      participants: (p.data ?? []) as TripParticipant[],
      stays: (s.data ?? []) as TripStay[],
      plans: (pl.data ?? []) as TripPlan[],
    };
    setData(next);
    writeCache(`trip:${tripId}`, next);
    setLoading(false);
  }, [supabase, tripId]);

  useEffect(() => {
    reload();
    const onVisible = () => document.visibilityState === "visible" && reload();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(SYNCED_EVENT, reload);
    const filter = `trip_id=eq.${tripId}`;
    const channel = supabase
      .channel(`trip:${tripId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "trips", filter: `id=eq.${tripId}` }, () => reload())
      .on("postgres_changes", { event: "*", schema: "public", table: "trip_participants", filter }, () => reload())
      .on("postgres_changes", { event: "*", schema: "public", table: "trip_stays", filter }, () => reload())
      .on("postgres_changes", { event: "*", schema: "public", table: "trip_plans", filter }, () => reload())
      .subscribe();
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(SYNCED_EVENT, reload);
      supabase.removeChannel(channel);
    };
  }, [supabase, tripId, reload]);

  return { ...data, loading, missing, reload };
}
