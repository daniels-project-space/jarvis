import {
  __name,
  init_esm
} from "./chunk-J4P35T43.mjs";

// src/trigger/push-send.ts
init_esm();
import webpush from "web-push";
var CONVEX_URL = process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL ?? "https://tangible-goose-318.convex.cloud";
var VAULT_URL = process.env.VAULT_URL ?? "https://fantastic-roadrunner-485.convex.cloud";
async function cq(path, args) {
  return (await (await fetch(`${CONVEX_URL}/api/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" })
  })).json()).value;
}
__name(cq, "cq");
async function cm(path, args) {
  await fetch(`${CONVEX_URL}/api/mutation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" })
  }).catch(() => {
  });
}
__name(cm, "cm");
async function vault(service) {
  const rows = (await (await fetch(`${VAULT_URL}/api/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "secrets:listByService", args: { service }, format: "json" })
  })).json()).value ?? [];
  return Object.fromEntries(rows.map((x) => [x.keyName, x.value]));
}
__name(vault, "vault");
async function sendPush(title, body, url = "/") {
  try {
    const env = await vault("jarvis");
    if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return;
    webpush.setVapidDetails(
      env.VAPID_SUBJECT || "mailto:daniel.mabro@gmail.com",
      env.VAPID_PUBLIC_KEY,
      env.VAPID_PRIVATE_KEY
    );
    const subs = await cq("push:listSubs", {}) ?? [];
    await Promise.allSettled(
      subs.map(
        (s) => webpush.sendNotification(s, JSON.stringify({ title, body, url })).catch((e) => {
          if (e?.statusCode === 404 || e?.statusCode === 410) return cm("push:deleteSub", { endpoint: s.endpoint });
        })
      )
    );
  } catch {
  }
}
__name(sendPush, "sendPush");

export {
  sendPush
};
//# sourceMappingURL=chunk-BOIXZMYY.mjs.map
