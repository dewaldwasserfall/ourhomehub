/**
 * Household → Home: the SmartThings connection and the devices it brings in
 * (TV, washer, dryer, Hue lights linked into SmartThings, ...).
 *
 *   * Owner: connect or disconnect SmartThings, turn on live updates, and
 *     choose which adults may manage Home.
 *   * Owner and those adults: see devices by room with their state, and
 *     "Update devices". Controls and automations come in the next steps.
 *   * Everyone else: a short "ask the owner" note.
 *
 * Device rows update live (home_devices is in the realtime publication).
 */
"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Avatar } from "@/components/avatar";
import { useHousehold } from "@/components/household-context";
import { ChevronLeftIcon, HomeIcon, RefreshIcon } from "@/components/icons";
import { Navbar } from "@/components/navbar";
import { useToast } from "@/components/toast";
import { friendlyError } from "@/lib/errors";
import { canManageHome, roleLabel } from "@/lib/roles";
import { deviceSummary } from "@/lib/smartthings/devices";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import type { HomeConnection, HomeDevice } from "@/lib/types";

/** Messages for ?st=... after the connect flow. */
const CONNECT_MESSAGES: Record<string, string> = {
  connected: "SmartThings is connected.",
  not_set_up: "SmartThings isn't set up yet: the app's client id and secret need adding in Vercel.",
  owner_only: "Only the owner can connect SmartThings.",
  state_mismatch: "That sign-in link had expired. Try connecting again.",
  cancelled: "Connecting was cancelled.",
  failed: "Couldn't connect SmartThings. Try again.",
};

const KIND_LABELS: Record<HomeDevice["kind"], string> = {
  tv: "TV",
  washer: "Washer",
  dryer: "Dryer",
  dishwasher: "Dishwasher",
  light: "Light",
  switch: "Switch",
  sensor: "Sensor",
  other: "Device",
};

const when = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function HomeSettings() {
  const supabase = getSupabaseBrowserClient();
  const { household, me, members } = useHousehold();
  const toast = useToast();
  const params = useSearchParams();
  const isOwner = me.role === "owner";
  const allowed = canManageHome(me);

  // Step 1: the connection and devices (live).
  const [connection, setConnection] = useState<HomeConnection | null>(null);
  const [devices, setDevices] = useState<HomeDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    const [c, d] = await Promise.all([
      supabase
        .from("home_connections")
        .select("household_id, location_name, status, last_error, last_synced_at, last_event_at, events_enabled, created_at")
        .maybeSingle<HomeConnection>(),
      supabase.from("home_devices").select("*").eq("present", true).order("name"),
    ]);
    setConnection(c.data ?? null);
    setDevices((d.data ?? []) as HomeDevice[]);
    setLoading(false);
  }, [supabase]);
  useEffect(() => {
    if (!allowed) return;
    load();
    const channel = supabase
      .channel(`home-devices:${household.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "home_devices", filter: `household_id=eq.${household.id}` }, () => load())
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [allowed, supabase, household.id, load]);

  // Step 2: the result of the connect flow, once.
  useEffect(() => {
    const status = params.get("st");
    if (status && CONNECT_MESSAGES[status]) toast.show(CONNECT_MESSAGES[status]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Step 3: actions.
  const [busy, setBusy] = useState<string | null>(null);
  async function post(path: string, body: object, okMessage: string) {
    setBusy(path);
    const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    setBusy(null);
    const data = (await res.json().catch(() => ({}))) as { message?: string };
    if (!res.ok) return void toast.show(data.message ?? "That didn't work. Try again.");
    toast.show(okMessage);
    await load();
  }
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  // Step 4: owner gives adults access.
  const [access, setAccess] = useState<Record<string, boolean>>(() => Object.fromEntries(members.map((m) => [m.id, canManageHome(m)])));
  async function toggleAccess(memberId: string, on: boolean) {
    setAccess((cur) => ({ ...cur, [memberId]: on }));
    const { error } = await supabase.rpc("set_home_access", { p_member_id: memberId, p_allowed: on });
    if (error) {
      setAccess((cur) => ({ ...cur, [memberId]: !on }));
      toast.show(friendlyError(error));
    }
  }

  // Step 5: devices by room.
  const rooms = useMemo(() => {
    const map = new Map<string, HomeDevice[]>();
    for (const d of devices) map.set(d.room ?? "No room", [...(map.get(d.room ?? "No room") ?? []), d]);
    return [...map.entries()].sort(([a], [b]) => (a === "No room" ? 1 : b === "No room" ? -1 : a.localeCompare(b)));
  }, [devices]);

  const back = (
    <Link href="/household" className="nav-button" aria-label="Back to Household">
      <ChevronLeftIcon size={22} />
      Household
    </Link>
  );

  if (!allowed) {
    return (
      <main className="screen">
        <Navbar title="Home" leading={back} />
        <section className="section">
          <div className="group empty">
            <span className="empty__title">Home is private</span>
            Ask {members.find((m) => m.role === "owner")?.display_name.split(" ")[0] ?? "the owner"} to give you access.
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="screen">
      <Navbar title="Home" leading={back} />

      {/* The connection */}
      <section className="section">
        <div className="section__header">
          <span className="section__header-title">SmartThings</span>
        </div>
        <div className="group">
          {loading ? (
            <div className="row">
              <span className="row__body row__subtitle">Loading…</span>
            </div>
          ) : connection ? (
            <>
              <div className="row">
                <span className="row__icon" style={{ background: connection.status === "active" ? "#15bef0" : "#ff3b30" }}>
                  <HomeIcon size={19} strokeWidth={2} />
                </span>
                <span className="row__body">
                  <span className="row__title">{connection.location_name ?? "Connected"}</span>
                  <span className="row__subtitle">
                    {connection.status === "error"
                      ? (connection.last_error ?? "Something went wrong")
                      : connection.last_synced_at
                        ? `Updated ${when.format(new Date(connection.last_synced_at))}`
                        : "Connected"}
                  </span>
                </span>
                <button
                  type="button"
                  className="nav-button nav-button--icon"
                  aria-label="Update devices"
                  disabled={!!busy}
                  onClick={() => post("/api/smartthings/sync", {}, "Devices updated.")}
                >
                  <RefreshIcon size={20} />
                </button>
              </div>
              <div className="row">
                <span className="row__body">
                  <span className="row__title">Live updates</span>
                  <span className="row__subtitle">
                    {connection.events_enabled
                      ? connection.last_event_at
                        ? `On · last change ${when.format(new Date(connection.last_event_at))}`
                        : "On · waiting for the first change"
                      : "Off · devices update when you tap refresh"}
                  </span>
                </span>
                {!connection.events_enabled && (
                  <button type="button" className="chip-button" disabled={!!busy} onClick={() => post("/api/smartthings/sync", { subscribe: true }, "Trying to turn on live updates…")}>
                    Turn on
                  </button>
                )}
              </div>
              {connection.status === "error" && isOwner && (
                <a className="row row--link" href="/api/smartthings/connect">
                  <span className="row__body row__title">Reconnect SmartThings</span>
                </a>
              )}
              {isOwner && (
                <button
                  type="button"
                  className="row row--pressable"
                  disabled={!!busy}
                  onClick={() => (confirmDisconnect ? post("/api/smartthings/disconnect", {}, "SmartThings disconnected.") : setConfirmDisconnect(true))}
                >
                  <span className="row__body row__title" style={{ color: "var(--red, #ff3b30)" }}>
                    {confirmDisconnect ? "Tap again to disconnect" : "Disconnect"}
                  </span>
                </button>
              )}
            </>
          ) : isOwner ? (
            <a className="row row--link" href="/api/smartthings/connect">
              <span className="row__icon" style={{ background: "#15bef0" }}>
                <HomeIcon size={19} strokeWidth={2} />
              </span>
              <span className="row__body">
                <span className="row__title">Connect SmartThings</span>
                <span className="row__subtitle">Sign in with Samsung and pick your home</span>
              </span>
            </a>
          ) : (
            <div className="row">
              <span className="row__body row__subtitle">Not connected yet. The owner connects SmartThings.</span>
            </div>
          )}
        </div>
        <p className="section__footer">
          Hue lights come in through SmartThings: add them in the SmartThings app under + → Add device → Philips Hue.
        </p>
      </section>

      {/* Devices */}
      {connection && (
        <section className="section">
          <div className="section__header">
            <span className="section__header-title">Devices</span>
          </div>
          {devices.length === 0 && <div className="group empty">No devices found in this home.</div>}
          {rooms.map(([room, list]) => (
            <div key={room} className="group" style={{ marginBottom: 12 }}>
              <div className="row supply-task-group">
                <span className="row__subtitle">{room}</span>
              </div>
              {list.map((d) => {
                const summary = deviceSummary(d.kind, d.state);
                return (
                  <div key={d.id} className="row">
                    <span className="row__body">
                      <span className="row__title">{d.name}</span>
                      <span className="row__subtitle">
                        {KIND_LABELS[d.kind]}
                        {summary ? ` · ${summary}` : ""}
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </section>
      )}

      {/* Owner: who manages Home */}
      {isOwner && (
        <section className="section">
          <div className="section__header">
            <span className="section__header-title">Who can manage Home</span>
          </div>
          <div className="group">
            {members
              .filter((m) => m.role !== "child")
              .map((m) => {
                const on = !!access[m.id];
                return (
                  <div key={m.id} className="row">
                    <Avatar member={m} size="mini" />
                    <span className="row__body">
                      <span className="row__title">{m.display_name}</span>
                      <span className="row__subtitle">{roleLabel(m.role)}</span>
                    </span>
                    <button
                      type="button"
                      role="switch"
                      className="switch"
                      aria-label={`${m.display_name} can manage Home`}
                      aria-checked={on}
                      disabled={m.role === "owner"}
                      onClick={() => toggleAccess(m.id, !on)}
                    />
                  </div>
                );
              })}
          </div>
          <p className="section__footer">They can see and control devices and build automations. Kids never can.</p>
        </section>
      )}
      {toast.node}
    </main>
  );
}

export default function HomeSettingsPage() {
  return (
    <Suspense>
      <HomeSettings />
    </Suspense>
  );
}
