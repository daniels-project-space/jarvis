import { task } from "@trigger.dev/sdk/v3";
import { privateR2Delete } from "../lib/private-r2";

const CONVEX_URL = process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL ?? "https://tangible-goose-318.convex.cloud";

async function convexMutation(path: string, args: Record<string, unknown>) {
  const workerToken = process.env.JARVIS_WORKER_TOKEN;
  if (!workerToken) throw new Error("JARVIS_WORKER_TOKEN is not configured");
  const response = await fetch(`${CONVEX_URL}/api/mutation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args: { ...args, workerToken }, format: "json" }),
  });
  const body = await response.json().catch(() => null) as { status?: string; value?: unknown; errorMessage?: string } | null;
  if (!response.ok || !body || body.status === "error") throw new Error(`Convex mutation ${path} failed: ${String(body?.errorMessage ?? response.status).slice(0, 240)}`);
  return body.value;
}

export const fileCleanup = task({
  id: "jarvis-file-cleanup",
  queue: { name: "jarvis-private-file-cleanup", concurrencyLimit: 2 },
  machine: "micro",
  maxDuration: 120,
  retry: { maxAttempts: 8, minTimeoutInMs: 15_000, maxTimeoutInMs: 30_000, factor: 1.5, randomize: true },
  run: async (payload: { fileId: string }) => {
    const fileId = String(payload.fileId ?? "");
    if (!fileId) throw new Error("private cleanup file identity is missing");
    const claim = await convexMutation("files:claimCancelledUploadCleanup", { fileId }) as
      | { ready: boolean; retryAfterMs?: number; r2Keys?: string[] }
      | null;
    if (!claim) return { fileId, skipped: true };
    if (!claim.ready) throw new Error(`private upload claim is still active for ${Math.max(1, Number(claim.retryAfterMs ?? 0))}ms`);
    for (const key of claim.r2Keys ?? []) await privateR2Delete(key);
    const finished = await convexMutation("files:finishDelete", { fileId });
    if (!finished) throw new Error("private file cleanup could not finalize its durable row");
    return { fileId, deleted: true };
  },
});
