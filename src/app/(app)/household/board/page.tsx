/**
 * Family board settings (adults): pair a wall tablet and see or remove the
 * boards that are paired.
 *
 * Pairing: "Pair a tablet" makes an 8-digit code valid for 10 minutes. On the
 * tablet, open ourhomehub.nl/board and type it. The tablet then shows the
 * household's day and lets anyone tick things off; kids' ticks wait for a
 * grown-up to confirm them on Today.
 */
"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useHousehold } from "@/components/household-context";
import { ChevronLeftIcon, TabletIcon } from "@/components/icons";
import { Navbar } from "@/components/navbar";
import { useToast } from "@/components/toast";
import { friendlyError } from "@/lib/errors";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

interface Board {
  id: string;
  name: string;
  created_at: string;
  last_seen_at: string | null;
}

const shortDate = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });

export default function BoardSettingsPage() {
  const supabase = getSupabaseBrowserClient();
  const { meIsAdult } = useHousehold();
  const toast = useToast();
  const [boards, setBoards] = useState<Board[]>([]);
  const [code, setCode] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  // Step 1: the paired boards.
  const load = useCallback(async () => {
    const { data } = await supabase.from("boards").select("id, name, created_at, last_seen_at").order("created_at");
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
      {toast.node}
    </main>
  );
}
