import webpush from "web-push";

// Shared push sender for the Trigger tasks. Reads VAPID from the vault + the
// device subscriptions from Convex, and pushes to every registered device.
const CONVEX_URL =
  process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL ?? "https://tangible-goose-318.convex.cloud";
const VAULT_URL = process.env.VAULT_URL ?? "https://fantastic-roadrunner-485.convex.cloud";

async function cq(path: string, args: unknown) {
  return (
    await (
      await fetch(`${CONVEX_URL}/api/query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, args, format: "json" }),
      })
    ).json()
  ).value;
}
async function cm(path: string, args: unknown) {
  await fetch(`${CONVEX_URL}/api/mutation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" }),
  }).catch(() => {});
}
async function vault(service: string): Promise<Record<string, string>> {
  const rows =
    ((
      await (
        await fetch(`${VAULT_URL}/api/query`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: "secrets:listByService", args: { service }, format: "json" }),
        })
      ).json()
    ).value as Array<{ keyName: string; value: string }>) ?? [];
  return Object.fromEntries(rows.map((x) => [x.keyName, x.value]));
}

export async function sendPush(title: string, body: string, url = "/"): Promise<void> {
  try {
    const env = await vault("jarvis");
    if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return;
    webpush.setVapidDetails(
      env.VAPID_SUBJECT || "mailto:daniel.mabro@gmail.com",
      env.VAPID_PUBLIC_KEY,
      env.VAPID_PRIVATE_KEY,
    );
    const subs = ((await cq("push:listSubs", {})) as Array<any>) ?? [];
    await Promise.allSettled(
      subs.map((s) =>
        webpush.sendNotification(s, JSON.stringify({ title, body, url })).catch((e: any) => {
          if (e?.statusCode === 404 || e?.statusCode === 410) return cm("push:deleteSub", { endpoint: s.endpoint });
        }),
      ),
    );
  } catch {
    /* best-effort */
  }
}
