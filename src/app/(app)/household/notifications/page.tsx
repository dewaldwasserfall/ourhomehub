/**
 * Notifications: turn them on for this device, choose what you get, send a
 * test. Everyone has their own settings (children included).
 */
"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useHousehold } from "@/components/household-context";
import { ChevronLeftIcon } from "@/components/icons";
import { Navbar } from "@/components/navbar";
import { useToast } from "@/components/toast";
import { calendarApi } from "@/lib/calendar/use-calendar";
import { friendlyError } from "@/lib/errors";
import { defaultPrefs, type Prefs } from "@/lib/notify/due";
import { currentSubscription, disablePush, enablePush, pushSupport, type PushSupport } from "@/lib/push/client";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

/** A label-and-switch row. */
function SwitchRow({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="form-row">
      <span>
        <span className="form-row__label">{label}</span>
        {hint && <span className="row__subtitle">{hint}</span>}
      </span>
      <button type="button" role="switch" aria-checked={checked} aria-label={label} className="switch" onClick={() => onChange(!checked)} />
    </div>
  );
}

/** A label and a time picker, shown under a switch that's on. */
function TimeRow({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="form-row">
      <span className="form-row__label" style={{ color: "var(--ink-2)" }}>
        {label}
      </span>
      <input type="time" className="pill-input" style={{ width: 110 }} value={value.slice(0, 5)} onChange={(e) => e.target.value && onChange(e.target.value)} />
    </label>
  );
}

export default function NotificationsPage() {
  const supabase = getSupabaseBrowserClient();
  const { me, household, meIsAdult } = useHousehold();
  const toast = useToast();

  const [support, setSupport] = useState<PushSupport | null>(null);
  const [onHere, setOnHere] = useState<boolean | null>(null);
  const [deviceCount, setDeviceCount] = useState(0);
  const [prefs, setPrefs] = useState<Prefs>(defaultPrefs(me.role));
  const [busy, setBusy] = useState(false);

  // Step 1: this device's state, my other devices, and my saved preferences.
  const load = useCallback(async () => {
    setSupport(pushSupport());
    const [sub, devices, saved] = await Promise.all([
      currentSubscription().catch(() => null),
      supabase.from("push_subscriptions").select("endpoint"),
      supabase.from("notification_prefs").select("*").eq("member_id", me.id).maybeSingle<Prefs>(),
    ]);
    const endpoints = ((devices.data ?? []) as Array<{ endpoint: string }>).map((d) => d.endpoint);
    setOnHere(!!sub && endpoints.includes(sub.endpoint));
    setDeviceCount(endpoints.length);
    if (saved.data) setPrefs({ ...defaultPrefs(me.role), ...saved.data });
  }, [supabase, me.id, me.role]);

  useEffect(() => {
    load();
  }, [load]);

  // Step 2: on / off for this device.
  async function turnOn() {
    setBusy(true);
    const message = await enablePush();
    setBusy(false);
    if (message) return void toast.show(message);
    // Save the defaults, so the server and this screen agree from now on.
    await savePrefs(prefs);
    await load();
    toast.show("Notifications are on for this device");
  }

  async function turnOff() {
    setBusy(true);
    await disablePush();
    setBusy(false);
    await load();
  }

  async function sendTest() {
    const r = await calendarApi<{ reached: number }>("/api/notify/test", "POST");
    toast.show(r.ok ? "Sent. It should arrive in a few seconds." : (r.message ?? "Couldn't send the test."));
  }

  // Step 3: preferences save as you change them.
  async function savePrefs(next: Prefs) {
    setPrefs(next);
    const { error } = await supabase
      .from("notification_prefs")
      .upsert({ ...next, member_id: me.id, household_id: household.id, updated_at: new Date().toISOString() });
    if (error) toast.show(friendlyError(error));
  }
  const set = <K extends keyof Prefs>(key: K, value: Prefs[K]) => savePrefs({ ...prefs, [key]: value });

  return (
    <main className="screen">
      <Navbar
        title="Notifications"
        leading={
          <Link href="/household" className="nav-button" aria-label="Back to Household">
            <ChevronLeftIcon size={22} />
            Household
          </Link>
        }
      />

      {/* This device */}
      <section className="section">
        <div className="section__header">
          <span className="section__header-title">This device</span>
          {deviceCount > 0 && <span>{deviceCount === 1 ? "1 device on" : `${deviceCount} devices on`}</span>}
        </div>
        {support === "needs-home-screen" && (
          <div className="notice">
            On iPhone, notifications only work when HomeHub is opened from the Home Screen. In Safari, tap Share, then
            Add to Home Screen, open HomeHub from there and come back to this page.
          </div>
        )}
        {support === "unsupported" && <div className="notice">This browser can&rsquo;t show notifications.</div>}
        {support === "supported" && onHere !== null && (
          <div className="stack-sm">
            {onHere ? (
              <>
                <button type="button" className="button button--secondary" onClick={sendTest}>
                  Send a test notification
                </button>
                <button type="button" className="button button--plain" onClick={turnOff} disabled={busy}>
                  Turn off for this device
                </button>
              </>
            ) : (
              <button type="button" className="button button--primary" onClick={turnOn} disabled={busy}>
                Turn on notifications
              </button>
            )}
          </div>
        )}
      </section>

      {/* What to send */}
      <section className="section">
        <div className="section__header">
          <span className="section__header-title">Send me</span>
        </div>
        <div className="group">
          <SwitchRow
            label="Calendar reminders"
            hint={prefs.events ? `${prefs.event_lead_minutes} minutes before each event` : "Family calendar events"}
            checked={prefs.events}
            onChange={(v) => set("events", v)}
          />
          {prefs.events && (
            <label className="form-row">
              <span className="form-row__label" style={{ color: "var(--ink-2)" }}>
                Minutes before
              </span>
              <select
                className="pill-input"
                value={prefs.event_lead_minutes}
                onChange={(e) => set("event_lead_minutes", Number(e.target.value))}
              >
                {[10, 15, 30, 45, 60, 90, 120].map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        <div className="group" style={{ marginTop: 12 }}>
          <SwitchRow
            label="Morning summary"
            hint="To-dos and chores due today"
            checked={prefs.digest}
            onChange={(v) => set("digest", v)}
          />
          {prefs.digest && <TimeRow label="At" value={prefs.digest_time} onChange={(v) => set("digest_time", v)} />}
        </div>

        <div className="group" style={{ marginTop: 12 }}>
          <SwitchRow
            label="Routine reminder"
            hint="Only if steps are still open"
            checked={prefs.routine_nudge}
            onChange={(v) => set("routine_nudge", v)}
          />
          {prefs.routine_nudge && (
            <TimeRow label="At" value={prefs.routine_nudge_time} onChange={(v) => set("routine_nudge_time", v)} />
          )}
        </div>

        <div className="group" style={{ marginTop: 12 }}>
          <SwitchRow
            label="Bins, the evening before"
            hint="What goes out tonight"
            checked={prefs.bins}
            onChange={(v) => set("bins", v)}
          />
          {prefs.bins && <TimeRow label="At" value={prefs.bins_time} onChange={(v) => set("bins_time", v)} />}
          <SwitchRow
            label="Bins, on the morning"
            hint="What goes out today"
            checked={prefs.bins_morning}
            onChange={(v) => set("bins_morning", v)}
          />
          {prefs.bins_morning && (
            <TimeRow label="At" value={prefs.bins_morning_time} onChange={(v) => set("bins_morning_time", v)} />
          )}
        </div>

        {meIsAdult && (
          <div className="group" style={{ marginTop: 12 }}>
            <SwitchRow
              label="Shopping list changes"
              hint="When someone else adds to a shopping list"
              checked={prefs.list_added}
              onChange={(v) => set("list_added", v)}
            />
            <SwitchRow
              label="Week review"
              hint="Sunday at 19:00: what got done and next week's bins"
              checked={prefs.weekly_review}
              onChange={(v) => set("weekly_review", v)}
            />
          </div>
        )}
        <p className="section__footer">
          These are just for you. Reminders arrive on every device where you turned notifications on.
        </p>
      </section>
      {toast.node}
    </main>
  );
}
