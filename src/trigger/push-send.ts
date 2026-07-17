import webpush from "web-push";
import { vaultService } from "../lib/vault-client";

// Shared push sender for the Trigger tasks. Reads VAPID from the vault + the
// device subscriptions from Convex, and pushes to every registered device.
const CONVEX_URL =
  process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL ?? "https://tangible-goose-318.convex.cloud";

async function cq(path: string, args: unknown) {
  const workerToken = process.env.JARVIS_WORKER_TOKEN;
  if (!workerToken) throw new Error("JARVIS_WORKER_TOKEN is not configured");
  return (
    await (
      await fetch(`${CONVEX_URL}/api/query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, args: { ...((args ?? {}) as Record<string, unknown>), workerToken }, format: "json" }),
      })
    ).json()
  ).value;
}
async function cm(path: string, args: unknown) {
  const workerToken = process.env.JARVIS_WORKER_TOKEN;
  if (!workerToken) throw new Error("JARVIS_WORKER_TOKEN is not configured");
  await fetch(`${CONVEX_URL}/api/mutation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args: { ...((args ?? {}) as Record<string, unknown>), workerToken }, format: "json" }),
  }).catch(() => {});
}
export type PushOptions = {
  tag?: string;
  topic?: string;
  ttl?: number;
  urgency?: "very-low" | "low" | "normal" | "high";
};

export async function sendPush(title: string, body: string, url = "/", options: PushOptions = {}): Promise<void> {
  try {
    const env = await vaultService("jarvis");
    if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return;
    webpush.setVapidDetails(
      env.VAPID_SUBJECT || "mailto:daniel.mabro@gmail.com",
      env.VAPID_PUBLIC_KEY,
      env.VAPID_PRIVATE_KEY,
    );
    const subs = ((await cq("push:listSubs", {})) as Array<any>) ?? [];
    await Promise.allSettled(
      subs.map((s) =>
        webpush.sendNotification(
          s,
          JSON.stringify({ title, body, url, tag: options.tag }),
          {
            TTL: Math.max(60, Math.min(7 * 86_400, options.ttl ?? 86_400)),
            urgency: options.urgency ?? "normal",
            topic: options.topic?.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32),
          },
        ).catch((e: any) => {
          if (e?.statusCode === 404 || e?.statusCode === 410) return cm("push:deleteSub", { endpoint: s.endpoint });
        }),
      ),
    );
  } catch {
    /* best-effort */
  }
}
