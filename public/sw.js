/**
 * HomeHub service worker.
 *
 * For now it does one job: show push notifications and open the right page
 * when one is tapped. (Offline mode will extend this same file.)
 */

// Step 1: take over straight away after an update.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

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
