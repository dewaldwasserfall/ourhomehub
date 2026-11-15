/**
 * Adding on the Family board (admin mode only).
 *
 *   * Grocery: type it, pick the shopping list (the default one first). The
 *     sheet stays open so a run of items goes in quickly.
 *   * To-do: type it, pick who it's for (or nobody) and when it's due
 *     (no date, today, tomorrow).
 *
 * Both go through board_add_entry(), which only works while a parent has the
 * board unlocked and records the item as added by that parent (so the usual
 * "Anél added Milk" push goes out).
 */
"use client";

import { useEffect, useRef, useState } from "react";
import { Avatar } from "@/components/avatar";
import { useBoardAdmin } from "@/components/board/board-admin";
import { useHousehold } from "@/components/household-context";
import { Sheet } from "@/components/sheet";
import { addDays } from "@/lib/calendar/time";
import { friendlyError } from "@/lib/errors";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

export type AddKind = "grocery" | "todo";

interface ListRow {
  id: string;
  name: string;
  type: "shopping" | "todo";
  is_default: boolean;
  sort_order: number;
}

export function BoardAddSheet({
  kind,
  today,
  onClose,
  onAdded,
}: {
  kind: AddKind | null;
  today: string;
  onClose: () => void;
  onAdded: (message: string) => void;
}) {
  const supabase = getSupabaseBrowserClient();
  const { members } = useHousehold();
  const { adminError } = useBoardAdmin();

  // Step 1: the household's lists (the board can read them, not write them).
  const [lists, setLists] = useState<ListRow[]>([]);
  useEffect(() => {
    if (!kind) return;
    void supabase
      .from("lists")
      .select("id, name, type, is_default, sort_order")
      .order("sort_order")
      .then(({ data }) => setLists((data ?? []) as ListRow[]));
  }, [supabase, kind]);
  const shopping = [...lists.filter((l) => l.type === "shopping")].sort((a, b) => Number(b.is_default) - Number(a.is_default));
  const todoList = lists.find((l) => l.type === "todo");

  // Step 2: the form. Reset whenever the sheet opens.
  const [text, setText] = useState("");
  const [listId, setListId] = useState<string | null>(null);
  const [who, setWho] = useState<string | null>(null);
  const [due, setDue] = useState<"none" | "today" | "tomorrow">("none");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!kind) return;
    setText("");
    setWho(null);
    setDue("none");
    setError(null);
  }, [kind]);
  const chosenList = kind === "grocery" ? (listId && shopping.some((l) => l.id === listId) ? listId : shopping[0]?.id) : todoList?.id;

  // Step 3: add it.
  async function add() {
    const value = text.trim();
    if (!value || !chosenList || busy) return;
    setBusy(true);
    const { error: rpcError } = await supabase.rpc("board_add_entry", {
      p_list_id: chosenList,
      p_text: value,
      p_due_date: kind === "todo" && due !== "none" ? (due === "today" ? today : addDays(today, 1)) : null,
      p_assigned_to: kind === "todo" ? who : null,
    });
    setBusy(false);
    if (rpcError) {
      const message = adminError(rpcError.message);
      if (message !== rpcError.message) {
        onClose();
        return onAdded(message);
      }
      return setError(friendlyError(rpcError));
    }
    if (kind === "grocery") {
      // Stay open for the next item.
      onAdded(`Added ${value}`);
      setText("");
      input.current?.focus();
      return;
    }
    onAdded(`Added ${value}`);
    onClose();
  }

  const chip = (on: boolean) => `board-chip ${on ? "board-chip--on" : ""}`;

  return (
    <Sheet
      open={!!kind}
      onClose={onClose}
      title={kind === "grocery" ? "Add a grocery" : "Add a to-do"}
      leading={
        <button type="button" className="nav-button" onClick={onClose}>
          Done
        </button>
      }
      trailing={
        <button type="button" className="nav-button nav-button--strong" onClick={add} disabled={!text.trim() || !chosenList || busy}>
          Add
        </button>
      }
    >
      {kind && (
        <form
          className="board-add"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <input
            ref={input}
            className="input board-add__input"
            aria-label={kind === "grocery" ? "Grocery" : "To-do"}
            placeholder={kind === "grocery" ? "e.g. Milk" : "e.g. Tidy your room"}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setError(null);
            }}
            maxLength={200}
            autoFocus
            enterKeyHint="done"
          />

          {/* Grocery: which shopping list (only when there's a choice) */}
          {kind === "grocery" && shopping.length > 1 && (
            <div className="board-add__row">
              {shopping.map((l) => (
                <button key={l.id} type="button" className={chip(chosenList === l.id)} onClick={() => setListId(l.id)}>
                  {l.name}
                </button>
              ))}
            </div>
          )}

          {/* To-do: for whom, and when */}
          {kind === "todo" && (
            <>
              <div className="board-add__row">
                <button type="button" className={chip(who === null)} onClick={() => setWho(null)}>
                  Anyone
                </button>
                {members.map((m) => (
                  <button key={m.id} type="button" className={chip(who === m.id)} onClick={() => setWho(m.id)}>
                    <Avatar member={m} size="mini" />
                    {m.display_name.split(" ")[0]}
                  </button>
                ))}
              </div>
              <div className="board-add__row">
                {(["none", "today", "tomorrow"] as const).map((d) => (
                  <button key={d} type="button" className={chip(due === d)} onClick={() => setDue(d)}>
                    {d === "none" ? "No date" : d === "today" ? "Today" : "Tomorrow"}
                  </button>
                ))}
              </div>
            </>
          )}

          {kind === "grocery" && shopping.length === 0 && <p className="board-muted">No shopping list yet: add one on a phone first.</p>}
          {kind === "todo" && !todoList && <p className="board-muted">No to-do list yet: add one on a phone first.</p>}
          {error && (
            <p className="board-pin__note" role="alert">
              {error}
            </p>
          )}
        </form>
      )}
    </Sheet>
  );
}
