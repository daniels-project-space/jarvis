import { createHash } from "node:crypto";
import { schedules, task, tasks } from "@trigger.dev/sdk/v3";

import {
  assertPrivateCreationAssetStoreConfigured,
  privateCreationAssetGet,
  privateCreationAssetPut,
  requirePrivateCreationAssetLocator,
  type PrivateCreationAssetLocator,
} from "../lib/private-creation-asset-store";

const CONVEX_URL = process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL ?? "https://tangible-goose-318.convex.cloud";
const REHOME_MAX_BYTES = 30 * 1024 * 1024;

type CopyClaim =
  | {
    ready: true;
    creationId: string;
    ticketId: string;
    source: PrivateCreationAssetLocator;
    destination: PrivateCreationAssetLocator;
    contentType: string;
    maxBytes: number;
  }
  | { ready: false; inactive?: boolean; missing?: boolean; complete?: boolean; retryAfterMs?: number };

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

async function readFullBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.ok || !response.body) throw new Error(`private creation asset read failed (${response.status})`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      if (value.byteLength > maxBytes - total) throw new Error("private creation asset exceeds migration limit");
      chunks.push(value);
      total += value.byteLength;
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function cleanCreationId(value: unknown): string {
  const creationId = typeof value === "string" ? value.trim() : "";
  // Convex IDs are opaque; this only rejects empty/control input before the
  // task reaches its server-issued migration manifest lookup.
  if (!creationId || creationId.length > 200 || /[\u0000-\u001f\u007f]/.test(creationId)) {
    throw new Error("creation asset migration identity is invalid");
  }
  return creationId;
}

export async function rehomeCreationAsset(
  creationIdInput: unknown,
  dependencies: {
    call?: typeof convexCall;
    get?: typeof privateCreationAssetGet;
    put?: typeof privateCreationAssetPut;
    assertStore?: typeof assertPrivateCreationAssetStoreConfigured;
  } = {},
) {
  const creationId = cleanCreationId(creationIdInput);
  const call = dependencies.call ?? convexCall;
  const get = dependencies.get ?? privateCreationAssetGet;
  const put = dependencies.put ?? privateCreationAssetPut;
  const assertStore = dependencies.assertStore ?? assertPrivateCreationAssetStoreConfigured;
  const claim = await call("mutation", "creationAssetStoreMigration:claimCopy", { creationId }) as CopyClaim;
  if (!claim.ready) return { creationId, skipped: true, ...claim };

  try {
    const source = requirePrivateCreationAssetLocator(claim.source);
    const destination = requirePrivateCreationAssetLocator(claim.destination);
    if (destination.assetStore !== "private-r2-v2") throw new Error("migration destination must be the isolated V2 store");
    // Check V2 before reading/copying source bytes. A missing V2 bucket/vault
    // is a hard stop, never a V2-to-V1 fallback.
    await assertStore(destination.assetStore);
    const maxBytes = Math.min(REHOME_MAX_BYTES, Math.max(1, Math.floor(claim.maxBytes)));
    const sourceBytes = await readFullBody(await get(source), maxBytes);
    const sourceSha256 = sha256(sourceBytes);
    await put(destination, sourceBytes, claim.contentType, { sha256: sourceSha256 });

    // The transfer is not considered copied until a full independent V2 GET
    // produces the same byte length and SHA-256. HEAD/ETag metadata is never
    // used as a substitute for this readback proof.
    const destinationBytes = await readFullBody(await get(destination), maxBytes);
    const destinationSha256 = sha256(destinationBytes);
    if (destinationBytes.byteLength !== sourceBytes.byteLength || destinationSha256 !== sourceSha256) {
      throw new Error("V2 creation asset readback digest mismatch");
    }
    await call("mutation", "creationAssetStoreMigration:verifyCopy", {
      creationId,
      ticketId: claim.ticketId,
      sha256: destinationSha256,
      sizeBytes: destinationBytes.byteLength,
      contentType: claim.contentType,
    });
    return { creationId, copied: true, sha256: destinationSha256, sizeBytes: destinationBytes.byteLength };
  } catch (error) {
    // Retain any ambiguous V2 object for a later exact-key retry/readback.
    // The task does not receive or invoke a deletion path, so a delayed PUT
    // cannot resurrect an orphan after a terminal cleanup decision.
    await call("mutation", "creationAssetStoreMigration:releaseCopy", {
      creationId,
      ticketId: claim.ticketId,
      reason: error instanceof Error ? error.message : "migration copy failed",
    }).catch(() => undefined);
    throw error;
  }
}

// The payload intentionally contains an opaque creation ID only. Source and
// destination locators appear solely in the short-lived Convex claim result.
export const creationAssetRehome = task({
  id: "jarvis-creation-asset-rehome",
  queue: { name: "jarvis-private-creation-asset-rehome", concurrencyLimit: 1 },
  machine: "small-1x",
  maxDuration: 180,
  retry: { maxAttempts: 4, minTimeoutInMs: 60_000, maxTimeoutInMs: 5 * 60_000, factor: 1.5, randomize: true },
  run: async (payload: { creationId: string }) => await rehomeCreationAsset(payload.creationId),
});

// Once a controlled server route has frozen and snapshotted the manifest, this
// reconciler steadily dispatches opaque IDs. It makes no object-store call and
// cannot fabricate an asset locator.
export const creationAssetRehomeReconciler = schedules.task({
  id: "jarvis-creation-asset-rehome-reconciler",
  cron: "*/5 * * * *",
  maxDuration: 60,
  run: async () => {
    const pending = await convexCall("query", "creationAssetStoreMigration:pendingCreationIds", { limit: 4 }) as Array<{ creationId?: unknown }>;
    let dispatched = 0;
    for (const item of pending) {
      const creationId = typeof item?.creationId === "string" ? item.creationId : "";
      if (!creationId) continue;
      await tasks.trigger("jarvis-creation-asset-rehome", { creationId }, {
        idempotencyKey: `jarvis-creation-asset-rehome-${creationId}`,
      });
      dispatched += 1;
    }
    return { dispatched };
  },
});
