import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { task, tasks } from "@trigger.dev/sdk/v3";
import { CHAT_FILE_LIMITS } from "../lib/chat-files";
import { privateFileAttemptObjectKey, privateR2Get, privateR2Head, privateR2Put } from "../lib/private-r2";

const CONVEX_URL = process.env.CONVEX_URL;

class SourceArtifactMissingError extends Error {}
class RehomeReadbackMismatchError extends Error {}

type RehomeClaim = {
  claimed?: boolean;
  committed?: boolean;
  blocked?: boolean;
  verified?: boolean;
  retryAfterMs?: number;
  rehomeId?: string;
  fileId?: string;
  sourceIngestVersion?: number;
  sourceExtractedTextR2Key?: string;
  sourcePreviewR2Key?: string;
  targetOutputAttemptId?: string;
  targetOutputAttemptOutboxId?: string;
  targetExtractedTextR2Key?: string;
  targetPreviewR2Key?: string;
  targetGeneration?: number;
  requeued?: boolean;
  superseded?: boolean;
};

type RoleProof = {
  sourceSha256: string;
  targetSha256: string;
  sourceBytes: number;
  targetBytes: number;
};

async function rehomeConvexCall(kind: "query" | "mutation", path: string, args: Record<string, unknown>) {
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

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

async function fullPrivateRead(
  key: string,
  role: string,
  missingKind: "source" | "target",
): Promise<Uint8Array> {
  const response = await privateR2Get(key);
  if (response.status === 404) {
    if (missingKind === "source") throw new SourceArtifactMissingError(`${role} source is missing`);
    throw new RehomeReadbackMismatchError(`${role} target is missing after PUT`);
  }
  if (!response.ok) throw new Error(`${role} R2 GET failed (${response.status})`);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (!Number.isSafeInteger(declared) || declared < 0 || declared > CHAT_FILE_LIMITS.maxFileBytes) {
    throw new RehomeReadbackMismatchError(`${role} source has invalid byte length`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== declared || bytes.byteLength > CHAT_FILE_LIMITS.maxFileBytes) {
    throw new RehomeReadbackMismatchError(`${role} source full read does not match its declared length`);
  }
  return bytes;
}

async function copyAndVerifyRole(input: {
  rehomeId: string;
  claimToken: string;
  targetGeneration: number;
  sourceKey: string;
  targetKey: string;
  purpose: "extracted.txt" | "preview.webp";
  contentType: "text/plain" | "image/webp";
}): Promise<RoleProof> {
  const source = await fullPrivateRead(input.sourceKey, input.purpose, "source");
  const sourceSha256 = sha256(source);
  const began = await rehomeConvexCall("mutation", "fileDerivedArtifactRehomes:beginFileDerivedArtifactRehomeWrite", {
    rehomeId: input.rehomeId,
    claimToken: input.claimToken,
    targetGeneration: input.targetGeneration,
    purpose: input.purpose,
  });
  if (began !== true) throw new Error("rehome target is no longer writable");
  // The durable prewrite fence above intentionally precedes this external
  // operation. A transport failure after R2 accepts the PUT is retired into
  // an attempt-specific sweeper, never retried at the same path.
  await privateR2Put(input.targetKey, source, input.contentType, { sha256: sourceSha256 });
  const head = await privateR2Head(input.targetKey);
  if (
    !head
    || head.sizeBytes !== source.byteLength
    || head.contentType !== input.contentType
    || head.expectedSha256 !== sourceSha256
  ) {
    throw new RehomeReadbackMismatchError(`${input.purpose} target HEAD does not match the source`);
  }
  const target = await fullPrivateRead(input.targetKey, input.purpose, "target");
  const targetSha256 = sha256(target);
  if (targetSha256 !== sourceSha256 || !sameBytes(source, target)) {
    throw new RehomeReadbackMismatchError(`${input.purpose} target full readback is not identical`);
  }
  return {
    sourceSha256,
    targetSha256,
    sourceBytes: source.byteLength,
    targetBytes: target.byteLength,
  };
}

async function receipt(rehomeId: string) {
  return await rehomeConvexCall("query", "fileDerivedArtifactRehomes:fileDerivedArtifactRehomeReceipt", { rehomeId }) as {
    committed?: boolean;
    blocked?: boolean;
  state?: string;
  targetGeneration?: number;
  } | null;
}

async function wakeRehomeController(rehomeId: string) {
  await tasks.trigger(
    "jarvis-file-derived-artifact-rehome-controller",
    { limit: 8 },
    { idempotencyKey: `jarvis-file-derived-artifact-rehome-progress-${rehomeId}-${randomUUID()}` },
  ).catch(() => undefined);
}

/** Copy the exact durable V1 source snapshot into a fresh attempt-scoped V2
 * target. This task never deletes a V1 source; Convex creates a permanent
 * source reaper only after the pointer CAS has committed. */
export async function runFileDerivedArtifactRehome(payload: { rehomeId: string; claimToken?: string }) {
  const rehomeId = String(payload.rehomeId ?? "").trim();
  if (!/^[a-zA-Z0-9_-]{8,180}$/.test(rehomeId)) throw new Error("invalid file-derived-artifact rehome identity");
  const claimToken = /^[a-zA-Z0-9_-]{16,160}$/.test(String(payload.claimToken ?? ""))
    ? String(payload.claimToken)
    : randomUUID();
  const previous = await receipt(rehomeId);
  if (previous?.committed) {
    await wakeRehomeController(rehomeId);
    return { rehomeId, committed: true, recovered: true };
  }
  if (previous?.blocked) throw new Error("file-derived-artifact rehome requires repair");
  const claim = await rehomeConvexCall("mutation", "fileDerivedArtifactRehomes:claimFileDerivedArtifactRehome", {
    rehomeId,
    claimToken,
  }) as RehomeClaim | null;
  if (!claim) return { rehomeId, skipped: true };
  if (claim.committed) {
    await wakeRehomeController(rehomeId);
    return { rehomeId, committed: true, recovered: true };
  }
  if (claim.blocked) throw new Error("file-derived-artifact rehome requires repair");
  if (claim.verified) {
    if (!Number.isSafeInteger(claim.targetGeneration)) throw new Error("verified rehome is missing its target generation");
    const committed = await rehomeConvexCall("mutation", "fileDerivedArtifactRehomes:commitFileDerivedArtifactRehome", {
      rehomeId,
      targetGeneration: claim.targetGeneration,
    });
    if ((committed as { committed?: boolean }).committed !== true) throw new Error("verified rehome could not commit its pointer CAS");
    await wakeRehomeController(rehomeId);
    return { rehomeId, committed: true, recovered: true };
  }
  if (!claim.claimed) {
    if (claim.requeued || claim.superseded) {
      await wakeRehomeController(rehomeId);
      return { rehomeId, requeued: true };
    }
    if (claim.retryAfterMs) throw new Error(`file-derived-artifact rehome is claimed for ${Math.max(1, claim.retryAfterMs)}ms`);
    return { rehomeId, skipped: true };
  }
  if (
    !claim.fileId
    || !Number.isSafeInteger(claim.sourceIngestVersion)
    || !claim.targetOutputAttemptId
    || !claim.targetOutputAttemptOutboxId
    || !claim.targetExtractedTextR2Key
    || !claim.targetPreviewR2Key
    || !Number.isSafeInteger(claim.targetGeneration)
  ) throw new Error("Convex returned an incomplete file-derived-artifact rehome claim");
  const sourceIngestVersion = Number(claim.sourceIngestVersion);
  const targetGeneration = Number(claim.targetGeneration);
  const expectedExtracted = privateFileAttemptObjectKey(claim.fileId, sourceIngestVersion, claim.targetOutputAttemptId, "extracted.txt");
  const expectedPreview = privateFileAttemptObjectKey(claim.fileId, sourceIngestVersion, claim.targetOutputAttemptId, "preview.webp");
  if (claim.targetExtractedTextR2Key !== expectedExtracted || claim.targetPreviewR2Key !== expectedPreview) {
    throw new Error("Convex returned invalid file-derived-artifact target keys");
  }
  try {
    const extracted = claim.sourceExtractedTextR2Key
      ? await copyAndVerifyRole({
        rehomeId,
        claimToken,
        targetGeneration,
        sourceKey: claim.sourceExtractedTextR2Key,
        targetKey: expectedExtracted,
        purpose: "extracted.txt",
        contentType: "text/plain",
      })
      : undefined;
    const preview = claim.sourcePreviewR2Key
      ? await copyAndVerifyRole({
        rehomeId,
        claimToken,
        targetGeneration,
        sourceKey: claim.sourcePreviewR2Key,
        targetKey: expectedPreview,
        purpose: "preview.webp",
        contentType: "image/webp",
      })
      : undefined;
    const verified = await rehomeConvexCall("mutation", "fileDerivedArtifactRehomes:recordFileDerivedArtifactRehomeReadback", {
      rehomeId,
      claimToken,
      targetGeneration,
      sourceExtractedTextSha256: extracted?.sourceSha256,
      targetExtractedTextSha256: extracted?.targetSha256,
      sourceExtractedTextBytes: extracted?.sourceBytes,
      targetExtractedTextBytes: extracted?.targetBytes,
      sourcePreviewSha256: preview?.sourceSha256,
      targetPreviewSha256: preview?.targetSha256,
      sourcePreviewBytes: preview?.sourceBytes,
      targetPreviewBytes: preview?.targetBytes,
    }) as { verified?: boolean; reason?: string };
    if (verified.verified !== true) {
      if (verified.reason === "target_readback_mismatch") throw new RehomeReadbackMismatchError("Convex rejected rehome readback proof");
      throw new Error(`Convex rejected rehome verification: ${verified.reason ?? "unknown"}`);
    }
    const committed = await rehomeConvexCall("mutation", "fileDerivedArtifactRehomes:commitFileDerivedArtifactRehome", {
      rehomeId,
      targetGeneration,
    }) as { committed?: boolean; reason?: string };
    if (committed.committed !== true) throw new Error(`file-derived-artifact pointer CAS failed: ${committed.reason ?? "unknown"}`);
    await wakeRehomeController(rehomeId);
    return { rehomeId, committed: true, copiedRoles: Number(Boolean(extracted)) + Number(Boolean(preview)) };
  } catch (error) {
    // CAS/Convex response loss is resolved from the exact durable manifest
    // before any target receipt can be retired. That prevents the old
    // response-loss bug from deleting a now-referenced V2 object.
    const durable = await receipt(rehomeId).catch(() => null);
    if (durable?.committed && durable.targetGeneration === targetGeneration) {
      await wakeRehomeController(rehomeId);
      return { rehomeId, committed: true, recovered: true };
    }
    if (durable?.state === "verified" && durable.targetGeneration === targetGeneration) {
      const recoveredCommit = await rehomeConvexCall(
        "mutation",
        "fileDerivedArtifactRehomes:commitFileDerivedArtifactRehome",
        { rehomeId, targetGeneration },
      ).catch(() => null) as { committed?: boolean } | null;
      if (recoveredCommit?.committed) {
        await wakeRehomeController(rehomeId);
        return { rehomeId, committed: true, recovered: true };
      }
    }
    const failureCode = error instanceof SourceArtifactMissingError
      ? "source_missing"
      : error instanceof RehomeReadbackMismatchError
        ? "target_readback_mismatch"
        : null;
    if (failureCode) {
      await rehomeConvexCall("mutation", "fileDerivedArtifactRehomes:blockFileDerivedArtifactRehome", {
        rehomeId,
        claimToken,
        targetGeneration,
        failureCode,
      }).catch(() => undefined);
      await wakeRehomeController(rehomeId);
    } else {
      await rehomeConvexCall("mutation", "fileDerivedArtifactRehomes:retireFileDerivedArtifactRehome", {
        rehomeId,
        claimToken,
        targetGeneration,
        errorCode: `rehome_failed:${String(error).slice(0, 80)}`,
      }).catch(() => undefined);
      // A terminal Trigger retry can otherwise leave the logical manifest
      // planned with no controller run left to mint a fresh attempt. The
      // retired receipt owns the old target; this wake is only admission for
      // the next disjoint generation.
      await wakeRehomeController(rehomeId);
    }
    throw error;
  }
}

export const fileDerivedArtifactRehome = task({
  id: "jarvis-file-derived-artifact-rehome",
  queue: { name: "jarvis-private-file-derived-artifact-rehome", concurrencyLimit: 1 },
  machine: "micro",
  maxDuration: 120,
  retry: { maxAttempts: 4, minTimeoutInMs: 15_000, maxTimeoutInMs: 60_000, factor: 2, randomize: true },
  run: runFileDerivedArtifactRehome,
});
