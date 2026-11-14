/**
 * A trip's budget (adults with Trips access only).
 *
 *   * Summary in the home currency: total, paid, still to pay, and what's
 *     left of the planned budget (if one is set).
 *   * A warning for currencies without an exchange rate (those items are
 *     left out of the totals until a rate is set).
 *   * Items by category; tap to edit. Amount in its own currency, with the
 *     home-currency amount beside it.
 *   * Rates sheet: 1 unit of each foreign currency = how much at home.
 */
"use client";

import { useMemo, useState } from "react";
import { Segmented } from "@/components/segmented";
import { Sheet } from "@/components/sheet";
import { useToast } from "@/components/toast";
import { friendlyError } from "@/lib/errors";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { budgetSummary, byCategory, CURRENCIES, missingRates, money, parseAmount, rateMap, toHome } from "@/lib/trip-budget";
import { BUDGET_CATEGORIES, type BudgetCategory, type Trip, type TripBudgetItem, type TripRate } from "@/lib/types";

type Editing = { item: TripBudgetItem | null } | null;

export function TripBudget({
  trip,
  items,
  rates,
  reload,
}: {
  trip: Trip;
  items: TripBudgetItem[];
  rates: TripRate[];
  reload: () => Promise<void>;
}) {
  const supabase = getSupabaseBrowserClient();
  const toast = useToast();
  const home = trip.home_currency;
  const [editing, setEditing] = useState<Editing>(null);
  const [editingRates, setEditingRates] = useState(false);
  const [editingPlan, setEditingPlan] = useState(false);

  const map = useMemo(() => rateMap(rates), [rates]);
  const summary = budgetSummary(items, home, rates, trip.planned_budget_cents);
  const missing = missingRates(items, home, map);
  const groups = byCategory(items);

  async function run(write: PromiseLike<{ error: { message: string } | null }>) {
    const { error } = await write;
    if (error) toast.show(friendlyError(error));
    await reload();
    return !error;
  }

  return (
    <>
      {/* Summary */}
      <section className="section">
        <div className="group">
          <div className="row">
            <span className="row__body">
              <span className="row__subtitle">Total</span>
              <span className="trip-budget-total">{money(summary.totalCents, home)}</span>
            </span>
            <button type="button" className="chip-button" onClick={() => setEditingPlan(true)}>
              {trip.planned_budget_cents === null ? "Set a budget" : "Budget"}
            </button>
          </div>
          {summary.leftCents !== null && (
            <div className="row">
              <span className="row__body">
                <span className={`row__title ${summary.leftCents < 0 ? "trip-warning" : ""}`}>
                  {summary.leftCents < 0
                    ? `${money(-summary.leftCents, home)} over the ${money(trip.planned_budget_cents!, home)} budget`
                    : `${money(summary.leftCents, home)} left of ${money(trip.planned_budget_cents!, home)}`}
                </span>
              </span>
            </div>
          )}
          <div className="row">
            <span className="row__body">
              <span className="row__subtitle">Paid</span>
              <span className="row__title">{money(summary.paidCents, home)}</span>
            </span>
            <span className="row__body" style={{ textAlign: "right" }}>
              <span className="row__subtitle">Still to pay</span>
              <span className="row__title">{money(summary.unpaidCents, home)}</span>
            </span>
          </div>
          {missing.length > 0 && (
            <button type="button" className="row row--pressable" onClick={() => setEditingRates(true)}>
              <span className="row__body">
                <span className="row__title trip-warning">Set a rate for {missing.join(", ")}</span>
                <span className="row__subtitle">
                  {summary.uncounted === 1 ? "1 item isn't" : `${summary.uncounted} items aren't`} in the totals until then
                </span>
              </span>
            </button>
          )}
        </div>
      </section>

      {/* Items by category */}
      {groups.map(([category, list]) => (
        <section key={category} className="section">
          <div className="section__header">
            <span className="section__header-title">{category}</span>
          </div>
          <div className="group">
            {list.map((i) => {
              const homeCents = i.currency === home ? null : toHome(i, home, map);
              return (
                <button key={i.id} type="button" className="row row--pressable" onClick={() => setEditing({ item: i })}>
                  <span className="row__body">
                    <span className="row__title">{i.title}</span>
                    <span className="row__subtitle">
                      {i.paid ? "Paid" : "To pay"}
                      {i.date && ` · ${new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${i.date}T12:00:00Z`))}`}
                    </span>
                  </span>
                  <span className="row__trailing trip-amount">
                    {money(i.amount_cents, i.currency)}
                    {homeCents !== null && <span className="trip-amount__home">{money(homeCents, home)}</span>}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      ))}

      <section className="section">
        <div className="trip-actions">
          <button type="button" className="button button--primary" onClick={() => setEditing({ item: null })}>
            Add a cost
          </button>
          <button type="button" className="button" onClick={() => setEditingRates(true)}>
            Exchange rates
          </button>
        </div>
      </section>

      {/* Sheets */}
      <ItemSheet
        editing={editing}
        home={home}
        onClose={() => setEditing(null)}
        onSave={(fields) =>
          editing?.item
            ? run(supabase.from("trip_budget").update(fields).eq("id", editing.item.id))
            : run(supabase.from("trip_budget").insert({ trip_id: trip.id, ...fields }))
        }
        onDelete={async () => {
          if (editing?.item && (await run(supabase.from("trip_budget").delete().eq("id", editing.item.id)))) setEditing(null);
        }}
      />
      <RatesSheet
        open={editingRates}
        home={home}
        used={[...new Set([...items.map((i) => i.currency), ...rates.map((r) => r.currency)])].filter((c) => c !== home).sort()}
        rates={map}
        onClose={() => setEditingRates(false)}
        onSave={async (next) => {
          // Upsert the filled-in rates; remove the ones cleared.
          const keep = [...next.entries()];
          const cleared = [...map.keys()].filter((c) => !next.has(c));
          if (keep.length) {
            const ok = await run(
              supabase.from("trip_rates").upsert(keep.map(([currency, rate]) => ({ trip_id: trip.id, currency, rate })), { onConflict: "trip_id,currency" }),
            );
            if (!ok) return false;
          }
          if (cleared.length) await run(supabase.from("trip_rates").delete().eq("trip_id", trip.id).in("currency", cleared));
          return true;
        }}
      />
      <PlanSheet
        open={editingPlan}
        trip={trip}
        onClose={() => setEditingPlan(false)}
        onSave={(cents, currency) => run(supabase.from("trips").update({ planned_budget_cents: cents, home_currency: currency }).eq("id", trip.id))}
      />
      {toast.node}
    </>
  );
}

// -----------------------------------------------------------------------------
// A cost
// -----------------------------------------------------------------------------

type ItemFields = Pick<TripBudgetItem, "title" | "category" | "amount_cents" | "currency" | "paid" | "date">;

function ItemSheet({
  editing,
  home,
  onClose,
  onSave,
  onDelete,
}: {
  editing: Editing;
  home: string;
  onClose: () => void;
  onSave: (fields: ItemFields) => Promise<boolean>;
  onDelete: () => void;
}) {
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<BudgetCategory>("Other");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState(home);
  const [paid, setPaid] = useState<"paid" | "unpaid">("unpaid");
  const [date, setDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [lastOpened, setLastOpened] = useState<Editing>(null);

  // Fill the fields each time the sheet opens.
  if (editing !== lastOpened) {
    setLastOpened(editing);
    if (editing) {
      const i = editing.item;
      setTitle(i?.title ?? "");
      setCategory(i?.category ?? "Other");
      setAmount(i ? (i.amount_cents / 100).toFixed(2) : "");
      setCurrency(i?.currency ?? home);
      setPaid(i?.paid ? "paid" : "unpaid");
      setDate(i?.date ?? "");
      setConfirm(false);
    }
  }

  const cents = parseAmount(amount);
  const valid = title.trim().length > 0 && cents !== null;
  const save = async () => {
    if (!valid) return;
    setBusy(true);
    const ok = await onSave({ title: title.trim(), category, amount_cents: cents!, currency, paid: paid === "paid", date: date || null });
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <Sheet
      open={!!editing}
      onClose={onClose}
      title={editing?.item ? "Cost" : "New cost"}
      leading={
        <button type="button" className="nav-button" onClick={onClose}>
          Cancel
        </button>
      }
      trailing={
        <button type="button" className="nav-button nav-button--strong" onClick={save} disabled={busy || !valid}>
          {editing?.item ? "Done" : "Add"}
        </button>
      }
    >
      <div className="sheet__stack">
        <input
          className="input"
          aria-label="What"
          placeholder="e.g. Flights"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
          style={{ fontWeight: 600 }}
          autoFocus={!editing?.item}
        />
        <div className="group">
          <label className="form-row">
            <span className="form-row__label">Amount</span>
            <span className="form-row__controls">
              <input
                className="pill-input"
                inputMode="decimal"
                style={{ width: 110, textAlign: "right" }}
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                aria-invalid={amount !== "" && cents === null}
              />
              <select className="pill-input" value={currency} onChange={(e) => setCurrency(e.target.value)} aria-label="Currency">
                {[...new Set([home, ...CURRENCIES])].map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </span>
          </label>
          <label className="form-row">
            <span className="form-row__label">Date</span>
            <span className="form-row__controls">
              <input type="date" className="pill-input" style={{ width: 150 }} value={date} onChange={(e) => setDate(e.target.value)} />
            </span>
          </label>
        </div>
        <Segmented
          label="Paid"
          value={paid}
          onChange={setPaid}
          options={[
            { value: "unpaid", label: "To pay" },
            { value: "paid", label: "Paid" },
          ]}
        />
        <div>
          <span className="field__label">Category</span>
          <div className="chip-grid" role="group" aria-label="Category">
            {BUDGET_CATEGORIES.map((c) => (
              <button key={c} type="button" className="chip" aria-pressed={category === c} onClick={() => setCategory(c)}>
                {c}
              </button>
            ))}
          </div>
        </div>
        {editing?.item && (
          <button type="button" className="button button--danger" onClick={() => (confirm ? onDelete() : setConfirm(true))}>
            {confirm ? "Tap again to delete" : "Delete"}
          </button>
        )}
      </div>
    </Sheet>
  );
}

// -----------------------------------------------------------------------------
// Exchange rates
// -----------------------------------------------------------------------------

function RatesSheet({
  open,
  home,
  used,
  rates,
  onClose,
  onSave,
}: {
  open: boolean;
  home: string;
  /** Foreign currencies on this trip. */
  used: string[];
  rates: Map<string, number>;
  onClose: () => void;
  onSave: (rates: Map<string, number>) => Promise<boolean>;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [added, setAdded] = useState<string[]>([]);
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setValues(Object.fromEntries(used.map((c) => [c, rates.get(c)?.toString() ?? ""])));
      setAdded([]);
    }
  }
  const currencies = [...used, ...added];
  const parsed = (v: string) => {
    const n = Number(v.trim().replace(",", "."));
    return v.trim() && Number.isFinite(n) && n > 0 ? n : null;
  };
  const invalid = currencies.some((c) => values[c]?.trim() && parsed(values[c]) === null);

  const save = async () => {
    const next = new Map<string, number>();
    for (const c of currencies) {
      const n = parsed(values[c] ?? "");
      if (n !== null) next.set(c, n);
    }
    if (await onSave(next)) onClose();
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Exchange rates"
      leading={
        <button type="button" className="nav-button" onClick={onClose}>
          Cancel
        </button>
      }
      trailing={
        <button type="button" className="nav-button nav-button--strong" onClick={save} disabled={invalid}>
          Done
        </button>
      }
    >
      <div className="sheet__stack">
        {currencies.length > 0 && (
          <div className="group">
            {currencies.map((c) => (
              <label key={c} className="form-row">
                <span className="form-row__label">1 {c} =</span>
                <span className="form-row__controls">
                  <input
                    className="pill-input"
                    inputMode="decimal"
                    style={{ width: 110, textAlign: "right" }}
                    placeholder="e.g. 1.17"
                    value={values[c] ?? ""}
                    onChange={(e) => setValues((v) => ({ ...v, [c]: e.target.value }))}
                  />
                  <span className="row__subtitle">{home}</span>
                </span>
              </label>
            ))}
          </div>
        )}
        <label className="form-row group">
          <span className="form-row__label">Add a currency</span>
          <select
            className="pill-input"
            value=""
            onChange={(e) => e.target.value && setAdded((a) => [...a, e.target.value])}
            aria-label="Add a currency"
          >
            <option value="">Choose…</option>
            {CURRENCIES.filter((c) => c !== home && !currencies.includes(c)).map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <p className="section__footer" style={{ margin: 0 }}>
          Rates you set here are used for this trip&rsquo;s totals. Clear one to remove it.
        </p>
      </div>
    </Sheet>
  );
}

// -----------------------------------------------------------------------------
// Planned budget and home currency
// -----------------------------------------------------------------------------

function PlanSheet({
  open,
  trip,
  onClose,
  onSave,
}: {
  open: boolean;
  trip: Trip;
  onClose: () => void;
  onSave: (cents: number | null, currency: string) => Promise<boolean>;
}) {
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState(trip.home_currency);
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setAmount(trip.planned_budget_cents === null ? "" : (trip.planned_budget_cents / 100).toFixed(2));
      setCurrency(trip.home_currency);
    }
  }
  const cents = amount.trim() ? parseAmount(amount) : null;
  const invalid = amount.trim() !== "" && cents === null;
  const save = async () => {
    if (!invalid && (await onSave(cents, currency))) onClose();
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Budget"
      leading={
        <button type="button" className="nav-button" onClick={onClose}>
          Cancel
        </button>
      }
      trailing={
        <button type="button" className="nav-button nav-button--strong" onClick={save} disabled={invalid}>
          Done
        </button>
      }
    >
      <div className="sheet__stack">
        <div className="group">
          <label className="form-row">
            <span className="form-row__label">Planned budget</span>
            <input
              className="pill-input"
              inputMode="decimal"
              style={{ width: 120, textAlign: "right" }}
              placeholder="None"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
          <label className="form-row">
            <span className="form-row__label">Totals in</span>
            <select className="pill-input" value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {[...new Set([trip.home_currency, ...CURRENCIES])].map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="section__footer" style={{ margin: 0 }}>
          Leave the budget empty to just track costs. Changing the currency means setting the rates again.
        </p>
      </div>
    </Sheet>
  );
}
