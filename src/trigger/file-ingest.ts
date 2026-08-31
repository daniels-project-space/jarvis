import { createHash, randomUUID } from "node:crypto";
import { task, tasks } from "@trigger.dev/sdk/v3";
import { FileExtractionError, extractPrivateFile, type FileExtractionResult } from "../lib/file-extraction";
import { trustedReadyDuplicate, type ReadyDuplicateRecord } from "../lib/file-dedupe";
import { privateFileAttemptObjectKey, privateR2Get, privateR2Put } from "../lib/private-r2";
import { applyPrivateMediaAnalysis, MediaTranscriptionError, transcribePrivateMedia } from "./media-transcription";
import { extractVideoPreview, MediaFrameExtractionError } from "./media-frame-extraction";

const CONVEX_URL = process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL ?? "";

type IngestPayload = { fileId: string; ingestVersion: number };
type ClaimedFile = {
  _id: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  expectedSha256: string;
  r2Key: string;
  ingestVersion: number;
  ingestOutputProtocol?: number;
  ingestOutputAttemptId?: string;
  derivedOutput?: {
    outputAttemptOutboxId?: string;
    extractedTextR2Key: string;
    previewR2Key: string;
  };
};
type IngestCommitReceipt = {
  committed?: boolean;
  status?: "ready" | "stored_only";
};
type IngestOutputRetirement = IngestCommitReceipt & {
  outputAttemptId?: string;
  missing?: boolean;
};
type IngestOutputProtocolActivation = {
  activated?: boolean;
  activatedAt?: number;
  protocolVersion?: number;
  requeue?: Array<{ fileId?: unknown; ingestVersion?: unknown }>;
};

class StaleIngestCompletionError extends Error {
  constructor(readonly reason?: string) {
    super("completeIngest lost its claim");
  }
}

const INGEST_RECEIPT_RECONCILIATION_ATTEMPTS = 3;

function isIngestCommitReceipt(value: unknown): value is IngestCommitReceipt {
  return Boolean(value && typeof value === "object" && typeof (value as IngestCommitReceipt).committed === "boolean");
}

async function reconcileIngestCommit(args: {
  fileId: string;
  ingestVersion: number;
  outputAttemptId: string;
  extractedTextR2Key?: string;
  previewR2Key?: string;
}): Promise<IngestCommitReceipt | null> {
  for (let attempt = 0; attempt < INGEST_RECEIPT_RECONCILIATION_ATTEMPTS; attempt += 1) {
    try {
      const receipt = await convexCall("query", "files:ingestCommitReceipt", args);
      if (isIngestCommitReceipt(receipt)) return receipt;
    } catch {
      // A response-loss recovery is allowed a short bounded reconciliation
      // window before it transfers cleanup ownership to the durable outbox.
    }
    if (attempt + 1 < INGEST_RECEIPT_RECONCILIATION_ATTEMPTS) {
      await new Promise<void>((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
  return null;
}

async function convexCall(kind: "query" | "mutation", path: string, args: Record<string, unknown>) {
  const workerToken = process.env.JARVIS_WORKER_TOKEN;
  if (!CONVEX_URL || !workerToken) throw new Error("private file worker capability is unavailable");
  const response = await fetch(`${CONVEX_URL}/api/${kind}`, {
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

async function responseBytes(response: Response, expectedMax: number): Promise<Uint8Array> {
  if (!response.ok) throw new Error(`private object read failed (${response.status})`);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > expectedMax) throw new Error("private object exceeded its durable size bound");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.byteLength || bytes.byteLength > expectedMax) throw new Error("private object exceeded its durable size bound");
  return bytes;
}

async function writeDerived(
  fileId: string,
  version: number,
  claimToken: string,
  outputAttemptId: string,
  output: { outputAttemptOutboxId?: string; extractedTextR2Key: string; previewR2Key: string },
  result: FileExtractionResult,
) {
  const expectedExtracted = privateFileAttemptObjectKey(fileId, version, outputAttemptId, "extracted.txt");
  const expectedPreview = privateFileAttemptObjectKey(fileId, version, outputAttemptId, "preview.webp");
  if (output.extractedTextR2Key !== expectedExtracted || output.previewR2Key !== expectedPreview) {
    throw new Error("Convex returned an invalid V2 derived output identity");
  }
  const keys: { extractedTextR2Key?: string; previewR2Key?: string } = {};
  const outputAttemptOutboxId = String(output.outputAttemptOutboxId ?? "");
  if (!outputAttemptOutboxId) throw new Error("Convex did not allocate a V2 derived output receipt");
  const beginWrite = async (purpose: "extracted.txt" | "preview.webp") => {
    const ready = await convexCall("mutation", "files:beginIngestOutputWrite", {
      fileId,
      ingestVersion: version,
      claimToken,
      outputAttemptId: outputAttemptOutboxId,
      purpose,
    });
    if (ready !== true) throw new Error("V2 derived output attempt is no longer writable");
  };
  if (result.text) {
    // Persist intent before the external write. A transport failure after R2
    // accepts this request is therefore still swept by this exact attempt.
    await beginWrite("extracted.txt");
    keys.extractedTextR2Key = expectedExtracted;
    await privateR2Put(keys.extractedTextR2Key, result.text, "text/plain");
  }
  if (result.preview) {
    await beginWrite("preview.webp");
    keys.previewR2Key = expectedPreview;
    await privateR2Put(keys.previewR2Key, result.preview.bytes, result.preview.contentType);
  }
  return keys;
}

async function extractionFromDuplicate(candidate: ReadyDuplicateRecord, sha256: string): Promise<FileExtractionResult | null> {
  const duplicate = trustedReadyDuplicate(candidate, sha256);
  if (!duplicate) return null;
  try {
    const text = duplicate.file.extractedTextR2Key
      ? new TextDecoder("utf-8", { fatal: true }).decode(await responseBytes(await privateR2Get(duplicate.file.extractedTextR2Key), 512 * 1024))
      : "";
    const preview = duplicate.file.previewR2Key
      ? { bytes: await responseBytes(await privateR2Get(duplicate.file.previewR2Key), 4 * 1024 * 1024), contentType: "image/webp" as const }
      : undefined;
    return {
      sha256,
      detectedMimeType: duplicate.file.detectedMimeType ?? duplicate.file.mimeType,
      status: duplicate.file.status as "ready" | "stored_only",
      summary: duplicate.file.summary,
      text,
      chunks: duplicate.chunks,
      pageCount: duplicate.file.pageCount,
      sheetNames: duplicate.file.sheetNames,
      preview,
    };
  } catch {
    // A duplicate's derived object may be concurrently deleted. Parsing the
    // independently stored new original preserves correctness and ownership.
    return null;
  }
}

export async function runFileIngest(payload: IngestPayload) {
  const fileId = String(payload.fileId ?? "");
  const ingestVersion = Math.floor(Number(payload.ingestVersion));
  if (!fileId || !Number.isSafeInteger(ingestVersion) || ingestVersion < 1) throw new Error("invalid file ingest payload");
  // A release operator activates the V2 marker only after the old Trigger
  // fleet and Vercel readers are compatibility-drained. Until then this V2
  // task safely skips rather than auto-flipping a shared worker protocol.
  const claimToken = randomUUID();
  const claim = await convexCall("mutation", "files:claimIngest", {
    fileId,
    ingestVersion,
    claimToken,
    outputProtocol: 2,
  }) as ClaimedFile | null;
  if (!claim) return { fileId, skipped: true };
  const activeIngestVersion = Math.floor(Number(claim.ingestVersion));
  const outputAttemptId = String(claim.ingestOutputAttemptId ?? "");
  const derivedOutput = claim.derivedOutput;
  if (
    !Number.isSafeInteger(activeIngestVersion)
    || activeIngestVersion < 1
    || claim.ingestOutputProtocol !== 2
    || !outputAttemptId
    || !derivedOutput?.outputAttemptOutboxId
  ) {
    throw new Error("Convex did not allocate a V2 derived output attempt");
  }

  let heartbeatBusy = false;
  const heartbeat = setInterval(() => {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    void convexCall("mutation", "files:heartbeatIngest", { fileId, ingestVersion: activeIngestVersion, claimToken })
      .catch(() => undefined)
      .finally(() => { heartbeatBusy = false; });
  }, 30_000);
  let derivedKeys: { extractedTextR2Key?: string; previewR2Key?: string } = {};
  let completionAttempted = false;
  const retireOutputAttempt = async () => {
    const retirement = await convexCall("mutation", "files:retireIngestOutputAttempt", {
      fileId,
      ingestVersion: activeIngestVersion,
      claimToken,
      outputAttemptId: derivedOutput.outputAttemptOutboxId,
    }).catch(() => null) as IngestOutputRetirement | null;
    if (retirement?.outputAttemptId) {
      await tasks.trigger(
        "jarvis-file-ingest-derived-cleanup",
        { outputAttemptId: retirement.outputAttemptId },
        { idempotencyKey: `jarvis-file-ingest-derived-cleanup-v2-${retirement.outputAttemptId}` },
      ).catch(() => undefined);
    }
    return retirement;
  };
  try {
    const original = await responseBytes(await privateR2Get(claim.r2Key), claim.sizeBytes);
    if (original.byteLength !== claim.sizeBytes) throw new FileExtractionError("stored_size_mismatch", true);
    const actualSha256 = createHash("sha256").update(original).digest("hex");
    if (actualSha256 !== claim.expectedSha256) throw new FileExtractionError("content_digest_mismatch", true);
    const duplicate = await convexCall("query", "files:readyDuplicateByHash", {
      fileId,
      sha256: actualSha256,
    }) as ReadyDuplicateRecord | null;
    // Stored-only duplicates deliberately re-run extraction. A temporarily
    // unavailable transcription provider must not permanently suppress a later
    // media analysis attempt simply because the original bytes match.
    const reused = duplicate?.file.status === "ready" ? await extractionFromDuplicate(duplicate, actualSha256) : null;
    let result = reused ?? await extractPrivateFile({ bytes: original, name: claim.originalName, mimeType: claim.mimeType });
    if (result.status === "stored_only" && result.media) {
      const preview = result.media.kind === "video"
        ? await extractVideoPreview({ bytes: original })
          // A malformed or unsupported video must remain an honest private
          // stored-only upload, never consume retries as a durable ingest error.
          .catch((error) => error instanceof MediaFrameExtractionError ? undefined : Promise.reject(error))
        : undefined;
      const transcription = await transcribePrivateMedia({ bytes: original, mimeType: claim.mimeType })
        .catch((error) => error instanceof MediaTranscriptionError ? undefined : Promise.reject(error));
      result = applyPrivateMediaAnalysis(result, {
        preview: preview ? { bytes: preview.bytes, contentType: preview.contentType, timestamps: preview.timestamps } : undefined,
        transcription,
      });
    }
    derivedKeys = await writeDerived(fileId, activeIngestVersion, claimToken, outputAttemptId, derivedOutput, result);
    completionAttempted = true;
    const completion = await convexCall("mutation", "files:completeIngest", {
      fileId,
      ingestVersion: activeIngestVersion,
      claimToken,
      outputAttemptId,
      sha256: result.sha256,
      detectedMimeType: result.detectedMimeType,
      status: result.status,
      summary: result.summary,
      extractedTextR2Key: derivedKeys.extractedTextR2Key,
      previewR2Key: derivedKeys.previewR2Key,
      extractedChars: result.text.length,
      pageCount: result.pageCount,
      sheetNames: result.sheetNames,
      chunks: result.chunks,
    }) as { ok?: boolean; reason?: string };
    if (completion?.ok === false) throw new StaleIngestCompletionError(completion.reason);
    if (completion?.ok !== true) throw new Error("completeIngest returned no durable outcome");
    return { fileId, status: result.status, chunks: result.chunks.length, extractedChars: result.text.length, reused: Boolean(reused) };
  } catch (error) {
    // completeIngest is terminal and clears its claim token. If its response is
    // lost after Convex commits, replaying it is stale and the old catch path
    // would delete the exact objects the durable row now references. Reconcile
    // the precise worker output first. Every derived-output failure path is
    // handed to a durable attempt-owned cleanup record rather than deleting
    // inline. The cleanup record was allocated before the first R2 PUT.
    const hasDerivedKeys = Boolean(derivedKeys.extractedTextR2Key || derivedKeys.previewR2Key);
    if (completionAttempted) {
      const receipt = await reconcileIngestCommit({
        fileId,
        ingestVersion: activeIngestVersion,
        outputAttemptId,
        extractedTextR2Key: derivedKeys.extractedTextR2Key,
        previewR2Key: derivedKeys.previewR2Key,
      });
      if (receipt?.committed && (receipt.status === "ready" || receipt.status === "stored_only")) {
        return { fileId, status: receipt.status, recovered: true };
      }
      const cleanup = await retireOutputAttempt();
      if (cleanup?.committed && (cleanup.status === "ready" || cleanup.status === "stored_only")) {
        return { fileId, status: cleanup.status, recovered: true };
      }
      if (error instanceof StaleIngestCompletionError && cleanup && !cleanup.missing) {
        return { fileId, stale: true, reason: error.reason, cleanupQueued: Boolean(cleanup.outputAttemptId) };
      }
      throw error;
    }
    if (hasDerivedKeys) {
      const cleanup = await retireOutputAttempt();
      if (cleanup?.committed && (cleanup.status === "ready" || cleanup.status === "stored_only")) {
        return { fileId, status: cleanup.status, recovered: true };
      }
      throw error;
    }
    const extractionError = error instanceof FileExtractionError ? error : null;
    await convexCall("mutation", "files:failIngest", {
      fileId,
      ingestVersion: activeIngestVersion,
      claimToken,
      errorCode: extractionError?.code ?? `ingest_failed:${String(error).slice(0, 80)}`,
      quarantined: extractionError?.quarantined ?? false,
    }).catch(() => undefined);
    await retireOutputAttempt().catch(() => null);
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

export const fileIngest = task({
  id: "jarvis-file-ingest",
  queue: { name: "jarvis-private-file-ingest", concurrencyLimit: 2 },
  machine: "small-1x",
  retry: { maxAttempts: 2 },
  maxDuration: 300,
  run: runFileIngest,
});

/**
 * Release-only task. It makes the V2 marker durable only after an operator
 * has stopped the old Trigger fleet, then immediately wakes uploads whose
 * pre-activation V2 tasks safely skipped. The activation timestamp is part of
 * the idempotency key so the prior skipped task cannot suppress this wake-up.
 */
export async function runFileIngestOutputProtocolV2Activation(payload: {
  triggerDeploymentVersion?: string;
}) {
  // The migration controller proves readiness from durable Convex state. This
  // task deliberately has no caller-controlled "drained" switch: an old
  // worker token or payload cannot certify an irreversible output protocol.
  const activation = await rehomeConvexCall("mutation", "files:activateIngestOutputProtocolV2", {
    triggerDeploymentVersion: payload.triggerDeploymentVersion,
  }) as IngestOutputProtocolActivation;
  const activatedAt = Math.floor(Number(activation?.activatedAt));
  if (!Number.isSafeInteger(activatedAt) || activatedAt <= 0 || activation.protocolVersion !== 2) {
    throw new Error("Convex did not return a durable V2 protocol activation");
  }
  const requeue = Array.isArray(activation.requeue) ? activation.requeue : [];
  let requeued = 0;
  for (const candidate of requeue) {
    const fileId = String(candidate?.fileId ?? "").trim();
    const ingestVersion = Math.floor(Number(candidate?.ingestVersion));
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(fileId) || !Number.isSafeInteger(ingestVersion) || ingestVersion < 1) continue;
    await tasks.trigger(
      "jarvis-file-ingest",
      { fileId, ingestVersion },
      { idempotencyKey: `jarvis-file-ingest-v2-activation-${activatedAt}-${fileId}-v${ingestVersion}` },
    );
    requeued += 1;
  }
  return {
    activated: activation.activated === true,
    activatedAt,
    requeued,
    skippedInvalidCandidates: requeue.length - requeued,
  };
}

export const fileIngestOutputProtocolV2Activation = task({
  id: "jarvis-file-ingest-output-protocol-v2-activate",
  queue: { name: "jarvis-private-file-ingest-cutover", concurrencyLimit: 1 },
  machine: "micro",
  retry: { maxAttempts: 3 },
  maxDuration: 120,
  run: runFileIngestOutputProtocolV2Activation,
});
