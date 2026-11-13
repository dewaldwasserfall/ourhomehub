/**
 * HomeHub service worker.
 *
 * Two jobs:
 *  1. Offline: keep a copy of the app's pages and files so HomeHub opens
 *     without a connection. Data itself is cached by the app (localStorage);
 *     this file only caches the "shell".
 *  2. Push: show notifications and open the right page when one is tapped.
 */

// Bump the version to throw away old copies after a big change.
const CACHE = "homehub-v1";

// Step 1: take over straight away after an update, and drop old caches.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n.startsWith("homehub-") && n !== CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  ),
);

// Step 1b: decide how each request is answered.
//  - Never touch API routes, sign-in, Supabase or other sites (always live).
//  - Built files and icons never change under the same name -> cache first.
//  - Pages and page data -> network first, the last copy when offline.
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/") || url.pathname === "/sw.js") return;

  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/")) {
    event.respondWith(cacheFirst(request));
    return;
  }
  const isPage = request.mode === "navigate";
  const isPageData = request.headers.get("RSC") === "1";
  if (isPage || isPageData) event.respondWith(networkFirst(request, isPage));
});

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

async function networkFirst(request, isPage) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    // Only keep good, non-redirected answers (a redirect is usually sign-in).
    if (response.ok && !response.redirected) cache.put(request, response.clone());
    return response;
  } catch (error) {
    const hit = await cache.match(request, { ignoreVary: true });
    if (hit) return hit;
    // A page we never opened online: fall back to Today's shell, which
    // renders from the app's own offline copies.
    if (isPage) {
      const today = await cache.match("/", { ignoreVary: true });
      if (today) return today;
    }
    throw error;
  }
}

// Step 2: a push arrives -> show it. The payload is JSON from the server:
// { title, body, url, tag }. A tag replaces an older notification with the
// same tag instead of stacking a duplicate.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "HomeHub", body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "HomeHub", {
      body: data.body || "",
      tag: data.tag,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url: data.url || "/" },
    }),
  );
});

// Step 3: tapped -> focus an open HomeHub window on that page, or open one.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if (client.url.startsWith(self.location.origin)) {
          await client.focus();
          if ("navigate" in client) await client.navigate(url);
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
