/* JARVIS service worker — web push + notification click. */
const RETIRED_CONNECTION_ALERT = /failed to fetch|approve root-cause repair for repeated failed fetch/i;

function isRetiredConnectionAlert(value) {
  return RETIRED_CONNECTION_ALERT.test(`${value && value.title ? value.title : ""} ${value && value.body ? value.body : ""}`);
}

async function retireLegacyConnectionAlerts() {
  if (!self.registration.getNotifications) return;
  const notifications = await self.registration.getNotifications();
  for (const notification of notifications) {
    if (isRetiredConnectionAlert(notification)) notification.close();
  }
}

self.addEventListener("install", (event) => {
  // This worker owns push handling only (no offline response cache), so it is
  // safe to replace the prior version immediately and clean the phone without
  // making Daniel close every already-open Jarvis tab first.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(Promise.all([
    self.clients.claim(),
    retireLegacyConnectionAlerts(),
  ]));
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  // A one-off browser disconnect used to create a durable critical alert.
  // Those records are now retired server-side, but an already-delivered or
  // delayed Web Push payload can outlive that repair on a phone. Never revive
  // the raw browser exception; replace it with a single quiet recovery state.
  if (isRetiredConnectionAlert(data)) {
    data = {
      title: "Jarvis is connected",
      body: "The earlier connection alert is resolved. Nothing is waiting on you.",
      tag: "jarvis-connection-recovered",
      url: "/",
    };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "JARVIS", {
      body: data.body || "",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      vibrate: [150, 80, 150],
      tag: data.tag,
      data: { url: data.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
      for (const c of cs) if ("focus" in c) return c.focus();
      return clients.openWindow(url);
    }),
  );
});
