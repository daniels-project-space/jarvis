/* JARVIS service worker — web push + notification click. */
// Push is reserved for something Daniel deliberately asked to be reminded
// about or something that needs a decision. Routine machine state belongs in
// the in-app status surfaces, not in his notification tray.
const RETIRED_AUTOMATIC_ALERT = /failed to fetch|approve root-cause repair for repeated failed fetch|\b(?:jarvis|system|stack|service|deployment) health(?: check)?\b|\bhealth check (?:passed|complete|completed|healthy|failed)\b|\b\d+\/\d+ deploys healthy\b|\ball systems (?:healthy|operational)\b|\b(?:heartbeat|routine maintenance) (?:passed|complete|completed|healthy)\b|\bjarvis is connected\b|\bconnection (?:recovered|restored)\b/i;

function isRetiredAutomaticAlert(value) {
  return RETIRED_AUTOMATIC_ALERT.test(`${value && value.title ? value.title : ""} ${value && value.body ? value.body : ""}`);
}

async function retireLegacyAutomaticAlerts() {
  if (!self.registration.getNotifications) return;
  const notifications = await self.registration.getNotifications();
  for (const notification of notifications) {
    if (isRetiredAutomaticAlert(notification)) notification.close();
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
    retireLegacyAutomaticAlerts(),
  ]));
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  // A delayed provider payload may outlive the server-side repair. Retire it
  // silently: replacing it with a "connected" notification merely turns one
  // generic automatic alert into another.
  if (isRetiredAutomaticAlert(data)) {
    event.waitUntil(Promise.resolve());
    return;
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
