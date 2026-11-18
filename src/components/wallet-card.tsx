/**
 * My Wallet: a child's game time, money and promised rewards.
 *
 *   * The card: "🎮 35 min", "💶 €0.80", "🎁 Disneyland". On the board it
 *     sits in each child's column; on phones under the child on Stars.
 *   * Tap it: the wallet sheet, with the history of every change.
 *   * Adults (on a phone, or the board unlocked):
 *       - Time: use 5 / 10 / 15 / 30 minutes, or any amount;
 *       - Cash: pay out everything, or an amount;
 *       - Adjust: add or take off, with a note (corrections, bonuses);
 *       - Promised one-offs: mark given.
 *
 * Changes go through wallet_change / give_reward (or the board_ versions, as
 * the parent who unlocked the board). The database refuses anything else.
 */
"use client";

import { useState } from "react";
import { Sheet } from "@/components/sheet";
import { useHousehold } from "@/components/household-context";
import { rewardStatus, type RewardPlan, type RewardProgress } from "@/lib/rewards";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import type { Member } from "@/lib/types";
import { balances, describeEntry, formatAmount, unitOf, type WalletEntry, type WalletUnit } from "@/lib/wallet";

const QUICK_MINUTES = [5, 10, 15, 30];

export function WalletCard({
  child,
  entries,
  plans,
  progress,
  surface,
  admin,
  onMessage,
  adminError = (m) => m,
}: {
  child: Member;
  /** Wallet lines (any children; this child's are picked out). */
  entries: WalletEntry[];
  /** The child's active rewards. */
  plans: RewardPlan[];
  progress: Record<string, RewardProgress | undefined>;
  surface: "board" | "phone";
  /** May change it: an adult on a phone, or the board unlocked. */
  admin: boolean;
  onMessage: (message: string) => void;
  adminError?: (message: string) => string;
}) {
  const supabase = getSupabaseBrowserClient();
  const { memberById } = useHousehold();
  const name = child.display_name.split(" ")[0];

  // Step 1: what's in it. A unit shows when a reward pays in it, or there's
  //         something in it.
  const mine = entries.filter((e) => e.member_id === child.id);
  const bal = balances(mine, child.id);
  const paysIn = new Set(plans.map((p) => unitOf(p.reward_type)).filter(Boolean));
  const units = (["minutes", "euros"] as WalletUnit[]).filter((u) => paysIn.has(u) || bal[u] !== 0 || mine.some((e) => e.unit === u));
  const promised = plans.filter((p) => p.reward_type === "one_off" && rewardStatus(progress[p.id]) === "earned");
  const planTitle = (id: string | null) => plans.find((p) => p.id === id)?.title;

  // Step 2: the sheet and its forms.
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [custom, setCustom] = useState<{ unit: WalletUnit; kind: "used" | "paid" | "adjust"; amount: string; note: string; sign: 1 | -1 } | null>(
    null,
  );
  const [showAll, setShowAll] = useState(false);

  const change = async (unit: WalletUnit, kind: "used" | "paid" | "adjust", amount: number, note: string | null) => {
    if (!amount || busy) return;
    setBusy(true);
    const { error } = await supabase.rpc(surface === "board" ? "board_wallet_change" : "wallet_change", {
      p_member_id: child.id,
      p_unit: unit,
      p_kind: kind,
      p_amount: amount,
      p_note: note,
    });
    setBusy(false);
    if (error) {
      const locked = adminError(error.message);
      if (locked !== error.message) return onMessage(locked);
      if (error.message.includes("not_enough")) return onMessage(`${name} doesn't have that much.`);
      if (error.message.includes("adults_only")) return onMessage("Only a grown-up can do that.");
      return onMessage("That didn't work. Try again.");
    }
    setCustom(null);
    onMessage(
      kind === "used"
        ? `${formatAmount(unit, amount)} used`
        : kind === "paid"
          ? `Paid out ${formatAmount(unit, amount)}`
          : `${formatAmount(unit, amount, true)} added to ${name}'s wallet`,
    );
  };
  const give = async (plan: RewardPlan) => {
    setBusy(true);
    const { error } = await supabase.rpc(surface === "board" ? "board_give_reward" : "give_reward", { p_plan_id: plan.id });
    setBusy(false);
    if (error) {
      const locked = adminError(error.message);
      return onMessage(
        locked !== error.message ? locked : error.message.includes("parents_only") ? "Only a parent can do that." : "That didn't work. Try again.",
      );
    }
    onMessage(`${plan.title}: given ✓`);
  };

  const icon = (u: WalletUnit) => (u === "minutes" ? "🎮" : "💶");
  const label = (u: WalletUnit) => (u === "minutes" ? "Game time" : "Money");
  const when = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const history = showAll ? mine : mine.slice(0, 12);

  if (units.length === 0 && promised.length === 0 && !plans.some((p) => p.reward_type === "one_off")) return null;

  return (
    <>
      {/* The card */}
      <button type="button" className={`wallet-card wallet-card--${surface}`} onClick={() => setOpen(true)} aria-label={`${name}'s wallet`}>
        <span className="wallet-card__title">My Wallet</span>
        <span className="wallet-card__rows">
          {units.map((u) => (
            <span key={u} className="wallet-card__row">
              <span aria-hidden="true">{icon(u)}</span>
              <strong>{formatAmount(u, bal[u])}</strong>
              <span className="wallet-card__label">{u === "minutes" ? "game time" : "owed"}</span>
            </span>
          ))}
          {promised.map((p) => (
            <span key={p.id} className="wallet-card__row">
              <span aria-hidden="true">🎁</span>
              <strong>{p.title}</strong>
            </span>
          ))}
          {units.length === 0 && promised.length === 0 && <span className="wallet-card__label">Nothing in it yet</span>}
        </span>
      </button>

      {/* The sheet */}
      <Sheet
        open={open}
        onClose={() => {
          setOpen(false);
          setCustom(null);
        }}
        title={`${name}'s wallet`}
      >
        <div className="wallet">
          {units.map((u) => (
            <section key={u} className="wallet__unit">
              <div className="wallet__balance">
                <span aria-hidden="true">{icon(u)}</span>
                <span className="wallet__amount">{formatAmount(u, bal[u])}</span>
                <span className="wallet__what">{label(u)}</span>
              </div>
              {admin && (
                <div className="wallet__actions">
                  {u === "minutes" &&
                    QUICK_MINUTES.map((m) => (
                      <button
                        key={m}
                        type="button"
                        className="wallet__btn"
                        disabled={busy || bal.minutes < m}
                        onClick={() => void change("minutes", "used", m, null)}
                      >
                        Use {m} min
                      </button>
                    ))}
                  {u === "euros" && (
                    <button
                      type="button"
                      className="wallet__btn wallet__btn--pay"
                      disabled={busy || bal.euros <= 0}
                      onClick={() => void change("euros", "paid", bal.euros, null)}
                    >
                      Pay out {formatAmount("euros", Math.max(0, bal.euros))}
                    </button>
                  )}
                  <button
                    type="button"
                    className="wallet__btn"
                    disabled={busy}
                    onClick={() => setCustom({ unit: u, kind: u === "minutes" ? "used" : "paid", amount: "", note: "", sign: -1 })}
                  >
                    {u === "minutes" ? "Use other…" : "Pay part…"}
                  </button>
                  <button
                    type="button"
                    className="wallet__btn wallet__btn--soft"
                    disabled={busy}
                    onClick={() => setCustom({ unit: u, kind: "adjust", amount: "", note: "", sign: 1 })}
                  >
                    Adjust…
                  </button>
                </div>
              )}
            </section>
          ))}

          {/* An amount of your choice: use / pay part / adjust */}
          {custom && (
            <form
              className="wallet__form"
              onSubmit={(e) => {
                e.preventDefault();
                const n = Number(custom.amount.replace(",", "."));
                if (!Number.isFinite(n) || n <= 0) return onMessage("Type an amount above 0.");
                void change(custom.unit, custom.kind, custom.kind === "adjust" ? n * custom.sign : n, custom.note.trim() || null);
              }}
            >
              <span className="wallet__form-title">
                {custom.kind === "used" ? "Use game time" : custom.kind === "paid" ? "Pay out" : `Adjust ${label(custom.unit).toLowerCase()}`}
              </span>
              {custom.kind === "adjust" && (
                <div className="wallet__actions">
                  <button
                    type="button"
                    className={`wallet__btn ${custom.sign === 1 ? "wallet__btn--on" : ""}`}
                    onClick={() => setCustom({ ...custom, sign: 1 })}
                  >
                    Add
                  </button>
                  <button
                    type="button"
                    className={`wallet__btn ${custom.sign === -1 ? "wallet__btn--on" : ""}`}
                    onClick={() => setCustom({ ...custom, sign: -1 })}
                  >
                    Take off
                  </button>
                </div>
              )}
              <div className="wallet__inputs">
                <input
                  className="input"
                  inputMode="decimal"
                  placeholder={custom.unit === "minutes" ? "Minutes" : "Euros, e.g. 2.50"}
                  aria-label={custom.unit === "minutes" ? "Minutes" : "Euros"}
                  value={custom.amount}
                  onChange={(e) => setCustom({ ...custom, amount: e.target.value.replace(/[^0-9.,]/g, "") })}
                  autoFocus
                />
                <input
                  className="input"
                  placeholder={custom.kind === "adjust" ? "Why? (shows in the history)" : "Note (optional)"}
                  aria-label="Note"
                  maxLength={200}
                  value={custom.note}
                  onChange={(e) => setCustom({ ...custom, note: e.target.value })}
                />
              </div>
              <div className="wallet__actions">
                <button type="button" className="wallet__btn wallet__btn--soft" onClick={() => setCustom(null)}>
                  Cancel
                </button>
                <button type="submit" className="wallet__btn wallet__btn--pay" disabled={busy || !custom.amount}>
                  Save
                </button>
              </div>
            </form>
          )}

          {/* Promised one-offs */}
          {promised.length > 0 && (
            <section className="wallet__unit">
              <span className="wallet__form-title">Promised</span>
              {promised.map((p) => (
                <div key={p.id} className="wallet__promise">
                  <span>🎁 {p.title}</span>
                  {admin && (
                    <button type="button" className="wallet__btn wallet__btn--pay" disabled={busy} onClick={() => void give(p)}>
                      Mark given
                    </button>
                  )}
                </div>
              ))}
            </section>
          )}

          {!admin && surface === "board" && <p className="board-muted">A grown-up can unlock the board to use time or pay out.</p>}

          {/* History */}
          {mine.length > 0 && (
            <section className="wallet__history">
              <span className="wallet__form-title">History</span>
              <ul>
                {history.map((e) => (
                  <li key={e.id}>
                    <span className="wallet__line">{describeEntry(e, planTitle)}</span>
                    <span className="wallet__meta">
                      {when.format(new Date(e.created_at))}
                      {e.created_by && memberById(e.created_by) ? ` · ${memberById(e.created_by)!.display_name.split(" ")[0]}` : ""}
                    </span>
                    <span className={`wallet__delta ${Number(e.amount) < 0 ? "wallet__delta--out" : ""}`}>
                      {formatAmount(e.unit, Number(e.amount), true)}
                    </span>
                  </li>
                ))}
              </ul>
              {mine.length > history.length && (
                <button type="button" className="wallet__btn wallet__btn--soft" onClick={() => setShowAll(true)}>
                  Show all {mine.length}
                </button>
              )}
            </section>
          )}
        </div>
      </Sheet>
    </>
  );
}
