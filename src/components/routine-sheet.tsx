/**
 * Sheet to create or edit a routine: name, time of day, and whose it is
 * (the household's, or one person's own).
 */
"use client";

import { useEffect, useState } from "react";
import { TIME_OF_DAY_LABELS } from "@/lib/plan";
import type { Member, Routine, TimeOfDay } from "@/lib/types";
import { MemberChips } from "./plan-controls";
import { Segmented } from "./segmented";
import { Sheet } from "./sheet";

export interface RoutineFields {
  name: string;
  time_of_day: TimeOfDay;
  owner_member: string | null;
}

interface RoutineSheetProps {
  open: boolean;
  /** null = a new routine. */
  routine: Routine | null;
  members: Member[];
  onClose: () => void;
  onSave: (fields: RoutineFields) => Promise<void>;
  onDelete?: () => Promise<void>;
}

export function RoutineSheet({ open, routine, members, onClose, onSave, onDelete }: RoutineSheetProps) {
  const [name, setName] = useState("");
  const [timeOfDay, setTimeOfDay] = useState<TimeOfDay>("morning");
  const [owner, setOwner] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Step 1: fill the fields each time the sheet opens.
  useEffect(() => {
    if (!open) return;
    setName(routine?.name ?? "");
    setTimeOfDay(routine?.time_of_day ?? "morning");
    setOwner(routine?.owner_member ?? null);
    setConfirmDelete(false);
  }, [open, routine]);

  async function save() {
    if (!name.trim()) return;
    setBusy(true);
    await onSave({ name: name.trim(), time_of_day: timeOfDay, owner_member: owner });
    setBusy(false);
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={routine ? "Routine" : "New routine"}
      leading={
        <button type="button" className="nav-button" onClick={onClose}>
          Cancel
        </button>
      }
      trailing={
        <button type="button" className="nav-button nav-button--strong" onClick={save} disabled={busy || !name.trim()}>
          {routine ? "Done" : "Create"}
        </button>
      }
    >
      <div className="sheet__stack">
        <input
          className="input"
          aria-label="Routine name"
          placeholder="e.g. School morning"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
          maxLength={60}
          autoFocus={!routine}
        />
        <div>
          <span className="field__label">Time of day</span>
          <Segmented
            label="Time of day"
            value={timeOfDay}
            onChange={setTimeOfDay}
            options={(Object.keys(TIME_OF_DAY_LABELS) as TimeOfDay[]).map((t) => ({ value: t, label: TIME_OF_DAY_LABELS[t] }))}
          />
        </div>
        <div>
          <MemberChips members={members} value={owner} onChange={setOwner} label="Whose routine" anyoneLabel="Household" />
          <p className="section__footer" style={{ padding: "8px 0 0" }}>
            {owner
              ? "Shows on their Today. They can tick off every step."
              : "Shows on everyone's Today. Give a step to one person to make it theirs."}
          </p>
        </div>
        {routine && onDelete && (
          <button
            type="button"
            className="button button--danger"
            onClick={async () => {
              if (!confirmDelete) return setConfirmDelete(true);
              setBusy(true);
              await onDelete();
              setBusy(false);
            }}
            disabled={busy}
          >
            {confirmDelete ? "Tap again to delete the routine and its steps" : "Delete routine"}
          </button>
        )}
      </div>
    </Sheet>
  );
}
