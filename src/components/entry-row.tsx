/**
 * One line on a list.
 *
 * Tap the circle to tick it off, tap the text to edit, swipe left to reveal
 * Delete (or "Not now" for a suggestion). Suggested lines show why the app
 * added them; to-dos show their due date and who they're for.
 *
 * Read-only rows (children) can't be edited or swiped, and their tick is
 * shown only on lines assigned to that child.
 */
"use client";

import { motion, useAnimationControls, useMotionValue, useTransform, type PanInfo } from "framer-motion";
import { useRef } from "react";
import { suggestionReason } from "@/lib/rhythm";
import type { ListEntryWithItem, Member } from "@/lib/types";
import { Avatar } from "./avatar";
import { CheckCircle } from "./check-circle";

const ACTION_WIDTH = 88;

interface EntryRowProps {
  entry: ListEntryWithItem;
  /** Visually ticked (true while the tick animation plays, before it moves). */
  checked: boolean;
  /** Member who added it, shown only when it wasn't you. */
  addedBy?: Member;
  onToggle: () => void;
  onEdit: () => void;
  /** Swipe action: delete for manual lines, "Not now" for suggestions. */
  onSwipeAction: () => void;
  /** Extra trailing content (e.g. the "Not now" chip on suggestions). */
  trailing?: React.ReactNode;
  /** To-dos: who it's for (shown instead of "added by"). */
  assignee?: Member;
  /** To-dos: "Today", "Tomorrow", "Fri 20 Nov"; overdue shows in red. */
  due?: { label: string; overdue: boolean };
  /** No editing or swiping (children). */
  readOnly?: boolean;
  /** Show the tick control (false for lines a child may not tick). */
  canToggle?: boolean;
}

export function EntryRow({
  entry,
  checked,
  addedBy,
  onToggle,
  onEdit,
  onSwipeAction,
  trailing,
  assignee,
  due,
  readOnly = false,
  canToggle = true,
}: EntryRowProps) {
  const controls = useAnimationControls();
  const dragged = useRef(false);
  // The action behind the row only becomes visible once the row moves, so it
  // never bleeds through anti-aliased corners or translucent rows.
  const x = useMotionValue(0);
  const actionOpacity = useTransform(x, [-24, -1, 0], [1, 1, 0]);
  const isSuggestion = entry.source === "suggested" && entry.status === "open";
  const isDone = entry.status === "done";

  // Step 1: snap the row open or closed when the finger lifts.
  function handleDragEnd(_: unknown, info: PanInfo) {
    const open = info.offset.x < -ACTION_WIDTH / 2 || info.velocity.x < -500;
    controls.start({ x: open ? -ACTION_WIDTH : 0, transition: { type: "spring", stiffness: 500, damping: 40 } });
    // Let the click that ends a drag be ignored.
    setTimeout(() => (dragged.current = false), 50);
  }

  // Step 2: subtitle: suggestion reason, or quantity/note context.
  const subtitle = isSuggestion ? suggestionReason(entry.item?.pattern ?? null) : entry.note || null;
  const showDue = due && !isDone;

  return (
    // Step 3: the wrapper animates in, collapses out, and glides when the
    // line moves between sections (e.g. into Completed).
    <motion.div
      className="row-wrap"
      layout="position"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ type: "spring", stiffness: 500, damping: 42, opacity: { duration: 0.18 } }}
    >
      <motion.div className="row-wrap__actions" aria-hidden="true" style={{ opacity: actionOpacity }}>
        <button
          type="button"
          tabIndex={-1}
          className={`row-wrap__action ${isSuggestion ? "row-wrap__action--neutral" : ""}`}
          onClick={onSwipeAction}
        >
          {isSuggestion ? "Not now" : "Delete"}
        </button>
      </motion.div>

      <motion.div
        className={`row ${isDone ? "row--done" : ""}`}
        style={{ touchAction: "pan-y", x }}
        drag={isDone || readOnly ? false : "x"}
        dragDirectionLock
        dragConstraints={{ left: -ACTION_WIDTH, right: 0 }}
        dragElastic={{ left: 0.15, right: 0 }}
        onDragStart={() => (dragged.current = true)}
        onDragEnd={handleDragEnd}
        animate={controls}
      >
        {canToggle ? (
          <CheckCircle
            checked={checked}
            onToggle={onToggle}
            label={checked ? `Mark ${entry.text} as not done` : `Tick off ${entry.text}`}
          />
        ) : (
          <span className="check-placeholder" aria-hidden="true" />
        )}

        <button
          type="button"
          className="row__body"
          style={{ textAlign: "left", minHeight: 32 }}
          disabled={readOnly}
          onClick={() => {
            if (dragged.current || readOnly) return;
            controls.start({ x: 0 });
            onEdit();
          }}
        >
          <span className="row__title">{entry.text}</span>
          {(subtitle || showDue) && (
            <span className="row__subtitle">
              {showDue && <span className={due.overdue ? "due due--overdue" : "due"}>{due.label}</span>}
              {showDue && subtitle && " · "}
              {subtitle}
            </span>
          )}
        </button>

        <div className="row__trailing">
          {entry.quantity && <span className="quantity-pill">{entry.quantity}</span>}
          {assignee ? (
            <Avatar member={assignee} size="mini" />
          ) : (
            addedBy && !isDone && <Avatar member={addedBy} size="mini" />
          )}
          {trailing}
        </div>
      </motion.div>
    </motion.div>
  );
}
