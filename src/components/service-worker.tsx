/**
 * Registers HomeHub's service worker (/sw.js) once the app has loaded, so
 * push notifications (and later, offline mode) work. Renders nothing.
 */
"use client";

import { useEffect } from "react";
import { registerServiceWorker } from "@/lib/push/client";

export function ServiceWorker() {
  useEffect(() => {
    registerServiceWorker();
  }, []);
  return null;
}
