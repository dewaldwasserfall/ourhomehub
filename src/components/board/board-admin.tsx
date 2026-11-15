/**
 * Admin mode on the Family board.
 *
 *   * The 🔒 button in the top bar opens a PIN pad. A parent's own PIN (set
 *     on their phone under Household → Family board) unlocks the board as
 *     them: "+ Grocery", "+ To-do" and confirming the kids' waiting ticks.
 *   * It locks again after the board's auto-lock time without a tap
 *     (default 2 minutes), or on 🔓.
 *   * The database is the real gate: every admin action checks the unlock
 *     session there (see 20261115000200_board_admin.sql). This file only
 *     keeps the screen in step with it.
 */
"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Avatar } from "@/components/avatar";
import { useHousehold } from "@/components/household-context";
import { LockIcon, UnlockIcon } from "@/components/icons";
import { Sheet } from "@/components/sheet";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import type { Member } from "@/lib/types";

/** Push the server's end time out at most this often while tapping. */
const TOUCH_EVERY_MS = 30_000;

interface BoardAdmin {
  /** The parent who unlocked the board, or null when locked. */
  admin: Member | null;
  /** Open the PIN pad. */
  openPad: () => void;
  /** Lock now. */
  lock: () => void;
  /**
   * Call with an admin RPC's error message: when the database says the board
   * is locked, the screen locks too. Returns the message to show.
   */
  adminError: (message: string) => string;
}

const BoardAdminContext = createContext<BoardAdmin>({
  admin: null,
  openPad: () => {},
  lock: () => {},
  adminError: (m) => m,
});

export const useBoardAdmin = () => useContext(BoardAdminContext);

/** The answer from board_unlock(). */
interface UnlockAnswer {
  ok: boolean;
  error?: "wrong_pin" | "blocked";
  left?: number;
  until?: string;
  member_id?: string;
  minutes?: number;
}

export function BoardAdminProvider({ children }: { children: React.ReactNode }) {
  const supabase = getSupabaseBrowserClient();
  const { memberById } = useHousehold();

  // Step 1: the session as the screen sees it.
  const [adminId, setAdminId] = useState<string | null>(null);
  const minutes = useRef(2);
  const lockTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastTouch = useRef(0);

  const lock = useCallback(() => {
    clearTimeout(lockTimer.current);
    setAdminId(null);
    void supabase.rpc("board_lock");
  }, [supabase]);

  // 1a. (Re)start the auto-lock countdown.
  const armTimer = useCallback(() => {
    clearTimeout(lockTimer.current);
    lockTimer.current = setTimeout(lock, minutes.current * 60_000);
  }, [lock]);

  // 1b. While unlocked, every tap restarts the countdown here, and (every
  //     30 s at most) on the server too.
  useEffect(() => {
    if (!adminId) return;
    const onTap = () => {
      armTimer();
      if (Date.now() - lastTouch.current < TOUCH_EVERY_MS) return;
      lastTouch.current = Date.now();
      void supabase.rpc("board_touch").then(({ data }) => {
        if (data === null) lock(); // the server already locked it
      });
    };
    window.addEventListener("pointerdown", onTap, { passive: true });
    return () => window.removeEventListener("pointerdown", onTap);
  }, [adminId, armTimer, supabase, lock]);
  useEffect(() => () => clearTimeout(lockTimer.current), []);

  const adminError = useCallback(
    (message: string) => {
      if (message.includes("board_locked")) {
        lock();
        return "The board locked itself. Unlock it again.";
      }
      return message;
    },
    [lock],
  );

  // Step 2: the PIN pad.
  const [padOpen, setPadOpen] = useState(false);
  const [pin, setPin] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const openPad = useCallback(() => {
    setPin("");
    setNote(null);
    setPadOpen(true);
  }, []);

  async function submit(value: string) {
    if (value.length < 4 || busy) return;
    setBusy(true);
    const { data, error } = await supabase.rpc("board_unlock", { p_pin: value });
    setBusy(false);
    setPin("");
    if (error) return void setNote("Couldn't check the PIN. Try again.");
    const answer = data as UnlockAnswer;
    if (answer.ok && answer.member_id) {
      minutes.current = answer.minutes ?? 2;
      lastTouch.current = Date.now();
      setAdminId(answer.member_id);
      armTimer();
      setPadOpen(false);
      return;
    }
    if (answer.error === "blocked") {
      const until = answer.until ? new Date(answer.until) : null;
      const mins = until ? Math.max(1, Math.ceil((until.getTime() - Date.now()) / 60_000)) : 5;
      return void setNote(`Too many wrong PINs. Try again in ${mins} minute${mins === 1 ? "" : "s"}.`);
    }
    setNote(answer.left === 1 ? "Wrong PIN. 1 try left." : `Wrong PIN. ${answer.left ?? ""} tries left.`);
  }

  const press = (digit: string) => {
    setNote(null);
    setPin((p) => (p.length < 6 ? p + digit : p));
  };

  const admin = adminId ? (memberById(adminId) ?? null) : null;

  return (
    <BoardAdminContext.Provider value={{ admin, openPad, lock, adminError }}>
      {children}
      <Sheet open={padOpen} onClose={() => setPadOpen(false)} title="Unlock the board">
        <div className="board-pin">
          <p className="board-muted">Grown-ups: type your board PIN.</p>
          <div className="board-pin__dots" aria-label={`${pin.length} digits typed`}>
            {Array.from({ length: 6 }, (_, i) => (
              <span key={i} className={`board-pin__dot ${i < pin.length ? "board-pin__dot--on" : ""} ${i >= 4 ? "board-pin__dot--extra" : ""}`} />
            ))}
          </div>
          <p className="board-pin__note" role="status">
            {note ?? ""}
          </p>
          <div className="board-pin__pad">
            {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
              <button key={d} type="button" className="board-pin__key" onClick={() => press(d)} disabled={busy}>
                {d}
              </button>
            ))}
            <button type="button" className="board-pin__key board-pin__key--soft" onClick={() => setPin((p) => p.slice(0, -1))} disabled={busy}>
              Delete
            </button>
            <button type="button" className="board-pin__key" onClick={() => press("0")} disabled={busy}>
              0
            </button>
            <button
              type="button"
              className="board-pin__key board-pin__key--go"
              onClick={() => submit(pin)}
              disabled={busy || pin.length < 4}
            >
              Unlock
            </button>
          </div>
        </div>
      </Sheet>
    </BoardAdminContext.Provider>
  );
}

/** The 🔒 / 🔓 button in the board's top bar. */
export function BoardLockButton() {
  const { admin, openPad, lock } = useBoardAdmin();
  if (!admin) {
    return (
      <button type="button" className="board-lock" onClick={openPad} aria-label="Unlock admin mode">
        <LockIcon size={22} />
      </button>
    );
  }
  return (
    <button type="button" className="board-lock board-lock--open" onClick={lock} aria-label={`Lock (unlocked by ${admin.display_name})`}>
      <Avatar member={admin} size="mini" />
      <span>{admin.display_name.split(" ")[0]}</span>
      <UnlockIcon size={20} />
      <span className="board-lock__hint">Lock</span>
    </button>
  );
}
