/**
 * Every list with its open and suggested counts. Shared by the Lists tab
 * and, on desktop, the list sidebar beside an open list.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { isNetworkError, readCache, writeCache } from "./offline";
import { getSupabaseBrowserClient } from "./supabase/client";
import type { List } from "./types";

export interface ListSummary extends List {
  open: number;
  suggested: number;
}

export function useListSummaries(opts: { refreshSuggestions?: boolean } = {}) {
  const supabase = getSupabaseBrowserClient();
  const [lists, setLists] = useState<ListSummary[] | null>(null);
  const { refreshSuggestions = false } = opts;

  // Step 1: lists plus one query for every open line, counted per list.
  const load = useCallback(async () => {
    if (refreshSuggestions) await supabase.rpc("refresh_suggestions");
    const [listsRes, openRes] = await Promise.all([
      supabase.from("lists").select("*").order("sort_order").order("created_at"),
      supabase.from("list_entries").select("list_id, source").eq("status", "open"),
    ]);
    if (listsRes.error && isNetworkError(listsRes.error)) {
      setLists(readCache<ListSummary[]>("list-summaries") ?? []);
      return;
    }
    const openLines = (openRes.data ?? []) as Array<{ list_id: string; source: string }>;
    const summaries = ((listsRes.data ?? []) as List[]).map((l) => ({
      ...l,
      open: openLines.filter((o) => o.list_id === l.id).length,
      suggested: openLines.filter((o) => o.list_id === l.id && o.source === "suggested").length,
    }));
    setLists(summaries);
    writeCache("list-summaries", summaries);
  }, [supabase, refreshSuggestions]);

  // Step 2: first load, live counts while lines change, and a catch-up when
  //         the app returns to the foreground.
  useEffect(() => {
    load();
    const channel = supabase
      .channel(`list-summaries:${Math.random().toString(36).slice(2)}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "list_entries" }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "lists" }, () => load())
      .subscribe();
    const onVisible = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      supabase.removeChannel(channel);
    };
  }, [supabase, load]);

  return { lists, reload: load };
}
