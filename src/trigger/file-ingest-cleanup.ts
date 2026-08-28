import { randomUUID } from "node:crypto";
import { task } from "@trigger.dev/sdk/v3";
import { privateR2Delete } from "../lib/private-r2";

const CONVEX_URL = process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL ?? "";

async function convexMutation(path: string, args: Record<string, unknown>) {
  const workerToken = process.env.JARVIS_WORKER_TOKEN;
  if (!CONVEX_URL || !workerToken) throw new Error("private file worker capability is unavailable");
  const response = await fetch(`${CONVEX_URL}/api/mutation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args: { ...args, workerToken }, format: "json" }),
  });
  const payload = await response.json().catch(() => null) as { value?: unknown; status?: string; errorMessage?: string } | null;
  if (!response.ok || !payload || payload.status === "error") {
    throw new Error(`Convex ${path} failed: ${String(payload?.errorMessage ?? response.status).slice(0, 200)}`);
  }
  return payload.value;
}

export async function runFileIngestDerivedCleanup(payload: { outboxId?: string; outputAttemptId?: string }) {
  const outputAttemptId = String(payload.outputAttemptId ?? "");
  if (outputAttemptId) {
    const cleanupClaimToken = randomUUID();
    const claim = await convexMutation("files:claimIngestOutputCleanup", { outputAttemptId, cleanupClaimToken }) as
      | { ready: boolean; committed?: boolean; retryAfterMs?: number; r2Keys?: string[] }
      | null;
    if (!claim || claim.committed) return { outputAttemptId, skipped: true };
    if (!claim.ready) throw new Error(`private ingest cleanup is waiting for ${Math.max(1, Number(claim.retryAfterMs ?? 0))}ms`);
    for (const key of claim.r2Keys ?? []) await privateR2Delete(key);
    const finished = await convexMutation("files:finishIngestOutputCleanup", { outputAttemptId, cleanupClaimToken });
    if (!finished) throw new Error("private ingest cleanup could not finalize its durable output attempt");
    return { outputAttemptId, deleted: true };
  }
  const outboxId = String(payload.outboxId ?? "");
  if (!outboxId) throw new Error("private ingest cleanup outbox identity is missing");
  const cleanupClaimToken = randomUUID();
  const claim = await convexMutation("files:claimIngestDerivedCleanup", { outboxId, cleanupClaimToken }) as
    | { ready: boolean; committed?: boolean; retryAfterMs?: number; r2Keys?: string[] }
    | null;
  if (!claim || claim.committed) return { outboxId, skipped: true };
  if (!claim.ready) throw new Error(`private ingest cleanup is waiting for ${Math.max(1, Number(claim.retryAfterMs ?? 0))}ms`);
  for (const key of claim.r2Keys ?? []) await privateR2Delete(key);
  const finished = await convexMutation("files:finishIngestDerivedCleanup", { outboxId, cleanupClaimToken });
  if (!finished) throw new Error("private ingest cleanup could not finalize its durable outbox item");
  return { outboxId, deleted: true };
}

export const fileIngestDerivedCleanup = task({
  id: "jarvis-file-ingest-derived-cleanup",
  queue: { name: "jarvis-private-file-ingest-cleanup", concurrencyLimit: 2 },
  machine: "micro",
  maxDuration: 120,
  retry: { maxAttempts: 8, minTimeoutInMs: 15_000, maxTimeoutInMs: 30_000, factor: 1.5, randomize: true },
  run: runFileIngestDerivedCleanup,
});
