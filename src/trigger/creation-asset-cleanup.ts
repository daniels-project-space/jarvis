import { task } from "@trigger.dev/sdk/v3";
import { privateCreationAssetDelete } from "../lib/private-creation-asset-store";

const CONVEX_URL = process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL ?? "https://tangible-goose-318.convex.cloud";

async function convexCall(kind: "mutation" | "query", path: string, args: Record<string, unknown>) {
  const workerToken = process.env.JARVIS_WORKER_TOKEN;
  if (!workerToken) throw new Error("JARVIS_WORKER_TOKEN is not configured");
  const response = await fetch(`${CONVEX_URL}/api/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args: { ...args, workerToken }, format: "json" }),
  });
  const body = await response.json().catch(() => null) as { status?: string; value?: unknown; errorMessage?: string } | null;
  if (!response.ok || !body || body.status === "error") {
    throw new Error(`Convex ${kind} ${path} failed: ${String(body?.errorMessage ?? response.status).slice(0, 240)}`);
  }
  return body.value;
}

type CleanupClaim =
  | {
    ready: true;
    assetR2Key: string;
    assetStore: "private-r2-v1" | "private-r2-v2";
    assetLocator: string;
    deletionTicketId: string;
    cleanupProtocol: "nonterminal-reaper-v1";
  }
  | { ready: false; retryAfterMs?: number; preserved?: boolean }
  | null;

type CleanupFinish = { finished?: boolean; preserved?: boolean } | false;

// Recovery owns no user-facing state. It first acquires a bounded Convex
// lease, rechecks the canonical creations row immediately before R2 delete,
// then asks Convex to recheck it once more while retaining the intent. The
// global scheduled reconciler, rather than this one-shot task, performs each
// later sweep so a key never creates a perpetual delayed Trigger chain.
export const creationAssetCleanup = task({
  id: "jarvis-creation-asset-cleanup",
  queue: { name: "jarvis-private-creation-asset-cleanup", concurrencyLimit: 2 },
  machine: "micro",
  maxDuration: 120,
  retry: { maxAttempts: 8, minTimeoutInMs: 45_000, maxTimeoutInMs: 120_000, factor: 1.5, randomize: true },
  run: async (payload: { assetR2Key: string; assetStore?: string; assetLocator?: string }) => {
    const assetR2Key = String(payload.assetR2Key ?? "").trim();
    if (!assetR2Key) throw new Error("private creation cleanup identity is missing");
    const claim = await convexCall("mutation", "creationAssetCleanup:claim", {
      assetR2Key,
      assetStore: payload.assetStore,
      assetLocator: payload.assetLocator,
    }) as CleanupClaim;
    if (!claim) return { assetR2Key, skipped: true };
    if (!claim.ready) {
      if (claim.preserved) return { assetR2Key, preserved: true };
      return { assetR2Key, deferred: true };
    }
    // New Trigger must not run against the older finite-retention Convex
    // contract. Check before touching R2; Convex is deployed before Trigger.
    if (claim.cleanupProtocol !== "nonterminal-reaper-v1") {
      throw new Error("private creation cleanup requires the nonterminal Convex reaper contract");
    }

    // This check is intentionally separate from claim. It is the read just
    // before storage deletion; a creation mutation cannot slip in afterward
    // because the claim has already made this asset cleanup-owned.
    const canonicalCreation = await convexCall("query", "creations:getByAssetLocator", {
      assetStore: claim.assetStore,
      assetLocator: claim.assetLocator,
    });
    if (typeof canonicalCreation === "string" && canonicalCreation) {
      const finished = await convexCall("mutation", "creationAssetCleanup:finish", {
        assetR2Key: claim.assetR2Key,
        assetStore: claim.assetStore,
        assetLocator: claim.assetLocator,
        deletionTicketId: claim.deletionTicketId,
      }) as CleanupFinish;
      if (!finished) throw new Error("private creation cleanup could not preserve its durable intent");
      return { assetR2Key, preserved: true };
    }

    await privateCreationAssetDelete({ assetStore: claim.assetStore, assetLocator: claim.assetLocator });
    const finished = await convexCall("mutation", "creationAssetCleanup:finish", {
      assetR2Key: claim.assetR2Key,
      assetStore: claim.assetStore,
      assetLocator: claim.assetLocator,
      deletionTicketId: claim.deletionTicketId,
    }) as CleanupFinish;
    if (!finished) throw new Error("private creation cleanup could not update its durable recovery record");
    return { assetR2Key, deleted: Boolean(finished.finished), preserved: Boolean(finished.preserved) };
  },
});
