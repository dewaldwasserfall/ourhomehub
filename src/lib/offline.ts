/**
 * Offline mode: a local copy of what was last loaded, and a queue (outbox) of
 * changes made without a connection.
 *
 *   * readCache / writeCache   the last good copy of a screen's data, per
 *                              device (localStorage), shown when offline
 *   * enqueue / flushOutbox    ticks and additions made offline wait here and
 *                              are sent in order once the connection is back
 *   * isNetworkError           tells "no connection" apart from a refusal
 *
 * Only safe, repeatable actions are queued (ticking off, adding a line):
 * replaying them twice can't do damage. Anything else needs a connection.
 * Everything here is per device and cleared on sign-out (clearOfflineData).
 */
"use client";

import { getSupabaseBrowserClient } from "./supabase/client";

const CACHE_PREFIX = "hh-cache:";
const OUTBOX_KEY = "hh-outbox";
/** Fired on window whenever the queue changes or has been sent. */
export const OUTBOX_EVENT = "hh-outbox-change";
/** Fired on window after queued changes were sent, so screens reload. */
export const SYNCED_EVENT = "hh-synced";

// -----------------------------------------------------------------------------
// Step 1: the local copy
// -----------------------------------------------------------------------------

export function readCache<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    return raw ? (JSON.parse(raw) as { data: T }).data : null;
  } catch {
    return null;
  }
}

export function writeCache<T>(key: string, data: T) {
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ data, at: Date.now() }));
  } catch {
    // Storage full or unavailable: offline copies are a nice-to-have.
  }
}

/** "Failed to fetch" (Chrome), "Load failed" (Safari), "NetworkError" (Firefox). */
export function isNetworkError(error: unknown): boolean {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  const message = String((error as { message?: string } | null)?.message ?? error ?? "");
  return /failed to fetch|load failed|networkerror|network request failed/i.test(message);
}

// -----------------------------------------------------------------------------
// Step 2: the outbox
// -----------------------------------------------------------------------------

export type OutboxOp =
  | { type: "set_status"; entryId: string; status: "open" | "done" }
  | { type: "add_entry"; listId: string; text: string; quantity: string | null; category: string | null }
  | { type: "set_completion"; kind: "step" | "zone_task" | "chore"; itemId: string; forDate: string; done: boolean };

interface QueuedOp {
  id: string;
  op: OutboxOp;
  queuedAt: number;
}

function readOutbox(): QueuedOp[] {
  try {
    return JSON.parse(localStorage.getItem(OUTBOX_KEY) ?? "[]") as QueuedOp[];
  } catch {
    return [];
  }
}

function writeOutbox(queue: QueuedOp[]) {
  try {
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(queue));
  } catch {
    // Nothing more we can do; the change stays visible until reload.
  }
  window.dispatchEvent(new Event(OUTBOX_EVENT));
}

export function pendingCount(): number {
  return typeof window === "undefined" ? 0 : readOutbox().length;
}

/**
 * Queue a change. Ticking the same line twice keeps only the latest tick, so
 * the queue never replays an outdated state.
 */
export function enqueue(op: OutboxOp) {
  const queue = readOutbox().filter((q) => {
    if (op.type === "set_status" && q.op.type === "set_status") return q.op.entryId !== op.entryId;
    if (op.type === "set_completion" && q.op.type === "set_completion")
      return !(q.op.itemId === op.itemId && q.op.forDate === op.forDate && q.op.kind === op.kind);
    return true;
  });
  queue.push({ id: crypto.randomUUID(), op, queuedAt: Date.now() });
  writeOutbox(queue);
}

/** Send one queued change. */
async function send(op: OutboxOp) {
  const supabase = getSupabaseBrowserClient();
  switch (op.type) {
    case "set_status":
      return supabase.from("list_entries").update({ status: op.status }).eq("id", op.entryId);
    case "add_entry":
      return supabase.rpc("add_entry", { p_list_id: op.listId, p_text: op.text, p_quantity: op.quantity, p_category: op.category });
    case "set_completion":
      return supabase.rpc("set_completion", { p_kind: op.kind, p_item_id: op.itemId, p_for_date: op.forDate, p_done: op.done });
  }
}

let flushing = false;

/**
 * Send everything queued, oldest first. Stops at the first network error
 * (still offline); a change the server refuses (e.g. the line was deleted on
 * another phone) is dropped, since retrying it would never succeed.
 * Returns how many were sent.
 */
export async function flushOutbox(): Promise<number> {
  if (flushing || typeof window === "undefined") return 0;
  flushing = true;
  let sent = 0;
  try {
    for (;;) {
      const [next] = readOutbox();
      if (!next) break;
      const { error } = (await send(next.op)) ?? { error: null };
      if (error && isNetworkError(error)) break;
      if (error) console.warn("[offline] dropped a queued change the server refused", next.op, error.message);
      writeOutbox(readOutbox().filter((q) => q.id !== next.id));
      sent++;
    }
  } finally {
    flushing = false;
  }
  if (sent > 0) window.dispatchEvent(new Event(SYNCED_EVENT));
  return sent;
}

/** On sign-out: forget this device's copies and queue. */
export async function clearOfflineData() {
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(CACHE_PREFIX) || key === OUTBOX_KEY) localStorage.removeItem(key);
    }
    if ("caches" in window) {
      for (const name of await caches.keys()) if (name.startsWith("homehub-")) await caches.delete(name);
    }
  } catch {
    // Best effort.
  }
}
