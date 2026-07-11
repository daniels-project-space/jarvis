"use client";

function urlB64ToUint8Array(s: string) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...b].map((c) => c.charCodeAt(0)));
}

export async function registerSW() {
  if ("serviceWorker" in navigator) {
    try {
      await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    } catch {
      /* ignore */
    }
  }
}

export async function subscribePush(
  saveSub: (arg: { endpoint: string; keys: { p256dh: string; auth: string } }) => Promise<unknown>,
): Promise<string> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || typeof Notification === "undefined") {
    return "unsupported"; // iOS Safari tab: add to Home Screen first
  }
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return "denied";
  const reg = await navigator.serviceWorker.ready;
  const key = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  if (!key) return "no-key";
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(key) });
  const j = JSON.parse(JSON.stringify(sub)) as { endpoint: string; keys: { p256dh: string; auth: string } };
  await saveSub({ endpoint: j.endpoint, keys: j.keys });
  return "subscribed";
}
