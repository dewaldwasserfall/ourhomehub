/**
 * Family board settings (adults): pair a wall tablet and see or remove the
 * boards that are paired.
 *
 * Pairing: "Pair a tablet" makes an 8-digit code valid for 10 minutes. On the
 * tablet, open ourhomehub.nl/board and type it. The tablet then shows the
 * household's day and lets anyone tick things off; kids' ticks wait for a
 * grown-up to confirm them on Today.
 *
 * Admin mode: each parent (the owner, and adults marked as a parent) sets
 * their own 4-6 digit board PIN here. On the board, the lock button takes
 * it and unlocks adding groceries and to-dos and confirming ticks, until
 * the board's auto-lock time passes without a tap (set per board below).
 */
"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useHousehold } from "@/components/household-context";
import { ChevronLeftIcon, TabletIcon } from "@/components/icons";
import { Navbar } from "@/components/navbar";
import { useToast } from "@/components/toast";
import { friendlyError } from "@/lib/errors";
import { isParent } from "@/lib/roles";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

interface Board {
  id: string;
  name: string;
  created_at: string;
  last_seen_at: string | null;
  unlock_minutes: number;
}

/** Choices for how long a board stays unlocked after the last tap. */
const LOCK_CHOICES = [1, 2, 5, 10, 15, 30];

const shortDate = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });

export default function BoardSettingsPage() {
  const supabase = getSupabaseBrowserClient();
  const { meIsAdult, me } = useHousehold();
  const parent = isParent(me);
  const toast = useToast();
  const [boards, setBoards] = useState<Board[]>([]);
  const [code, setCode] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  // Step 1: the paired boards.
  const load = useCallback(async () => {
    const { data } = await supabase.from("boards").select("id, name, created_at, last_seen_at, unlock_minutes").order("created_at");
    setBoards((data ?? []) as Board[]);
  }, [supabase]);
  useEffect(() => {
    if (meIsAdult) load();
  }, [meIsAdult, load]);

  // Step 2: a pairing code. Once a tablet uses it, the list refreshes.
  async function makeCode() {
    const { data, error } = await supabase.rpc("create_board_code");
    if (error) return void toast.show(friendlyError(error));
    setCode(data as string);
  }
  useEffect(() => {
    if (!code) return;
    const timer = setInterval(load, 4000);
    const expire = setTimeout(() => setCode(null), 10 * 60_000);
    return () => {
      clearInterval(timer);
      clearTimeout(expire);
    };
  }, [code, load]);
  const known = boards.length;
  useEffect(() => {
    // A new board appeared while a code was showing: it's been used.
    setCode(null);
  }, [known]);

  // Step 3: remove a board (signs the tablet out).
  async function remove(id: string) {
    const res = await fetch("/api/board/remove", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ boardId: id }) });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      return void toast.show(body.message ?? "Couldn't remove the board.");
    }
    setConfirmRemove(null);
    await load();
  }

  // Step 4: auto-lock time per board.
  async function setLockMinutes(id: string, minutes: number) {
    setBoards((list) => list.map((b) => (b.id === id ? { ...b, unlock_minutes: minutes } : b)));
    const { error } = await supabase.from("boards").update({ unlock_minutes: minutes }).eq("id", id);
    if (error) {
      toast.show(friendlyError(error));
      await load();
    }
  }

  // Step 5: my board PIN (parents). Typed twice; never shown or read back.
  const [hasPin, setHasPin] = useState(false);
  const [pinForm, setPinForm] = useState<{ pin: string; again: string } | null>(null);
  const [pinError, setPinError] = useState<string | null>(null);
  useEffect(() => {
    if (!parent) return;
    void supabase.rpc("has_board_pin").then(({ data }) => setHasPin(Boolean(data)));
  }, [supabase, parent]);
  async function savePin() {
    if (!pinForm) return;
    if (!/^[0-9]{4,6}$/.test(pinForm.pin)) return setPinError("Use 4 to 6 digits.");
    if (pinForm.pin !== pinForm.again) return setPinError("The two PINs don't match.");
    const { error } = await supabase.rpc("set_board_pin", { p_pin: pinForm.pin });
    if (error) {
      if (error.message.includes("pin_taken")) return setPinError("Pick a different PIN: another parent uses that one.");
      return setPinError(friendlyError(error));
    }
    setPinForm(null);
    setPinError(null);
    setHasPin(true);
    toast.show("Board PIN saved");
  }
  async function removePin() {
    const { error } = await supabase.rpc("clear_board_pin");
    if (error) return void toast.show(friendlyError(error));
    setHasPin(false);
    setPinForm(null);
    toast.show("Board PIN removed");
  }
  const digitsOnly = (v: string) => v.replace(/\D/g, "").slice(0, 6);

  const back = (
    <Link href="/household" className="nav-button" aria-label="Back to Household">
      <ChevronLeftIcon size={22} />
      Household
    </Link>
  );

  if (!meIsAdult) {
    return (
      <main className="screen">
        <Navbar title="Family board" leading={back} />
        <section className="section">
          <div className="group empty">Only grown-ups can set up the Family board.</div>
        </section>
      </main>
    );
  }

  return (
    <main className="screen">
      <Navbar title="Family board" leading={back} />

      <section className="section">
        <div className="group">
          {boards.map((b) => (
            <div key={b.id} className="row">
              <span className="row__icon" style={{ background: "#8e8e93" }}>
                <TabletIcon size={19} strokeWidth={2} />
              </span>
              <span className="row__body">
                <span className="row__title">{b.name}</span>
                <span className="row__subtitle">
                  Paired {shortDate.format(new Date(b.created_at))}
                  {b.last_seen_at ? `, last used ${shortDate.format(new Date(b.last_seen_at))}` : ""}
                </span>
                <label className="board-lock-setting">
                  <span>Admin mode locks after</span>
                  <select
                    className="pill-input"
                    value={b.unlock_minutes}
                    onChange={(e) => setLockMinutes(b.id, Number(e.target.value))}
                    aria-label={`${b.name}: lock admin mode after`}
                  >
                    {LOCK_CHOICES.map((m) => (
                      <option key={m} value={m}>
                        {m} min
                      </option>
                    ))}
                  </select>
                </label>
              </span>
              <button type="button" className="chip-button" onClick={() => (confirmRemove === b.id ? remove(b.id) : setConfirmRemove(b.id))}>
                {confirmRemove === b.id ? "Tap again to remove" : "Remove"}
              </button>
            </div>
          ))}
          {code ? (
            <div className="row board-code">
              <span className="row__body">
                <span className="row__subtitle">On the tablet, open ourhomehub.nl/board and type:</span>
                <span className="board-code__digits">
                  {code.slice(0, 4)} {code.slice(4)}
                </span>
                <span className="row__subtitle">Works once, for 10 minutes.</span>
              </span>
            </div>
          ) : (
            <button type="button" className="row row--pressable trip-add-row" onClick={makeCode}>
              <TabletIcon size={18} />
              <span className="row__body">Pair a tablet</span>
            </button>
          )}
        </div>
        <p className="section__footer">
          The board shows everyone&rsquo;s tasks, bins and the calendar, never budget, trips or documents. When the kids tick something there,
          it waits under &ldquo;Waiting for you&rdquo; on Today until a grown-up confirms it.
        </p>
      </section>
      {/* My board PIN (parents only) */}
      {parent && (
        <section className="section">
          <div className="section__header">
            <span className="section__header-title">Admin mode</span>
          </div>
          <div className="group">
            {!pinForm ? (
              <div className="row">
                <span className="row__body">
                  <span className="row__title">Your board PIN</span>
                  <span className="row__subtitle">{hasPin ? "Set" : "Not set yet"}</span>
                </span>
                <span className="row__trailing">
                  {hasPin && (
                    <button type="button" className="chip-button" onClick={removePin}>
                      Remove
                    </button>
                  )}
                  <button
                    type="button"
                    className="chip-button chip-button--strong"
                    onClick={() => {
                      setPinError(null);
                      setPinForm({ pin: "", again: "" });
                    }}
                  >
                    {hasPin ? "Change" : "Set PIN"}
                  </button>
                </span>
              </div>
            ) : (
              <form
                className="row board-pin-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void savePin();
                }}
              >
                <input
                  className="input"
                  type="password"
                  inputMode="numeric"
                  autoComplete="new-password"
                  placeholder="New PIN (4-6 digits)"
                  aria-label="New PIN"
                  value={pinForm.pin}
                  onChange={(e) => setPinForm({ ...pinForm, pin: digitsOnly(e.target.value) })}
                  autoFocus
                />
                <input
                  className="input"
                  type="password"
                  inputMode="numeric"
                  autoComplete="new-password"
                  placeholder="Same PIN again"
                  aria-label="Same PIN again"
                  value={pinForm.again}
                  onChange={(e) => setPinForm({ ...pinForm, again: digitsOnly(e.target.value) })}
                />
                {pinError && (
                  <span className="row__subtitle" role="alert" style={{ color: "#d70015" }}>
                    {pinError}
                  </span>
                )}
                <span className="row__trailing">
                  <button type="button" className="chip-button" onClick={() => setPinForm(null)}>
                    Cancel
                  </button>
                  <button type="submit" className="chip-button chip-button--strong">
                    Save PIN
                  </button>
                </span>
              </form>
            )}
          </div>
          <p className="section__footer">
            On the board, tap the lock and type your PIN to add groceries and to-dos and confirm the kids&rsquo; ticks. It locks itself again
            after the time set above with no taps. Five wrong PINs block it for 5 minutes.
          </p>
        </section>
      )}
      {toast.node}
    </main>
  );
}
