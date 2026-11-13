/**
 * School holidays: everything that changes a day's mode, from now on.
 *
 *   * School holidays for the household's region, from the government feed
 *   * Dutch public holidays, worked out by the app
 *   * Your own days: extra days off, or "school day after all" overrides
 *
 * Imported and computed rows refresh weekly and can't be deleted (they'd come
 * back); add a School day override instead. Your own days can be edited.
 */
"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHousehold } from "@/components/household-context";
import { ChevronLeftIcon, PlusIcon, RefreshIcon } from "@/components/icons";
import { Navbar } from "@/components/navbar";
import { DateField } from "@/components/plan-controls";
import { Segmented } from "@/components/segmented";
import { Sheet } from "@/components/sheet";
import { useToast } from "@/components/toast";
import { addDays, dateKey } from "@/lib/calendar/time";
import { calendarApi } from "@/lib/calendar/use-calendar";
import { friendlyError } from "@/lib/errors";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import type { DayOverride, Household } from "@/lib/types";
import { usePlanData } from "@/lib/use-plan-data";

const KIND_LABELS: Record<DayOverride["kind"], string> = {
  holiday: "School holiday",
  public_holiday: "Public holiday",
  day_off: "Day off",
  school_day: "School day",
};

const REGIONS: Array<{ value: Household["school_region"]; label: string }> = [
  { value: "noord", label: "North" },
  { value: "midden", label: "Middle" },
  { value: "zuid", label: "South" },
];

const dayMonth = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const dayMonthYear = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const fmt = (f: Intl.DateTimeFormat, d: string) => f.format(new Date(`${d}T12:00:00Z`));

/** "17 Oct", "17–25 Oct 2026", "19 Dec 2026 – 3 Jan 2027". */
function describeRange(start: string, end: string, thisYear: string): string {
  const sameYear = start.slice(0, 4) === end.slice(0, 4);
  const withYear = start.slice(0, 4) !== thisYear || !sameYear;
  if (start === end) return withYear ? fmt(dayMonthYear, start) : fmt(dayMonth, start);
  if (sameYear && start.slice(0, 7) === end.slice(0, 7)) {
    return `${Number(start.slice(8))}–${withYear ? fmt(dayMonthYear, end) : fmt(dayMonth, end)}`;
  }
  return `${withYear ? fmt(dayMonthYear, start) : fmt(dayMonth, start)} – ${withYear ? fmt(dayMonthYear, end) : fmt(dayMonth, end)}`;
}

type Editing = { day: DayOverride | null } | null;

export default function HolidaysPage() {
  const supabase = getSupabaseBrowserClient();
  const { household, setHousehold } = useHousehold();
  const today = dateKey(new Date(), household.timezone);
  const { overrides, loading, reload } = usePlanData(household.id, today);
  const [importing, setImporting] = useState(false);
  const [editing, setEditing] = useState<Editing>(null);
  const autoImported = useRef(false);
  const toast = useToast();

  // Step 1: fetch from the government feed (also runs weekly on the server).
  const runImport = useCallback(
    async (quiet = false) => {
      setImporting(true);
      const r = await calendarApi<{ schoolHolidays: number; missingYears: string[] }>("/api/holidays/import", "POST");
      setImporting(false);
      await reload();
      if (!r.ok) return toast.show(r.message ?? "Couldn't update the holidays.");
      if (!quiet) {
        const missing = r.data?.missingYears.length ? ` ${r.data.missingYears.join(", ")} isn't published yet.` : "";
        toast.show(`Holidays up to date.${missing}`);
      }
    },
    [reload, toast],
  );

  // Step 2: the first visit imports straight away, so the list isn't empty.
  useEffect(() => {
    if (loading || autoImported.current) return;
    autoImported.current = true;
    if (!overrides.some((o) => o.source !== "manual")) runImport(true);
  }, [loading, overrides, runImport]);

  // Step 3: change region, then re-import for it.
  async function setRegion(region: Household["school_region"]) {
    const { error } = await supabase.from("households").update({ school_region: region }).eq("id", household.id);
    if (error) return void toast.show(friendlyError(error));
    setHousehold({ ...household, school_region: region });
    await runImport();
  }

  const upcoming = useMemo(() => overrides.filter((o) => o.end_date >= today), [overrides, today]);

  // Step 4: your own days (add, edit, delete).
  const [kind, setKind] = useState<"day_off" | "school_day">("day_off");
  const [name, setName] = useState("");
  const [start, setStart] = useState<string | null>(today);
  const [end, setEnd] = useState<string | null>(today);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!editing) return;
    const d = editing.day;
    setKind(d?.kind === "school_day" ? "school_day" : "day_off");
    setName(d?.name ?? "");
    setStart(d?.start_date ?? addDays(today, 1));
    setEnd(d?.end_date ?? addDays(today, 1));
    setConfirmDelete(false);
  }, [editing, today]);

  async function saveDay() {
    if (!editing || !start) return;
    const fields = {
      kind,
      name: name.trim() || (kind === "day_off" ? "Day off" : "School day"),
      start_date: start,
      end_date: end && end >= start ? end : start,
    };
    const { error } = editing.day
      ? await supabase.from("day_overrides").update(fields).eq("id", editing.day.id)
      : await supabase.from("day_overrides").insert({ household_id: household.id, source: "manual", ...fields });
    if (error) return void toast.show(friendlyError(error));
    setEditing(null);
    await reload();
  }

  async function deleteDay() {
    if (!editing?.day) return;
    if (!confirmDelete) return setConfirmDelete(true);
    const { error } = await supabase.from("day_overrides").delete().eq("id", editing.day.id);
    if (error) return void toast.show(friendlyError(error));
    setEditing(null);
    await reload();
  }

  const thisYear = today.slice(0, 4);

  return (
    <main className="screen">
      <Navbar
        title="School holidays"
        leading={
          <Link href="/household" className="nav-button" aria-label="Back to Household">
            <ChevronLeftIcon size={22} />
            Household
          </Link>
        }
        trailing={
          <>
            <button
              type="button"
              className="nav-button nav-button--icon"
              aria-label="Update from the government feed"
              onClick={() => runImport()}
              disabled={importing}
            >
              <RefreshIcon size={21} style={importing ? { animation: "spin 0.8s linear infinite" } : undefined} />
            </button>
            <button type="button" className="nav-button nav-button--icon" aria-label="Add your own day" onClick={() => setEditing({ day: null })}>
              <PlusIcon size={24} />
            </button>
          </>
        }
      />

      {/* Region */}
      <section className="section">
        <Segmented label="School holiday region" value={household.school_region} onChange={setRegion} options={REGIONS} />
        <p className="section__footer">Breda is in the South region. Holidays update every week from rijksoverheid.nl.</p>
      </section>

      {/* Upcoming days */}
      <section className="section">
        <div className="section__header">
          <span className="section__header-title">Coming up</span>
        </div>
        <div className="group">
          {(loading || (importing && upcoming.length === 0)) && <div className="skeleton" />}
          {!loading && !importing && upcoming.length === 0 && (
            <div className="empty">
              <span className="empty__title">No holidays yet</span>
              Tap the refresh button to fetch them.
            </div>
          )}
          {upcoming.map((o) => {
            const manual = o.source === "manual";
            const isNow = o.start_date <= today;
            const content = (
              <>
                <span className="row__body">
                  <span className="row__title">{o.name}</span>
                  <span className="row__subtitle">
                    {describeRange(o.start_date, o.end_date, thisYear)}
                    {isNow && " · now"}
                  </span>
                </span>
                <span className={`kind-badge kind-badge--${o.kind}`}>{KIND_LABELS[o.kind]}</span>
              </>
            );
            return manual ? (
              <button key={o.id} type="button" className="row row--pressable" onClick={() => setEditing({ day: o })}>
                {content}
              </button>
            ) : (
              <div key={o.id} className="row">
                {content}
              </div>
            );
          })}
        </div>
        <p className="section__footer">
          Good Friday and Liberation Day aren&rsquo;t a day off at every school. If yours is open, add a School day for it.
        </p>
      </section>

      {/* Add or edit your own day */}
      <Sheet
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.day ? "Your day" : "Add a day"}
        leading={
          <button type="button" className="nav-button" onClick={() => setEditing(null)}>
            Cancel
          </button>
        }
        trailing={
          <button type="button" className="nav-button nav-button--strong" onClick={saveDay} disabled={!start}>
            {editing?.day ? "Done" : "Add"}
          </button>
        }
      >
        <div className="sheet__stack">
          <div>
            <Segmented
              label="Kind of day"
              value={kind}
              onChange={setKind}
              options={[
                { value: "day_off", label: "Day off" },
                { value: "school_day", label: "School day" },
              ]}
            />
            <p className="section__footer" style={{ padding: "8px 0 0" }}>
              {kind === "day_off"
                ? "No school: holiday routines and chores apply."
                : "School as normal, even inside a holiday or on a public holiday."}
            </p>
          </div>
          <input
            className="input"
            aria-label="Name"
            placeholder={kind === "day_off" ? "e.g. Study day" : "e.g. School open on Good Friday"}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
          />
          <DateField label="From" value={start} onChange={(d) => { setStart(d); if (d && (!end || end < d)) setEnd(d); }} clearable={false} />
          <DateField label="Until" value={end} onChange={setEnd} clearable={false} />
          {editing?.day && (
            <button type="button" className="button button--danger" onClick={deleteDay}>
              {confirmDelete ? "Tap again to delete" : "Delete"}
            </button>
          )}
        </div>
      </Sheet>
      {toast.node}
    </main>
  );
}
