/**
 * Pairing screen for a new Family board.
 *
 * An adult opens Household → Family board on their phone, taps "Pair a
 * tablet" and reads out the 8-digit code; it's typed here. On success the
 * tablet is signed in as the board and the page reloads into the board.
 */
"use client";

import { useState } from "react";

export function BoardPair() {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const digits = code.replace(/\D/g, "").slice(0, 8);

  // Step 1: send the code; the server signs this tablet in.
  async function pair(e: React.FormEvent) {
    e.preventDefault();
    if (digits.length !== 8 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/board/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: digits }),
      });
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) {
        setError(body.message ?? "That didn't work. Try again.");
        setBusy(false);
        return;
      }
      // Step 2: a full reload, so the server renders the board with the new session.
      window.location.replace("/board");
    } catch {
      setError("No connection. Check the Wi-Fi and try again.");
      setBusy(false);
    }
  }

  return (
    <main className="board-pair">
      <form className="board-pair__card" onSubmit={pair}>
        <h1 className="board-pair__title">Set up the Family board</h1>
        <p className="board-pair__text">
          On a grown-up&rsquo;s phone, open <strong>Household → Family board</strong> and tap <strong>Pair a tablet</strong>. Type the code
          it shows.
        </p>
        <input
          className="board-pair__code"
          inputMode="numeric"
          autoComplete="one-time-code"
          aria-label="Pairing code"
          placeholder="0000 0000"
          value={digits.length > 4 ? `${digits.slice(0, 4)} ${digits.slice(4)}` : digits}
          onChange={(e) => setCode(e.target.value)}
          autoFocus
        />
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="button button--primary" disabled={digits.length !== 8 || busy}>
          {busy ? "Pairing…" : "Pair"}
        </button>
      </form>
    </main>
  );
}
