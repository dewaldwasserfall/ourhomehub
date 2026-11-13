/**
 * Sheet to edit one routine step, zone task or chore-like item:
 *
 *   title                 always
 *   days + when           routine steps (weekdays, school/holiday/weekend)
 *   for                   who it's for (Anyone = whoever gets to it)
 *
 * Which parts show is chosen by the caller, so steps and zone tasks share it.
 */
"use client";

import { useEffect, useState } from "react";
import { ALL_MODES } from "@/lib/plan";
import type { DayMode, Member } from "@/lib/types";
import { MemberChips, ModeChips, WeekdayChips } from "./plan-controls";
import { Sheet } from "./sheet";

export interface StepFields {
  title: string;
  weekdays: number[] | null;
  modes: DayMode[];
  assigned_to: string | null;
}

interface StepSheetProps {
  /** The item being edited; null closes the sheet. */
  item: (Partial<StepFields> & { title: string }) | null;
  heading: string;
  members: Member[];
  /** Show the weekday and mode pickers (routine steps). */
  withSchedule: boolean;
  /** Label for "Anyone" (e.g. the routine owner's name for a personal routine). */
  anyoneLabel?: string;
  onClose: () => void;
  onSave: (fields: StepFields) => Promise<void>;
  onDelete: () => Promise<void>;
}

export function StepSheet({ item, heading, members, withSchedule, anyoneLabel, onClose, onSave, onDelete }: StepSheetProps) {
  const [title, setTitle] = useState("");
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [modes, setModes] = useState<DayMode[]>(ALL_MODES);
  const [assignedTo, setAssignedTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Step 1: fill the fields each time the sheet opens.
  useEffect(() => {
    if (!item) return;
    setTitle(item.title);
    setWeekdays(item.weekdays ?? []);
    setModes(item.modes ?? ALL_MODES);
    setAssignedTo(item.assigned_to ?? null);
  }, [item]);

  async function save() {
    if (!title.trim()) return;
    setBusy(true);
    await onSave({
      title: title.trim(),
      // An empty selection or all seven days both mean "every day".
      weekdays: weekdays.length === 0 || weekdays.length === 7 ? null : weekdays,
      modes,
      assigned_to: assignedTo,
    });
    setBusy(false);
    onClose();
  }

  return (
    <Sheet
      open={!!item}
      onClose={onClose}
      title={heading}
      leading={
        <button type="button" className="nav-button" onClick={onClose}>
          Cancel
        </button>
      }
      trailing={
        <button type="button" className="nav-button nav-button--strong" onClick={save} disabled={busy || !title.trim()}>
          Done
        </button>
      }
    >
      <div className="sheet__stack">
        <input
          className="input"
          aria-label="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={120}
          style={{ fontWeight: 600 }}
        />
        {withSchedule && (
          <>
            <WeekdayChips value={weekdays} onChange={setWeekdays} />
            <ModeChips value={modes} onChange={setModes} />
          </>
        )}
        <MemberChips members={members} value={assignedTo} onChange={setAssignedTo} anyoneLabel={anyoneLabel} />
        <button
          type="button"
          className="button button--danger"
          onClick={async () => {
            setBusy(true);
            await onDelete();
            setBusy(false);
            onClose();
          }}
          disabled={busy}
        >
          Delete
        </button>
      </div>
    </Sheet>
  );
}
