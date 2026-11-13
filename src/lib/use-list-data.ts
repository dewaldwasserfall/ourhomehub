/**
 * Data hook for one list screen.
 *
 * Loads the list, its open and recently completed lines (with item and
 * learned pattern), and the household's item catalogue for autocomplete.
 * Subscribes to realtime so changes from the other phone appear instantly,
 * and exposes optimistic helpers so taps feel immediate.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { enqueue, isNetworkError, readCache, SYNCED_EVENT, writeCache } from "./offline";
import { getSupabaseBrowserClient } from "./supabase/client";
import type { EntryStatus, ItemWithPattern, List, ListEntryWithItem } from "./types";

/** How many completed lines to keep visible before "Clear" tidies them away. */
const COMPLETED_LIMIT = 40;

const ENTRY_SELECT = "*, item:items(*, pattern:item_patterns(*))";

export function useListData(listId: string) {
  const supabase = getSupabaseBrowserClient();
  const [list, setList] = useState<List | null>(null);
  const [entries, setEntries] = useState<ListEntryWithItem[]>([]);
  const [catalogue, setCatalogue] = useState<ItemWithPattern[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Step 1: fetch the lines (open + recent completed).
  const loadEntries = useCallback(async () => {
    const [open, done] = await Promise.all([
      supabase.from("list_entries").select(ENTRY_SELECT).eq("list_id", listId).eq("status", "open").order("added_at"),
      supabase
        .from("list_entries")
        .select(ENTRY_SELECT)
        .eq("list_id", listId)
        .eq("status", "done")
        .order("completed_at", { ascending: false })
        .limit(COMPLETED_LIMIT),
    ]);
    if (!open.error && !done.error) {
      const all = [...(open.data as ListEntryWithItem[]), ...(done.data as ListEntryWithItem[])];
      setEntries(all);
      writeCache(`list:${listId}:entries`, all);
    } else if (isNetworkError(open.error ?? done.error)) {
      // Offline: the last copy of this list.
      const cached = readCache<ListEntryWithItem[]>(`list:${listId}:entries`);
      if (cached) setEntries(cached);
    }
  }, [supabase, listId]);

  // Step 2: fetch the catalogue (only needed for shopping lists).
  const loadCatalogue = useCallback(async () => {
    const { data } = await supabase.from("items").select("*, pattern:item_patterns(*)").order("display_name");
    if (data) {
      setCatalogue(data as ItemWithPattern[]);
      writeCache("catalogue", data);
    } else {
      const cached = readCache<ItemWithPattern[]>("catalogue");
      if (cached) setCatalogue(cached);
    }
  }, [supabase]);

  // Step 3: initial load. For shopping lists, ask the engine for anything due
  // first, so suggestions are there the moment the list opens.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data: fetched, error: listError } = await supabase.from("lists").select("*").eq("id", listId).maybeSingle<List>();
      if (cancelled) return;
      // Offline: use the copy of the list row from the last visit.
      const listRow = fetched ?? (isNetworkError(listError) ? readCache<List>(`list:${listId}`) : null);
      if (fetched) writeCache(`list:${listId}`, fetched);
      if (!listRow) {
        setNotFound(true);
        setLoading(false);
        return;
      }
      setList(listRow);
      if (listRow.type === "shopping") {
        if (fetched) await supabase.rpc("refresh_suggestions");
        await loadCatalogue();
      }
      await loadEntries();
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase, listId, loadEntries, loadCatalogue]);

  // Step 4: realtime. Any change to this household's lines triggers a short,
  // debounced refetch (bursts like "Clear completed" collapse into one).
  useEffect(() => {
    if (!list) return;
    const scheduleRefetch = () => {
      clearTimeout(refetchTimer.current);
      refetchTimer.current = setTimeout(() => {
        loadEntries();
        if (list.type === "shopping") loadCatalogue();
      }, 250);
    };
    const channel = supabase
      .channel(`list:${list.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "list_entries", filter: `list_id=eq.${list.id}` },
        scheduleRefetch,
      )
      // Deletes only carry the primary key, so they can't be filtered by list.
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "list_entries" }, scheduleRefetch)
      .subscribe();

    // Also catch up when the app comes back to the foreground, and after
    // changes made offline have been sent.
    const onVisible = () => document.visibilityState === "visible" && scheduleRefetch();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(SYNCED_EVENT, scheduleRefetch);

    return () => {
      clearTimeout(refetchTimer.current);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(SYNCED_EVENT, scheduleRefetch);
      supabase.removeChannel(channel);
    };
  }, [supabase, list, loadEntries, loadCatalogue]);

  // Step 5: optimistic helpers. Update local state first, then the database;
  // on failure, reload the truth and report the error to the caller.
  const patchLocal = useCallback((id: string, patch: Partial<ListEntryWithItem>) => {
    setEntries((current) => current.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  }, []);

  const setStatus = useCallback(
    async (id: string, status: EntryStatus) => {
      const now = new Date().toISOString();
      patchLocal(id, { status, completed_at: status === "done" ? now : null });
      const { error } = await supabase.from("list_entries").update({ status }).eq("id", id);
      // No connection: keep the tick and send it later.
      if (error && isNetworkError(error) && (status === "open" || status === "done")) {
        enqueue({ type: "set_status", entryId: id, status });
        setEntries((current) => {
          const next = current.map((e) => (e.id === id ? { ...e, status, completed_at: status === "done" ? now : null } : e));
          writeCache(`list:${listId}:entries`, next);
          return next;
        });
        return null;
      }
      if (error) await loadEntries();
      return error;
    },
    [supabase, patchLocal, loadEntries, listId],
  );

  const removeEntry = useCallback(
    async (id: string) => {
      setEntries((current) => current.filter((e) => e.id !== id));
      const { error } = await supabase.from("list_entries").delete().eq("id", id);
      if (error) await loadEntries();
      return error;
    },
    [supabase, loadEntries],
  );

  const clearCompleted = useCallback(async () => {
    const doneIds = entries.filter((e) => e.status === "done").map((e) => e.id);
    if (doneIds.length === 0) return null;
    setEntries((current) => current.filter((e) => e.status !== "done"));
    const { error } = await supabase.from("list_entries").update({ status: "cleared" }).in("id", doneIds);
    if (error) await loadEntries();
    return error;
  }, [supabase, entries, loadEntries]);

  /**
   * A line added while offline: shown straight away (marked pending) until
   * the queued change has been sent and the list reloads.
   */
  const addPendingLine = useCallback(
    (text: string, quantity: string | null) => {
      const now = new Date().toISOString();
      const pending = {
        id: `pending-${crypto.randomUUID()}`,
        list_id: listId,
        household_id: list?.household_id ?? "",
        item_id: null,
        item: null,
        text,
        quantity,
        note: "Waiting for a connection",
        status: "open",
        source: "manual",
        added_by: null,
        added_at: now,
        completed_by: null,
        completed_at: null,
        updated_at: now,
        due_date: null,
        assigned_to: null,
      } as unknown as ListEntryWithItem;
      setEntries((current) => [...current, pending]);
    },
    [listId, list?.household_id],
  );

  return {
    list,
    addPendingLine,
    entries,
    catalogue,
    loading,
    notFound,
    reload: loadEntries,
    reloadCatalogue: loadCatalogue,
    patchLocal,
    setStatus,
    removeEntry,
    clearCompleted,
  };
}
