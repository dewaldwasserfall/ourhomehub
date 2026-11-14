/**
 * Small pickers shared by the to-do, routine, zone and chore sheets:
 *
 *   MemberChips   who something is for (Anyone, or one person)
 *   WeekdayChips  which weekdays a routine step shows on
 *   ModeChips     school days / holidays / weekends
 *   DateField     an optional date with a Clear button
 *
 * All are plain chip rows, so they fit the existing sheet layout and work
 * with the keyboard and screen readers (aria-pressed toggles).
 */
"use client";

import { ALL_MODES, WEEKDAY_NAMES, WEEKDAY_SHORT } from "@/lib/plan";
import { personAccentStyle } from "@/lib/themes";
import type { DayMode, Member } from "@/lib/types";
import { Avatar } from "./avatar";

// -----------------------------------------------------------------------------
// Step 1: who it's for
// -----------------------------------------------------------------------------

export function MemberChips({
  members,
  value,
  onChange,
  label = "For",
  anyoneLabel = "Anyone",
}: {
  members: Member[];
  value: string | null;
  onChange: (memberId: string | null) => void;
  label?: string;
  anyoneLabel?: string;
}) {
  return (
    <div>
      <span className="field__label">{label}</span>
      <div className="chip-grid" role="group" aria-label={label}>
        <button type="button" className="chip" aria-pressed={value === null} onClick={() => onChange(null)}>
          {anyoneLabel}
        </button>
        {members.map((m) => (
          <button
            key={m.id}
            type="button"
            className="chip chip--person"
            // A selected person shows in their own colour.
            style={personAccentStyle(m.theme_accent)}
            aria-pressed={value === m.id}
            onClick={() => onChange(m.id)}
          >
            <Avatar member={m} size="mini" />
            {m.display_name.split(" ")[0]}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Several people (e.g. who's going on a trip). */
export function MembersPicker({
  members,
  value,
  onChange,
  label,
}: {
  members: Member[];
  value: string[];
  onChange: (memberIds: string[]) => void;
  label: string;
}) {
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  return (
    <div>
      <span className="field__label">{label}</span>
      <div className="chip-grid" role="group" aria-label={label}>
        {members.map((m) => (
          <button
            key={m.id}
            type="button"
            className="chip chip--person"
            style={personAccentStyle(m.theme_accent)}
            aria-pressed={value.includes(m.id)}
            onClick={() => toggle(m.id)}
          >
            <Avatar member={m} size="mini" />
            {m.display_name.split(" ")[0]}
          </button>
        ))}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Step 2: weekdays (none selected = every day)
// -----------------------------------------------------------------------------

export function WeekdayChips({ value, onChange }: { value: number[]; onChange: (days: number[]) => void }) {
  const toggle = (day: number) =>
    onChange(value.includes(day) ? value.filter((d) => d !== day) : [...value, day].sort((a, b) => a - b));
  return (
    <div>
      <span className="field__label">Days {value.length === 0 && <span className="field__hint">every day</span>}</span>
      <div className="weekday-chips" role="group" aria-label="Days">
        {WEEKDAY_SHORT.map((letter, i) => (
          <button
            key={i}
            type="button"
            className="weekday-chip"
            aria-pressed={value.includes(i + 1)}
            aria-label={WEEKDAY_NAMES[i]}
            onClick={() => toggle(i + 1)}
          >
            {letter}
          </button>
        ))}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Step 3: modes (at least one stays selected)
// -----------------------------------------------------------------------------

const MODE_CHIP_LABELS: Record<DayMode, string> = { school: "School days", holiday: "Holidays", weekend: "Weekends" };

export function ModeChips({ value, onChange }: { value: DayMode[]; onChange: (modes: DayMode[]) => void }) {
  const toggle = (mode: DayMode) => {
    const next = value.includes(mode) ? value.filter((m) => m !== mode) : [...value, mode];
    if (next.length) onChange(ALL_MODES.filter((m) => next.includes(m)));
  };
  return (
    <div>
      <span className="field__label">When</span>
      <div className="chip-grid" role="group" aria-label="When">
        {ALL_MODES.map((mode) => (
          <button key={mode} type="button" className="chip" aria-pressed={value.includes(mode)} onClick={() => toggle(mode)}>
            {MODE_CHIP_LABELS[mode]}
          </button>
        ))}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Step 4: an optional date
// -----------------------------------------------------------------------------

export function DateField({
  label,
  value,
  onChange,
  clearable = true,
}: {
  label: string;
  value: string | null;
  onChange: (date: string | null) => void;
  clearable?: boolean;
}) {
  return (
    <div className="group">
      <label className="form-row">
        <span className="form-row__label">{label}</span>
        <span className="form-row__controls">
          <input
            type="date"
            className="pill-input"
            style={{ width: 150 }}
            value={value ?? ""}
            onChange={(e) => onChange(e.target.value || null)}
          />
          {clearable && value && (
            <button type="button" className="chip-button" onClick={() => onChange(null)}>
              Clear
            </button>
          )}
        </span>
      </label>
    </div>
  );
}
