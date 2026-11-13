/**
 * An editable, reorderable list of short items: the steps of a routine and
 * the tasks of a zone.
 *
 *   * drag the handle to reorder (saved when the finger lifts)
 *   * tap a row to open its sheet
 *   * type in the last row and press Return to add
 */
"use client";

import { Reorder, useDragControls } from "framer-motion";
import { useEffect, useState, type ReactNode } from "react";
import type { Member } from "@/lib/types";
import { Avatar } from "./avatar";
import { GripIcon, PlusIcon } from "./icons";

export interface PlanListItem {
  id: string;
  title: string;
}

interface PlanItemListProps<T extends PlanListItem> {
  items: T[];
  /** Second line under the title (e.g. "School days, Mon"). */
  describe?: (item: T) => ReactNode;
  /** Who it's for, shown as a small avatar. */
  assigneeOf?: (item: T) => Member | undefined;
  onOpen: (item: T) => void;
  onAdd: (title: string) => Promise<boolean>;
  /** Called with the new order of ids after a drag. */
  onReorder: (ids: string[]) => void;
  addPlaceholder: string;
}

/** Step 1: one draggable row (the handle starts the drag, so taps still open). */
function ItemRow<T extends PlanListItem>({
  item,
  describe,
  assigneeOf,
  onOpen,
  onDrop,
}: Pick<PlanItemListProps<T>, "describe" | "assigneeOf" | "onOpen"> & { item: T; onDrop: () => void }) {
  const controls = useDragControls();
  const assignee = assigneeOf?.(item);
  return (
    <Reorder.Item as="div" value={item} dragListener={false} dragControls={controls} onDragEnd={onDrop} className="reorder-item">
      <div className="row">
        <button type="button" className="row__body" style={{ textAlign: "left", minHeight: 32 }} onClick={() => onOpen(item)}>
          <span className="row__title">{item.title}</span>
          {describe && <span className="row__subtitle">{describe(item)}</span>}
        </button>
        <span className="row__trailing">
          {assignee && <Avatar member={assignee} size="mini" />}
          <span
            className="drag-handle"
            aria-label={`Drag to reorder ${item.title}`}
            role="button"
            tabIndex={-1}
            onPointerDown={(e) => controls.start(e)}
          >
            <GripIcon size={20} />
          </span>
        </span>
      </div>
    </Reorder.Item>
  );
}

export function PlanItemList<T extends PlanListItem>({
  items,
  describe,
  assigneeOf,
  onOpen,
  onAdd,
  onReorder,
  addPlaceholder,
}: PlanItemListProps<T>) {
  // Step 2: local order while dragging; reset when the data changes.
  const [order, setOrder] = useState(items);
  useEffect(() => setOrder(items), [items]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  // Step 3: add on Return; keep the field focused for the next one.
  async function add() {
    const title = draft.trim();
    if (!title || busy) return;
    setBusy(true);
    if (await onAdd(title)) setDraft("");
    setBusy(false);
  }

  return (
    <div className="group">
      <Reorder.Group axis="y" values={order} onReorder={setOrder} as="div" className="reorder-group">
        {order.map((item) => (
          <ItemRow
            key={item.id}
            item={item}
            describe={describe}
            assigneeOf={assigneeOf}
            onOpen={onOpen}
            onDrop={() => onReorder(order.map((i) => i.id))}
          />
        ))}
      </Reorder.Group>
      <div className="row add-row">
        <PlusIcon size={20} style={{ color: "var(--accent)", flex: "none" }} />
        <input
          className="add-row__input"
          placeholder={addPlaceholder}
          aria-label={addPlaceholder}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          onBlur={add}
          maxLength={120}
          enterKeyHint="done"
        />
      </div>
    </div>
  );
}
