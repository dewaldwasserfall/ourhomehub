/**
 * Lists tab.
 *
 * Shows every list with what's open on it, a row into Rhythms, a short
 * "Coming up" preview of items the engine expects you'll need soon, and (for
 * adults) a way to add a list. Today is the home screen since Phase 3.
 */
"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useHousehold } from "@/components/household-context";
import { CartIcon, ChecklistIcon, ChevronRightIcon, GlowSparkle, PlusIcon, RhythmIcon } from "@/components/icons";
import { Navbar } from "@/components/navbar";
import { Segmented } from "@/components/segmented";
import { Sheet } from "@/components/sheet";
import { friendlyError } from "@/lib/errors";
import { describeDue, MIN_CONFIDENCE } from "@/lib/rhythm";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import type { ItemPattern, List, ListType } from "@/lib/types";

interface ListSummary extends List {
  open: number;
  suggested: number;
}

type UpcomingItem = ItemPattern & { item: { display_name: string } };

export default function ListsPage() {
  const supabase = getSupabaseBrowserClient();
  const { household, meIsAdult } = useHousehold();
  const [lists, setLists] = useState<ListSummary[] | null>(null);
  const [upcoming, setUpcoming] = useState<UpcomingItem[]>([]);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<ListType>("shopping");
  const [error, setError] = useState<string | null>(null);

  // Step 1: load lists with counts, plus the next few predicted items.
  const load = useCallback(async () => {
    await supabase.rpc("refresh_suggestions");
    const [listsRes, openRes, upcomingRes] = await Promise.all([
      supabase.from("lists").select("*").order("sort_order").order("created_at"),
      supabase.from("list_entries").select("list_id, source").eq("status", "open"),
      supabase
        .from("item_patterns")
        .select("*, item:items(display_name)")
        .not("next_expected_at", "is", null)
        .gte("confidence", MIN_CONFIDENCE)
        .gt("next_expected_at", new Date().toISOString())
        .order("next_expected_at")
        .limit(3),
    ]);
    const openLines = (openRes.data ?? []) as Array<{ list_id: string; source: string }>;
    setLists(
      ((listsRes.data ?? []) as List[]).map((l) => ({
        ...l,
        open: openLines.filter((o) => o.list_id === l.id).length,
        suggested: openLines.filter((o) => o.list_id === l.id && o.source === "suggested").length,
      })),
    );
    setUpcoming((upcomingRes.data ?? []) as UpcomingItem[]);
  }, [supabase]);

  useEffect(() => {
    load();
    const onVisible = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [load]);

  // Step 2: create a list.
  async function createList() {
    const name = newName.trim();
    if (!name) return;
    const { error: insertError } = await supabase.from("lists").insert({
      household_id: household.id,
      name,
      type: newType,
      sort_order: (lists?.length ?? 0) + 1,
    });
    if (insertError) {
      setError(friendlyError(insertError));
      return;
    }
    setSheetOpen(false);
    setNewName("");
    setNewType("shopping");
    setError(null);
    load();
  }

  return (
    <main className="screen">
      <Navbar
        title="Lists"
        trailing={
          meIsAdult && (
          <button
            type="button"
            className="nav-button nav-button--icon"
            aria-label="New list"
            onClick={() => setSheetOpen(true)}
          >
            <PlusIcon size={24} />
          </button>
          )
        }
      />

      {/* Lists */}
      <section className="section">
        <div className="group">
          {lists === null &&
            [0, 1].map((i) => <div key={i} className="skeleton" style={{ height: 64 }} />)}
          {lists?.map((list) => {
            const Icon = list.type === "shopping" ? CartIcon : ChecklistIcon;
            const noun = list.type === "shopping" ? "to buy" : "to do";
            return (
              <Link
                key={list.id}
                href={`/lists/${list.id}`}
                className="row row--link"
                style={{ minHeight: 64 }}
              >
                <span
                  className="row__icon"
                  style={{ background: list.type === "shopping" ? "var(--accent)" : "#ff9500" }}
                >
                  <Icon size={19} strokeWidth={2} />
                </span>
                <span className="row__body">
                  <span className="row__title" style={{ fontWeight: 500 }}>
                    {list.name}
                  </span>
                  <span className="row__subtitle">
                    {list.open === 0 ? "All done" : `${list.open} ${noun}`}
                  </span>
                </span>
                <span className="row__trailing">
                  {list.suggested > 0 && (
                    <span
                      style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 13 }}
                      aria-label={`${list.suggested} suggested`}
                    >
                      <GlowSparkle size={14} id={`spark-${list.id}`} />
                      <span className="glow-text">{list.suggested}</span>
                    </span>
                  )}
                  <ChevronRightIcon className="row__chevron" size={16} />
                </span>
              </Link>
            );
          })}
        </div>
      </section>

      {/* Rhythms: what the app has learned (used to be its own tab) */}
      <section className="section">
        <div className="group">
          <Link href="/rhythms" className="row row--link">
            <span className="row__icon" style={{ background: "#af52de" }}>
              <RhythmIcon size={19} strokeWidth={2} />
            </span>
            <span className="row__body">
              <span className="row__title">Rhythms</span>
              <span className="row__subtitle">How often you buy things, and what&rsquo;s due next</span>
            </span>
            <ChevronRightIcon className="row__chevron" size={16} />
          </Link>
        </div>
      </section>

      {/* Coming up: a glimpse of what the engine expects */}
      {upcoming.length > 0 && (
        <section className="section">
          <div className="section__header">
            <span className="section__header-title">Coming up</span>
            <Link href="/rhythms" className="section__header-action">
              See all
            </Link>
          </div>
          <div className="group">
            {upcoming.map((p) => (
              <div key={p.item_id} className="row" style={{ ["--separator-inset" as string]: "16px" }}>
                <span className="row__body">
                  <span className="row__title">{p.item.display_name}</span>
                </span>
                <span className="row__trailing" style={{ fontSize: 15 }}>
                  {describeDue(p.next_expected_at!)}
                </span>
              </div>
            ))}
          </div>
          <p className="section__footer">These are added to Groceries automatically when they&rsquo;re due.</p>
        </section>
      )}

      {/* New list sheet */}
      <Sheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title="New list"
        leading={
          <button type="button" className="nav-button" onClick={() => setSheetOpen(false)}>
            Cancel
          </button>
        }
        trailing={
          <button
            type="button"
            className="nav-button nav-button--strong"
            onClick={createList}
            disabled={!newName.trim()}
          >
            Create
          </button>
        }
      >
        <div className="sheet__stack">
          <input
            className="input"
            aria-label="List name"
            placeholder={newType === "shopping" ? "e.g. Hardware store" : "e.g. Weekend jobs"}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && createList()}
            maxLength={40}
            autoFocus
          />
          <div>
            <Segmented
              label="List type"
              value={newType}
              onChange={setNewType}
              options={[
                { value: "shopping", label: "Shopping" },
                { value: "todo", label: "To-do" },
              ]}
            />
            <p className="section__footer">
              {newType === "shopping"
                ? "Sorted by aisle. Everything you tick off teaches HomeHub your rhythms."
                : "A simple checklist. Nothing is learned from it."}
            </p>
          </div>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </div>
      </Sheet>
    </main>
  );
}
