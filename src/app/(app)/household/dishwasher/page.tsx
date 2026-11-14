/**
 * Household → Dishwasher: the AEG dishwasher via the Electrolux Group API.
 *
 *   * Owner, not connected: paste the API key, access token and refresh
 *     token from developer.electrolux.one (sent once to the server, kept in
 *     Vault, never shown again).
 *   * Connected: its state, last check, the "Empty the dishwasher" switch,
 *     and Disconnect (owner).
 *   * Everyone else: the state only.
 */
"use client";

import Link from "next/link";
import { useState } from "react";
import { useHousehold } from "@/components/household-context";
import { ChevronLeftIcon } from "@/components/icons";
import { Navbar } from "@/components/navbar";
import { useToast } from "@/components/toast";
import { dishwasherLine } from "@/components/dishwasher-card";
import { friendlyError } from "@/lib/errors";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useAppliance } from "@/lib/use-appliance";

const when = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

const STATE_LABELS: Record<string, string> = {
  OFF: "Off",
  IDLE: "Idle",
  READY_TO_START: "Ready to start",
  DELAYED_START: "Starts later",
  RUNNING: "Running",
  PAUSED: "Paused",
  END_OF_CYCLE: "Done",
};

export default function DishwasherPage() {
  const supabase = getSupabaseBrowserClient();
  const { household, me } = useHousehold();
  const toast = useToast();
  const isOwner = me.role === "owner";
  const { appliance, loading, reload } = useAppliance(household.id);

  // Step 1: the connect form (owner).
  const [apiKey, setApiKey] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [refreshToken, setRefreshToken] = useState("");
  const [busy, setBusy] = useState(false);
  async function connect(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const res = await fetch("/api/appliances/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey, accessToken, refreshToken }),
    });
    const data = (await res.json().catch(() => ({}))) as { message?: string; name?: string };
    setBusy(false);
    if (!res.ok) return void toast.show(data.message ?? "Couldn't connect. Try again.");
    // Step 1a: clear the secrets from the page straight away.
    setApiKey("");
    setAccessToken("");
    setRefreshToken("");
    toast.show(`Connected: ${data.name ?? "dishwasher"}`);
    await reload();
  }

  // Step 2: settings and disconnect.
  async function setAutoTask(on: boolean) {
    const { error } = await supabase.rpc("set_appliance_auto_task", { p_on: on });
    if (error) toast.show(friendlyError(error));
    await reload();
  }
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  async function disconnect() {
    if (!confirmDisconnect) return setConfirmDisconnect(true);
    const res = await fetch("/api/appliances/disconnect", { method: "POST" });
    setConfirmDisconnect(false);
    if (!res.ok) return void toast.show("Couldn't disconnect. Try again.");
    toast.show("Dishwasher disconnected.");
    await reload();
  }

  const back = (
    <Link href="/household" className="nav-button" aria-label="Back to Household">
      <ChevronLeftIcon size={22} />
      Household
    </Link>
  );
  const line = appliance ? dishwasherLine(appliance.state, appliance.cycle_phase, appliance.ends_at, new Date()) : null;

  return (
    <main className="screen">
      <Navbar title="Dishwasher" leading={back} />

      {loading ? null : appliance ? (
        <>
          {/* Status */}
          <section className="section">
            <div className="group">
              <div className="row">
                <span className="row__body">
                  <span className="row__title">{appliance.appliance_name || "Dishwasher"}</span>
                  <span className="row__subtitle">
                    {appliance.status === "error"
                      ? (appliance.last_error ?? "Something went wrong")
                      : (line ?? STATE_LABELS[appliance.state ?? ""] ?? "Waiting for the first check")}
                  </span>
                </span>
              </div>
              <div className="row">
                <span className="row__body">
                  <span className="row__subtitle">
                    {appliance.last_polled_at ? `Checked ${when.format(new Date(appliance.last_polled_at))}` : "Not checked yet"}
                    {appliance.last_run_ended_at ? ` · last run finished ${when.format(new Date(appliance.last_run_ended_at))}` : ""}
                  </span>
                </span>
              </div>
            </div>
            <p className="section__footer">HomeHub checks every 5 minutes; the time left counts down in between.</p>
          </section>

          {/* The to-do */}
          <section className="section">
            <div className="group">
              <div className="row">
                <span className="row__body">
                  <span className="row__title">Add &ldquo;Empty the dishwasher&rdquo;</span>
                  <span className="row__subtitle">When a run finishes, for anyone to tick off</span>
                </span>
                <button
                  type="button"
                  role="switch"
                  className="switch"
                  aria-label="Add Empty the dishwasher when a run finishes"
                  aria-checked={appliance.auto_task}
                  disabled={!isOwner}
                  onClick={() => setAutoTask(!appliance.auto_task)}
                />
              </div>
            </div>
          </section>

          {/* Reconnect or disconnect (owner) */}
          {isOwner && (
            <section className="section">
              <div className="group">
                <button type="button" className="row row--pressable" onClick={disconnect}>
                  <span className="row__body row__title" style={{ color: "var(--red, #ff3b30)" }}>
                    {confirmDisconnect ? "Tap again to disconnect" : "Disconnect"}
                  </span>
                </button>
              </div>
              {appliance.status === "error" && (
                <p className="section__footer">To reconnect: disconnect, make a new token on developer.electrolux.one and connect again.</p>
              )}
            </section>
          )}
        </>
      ) : isOwner ? (
        /* Connect (owner) */
        <form className="section" onSubmit={connect} autoComplete="off">
          <div className="section__header">
            <span className="section__header-title">Connect your AEG dishwasher</span>
          </div>
          <div className="group">
            {(
              [
                ["API key", apiKey, setApiKey],
                ["Access token", accessToken, setAccessToken],
                ["Refresh token", refreshToken, setRefreshToken],
              ] as const
            ).map(([label, value, set]) => (
              <label key={label} className="form-row">
                <span className="form-row__label">{label}</span>
                <input
                  type="password"
                  className="pill-input"
                  style={{ flex: 1, minWidth: 0 }}
                  value={value}
                  onChange={(e) => set(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
            ))}
          </div>
          <p className="section__footer">
            From developer.electrolux.one (signed in with your My AEG account). They go to HomeHub&rsquo;s server once and are kept encrypted; nobody
            sees them again.
          </p>
          <div style={{ padding: "0 16px" }}>
            <button type="submit" className="button button--primary" disabled={busy || !apiKey.trim() || !refreshToken.trim()}>
              {busy ? "Connecting…" : "Connect"}
            </button>
          </div>
        </form>
      ) : (
        <section className="section">
          <div className="group empty">Not connected yet. The owner connects the dishwasher.</div>
        </section>
      )}
      {toast.node}
    </main>
  );
}
