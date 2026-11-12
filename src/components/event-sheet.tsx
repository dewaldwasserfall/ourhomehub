/**
 * Sheet for adding, editing or viewing a family-calendar event.
 *
 * Modes:
 *   new        empty form, "Add"
 *   edit       a one-off event, "Done" + Delete
 *   read-only  a repeating event: details plus "Open in Google Calendar"
 */
"use client";

import { useEffect, useState } from "react";
import { addDays, dateKey, instantOf, pad, timeKey } from "@/lib/calendar/time";
import type { EventInput, Occurrence } from "@/lib/calendar/types";
import { RepeatIcon } from "./icons";
import { Sheet } from "./sheet";

interface EventSheetProps {
  /** "new" opens an empty form for this day; an occurrence opens that event. */
  target: { kind: "new"; day: string } | { kind: "existing"; occurrence: Occurrence } | null;
  timeZone: string;
  onClose: () => void;
  onCreate: (input: EventInput) => Promise<string | null>;
  onUpdate: (id: string, input: EventInput) => Promise<string | null>;
  onDelete: (id: string) => Promise<string | null>;
}

interface FormState {
  title: string;
  location: string;
  description: string;
  allDay: boolean;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
}

/** Step 1: a sensible blank form: the next full hour, one hour long. */
function blankForm(day: string, timeZone: string): FormState {
  const now = new Date();
  const today = dateKey(now, timeZone);
  let startHour = day === today ? Number(timeKey(now, timeZone).slice(0, 2)) + 1 : 9;
  let startDay = day;
  if (startHour > 22) {
    startHour = 9;
    startDay = addDays(day, 1);
  }
  return {
    title: "",
    location: "",
    description: "",
    allDay: false,
    startDate: startDay,
    startTime: `${pad(startHour)}:00`,
    endDate: startDay,
    endTime: `${pad(startHour + 1)}:00`,
  };
}

/** Step 1b: the form for an existing event (all-day end shown inclusive). */
function formFrom(occ: Occurrence, timeZone: string): FormState {
  const row = occ.row;
  if (occ.allDay) {
    return {
      title: row.title,
      location: row.location ?? "",
      description: row.description ?? "",
      allDay: true,
      startDate: occ.startDate,
      startTime: "09:00",
      endDate: occ.endDate,
      endTime: "10:00",
    };
  }
  return {
    title: row.title,
    location: row.location ?? "",
    description: row.description ?? "",
    allDay: false,
    startDate: dateKey(occ.start!, timeZone),
    startTime: timeKey(occ.start!, timeZone),
    endDate: dateKey(occ.end!, timeZone),
    endTime: timeKey(occ.end!, timeZone),
  };
}

/** "Friday 20 November, 19:00 – 20:30" style summary for read-only events. */
function describeWhen(occ: Occurrence, timeZone: string): string {
  const day = (key: string) =>
    new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(
      new Date(`${key}T12:00:00Z`),
    );
  if (occ.allDay) return occ.startDate === occ.endDate ? `${day(occ.startDate)}, all day` : `${day(occ.startDate)} to ${day(occ.endDate)}`;
  return `${day(occ.startDate)}, ${timeKey(occ.start!, timeZone)} to ${timeKey(occ.end!, timeZone)}`;
}

export function EventSheet({ target, timeZone, onClose, onCreate, onUpdate, onDelete }: EventSheetProps) {
  const [form, setForm] = useState<FormState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const existing = target?.kind === "existing" ? target.occurrence : null;
  const readOnly = Boolean(existing?.isRecurring);

  // Step 2: reset the form whenever the sheet opens on something new.
  useEffect(() => {
    setError(null);
    if (!target) return;
    setForm(target.kind === "new" ? blankForm(target.day, timeZone) : formFrom(target.occurrence, timeZone));
  }, [target, timeZone]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => {
      if (!f) return f;
      const next = { ...f, [key]: value };
      // Keep the end after the start when the start moves.
      if (key === "startDate" && next.endDate < (value as string)) next.endDate = value as string;
      if (key === "startTime" && next.startDate === next.endDate && next.endTime <= (value as string)) {
        const t = instantOf(next.startDate, value as string, timeZone);
        const later = new Date(t.getTime() + 60 * 60 * 1000);
        next.endDate = dateKey(later, timeZone);
        next.endTime = timeKey(later, timeZone);
      }
      return next;
    });

  // Step 3: save / delete through the server.
  async function save() {
    if (!form) return;
    setBusy(true);
    setError(null);
    const input: EventInput = {
      title: form.title,
      location: form.location || null,
      description: form.description || null,
      allDay: form.allDay,
      startDate: form.startDate,
      endDate: form.endDate,
      startTime: form.allDay ? null : form.startTime,
      endTime: form.allDay ? null : form.endTime,
    };
    const message = existing ? await onUpdate(existing.row.id, input) : await onCreate(input);
    setBusy(false);
    if (message) setError(message);
    else onClose();
  }

  async function remove() {
    if (!existing) return;
    setBusy(true);
    const message = await onDelete(existing.row.id);
    setBusy(false);
    if (message) setError(message);
    else onClose();
  }

  const title = readOnly ? "Repeating event" : existing ? "Edit event" : "New event";

  return (
    <Sheet
      open={!!target}
      onClose={onClose}
      title={title}
      leading={
        <button type="button" className="nav-button" onClick={onClose}>
          {readOnly ? "Close" : "Cancel"}
        </button>
      }
      trailing={
        readOnly ? undefined : (
          <button
            type="button"
            className="nav-button nav-button--strong"
            onClick={save}
            disabled={busy || !form?.title.trim()}
          >
            {busy ? "Saving" : existing ? "Done" : "Add"}
          </button>
        )
      }
    >
      {form && readOnly && existing && (
        // Step 4a: read-only view for repeating events.
        <div className="sheet__stack">
          <div className="group">
            <div className="row" style={{ alignItems: "flex-start" }}>
              <div className="row__body">
                <span className="row__title" style={{ fontWeight: 600 }}>
                  {existing.title || "(No title)"}
                </span>
                <span className="row__subtitle">{describeWhen(existing, timeZone)}</span>
                {existing.row.location && <span className="row__subtitle">{existing.row.location}</span>}
              </div>
              <RepeatIcon size={18} style={{ color: "var(--ink-2)" }} />
            </div>
            {existing.row.description && (
              <div className="row" style={{ ["--separator-inset" as string]: "16px" }}>
                <span className="row__subtitle" style={{ whiteSpace: "pre-wrap" }}>
                  {existing.row.description}
                </span>
              </div>
            )}
          </div>
          <p className="notice">
            This event repeats. To change or delete it, open it in Google Calendar; the change shows here within seconds.
          </p>
          {existing.row.html_link && (
            <a className="button button--secondary" href={existing.row.html_link} target="_blank" rel="noreferrer">
              Open in Google Calendar
            </a>
          )}
        </div>
      )}

      {form && !readOnly && (
        // Step 4b: the editable form.
        <div className="sheet__stack">
          <div className="group">
            <input
              className="input"
              aria-label="Title"
              placeholder="Title"
              value={form.title}
              onChange={(e) => set("title", e.target.value)}
              maxLength={300}
              autoFocus={!existing}
              style={{ borderRadius: 0, fontWeight: 600 }}
            />
            <div style={{ marginLeft: 16, borderTop: "0.5px solid var(--separator)" }}>
              <input
                className="input"
                aria-label="Location"
                placeholder="Location"
                value={form.location}
                onChange={(e) => set("location", e.target.value)}
                maxLength={300}
                style={{ borderRadius: 0, paddingLeft: 0 }}
              />
            </div>
          </div>

          <div className="group">
            <div className="form-row">
              <span className="form-row__label">All day</span>
              <button
                type="button"
                role="switch"
                aria-checked={form.allDay}
                aria-label="All day"
                className="switch"
                onClick={() => set("allDay", !form.allDay)}
              />
            </div>
            <div className="form-row">
              <span className="form-row__label">Starts</span>
              <span className="form-row__controls">
                <input
                  type="date"
                  className="pill-input"
                  style={{ width: 150 }}
                  aria-label="Start date"
                  value={form.startDate}
                  onChange={(e) => e.target.value && set("startDate", e.target.value)}
                />
                {!form.allDay && (
                  <input
                    type="time"
                    className="pill-input"
                    style={{ width: 128 }}
                    aria-label="Start time"
                    value={form.startTime}
                    onChange={(e) => e.target.value && set("startTime", e.target.value)}
                  />
                )}
              </span>
            </div>
            <div className="form-row">
              <span className="form-row__label">Ends</span>
              <span className="form-row__controls">
                <input
                  type="date"
                  className="pill-input"
                  style={{ width: 150 }}
                  aria-label="End date"
                  value={form.endDate}
                  min={form.startDate}
                  onChange={(e) => e.target.value && set("endDate", e.target.value)}
                />
                {!form.allDay && (
                  <input
                    type="time"
                    className="pill-input"
                    style={{ width: 128 }}
                    aria-label="End time"
                    value={form.endTime}
                    onChange={(e) => e.target.value && set("endTime", e.target.value)}
                  />
                )}
              </span>
            </div>
          </div>

          <textarea
            className="input"
            aria-label="Notes"
            placeholder="Notes"
            value={form.description}
            onChange={(e) => set("description", e.target.value)}
            maxLength={2000}
            rows={3}
          />

          {error && (
            <p className="form-error" role="alert" style={{ margin: 0 }}>
              {error}
            </p>
          )}

          {existing && (
            <button type="button" className="button button--danger" onClick={remove} disabled={busy}>
              Delete event
            </button>
          )}
          <p className="section__footer" style={{ padding: "0 16px" }}>
            Saved to the family Google Calendar, so it shows up on everyone&rsquo;s phones and in Google Calendar too.
          </p>
        </div>
      )}
    </Sheet>
  );
}
