/**
 * "Family calendar" card on the Household tab.
 *
 * Shows whether the shared Google Calendar is connected and when it last
 * synced. Owners get Connect / Reconnect / Disconnect; everyone else sees the
 * status only.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { describeAgo } from "@/lib/rhythm";
import { calendarApi } from "@/lib/calendar/use-calendar";
import type { CalendarConnectionStatus } from "@/lib/calendar/types";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { CalendarIcon } from "./icons";

/** Outcomes the OAuth callback sends back as ?calendar=<code>. */
const OUTCOMES: Record<string, { text: string; error?: boolean }> = {
  connected: { text: "Family calendar connected. Events now sync both ways." },
  cancelled: { text: "Connecting was cancelled. Nothing changed.", error: true },
  failed: { text: "Google didn't complete the connection. Try again.", error: true },
  owner_only: { text: "Only the household owner can connect the calendar.", error: true },
  no_refresh_token: { text: "Google didn't grant lasting access. Try connecting again.", error: true },
  missing_permission: {
    text: "Tick the box that lets Household Hub see and edit calendar events, then try again.",
    error: true,
  },
};

/** "2 minutes ago", "3 hours ago", else the rhythm wording ("yesterday"). */
function syncedAgo(iso: string | null): string {
  if (!iso) return "not synced yet";
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "synced just now";
  if (minutes < 60) return `synced ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `synced ${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `synced ${describeAgo(iso)}`;
}

export function FamilyCalendarCard({ isOwner, ownerName }: { isOwner: boolean; ownerName: string }) {
  const supabase = getSupabaseBrowserClient();
  const [status, setStatus] = useState<CalendarConnectionStatus | null | undefined>(undefined);
  const [outcome, setOutcome] = useState<{ text: string; error?: boolean } | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [busy, setBusy] = useState(false);

  // Step 1: load the connection summary.
  const load = useCallback(async () => {
    const { data } = await supabase.rpc("calendar_connection_status");
    setStatus(((data ?? []) as CalendarConnectionStatus[])[0] ?? null);
  }, [supabase]);

  // Step 2: show the result of a connect attempt, then tidy the address bar.
  useEffect(() => {
    load();
    const params = new URLSearchParams(window.location.search);
    const code = params.get("calendar");
    if (code) {
      setOutcome(OUTCOMES[code] ?? OUTCOMES.failed);
      params.delete("calendar");
      const qs = params.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
    }
  }, [load]);

  // Step 3: disconnect needs a second tap to confirm.
  async function disconnect() {
    if (!confirmDisconnect) {
      setConfirmDisconnect(true);
      return;
    }
    setBusy(true);
    const result = await calendarApi("/api/calendar/disconnect", "POST");
    setBusy(false);
    setConfirmDisconnect(false);
    setOutcome(result.ok ? { text: "Family calendar disconnected. Nothing in Google Calendar was changed." } : { text: result.message ?? "Couldn't disconnect.", error: true });
    load();
  }

  return (
    <section className="section">
      <div className="section__header">
        <span className="section__header-title">Family calendar</span>
      </div>

      <div className="group">
        {status === undefined && <div className="skeleton" style={{ height: 64 }} />}

        {status === null && (
          <div className="row" style={{ alignItems: "flex-start" }}>
            <span className="row__icon" style={{ background: "#0a84ff" }}>
              <CalendarIcon size={19} strokeWidth={2} />
            </span>
            <span className="row__body">
              <span className="row__title">Not connected</span>
              <span className="row__subtitle">
                {isOwner
                  ? "Connect the shared Google Calendar once and everyone sees it on the Calendar tab."
                  : `${ownerName} can connect the shared Google Calendar on this tab.`}
              </span>
            </span>
          </div>
        )}

        {status && (
          <div className="row" style={{ alignItems: "flex-start" }}>
            <span className="row__icon" style={{ background: "#0a84ff" }}>
              <CalendarIcon size={19} strokeWidth={2} />
            </span>
            <span className="row__body">
              <span className="row__title">
                <span className={`status-dot ${status.status === "error" ? "status-dot--error" : ""}`} aria-hidden="true" />
                {status.status === "error" ? "Needs reconnecting" : "Connected"}
              </span>
              <span className="row__subtitle">
                {status.google_email}, {syncedAgo(status.last_synced_at)}
              </span>
            </span>
          </div>
        )}
      </div>

      {/* Owner actions */}
      {isOwner && status !== undefined && (
        <div className="stack-sm" style={{ marginTop: 12 }}>
          {status === null || status.status === "error" ? (
            // A full page navigation: Google's consent screen can't load in a frame.
            <a className="button button--primary" href="/api/calendar/connect">
              {status ? "Reconnect family calendar" : "Connect family calendar"}
            </a>
          ) : (
            <a className="button button--secondary" href="/api/calendar/connect">
              Reconnect
            </a>
          )}
          {status && (
            <button type="button" className="button button--danger" onClick={disconnect} disabled={busy}>
              {confirmDisconnect ? "Tap again to disconnect" : "Disconnect"}
            </button>
          )}
        </div>
      )}

      {outcome && (
        <p className={outcome.error ? "form-error" : "section__footer"} role="status">
          {outcome.text}
        </p>
      )}
      {isOwner && status === null && !outcome && (
        <p className="section__footer">
          Sign in to Google as wasserfallfamilie@gmail.com when asked. Only the family calendar is synced.
        </p>
      )}
    </section>
  );
}
