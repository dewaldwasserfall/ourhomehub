/**
 * Bin days: collection dates copied from Breda's Afvalservice app (it has no
 * feed and shows about two months ahead), grouped by month.
 *
 * Adults add dates (several at once for one bin type) and delete them;
 * everyone can look. A recurring chore reminds someone to add the next batch.
 */
"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useHousehold } from "@/components/household-context";
import { ChevronLeftIcon, PlusIcon } from "@/components/icons";
import { Navbar } from "@/components/navbar";
import { Sheet } from "@/components/sheet";
import { useToast } from "@/components/toast";
import { BIN_KINDS, binColour, binLabel, lastBinDate, type BinDay, type BinKind } from "@/lib/bins";
import { dateKey } from "@/lib/calendar/time";
import { friendlyError } from "@/lib/errors";
import { describeDay } from "@/lib/plan";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { usePlanData } from "@/lib/use-plan-data";

const monthName = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

export default function BinsPage() {
  const supabase = getSupabaseBrowserClient();
  const { household, meIsAdult } = useHousehold();
  const today = dateKey(new Date(), household.timezone);
  const { binDays, reload } = usePlanData(household.id, today);
  const toast = useToast();

  // Step 1: upcoming dates grouped by month, bins of the same day together.
  const months = useMemo(() => {
    const byDate = new Map<string, BinDay[]>();
    for (const d of binDays) byDate.set(d.date, [...(byDate.get(d.date) ?? []), d]);
    const groups = new Map<string, Array<{ date: string; days: BinDay[] }>>();
    for (const [date, days] of [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const month = date.slice(0, 7);
      groups.set(month, [...(groups.get(month) ?? []), { date, days }]);
    }
    return [...groups.entries()];
  }, [binDays]);
  const last = lastBinDate(binDays);

  // Step 2: adding — one bin type, one or more dates.
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<BinKind>("plastic");
  const [dates, setDates] = useState<string[]>([""]);

  async function save() {
    const valid = [...new Set(dates.filter(Boolean))];
    if (!valid.length) return;
    const { error } = await supabase
      .from("bin_days")
      .upsert(valid.map((date) => ({ household_id: household.id, kind, date })), { onConflict: "household_id,kind,date", ignoreDuplicates: true });
    if (error) return void toast.show(friendlyError(error));
    setAdding(false);
    setDates([""]);
    await reload();
  }

  // Step 3: delete one date (tap, then confirm in the toast-free way: a second tap).
  const [confirmId, setConfirmId] = useState<string | null>(null);
  async function remove(day: BinDay) {
    if (confirmId !== day.id) return setConfirmId(day.id);
    const { error } = await supabase.from("bin_days").delete().eq("id", day.id);
    if (error) toast.show(friendlyError(error));
    setConfirmId(null);
    await reload();
  }

  return (
    <main className="screen">
      <Navbar
        title="Bin days"
        leading={
          <Link href="/household" className="nav-button" aria-label="Back to Household">
            <ChevronLeftIcon size={22} />
            Household
          </Link>
        }
        trailing={
          meIsAdult && (
            <button type="button" className="nav-button nav-button--icon" aria-label="Add bin dates" onClick={() => setAdding(true)}>
              <PlusIcon size={24} />
            </button>
          )
        }
        subtitle={last ? `Dates entered up to ${describeDay(last, today)}` : "Copy the dates from the Afvalservice app"}
      />

      {months.length === 0 && (
        <section className="section">
          <div className="group empty">
            <span className="empty__title">No bin days yet</span>
            Add the collection dates shown in Breda&rsquo;s Afvalservice app.
          </div>
        </section>
      )}

      {months.map(([month, entries]) => (
        <section key={month} className="section">
          <div className="section__header">
            <span className="section__header-title">{monthName.format(new Date(`${month}-01T12:00:00Z`))}</span>
          </div>
          <div className="group">
            {entries.flatMap(({ date, days }) =>
              days.map((day) => (
                <button
                  key={day.id}
                  type="button"
                  className="row row--pressable"
                  disabled={!meIsAdult}
                  onClick={() => remove(day)}
                >
                  <span className="bin-dot" style={{ background: binColour(day.kind), width: 14, height: 14 }} aria-hidden="true" />
                  <span className="row__body">
                    <span className="row__title">{binLabel(day.kind)}</span>
                    <span className="row__subtitle">{describeDay(date, today)}</span>
                  </span>
                  {confirmId === day.id && <span className="chip-button" style={{ color: "var(--danger)" }}>Tap again to delete</span>}
                </button>
              )),
            )}
          </div>
        </section>
      ))}

      <Sheet
        open={adding}
        onClose={() => setAdding(false)}
        title="Add bin dates"
        leading={
          <button type="button" className="nav-button" onClick={() => setAdding(false)}>
            Cancel
          </button>
        }
        trailing={
          <button type="button" className="nav-button nav-button--strong" onClick={save} disabled={!dates.some(Boolean)}>
            Add
          </button>
        }
      >
        <div className="sheet__stack">
          <div className="chip-grid" role="group" aria-label="Bin">
            {BIN_KINDS.map((k) => (
              <button
                key={k.id}
                type="button"
                className="chip bin-chip"
                style={{ ["--bin" as string]: k.colour }}
                aria-pressed={kind === k.id}
                onClick={() => setKind(k.id)}
              >
                {k.label}
              </button>
            ))}
          </div>
          <div className="group">
            {dates.map((d, i) => (
              <label key={i} className="form-row">
                <span className="form-row__label">Date {dates.length > 1 ? i + 1 : ""}</span>
                <input
                  type="date"
                  className="pill-input"
                  style={{ width: 150 }}
                  value={d}
                  onChange={(e) => setDates(dates.map((x, j) => (j === i ? e.target.value : x)))}
                />
              </label>
            ))}
          </div>
          <button type="button" className="button button--secondary" onClick={() => setDates([...dates, ""])}>
            Another date
          </button>
        </div>
      </Sheet>
      {toast.node}
    </main>
  );
}
