/**
 * A single list (Groceries, To-do, ...).
 *
 * Layout, top to bottom:
 *   1. Suggested for you: lines the engine added, with the iridescent edge
 *   2. Open lines, grouped by aisle on shopping lists
 *   3. Completed: collapsible, with Clear
 *   4. The composer, floating above the tab bar
 */
"use client";

import { AnimatePresence } from "framer-motion";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useMemo, useRef, useState } from "react";
import { Composer } from "@/components/composer";
import { EditEntrySheet, type EntryEdits } from "@/components/edit-entry-sheet";
import { EntryRow } from "@/components/entry-row";
import { useHousehold } from "@/components/household-context";
import { ChevronDownIcon, ChevronLeftIcon, GlowSparkle } from "@/components/icons";
import { Navbar } from "@/components/navbar";
import { useToast } from "@/components/toast";
import { categoryRank, guessCategory } from "@/lib/categories";
import { friendlyError } from "@/lib/errors";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import type { ItemWithPattern, ListEntryWithItem } from "@/lib/types";
import { useListData } from "@/lib/use-list-data";

/** How long a ticked line stays in place (showing its check) before moving. */
const TICK_SETTLE_MS = 650;

export default function ListPage() {
  const { id } = useParams<{ id: string }>();
  const supabase = getSupabaseBrowserClient();
  const { me, memberByUserId } = useHousehold();
  const { list, entries, catalogue, loading, notFound, reload, reloadCatalogue, setStatus, removeEntry, clearCompleted } =
    useListData(id);
  const toast = useToast();

  const [editing, setEditing] = useState<ListEntryWithItem | null>(null);
  const [showCompleted, setShowCompleted] = useState(false);
  // Lines that show a tick but haven't moved to Completed yet.
  const [settling, setSettling] = useState<Set<string>>(new Set());
  const settleTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const isShopping = list?.type === "shopping";

  // ---------------------------------------------------------------------------
  // Step 1: split lines into sections.
  // ---------------------------------------------------------------------------
  const { suggested, groups, completed, openItemIds, openCount } = useMemo(() => {
    const open = entries.filter((e) => e.status === "open");
    const suggestedLines = open.filter((e) => e.source === "suggested");
    const manualLines = open.filter((e) => e.source !== "suggested");

    // Shopping: group by aisle in store order. To-do: one group.
    const byCategory = new Map<string, ListEntryWithItem[]>();
    for (const line of manualLines) {
      const key = isShopping ? (line.item?.category ?? "Other") : "To do";
      byCategory.set(key, [...(byCategory.get(key) ?? []), line]);
    }
    const grouped = [...byCategory.entries()].sort(([a], [b]) => categoryRank(a) - categoryRank(b));

    return {
      suggested: suggestedLines,
      groups: grouped,
      completed: entries.filter((e) => e.status === "done"),
      openItemIds: new Set(open.map((e) => e.item_id).filter(Boolean) as string[]),
      openCount: open.length,
    };
  }, [entries, isShopping]);

  // ---------------------------------------------------------------------------
  // Step 2: actions.
  // ---------------------------------------------------------------------------

  /** Tick or untick. Ticking shows the check first, then moves the line. */
  const toggle = useCallback(
    (entry: ListEntryWithItem) => {
      // Second tap while settling: cancel the tick.
      const pending = settleTimers.current.get(entry.id);
      if (pending) {
        clearTimeout(pending);
        settleTimers.current.delete(entry.id);
        setSettling((s) => new Set([...s].filter((x) => x !== entry.id)));
        return;
      }

      if (entry.status === "done") {
        setStatus(entry.id, "open").then((err) => err && toast.show(friendlyError(err)));
        return;
      }

      setSettling((s) => new Set(s).add(entry.id));
      const timer = setTimeout(async () => {
        settleTimers.current.delete(entry.id);
        const err = await setStatus(entry.id, "done");
        setSettling((s) => new Set([...s].filter((x) => x !== entry.id)));
        if (err) toast.show(friendlyError(err));
      }, TICK_SETTLE_MS);
      settleTimers.current.set(entry.id, timer);
    },
    [setStatus, toast],
  );

  /** Add from the composer. Returns true when saved so the input clears. */
  const add = useCallback(
    async (name: string, quantity: string | null, known?: ItemWithPattern) => {
      if (!list) return false;
      const { error } = await supabase.rpc("add_entry", {
        p_list_id: list.id,
        p_text: name,
        p_quantity: quantity,
        p_category: isShopping ? (known?.category ?? guessCategory(name)) : null,
      });
      if (error) {
        toast.show(friendlyError(error));
        return false;
      }
      await reload();
      if (isShopping) reloadCatalogue();
      return true;
    },
    [supabase, list, isShopping, reload, reloadCatalogue, toast],
  );

  /** "Not now" on a suggestion: the engine learns to wait longer. */
  const dismiss = useCallback(
    async (entry: ListEntryWithItem) => {
      const err = await setStatus(entry.id, "dismissed");
      toast.show(err ? friendlyError(err) : `Got it. ${entry.text} will come back a little later next time.`);
      await reload();
    },
    [setStatus, reload, toast],
  );

  /** Delete a manual line, with Undo. */
  const remove = useCallback(
    async (entry: ListEntryWithItem) => {
      const err = await removeEntry(entry.id);
      if (err) {
        toast.show(friendlyError(err));
        return;
      }
      toast.show(`Deleted ${entry.text}`, {
        label: "Undo",
        onAction: () => add(entry.text, entry.quantity, entry.item ?? undefined),
      });
    },
    [removeEntry, add, toast],
  );

  /** Save edits from the sheet. Renaming a shopping line re-links its item. */
  const saveEdits = useCallback(
    async (entry: ListEntryWithItem, edits: EntryEdits) => {
      if (!list) return;
      const renamed = edits.text !== entry.text;

      // Step 2a: shopping rename -> add under the new name, remove the old line,
      // so purchase history follows the right item.
      if (isShopping && renamed && entry.status === "open") {
        const { data: newId, error } = await supabase.rpc("add_entry", {
          p_list_id: list.id,
          p_text: edits.text,
          p_quantity: edits.quantity,
          p_category: edits.category ?? guessCategory(edits.text),
        });
        if (error) return void toast.show(friendlyError(error));
        if (newId !== entry.id) await supabase.from("list_entries").delete().eq("id", entry.id);
        if (edits.note) await supabase.from("list_entries").update({ note: edits.note }).eq("id", newId);
      } else {
        // Step 2b: plain field update.
        const { error } = await supabase
          .from("list_entries")
          .update({ text: edits.text, quantity: edits.quantity, note: edits.note })
          .eq("id", entry.id);
        if (error) return void toast.show(friendlyError(error));
      }

      // Step 2c: aisle lives on the item, so it sticks for next time.
      if (entry.item && edits.category && edits.category !== entry.item.category && !renamed) {
        await supabase.from("items").update({ category: edits.category }).eq("id", entry.item.id);
      }
      await reload();
      if (isShopping) reloadCatalogue();
    },
    [supabase, list, isShopping, reload, reloadCatalogue, toast],
  );

  const swipeAction = (entry: ListEntryWithItem) =>
    entry.source === "suggested" && entry.status === "open" ? dismiss(entry) : remove(entry);

  /** Show who added a line, but only when it was someone else. */
  const addedByOther = (entry: ListEntryWithItem) =>
    entry.added_by && entry.added_by !== me.user_id ? memberByUserId(entry.added_by) : undefined;

  // ---------------------------------------------------------------------------
  // Step 3: render.
  // ---------------------------------------------------------------------------
  const back = (
    <Link href="/" className="nav-button" aria-label="Back to Lists">
      <ChevronLeftIcon size={22} />
      Lists
    </Link>
  );

  if (notFound) {
    return (
      <main className="screen">
        <Navbar title="List not found" leading={back} />
        <div className="group empty">
          <span className="empty__title">This list was deleted</span>
          Go back to Lists to pick another one.
        </div>
      </main>
    );
  }

  const summary = !list
    ? undefined
    : openCount === 0
      ? "All done"
      : `${openCount} ${isShopping ? "to buy" : "to do"}${suggested.length ? `, ${suggested.length} suggested` : ""}`;

  return (
    <main className="screen screen--with-composer">
      <Navbar title={list?.name ?? " "} leading={back} subtitle={summary} />

      {/* Loading skeleton */}
      {loading && (
        <section className="section">
          <div className="group" aria-busy="true" aria-label="Loading list">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="skeleton" />
            ))}
          </div>
        </section>
      )}

      {!loading && list && (
        <>
          {/* 1. Suggested for you */}
          {suggested.length > 0 && (
            <section className="section" aria-labelledby="suggested-heading">
              <div className="section__header">
                <span id="suggested-heading" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                  <GlowSparkle size={15} />
                  <span className="glow-text">Suggested for you</span>
                </span>
              </div>
              <div className="group group--suggested">
                <AnimatePresence initial={false}>
                  {suggested.map((entry) => (
                    <EntryRow
                      key={entry.id}
                      entry={entry}
                      checked={settling.has(entry.id)}
                      onToggle={() => toggle(entry)}
                      onEdit={() => setEditing(entry)}
                      onSwipeAction={() => swipeAction(entry)}
                      trailing={
                        <button type="button" className="chip-button" onClick={() => dismiss(entry)}>
                          Not now
                        </button>
                      }
                    />
                  ))}
                </AnimatePresence>
              </div>
              <p className="section__footer">
                Added because you usually run out around now. Tick them off as you shop.
              </p>
            </section>
          )}

          {/* 2. Open lines */}
          {groups.map(([category, lines]) => (
            <section key={category} className="section">
              <div className="section__header">
                <span className="section__header-title">{category}</span>
                <span className="row__count">{lines.length}</span>
              </div>
              <div className="group">
                <AnimatePresence initial={false}>
                  {lines.map((entry) => (
                    <EntryRow
                      key={entry.id}
                      entry={entry}
                      checked={settling.has(entry.id)}
                      addedBy={addedByOther(entry)}
                      onToggle={() => toggle(entry)}
                      onEdit={() => setEditing(entry)}
                      onSwipeAction={() => swipeAction(entry)}
                    />
                  ))}
                </AnimatePresence>
              </div>
            </section>
          ))}

          {/* Empty state */}
          {openCount === 0 && (
            <section className="section">
              <div className="group empty">
                <span className="empty__title">{completed.length ? "Everything's ticked off" : "Nothing here yet"}</span>
                {isShopping
                  ? "Add what you need below. Try “2 milk” or “500g mince”."
                  : "Add the first thing below."}
              </div>
            </section>
          )}

          {/* 3. Completed */}
          {completed.length > 0 && (
            <section className="section">
              <div className="section__header">
                <button
                  type="button"
                  className="section__header-title"
                  style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "var(--ink-2)" }}
                  aria-expanded={showCompleted}
                  onClick={() => setShowCompleted((v) => !v)}
                >
                  Completed ({completed.length})
                  <ChevronDownIcon
                    size={14}
                    style={{ transform: showCompleted ? "none" : "rotate(-90deg)", transition: "transform .2s" }}
                  />
                </button>
                <button
                  type="button"
                  className="section__header-action"
                  onClick={async () => {
                    const err = await clearCompleted();
                    if (err) toast.show(friendlyError(err));
                  }}
                >
                  Clear
                </button>
              </div>
              {showCompleted && (
                <div className="group">
                  <AnimatePresence initial={false}>
                    {completed.map((entry) => (
                      <EntryRow
                        key={entry.id}
                        entry={entry}
                        checked
                        onToggle={() => toggle(entry)}
                        onEdit={() => setEditing(entry)}
                        onSwipeAction={() => remove(entry)}
                      />
                    ))}
                  </AnimatePresence>
                </div>
              )}
            </section>
          )}

          <Composer
            placeholder={`Add to ${list.name}`}
            catalogue={isShopping ? catalogue : undefined}
            openItemIds={openItemIds}
            onAdd={add}
          />
        </>
      )}

      <EditEntrySheet
        entry={editing}
        listType={list?.type ?? "shopping"}
        onClose={() => setEditing(null)}
        onSave={saveEdits}
        onDelete={(entry) => swipeAction(entry)}
      />
      {toast.node}
    </main>
  );
}
