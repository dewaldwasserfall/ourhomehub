/**
 * Sheet for editing one line: name, quantity, note, (for shopping) the aisle
 * category, and (for to-dos) a due date and who it's for. Also the
 * keyboard-friendly way to delete or dismiss.
 */
"use client";

import { useEffect, useState } from "react";
import { CATEGORIES } from "@/lib/categories";
import { describeAgo, describeInterval } from "@/lib/rhythm";
import type { ListEntryWithItem, ListType, Member } from "@/lib/types";
import { DateField, MemberChips } from "./plan-controls";
import { Sheet } from "./sheet";

export interface EntryEdits {
  text: string;
  quantity: string | null;
  note: string | null;
  category: string | null;
  /** To-dos only. */
  dueDate: string | null;
  assignedTo: string | null;
}

interface EditEntrySheetProps {
  entry: ListEntryWithItem | null;
  listType: ListType;
  onClose: () => void;
  onSave: (entry: ListEntryWithItem, edits: EntryEdits) => Promise<void>;
  onDelete: (entry: ListEntryWithItem) => Promise<void>;
  /** Household members, for "For" on to-dos. */
  members: Member[];
}

export function EditEntrySheet({ entry, listType, onClose, onSave, onDelete, members }: EditEntrySheetProps) {
  const [text, setText] = useState("");
  const [quantity, setQuantity] = useState("");
  const [note, setNote] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [dueDate, setDueDate] = useState<string | null>(null);
  const [assignedTo, setAssignedTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Step 1: load the entry's values each time the sheet opens.
  useEffect(() => {
    if (!entry) return;
    setText(entry.text);
    setQuantity(entry.quantity ?? "");
    setNote(entry.note ?? "");
    setCategory(entry.item?.category ?? null);
    setDueDate(entry.due_date);
    setAssignedTo(entry.assigned_to);
  }, [entry]);

  async function save() {
    if (!entry || !text.trim()) return;
    setBusy(true);
    await onSave(entry, {
      text: text.trim(),
      quantity: quantity.trim() || null,
      note: note.trim() || null,
      category,
      dueDate,
      assignedTo,
    });
    setBusy(false);
    onClose();
  }

  const isSuggestion = entry?.source === "suggested" && entry.status === "open";
  const pattern = entry?.item?.pattern;

  return (
    <Sheet
      open={!!entry}
      onClose={onClose}
      title={listType === "shopping" ? "Item" : "To-do"}
      leading={
        <button type="button" className="nav-button" onClick={onClose}>
          Cancel
        </button>
      }
      trailing={
        <button type="button" className="nav-button nav-button--strong" onClick={save} disabled={busy || !text.trim()}>
          Done
        </button>
      }
    >
      <div className="sheet__stack">
        {/* Name and quantity */}
        <div className="group">
          <input
            className="input"
            aria-label="Name"
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={200}
            style={{ borderRadius: 0, fontWeight: 600 }}
          />
          <div style={{ marginLeft: 16, borderTop: "0.5px solid var(--separator)" }}>
            <input
              className="input"
              aria-label="Quantity"
              placeholder="Quantity, e.g. 2 or 500 g"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              maxLength={30}
              style={{ borderRadius: 0, paddingLeft: 0 }}
            />
          </div>
          <div style={{ marginLeft: 16, borderTop: "0.5px solid var(--separator)" }}>
            <textarea
              className="input"
              aria-label="Note"
              placeholder="Note, e.g. the decaf one"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              rows={2}
              style={{ borderRadius: 0, paddingLeft: 0 }}
            />
          </div>
        </div>

        {/* To-dos: when, and for whom (unassigned shows on everyone's Today) */}
        {listType === "todo" && (
          <>
            <DateField label="Due" value={dueDate} onChange={setDueDate} />
            <MemberChips members={members} value={assignedTo} onChange={setAssignedTo} />
          </>
        )}

        {/* Aisle */}
        {listType === "shopping" && entry?.item && (
          <div>
            <span className="field__label">Aisle</span>
            <div className="chip-grid">
              {CATEGORIES.map((c) => (
                <button
                  key={c}
                  type="button"
                  className="chip"
                  aria-pressed={category === c}
                  onClick={() => setCategory(c)}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* What the app knows about this item */}
        {pattern && (
          <p className="section__footer" style={{ padding: "0 16px" }}>
            {pattern.median_interval_days
              ? `You buy this ${describeInterval(Number(pattern.median_interval_days))}. `
              : `Bought ${pattern.purchase_count === 1 ? "once" : `${pattern.purchase_count} times`} so far. `}
            {pattern.last_purchased_at && `Last bought ${describeAgo(pattern.last_purchased_at)}.`}
          </p>
        )}

        <button
          type="button"
          className="button button--danger"
          onClick={async () => {
            if (!entry) return;
            await onDelete(entry);
            onClose();
          }}
        >
          {isSuggestion ? "Not now" : "Delete"}
        </button>
      </div>
    </Sheet>
  );
}
