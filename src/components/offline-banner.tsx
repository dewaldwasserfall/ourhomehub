/**
 * Shows when there's no connection or changes are waiting to be sent, and
 * sends them as soon as the connection is back (also on app start and when
 * the app returns to the foreground).
 */
"use client";

import { useEffect, useState } from "react";
import { flushOutbox, OUTBOX_EVENT, pendingCount } from "@/lib/offline";

export function OfflineBanner() {
  const [online, setOnline] = useState(true);
  const [pending, setPending] = useState(0);

  useEffect(() => {
    // Step 1: follow the connection and the queue.
    const update = () => {
      setOnline(navigator.onLine);
      setPending(pendingCount());
    };
    const tryFlush = () => {
      if (navigator.onLine) flushOutbox().then(update);
    };
    update();
    tryFlush();

    // Step 2: send queued changes when the connection comes back.
    const onOnline = () => {
      update();
      tryFlush();
    };
    const onVisible = () => document.visibilityState === "visible" && tryFlush();
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", update);
    window.addEventListener(OUTBOX_EVENT, update);
    document.addEventListener("visibilitychange", onVisible);
    // Safety net: some phones don't fire "online" reliably.
    const timer = setInterval(tryFlush, 30_000);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", update);
      window.removeEventListener(OUTBOX_EVENT, update);
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(timer);
    };
  }, []);

  if (online && pending === 0) return null;
  const changes = pending === 1 ? "1 change" : `${pending} changes`;
  return (
    <div className="offline-banner" role="status" aria-live="polite">
      {!online ? (pending ? `Offline · ${changes} will sync` : "Offline · showing what was last loaded") : `Sending ${changes}…`}
    </div>
  );
}
