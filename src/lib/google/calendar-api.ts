/**
 * Minimal Google Calendar API v3 client (server only), using plain fetch so
 * the app doesn't need the large googleapis package.
 */
import type { GoogleEvent } from "@/lib/calendar/types";

const BASE = "https://www.googleapis.com/calendar/v3";

/** A failed Google call; `status` 410 means the sync token expired. */
export class GoogleApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Drop null and undefined keys (Google treats them as unset on insert). */
export function stripNulls<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripNulls) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => [k, stripNulls(v)]),
    ) as T;
  }
  return value;
}

async function call<T>(accessToken: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new GoogleApiError(res.status, `Google Calendar ${init.method ?? "GET"} ${path} failed: ${res.status} ${text.slice(0, 300)}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const cal = (calendarId: string) => `/calendars/${encodeURIComponent(calendarId)}`;

// -----------------------------------------------------------------------------
// Events
// -----------------------------------------------------------------------------

export interface EventsPage {
  items?: GoogleEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
  timeZone?: string;
}

/**
 * One page of events. With no syncToken: everything (a full sync).
 * With a syncToken: only what changed since that token.
 * singleEvents stays false: series come as one master plus exceptions.
 */
export function listEvents(accessToken: string, calendarId: string, opts: { syncToken?: string | null; pageToken?: string }) {
  const params = new URLSearchParams({ maxResults: "2500", singleEvents: "false" });
  if (opts.syncToken) params.set("syncToken", opts.syncToken);
  if (opts.pageToken) params.set("pageToken", opts.pageToken);
  return call<EventsPage>(accessToken, `${cal(calendarId)}/events?${params}`);
}

export function insertEvent(accessToken: string, calendarId: string, body: Record<string, unknown>) {
  return call<GoogleEvent>(accessToken, `${cal(calendarId)}/events`, {
    method: "POST",
    body: JSON.stringify(stripNulls(body)),
  });
}

export function patchEvent(accessToken: string, calendarId: string, eventId: string, body: Record<string, unknown>) {
  return call<GoogleEvent>(accessToken, `${cal(calendarId)}/events/${encodeURIComponent(eventId)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function deleteEvent(accessToken: string, calendarId: string, eventId: string) {
  return call<void>(accessToken, `${cal(calendarId)}/events/${encodeURIComponent(eventId)}`, { method: "DELETE" });
}

/** The calendar's own time zone (used for events that don't name one). */
export function getCalendar(accessToken: string, calendarId: string) {
  return call<{ id: string; timeZone?: string; summary?: string }>(accessToken, cal(calendarId));
}

// -----------------------------------------------------------------------------
// Push notifications
// -----------------------------------------------------------------------------

export interface Channel {
  id: string;
  resourceId: string;
  expiration?: string; // ms since epoch, as a string
}

/** Ask Google to POST to `address` whenever the calendar's events change. */
export function watchEvents(accessToken: string, calendarId: string, channel: { id: string; token: string; address: string }) {
  return call<Channel>(accessToken, `${cal(calendarId)}/events/watch`, {
    method: "POST",
    body: JSON.stringify({ id: channel.id, type: "web_hook", address: channel.address, token: channel.token }),
  });
}

/** Stop a channel (on renew or disconnect). Best effort: it expires anyway. */
export async function stopChannel(accessToken: string, channelId: string, resourceId: string): Promise<void> {
  await call<void>(accessToken, "/channels/stop", {
    method: "POST",
    body: JSON.stringify({ id: channelId, resourceId }),
  }).catch(() => undefined);
}
