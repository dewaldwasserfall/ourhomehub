/**
 * Edit sheets for Trips:
 *
 *   * TripSheet        – new trip, or edit name / destination / dates / who's going
 *   * StaySheet        – a place to sleep (check-in, check-out, booking ref)
 *   * PlanSheet        – a day plan (date, optional time, details)
 *   * EmergencySheet   – embassy, insurance, contacts
 *   * ParticipantSheet – when someone joins later or leaves earlier
 *
 * Each sheet only collects and validates; the page saves through Supabase
 * and shows any error. Dates are plain YYYY-MM-DD keys.
 */
"use client";

import { useEffect, useState } from "react";
import { MembersPicker } from "@/components/plan-controls";
import { Sheet } from "@/components/sheet";
import type { Member, Trip, TripEmergency, TripParticipant, TripPlan, TripStay } from "@/lib/types";

/** The Cancel / Done buttons every sheet shares. */
function useSheetChrome(onClose: () => void, onDone: () => void, doneLabel: string, disabled: boolean) {
  return {
    leading: (
      <button type="button" className="nav-button" onClick={onClose}>
        Cancel
      </button>
    ),
    trailing: (
      <button type="button" className="nav-button nav-button--strong" onClick={onDone} disabled={disabled}>
        {doneLabel}
      </button>
    ),
  };
}

/** A labelled date (or time) input row inside a group. */
function InputRow({
  label,
  type,
  value,
  onChange,
  min,
}: {
  label: string;
  type: "date" | "time";
  value: string;
  onChange: (v: string) => void;
  min?: string;
}) {
  return (
    <label className="form-row">
      <span className="form-row__label">{label}</span>
      <span className="form-row__controls">
        <input
          type={type}
          className="pill-input"
          style={{ width: type === "date" ? 150 : 128 }}
          value={value}
          min={min}
          onChange={(e) => onChange(e.target.value)}
        />
        {type === "time" && value && (
          <button type="button" className="chip-button" onClick={() => onChange("")}>
            Clear
          </button>
        )}
      </span>
    </label>
  );
}

/** "Tap again" delete button shared by the sheets. */
function DeleteButton({ label, onDelete }: { label: string; onDelete: () => void }) {
  const [confirm, setConfirm] = useState(false);
  return (
    <button type="button" className="button button--danger" onClick={() => (confirm ? onDelete() : setConfirm(true))}>
      {confirm ? "Tap again to delete" : label}
    </button>
  );
}

// -----------------------------------------------------------------------------
// Step 1: the trip itself
// -----------------------------------------------------------------------------

export interface TripFields {
  name: string;
  destination: string;
  start_date: string;
  end_date: string;
  notes: string;
  participantIds: string[];
}

export function TripSheet({
  open,
  trip,
  participantIds,
  members,
  today,
  onClose,
  onSave,
  onDelete,
}: {
  open: boolean;
  /** null = a new trip */
  trip: Trip | null;
  participantIds: string[];
  members: Member[];
  today: string;
  onClose: () => void;
  onSave: (fields: TripFields) => Promise<boolean>;
  onDelete?: () => void;
}) {
  const [name, setName] = useState("");
  const [destination, setDestination] = useState("");
  const [start, setStart] = useState(today);
  const [end, setEnd] = useState(today);
  const [notes, setNotes] = useState("");
  const [who, setWho] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  // Step 1a: fill the fields when the sheet opens.
  useEffect(() => {
    if (!open) return;
    setName(trip?.name ?? "");
    setDestination(trip?.destination ?? "");
    setStart(trip?.start_date ?? today);
    setEnd(trip?.end_date ?? today);
    setNotes(trip?.notes ?? "");
    // A new trip starts with the whole household going.
    setWho(trip ? participantIds : members.map((m) => m.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, trip]);

  const valid = name.trim().length > 0 && start && end && end >= start;
  const save = async () => {
    if (!valid) return;
    setBusy(true);
    const ok = await onSave({ name: name.trim(), destination: destination.trim(), start_date: start, end_date: end, notes, participantIds: who });
    setBusy(false);
    if (ok) onClose();
  };
  const chrome = useSheetChrome(onClose, save, trip ? "Done" : "Add", busy || !valid);

  return (
    <Sheet open={open} onClose={onClose} title={trip ? "Trip" : "New trip"} {...chrome}>
      <div className="sheet__stack">
        <input
          className="input"
          aria-label="Trip name"
          placeholder="e.g. Summer in Spain"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
          style={{ fontWeight: 600 }}
          autoFocus={!trip}
        />
        <input
          className="input"
          aria-label="Destination"
          placeholder="Destination, e.g. Costa Brava"
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
          maxLength={200}
        />
        <div className="group">
          <InputRow label="First day" type="date" value={start} onChange={(v) => {
            setStart(v);
            if (v && end < v) setEnd(v);
          }} />
          <InputRow label="Last day" type="date" value={end} min={start} onChange={setEnd} />
        </div>
        <MembersPicker members={members} value={who} onChange={setWho} label="Who's going" />
        <textarea
          className="input"
          aria-label="Notes"
          placeholder="Notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          maxLength={5000}
          rows={3}
        />
        {trip && onDelete && <DeleteButton label="Delete trip" onDelete={onDelete} />}
      </div>
    </Sheet>
  );
}

// -----------------------------------------------------------------------------
// Step 2: a place to sleep
// -----------------------------------------------------------------------------

export type StayFields = Pick<TripStay, "name" | "location" | "check_in" | "check_out" | "booking_ref" | "notes">;

export function StaySheet({
  open,
  stay,
  defaultCheckIn,
  defaultCheckOut,
  onClose,
  onSave,
  onDelete,
}: {
  open: boolean;
  stay: TripStay | null;
  defaultCheckIn: string;
  defaultCheckOut: string;
  onClose: () => void;
  onSave: (fields: StayFields) => Promise<boolean>;
  onDelete?: () => void;
}) {
  const [f, setF] = useState<StayFields>({ name: "", location: "", check_in: "", check_out: "", booking_ref: "", notes: "" });
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof StayFields>(k: K, v: StayFields[K]) => setF((cur) => ({ ...cur, [k]: v }));

  useEffect(() => {
    if (!open) return;
    setF({
      name: stay?.name ?? "",
      location: stay?.location ?? "",
      check_in: stay?.check_in ?? defaultCheckIn,
      check_out: stay?.check_out ?? defaultCheckOut,
      booking_ref: stay?.booking_ref ?? "",
      notes: stay?.notes ?? "",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, stay]);

  const valid = f.name.trim().length > 0 && f.check_in && f.check_out > f.check_in;
  const save = async () => {
    if (!valid) return;
    setBusy(true);
    const ok = await onSave({ ...f, name: f.name.trim(), location: f.location.trim(), booking_ref: f.booking_ref.trim() });
    setBusy(false);
    if (ok) onClose();
  };
  const chrome = useSheetChrome(onClose, save, stay ? "Done" : "Add", busy || !valid);

  return (
    <Sheet open={open} onClose={onClose} title={stay ? "Stay" : "New stay"} {...chrome}>
      <div className="sheet__stack">
        <input
          className="input"
          aria-label="Where you're staying"
          placeholder="e.g. Casa Mar"
          value={f.name}
          onChange={(e) => set("name", e.target.value)}
          maxLength={200}
          style={{ fontWeight: 600 }}
          autoFocus={!stay}
        />
        <input
          className="input"
          aria-label="Address or town"
          placeholder="Address or town"
          value={f.location}
          onChange={(e) => set("location", e.target.value)}
          maxLength={300}
        />
        <div className="group">
          <InputRow label="Check-in" type="date" value={f.check_in} onChange={(v) => set("check_in", v)} />
          <InputRow label="Check-out" type="date" value={f.check_out} min={f.check_in} onChange={(v) => set("check_out", v)} />
        </div>
        {f.check_in && f.check_out && f.check_out <= f.check_in && (
          <p className="form-error" role="alert" style={{ margin: 0 }}>
            Check-out is the morning you leave, so it comes after check-in.
          </p>
        )}
        <input
          className="input"
          aria-label="Booking reference"
          placeholder="Booking reference"
          value={f.booking_ref}
          onChange={(e) => set("booking_ref", e.target.value)}
          maxLength={200}
        />
        <textarea
          className="input"
          aria-label="Notes"
          placeholder="Notes, e.g. key box code, parking"
          value={f.notes}
          onChange={(e) => set("notes", e.target.value)}
          maxLength={2000}
          rows={3}
        />
        {stay && onDelete && <DeleteButton label="Delete stay" onDelete={onDelete} />}
      </div>
    </Sheet>
  );
}

// -----------------------------------------------------------------------------
// Step 3: a day plan
// -----------------------------------------------------------------------------

export type PlanFields = Pick<TripPlan, "day" | "time" | "title" | "details">;

export function PlanSheet({
  open,
  plan,
  defaultDay,
  onClose,
  onSave,
  onDelete,
}: {
  open: boolean;
  plan: TripPlan | null;
  defaultDay: string;
  onClose: () => void;
  onSave: (fields: PlanFields) => Promise<boolean>;
  onDelete?: () => void;
}) {
  const [day, setDay] = useState(defaultDay);
  const [time, setTime] = useState("");
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDay(plan?.day ?? defaultDay);
    setTime(plan?.time?.slice(0, 5) ?? "");
    setTitle(plan?.title ?? "");
    setDetails(plan?.details ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, plan]);

  const valid = title.trim().length > 0 && Boolean(day);
  const save = async () => {
    if (!valid) return;
    setBusy(true);
    const ok = await onSave({ day, time: time || null, title: title.trim(), details });
    setBusy(false);
    if (ok) onClose();
  };
  const chrome = useSheetChrome(onClose, save, plan ? "Done" : "Add", busy || !valid);

  return (
    <Sheet open={open} onClose={onClose} title={plan ? "Plan" : "New plan"} {...chrome}>
      <div className="sheet__stack">
        <input
          className="input"
          aria-label="What"
          placeholder="e.g. Flight KL1675 to Girona"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
          style={{ fontWeight: 600 }}
          autoFocus={!plan}
        />
        <div className="group">
          <InputRow label="Day" type="date" value={day} onChange={setDay} />
          <InputRow label="Time" type="time" value={time} onChange={setTime} />
        </div>
        <textarea
          className="input"
          aria-label="Details"
          placeholder="Details, e.g. terminal, booking number, address"
          value={details}
          onChange={(e) => setDetails(e.target.value)}
          maxLength={2000}
          rows={4}
        />
        {plan && onDelete && <DeleteButton label="Delete plan" onDelete={onDelete} />}
      </div>
    </Sheet>
  );
}

// -----------------------------------------------------------------------------
// Step 4: the emergency card
// -----------------------------------------------------------------------------

const EMERGENCY_FIELDS: Array<{ key: keyof TripEmergency; label: string; placeholder: string; rows?: number }> = [
  { key: "embassy", label: "Embassy or consulate", placeholder: "Name, address, phone", rows: 2 },
  { key: "insurance_policy", label: "Travel insurance", placeholder: "Insurer and policy number" },
  { key: "insurance_phone", label: "Insurance emergency number", placeholder: "+31 …" },
  { key: "contacts", label: "Emergency contacts", placeholder: "Names and numbers", rows: 2 },
  { key: "notes", label: "Notes", placeholder: "Allergies, medication, anything else", rows: 2 },
];

export function EmergencySheet({
  open,
  value,
  onClose,
  onSave,
}: {
  open: boolean;
  value: TripEmergency;
  onClose: () => void;
  onSave: (value: TripEmergency) => Promise<boolean>;
}) {
  const [f, setF] = useState<TripEmergency>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setF(value ?? {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const save = async () => {
    setBusy(true);
    // Drop empty fields so "is it filled in?" stays simple.
    const clean = Object.fromEntries(Object.entries(f).filter(([, v]) => typeof v === "string" && v.trim())) as TripEmergency;
    const ok = await onSave(clean);
    setBusy(false);
    if (ok) onClose();
  };
  const chrome = useSheetChrome(onClose, save, "Done", busy);

  return (
    <Sheet open={open} onClose={onClose} title="Emergency card" {...chrome}>
      <div className="sheet__stack">
        {EMERGENCY_FIELDS.map(({ key, label, placeholder, rows }) => (
          <div key={key}>
            <span className="field__label">{label}</span>
            <textarea
              className="input"
              aria-label={label}
              placeholder={placeholder}
              value={f[key] ?? ""}
              onChange={(e) => setF((cur) => ({ ...cur, [key]: e.target.value }))}
              maxLength={1000}
              rows={rows ?? 1}
            />
          </div>
        ))}
      </div>
    </Sheet>
  );
}

export const EMERGENCY_LABELS = Object.fromEntries(EMERGENCY_FIELDS.map((f) => [f.key, f.label])) as Record<keyof TripEmergency, string>;

// -----------------------------------------------------------------------------
// Step 5: when one person joins or leaves
// -----------------------------------------------------------------------------

export function ParticipantSheet({
  open,
  participant,
  member,
  trip,
  onClose,
  onSave,
}: {
  open: boolean;
  participant: TripParticipant | null;
  member: Member | null;
  trip: Trip;
  onClose: () => void;
  onSave: (join: string | null, leave: string | null) => Promise<boolean>;
}) {
  const [join, setJoin] = useState("");
  const [leave, setLeave] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setJoin(participant?.join_date ?? "");
    setLeave(participant?.leave_date ?? "");
  }, [open, participant]);

  const valid = !join || !leave || leave >= join;
  const save = async () => {
    setBusy(true);
    // The trip's own first/last day means "whole trip": store nothing.
    const ok = await onSave(join && join !== trip.start_date ? join : null, leave && leave !== trip.end_date ? leave : null);
    setBusy(false);
    if (ok) onClose();
  };
  const chrome = useSheetChrome(onClose, save, "Done", busy || !valid);

  return (
    <Sheet open={open} onClose={onClose} title={member ? member.display_name.split(" ")[0] : "Dates"} {...chrome}>
      <div className="sheet__stack">
        <div className="group">
          <InputRow label="Joins" type="date" value={join || trip.start_date} min={trip.start_date} onChange={setJoin} />
          <InputRow label="Leaves" type="date" value={leave || trip.end_date} min={join || trip.start_date} onChange={setLeave} />
        </div>
        <p className="section__footer" style={{ margin: 0 }}>
          Leave these on the trip&rsquo;s first and last day if they&rsquo;re there the whole time.
        </p>
      </div>
    </Sheet>
  );
}
