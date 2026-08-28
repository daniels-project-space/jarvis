import { createHash, randomUUID } from "node:crypto";
import { task, tasks } from "@trigger.dev/sdk/v3";

const CONVEX_URL = process.env.CONVEX_URL;

async function rehomeConvexCall(kind: "query" | "mutation", path: string, args: Record<string, unknown> = {}) {
  const rehomeToken = process.env.JARVIS_FILE_REHOME_TOKEN;
  if (!CONVEX_URL || !rehomeToken) throw new Error("file-derived-artifact rehome capability is unavailable");
  const response = await fetch(`${CONVEX_URL}/api/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args: { ...args, rehomeToken }, format: "json" }),
  });
  const payload = await response.json().catch(() => null) as { value?: unknown; status?: string; errorMessage?: string } | null;
  if (!response.ok || !payload || payload.status === "error") {
    throw new Error(`Convex ${path} failed: ${String(payload?.errorMessage ?? response.status).slice(0, 200)}`);
  }
  return payload.value;
}

function dispatchIdentity(rehomeId: string, targetGeneration: unknown) {
  const generation = Number(targetGeneration ?? 0);
  if (!Number.isSafeInteger(generation) || generation < 0 || generation >= 10_000) {
    throw new Error("file-derived-artifact rehome has an invalid target generation");
  }
  // The generation is durable Convex state. Controllers that race before a
  // worker claims therefore submit the exact same Trigger idempotency key,
  // rather than multiplying no-op work behind the single-concurrency queue.
  const nextGeneration = generation + 1;
  const digest = createHash("sha256").update(`${rehomeId}:${nextGeneration}`).digest("hex").slice(0, 32);
  return {
    idempotencyKey: `jarvis-file-derived-artifact-rehome-${digest}-g${nextGeneration}`,
  };
}

/** Explicit operational controller for the V1→V2 migration. It does not
 * activate V2: activation remains a separate, server-gated release action
 * after this controller has produced a ready proof. */
export async function runFileDerivedArtifactRehomeController(payload: { limit?: number } = {}) {
  const limit = Math.min(16, Math.max(1, Math.floor(payload.limit ?? 8)));
  const cleanupPreflight = await rehomeConvexCall(
    "mutation",
    "fileDerivedArtifactRehomes:advanceFileDerivedArtifactRehomeCleanupPreflight",
    { limit },
  ) as { phase?: string; status?: string; isDone?: boolean };
  const inventory = await rehomeConvexCall("mutation", "fileDerivedArtifactRehomes:advanceFileDerivedArtifactRehomeInventory", { limit }) as {
    phase?: string;
  };
  const pending = await rehomeConvexCall("query", "fileDerivedArtifactRehomes:pendingFileDerivedArtifactRehomes", { limit }) as Array<{
    rehomeId?: unknown;
    fileId?: unknown;
    targetGeneration?: unknown;
    claimToken?: unknown;
  }>;
  let scheduled = 0;
  for (const item of Array.isArray(pending) ? pending : []) {
    const rehomeId = String(item?.rehomeId ?? "").trim();
    if (!/^[a-zA-Z0-9_-]{8,180}$/.test(rehomeId)) continue;
    const admission = dispatchIdentity(rehomeId, item.targetGeneration);
    const claimToken = String(item?.claimToken ?? "").trim();
    if (!/^[a-zA-Z0-9_-]{16,160}$/.test(claimToken)) continue;
    await tasks.trigger(
      "jarvis-file-derived-artifact-rehome",
      { rehomeId, claimToken },
      // This outlives a worker's max duration, deduplicating racing
      // controllers while still allowing the delayed reconciler to recover a
      // provider failure before any task reached its Convex claim.
      { idempotencyKey: admission.idempotencyKey, idempotencyKeyTTL: "3m" },
    );
    scheduled += 1;
  }
  // Final readiness is a second paginated server audit, not a fixed-size
  // lookup. Run at most one bounded page per controller turn and keep the
  // delayed reconciler alive until it seals.
  const audit = !scheduled && inventory?.phase === "rehoming"
    ? await rehomeConvexCall("mutation", "fileDerivedArtifactRehomes:advanceFileDerivedArtifactRehomeAudit", { limit }) as {
      isDone?: boolean;
      status?: string;
    }
    : null;
  const readiness = !scheduled && audit?.isDone
    ? await rehomeConvexCall("mutation", "fileDerivedArtifactRehomes:finalizeFileDerivedArtifactRehome", {})
    : null;
  if (inventory?.phase === "frozen" || inventory?.phase === "inventorying") {
    // One bounded inventory page per controller run keeps the Convex mutation
    // small. Queue the next page behind this single-concurrency controller;
    // the V2 activation task remains entirely separate.
    await tasks.trigger(
      "jarvis-file-derived-artifact-rehome-controller",
      { limit },
      { idempotencyKey: `jarvis-file-derived-artifact-rehome-inventory-${randomUUID()}` },
    );
  } else if (
    inventory?.phase === "rehoming"
    && (scheduled > 0 || (readiness as { ready?: boolean } | null)?.ready !== true)
  ) {
    // A worker can die after its durable claim but before its own retry/wake
    // path. Keep one delayed controller reconciliation alive so its expired
    // lease is reclaimed into a fresh, disjoint target generation instead of
    // leaving the global file freeze stranded forever.
    const reconciliationMinute = Math.floor(Date.now() / 60_000) + 1;
    await tasks.trigger(
      "jarvis-file-derived-artifact-rehome-controller",
      { limit },
      {
        idempotencyKey: `jarvis-file-derived-artifact-rehome-reconcile-${reconciliationMinute}`,
        delay: "1m",
      },
    );
  }
  return {
    phase: inventory?.phase,
    scheduled,
    ...(cleanupPreflight ? { cleanupPreflightStatus: cleanupPreflight.status } : {}),
    ...(audit ? { auditStatus: audit.status } : {}),
    ready: Boolean((readiness as { ready?: boolean } | null)?.ready),
  };
}

export const fileDerivedArtifactRehomeController = task({
  id: "jarvis-file-derived-artifact-rehome-controller",
  queue: { name: "jarvis-private-file-derived-artifact-rehome-controller", concurrencyLimit: 1 },
  machine: "micro",
  maxDuration: 120,
  retry: { maxAttempts: 3, minTimeoutInMs: 15_000, maxTimeoutInMs: 60_000, factor: 2, randomize: true },
  run: runFileDerivedArtifactRehomeController,
});
