/**
 * Data hook for the Calendar tab and the Household calendar card.
 *
 * Reads the synced copy straight from Supabase (RLS: own household only),
 * listens for realtime changes, and sends every write through the server
 * routes, which talk to Google first.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { readCache, writeCache } from "../offline";
import { getSupabaseBrowserClient } from "../supabase/client";
import type { CalendarConnectionStatus, CalendarEventRow, EventInput } from "./types";

/** Rows per request; matches Supabase's default API row limit. */
const EVENTS_PAGE_SIZE = 1000;

export interface ApiResult<T = unknown> {
  ok: boolean;
  data?: T;
  message?: string;
}

/** Call one of the calendar server routes; errors come back as interface copy. */
export async function calendarApi<T = unknown>(path: string, method: string, body?: unknown): Promise<ApiResult<T>> {
  try {
    const res = await fetch(path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, message: json.message ?? "Something went wrong. Try again." };
    return { ok: true, data: json as T };
  } catch {
    return { ok: false, message: "No connection. Check your internet and try again." };
  }
}

export function useCalendar(householdId: string) {
  const supabase = getSupabaseBrowserClient();
  const [rows, setRows] = useState<CalendarEventRow[]>([]);
  const [status, setStatus] = useState<CalendarConnectionStatus | null | undefined>(undefined); // undefined = loading
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Step 1: load the synced events and the connection summary.
  //         Supabase returns at most 1,000 rows per request, and the family
  //         calendar has more, so events are fetched page by page (ordered by
  //         id so pages never overlap or skip a row).
  const loadAllEvents = useCallback(async (): Promise<CalendarEventRow[] | null> => {
    const all: CalendarEventRow[] = [];
    for (let from = 0; ; from += EVENTS_PAGE_SIZE) {
      const { data, error } = await supabase
        .from("calendar_events")
        .select("*")
        .order("id")
        .range(from, from + EVENTS_PAGE_SIZE - 1);
      if (error) return null;
      all.push(...(data as CalendarEventRow[]));
      if (data.length < EVENTS_PAGE_SIZE) return all;
    }
  }, [supabase]);

  const load = useCallback(async () => {
    const [events, statusRes] = await Promise.all([loadAllEvents(), supabase.rpc("calendar_connection_status")]);
    const cacheKey = `calendar:${householdId}`;
    if (events) {
      setRows(events);
      // Offline copy: every repeating series and its exceptions, plus one-off
      // events from a week ago onwards (keeps it small enough for the phone).
      const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
      writeCache(
        cacheKey,
        events.filter((e) => e.recurrence || e.recurring_event_id || (e.end_at ?? `${e.end_date}T00:00:00Z`) >= weekAgo),
      );
    } else {
      // No connection: show the last copy.
      const cached = readCache<CalendarEventRow[]>(cacheKey);
      if (cached) setRows(cached);
    }
    if (!statusRes.error) {
      const list = (statusRes.data ?? []) as CalendarConnectionStatus[];
      setStatus(list[0] ?? null);
      writeCache(`calendar-status:${householdId}`, list[0] ?? null);
    } else {
      const cachedStatus = readCache<CalendarConnectionStatus | null>(`calendar-status:${householdId}`);
      if (cachedStatus !== null) setStatus(cachedStatus);
    }
    setLoading(false);
  }, [supabase, loadAllEvents, householdId]);

  // Step 2: ask the server to pull from Google now, then reload.
  const sync = useCallback(async () => {
    setSyncing(true);
    const result = await calendarApi("/api/calendar/sync", "POST");
    await load();
    setSyncing(false);
    return result;
  }, [load]);

  // Step 3: initial load, realtime, and a catch-up when the app returns.
  useEffect(() => {
    load();
    const schedule = () => {
      clearTimeout(refetchTimer.current);
      refetchTimer.current = setTimeout(load, 300);
    };
    const channel = supabase
      .channel(`calendar:${householdId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "calendar_events", filter: `household_id=eq.${householdId}` }, schedule)
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "calendar_events" }, schedule)
      .subscribe();
    const onVisible = () => document.visibilityState === "visible" && schedule();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(refetchTimer.current);
      document.removeEventListener("visibilitychange", onVisible);
      supabase.removeChannel(channel);
    };
  }, [supabase, householdId, load]);

  // Step 4: writes (Google first, then the local copy; realtime tells the others).
  const createEvent = useCallback(
    async (input: EventInput) => {
      const result = await calendarApi<{ event: CalendarEventRow }>("/api/calendar/events", "POST", input);
      if (result.ok && result.data) setRows((r) => [...r, result.data!.event]);
      return result;
    },
    [],
  );

  const updateEvent = useCallback(async (id: string, input: EventInput) => {
    const result = await calendarApi<{ event: CalendarEventRow }>(`/api/calendar/events/${id}`, "PATCH", input);
    if (result.ok && result.data) setRows((r) => r.map((row) => (row.id === id ? result.data!.event : row)));
    return result;
  }, []);

  const deleteEvent = useCallback(async (id: string) => {
    const result = await calendarApi(`/api/calendar/events/${id}`, "DELETE");
    if (result.ok) setRows((r) => r.filter((row) => row.id !== id));
    return result;
  }, []);

  return { rows, status, loading, syncing, reload: load, sync, createEvent, updateEvent, deleteEvent };
}
