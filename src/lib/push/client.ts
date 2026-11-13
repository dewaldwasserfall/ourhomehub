/**
 * Browser side of push notifications: register the service worker, ask for
 * permission, and register or remove this device.
 *
 * iPhone rules (iOS 16.4+): push only works in HomeHub opened from the Home
 * Screen, and the permission prompt may only follow a tap.
 */
"use client";

import { VAPID_PUBLIC_KEY } from "../notify/config";
import { getSupabaseBrowserClient } from "../supabase/client";

export type PushSupport =
  | "supported"
  // iPhone/iPad in Safari: works only after "Add to Home Screen".
  | "needs-home-screen"
  // Old browser or a browser without Web Push.
  | "unsupported";

/** Step 1: can this browser do push, and if not, why not? */
export function pushSupport(): PushSupport {
  if (typeof window === "undefined") return "unsupported";
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone =
    window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (ios && !standalone) return "needs-home-screen";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "unsupported";
  return "supported";
}

/** Step 2: register /sw.js (safe to call on every page load). */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  } catch (err) {
    console.error("[push] service worker registration failed", err);
    return null;
  }
}

/** This device's current subscription, if notifications are on. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  const registration = await registerServiceWorker();
  return registration ? registration.pushManager.getSubscription() : null;
}

/** VAPID keys are base64url; PushManager wants raw bytes. */
function keyBytes(base64url: string): Uint8Array {
  const base64 = (base64url + "=".repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

/** "iPhone", "Mac", "Android", ... so people can tell devices apart. */
function deviceLabel(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Mac/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  return "Browser";
}

/**
 * Step 3: turn notifications on for this device. Must be called from a tap.
 * Returns null on success, otherwise a message for the person.
 */
export async function enablePush(): Promise<string | null> {
  const support = pushSupport();
  if (support === "needs-home-screen") return "Open HomeHub from your Home Screen first, then turn notifications on there.";
  if (support === "unsupported") return "This browser can't show notifications.";

  // 3a. Ask. "denied" can only be undone in the phone's settings.
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return permission === "denied"
      ? "Notifications are blocked for HomeHub. Allow them in your phone's Settings, then try again."
      : "Notifications weren't turned on.";
  }

  // 3b. Subscribe with the push service and register the device with HomeHub.
  const registration = await registerServiceWorker();
  if (!registration) return "Couldn't set up notifications on this device.";
  await navigator.serviceWorker.ready;
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes(VAPID_PUBLIC_KEY) as BufferSource,
    }));

  const json = subscription.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  const { error } = await getSupabaseBrowserClient().rpc("save_push_subscription", {
    p_endpoint: json.endpoint,
    p_p256dh: json.keys.p256dh,
    p_auth: json.keys.auth,
    p_device_label: deviceLabel(),
  });
  return error ? "Couldn't save this device. Check your connection and try again." : null;
}

/** Step 4: turn notifications off for this device. */
export async function disablePush(): Promise<void> {
  const subscription = await currentSubscription();
  if (!subscription) return;
  await getSupabaseBrowserClient().rpc("remove_push_subscription", { p_endpoint: subscription.endpoint });
  await subscription.unsubscribe();
}
