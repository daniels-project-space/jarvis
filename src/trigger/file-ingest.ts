import { createHash, randomUUID } from "node:crypto";
import { task, tasks } from "@trigger.dev/sdk/v3";
import { FileExtractionError, extractPrivateFile, type FileExtractionResult } from "../lib/file-extraction";
import { trustedReadyDuplicate, type ReadyDuplicateRecord } from "../lib/file-dedupe";
import { privateFileObjectKey, privateR2Get, privateR2Put } from "../lib/private-r2";
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
};
type IngestCommitReceipt = {
  committed?: boolean;
  status?: "ready" | "stored_only";
};
type IngestCleanupEnqueue = IngestCommitReceipt & {
  outboxId?: string;
  waiting?: boolean;
  enqueued?: boolean;
  conflict?: boolean;
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

async function responseBytes(response: Response, expectedMax: number): Promise<Uint8Array> {
  if (!response.ok) throw new Error(`private object read failed (${response.status})`);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > expectedMax) throw new Error("private object exceeded its durable size bound");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.byteLength || bytes.byteLength > expectedMax) throw new Error("private object exceeded its durable size bound");
  return bytes;
}

async function writeDerived(fileId: string, version: number, result: FileExtractionResult) {
  const keys: { extractedTextR2Key?: string; previewR2Key?: string } = {};
  if (result.text) {
    keys.extractedTextR2Key = privateFileObjectKey(fileId, version, "extracted.txt");
    await privateR2Put(keys.extractedTextR2Key, result.text, "text/plain");
  }
  if (result.preview) {
    keys.previewR2Key = privateFileObjectKey(fileId, version, "preview.webp");
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
  const claimToken = randomUUID();
  const claim = await convexCall("mutation", "files:claimIngest", { fileId, ingestVersion, claimToken }) as ClaimedFile | null;
  if (!claim) return { fileId, skipped: true };

  let heartbeatBusy = false;
  const heartbeat = setInterval(() => {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    void convexCall("mutation", "files:heartbeatIngest", { fileId, ingestVersion, claimToken })
      .catch(() => undefined)
      .finally(() => { heartbeatBusy = false; });
  }, 30_000);
  let derivedKeys: { extractedTextR2Key?: string; previewR2Key?: string } = {};
  let completionAttempted = false;
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
    derivedKeys = await writeDerived(fileId, ingestVersion, result);
    completionAttempted = true;
    const completion = await convexCall("mutation", "files:completeIngest", {
      fileId,
      ingestVersion,
      claimToken,
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
    // handed to a durable, exact cleanup outbox rather than deleting inline.
    const hasDerivedKeys = Boolean(derivedKeys.extractedTextR2Key || derivedKeys.previewR2Key);
    if (completionAttempted) {
      const receipt = await reconcileIngestCommit({
        fileId,
        ingestVersion,
        extractedTextR2Key: derivedKeys.extractedTextR2Key,
        previewR2Key: derivedKeys.previewR2Key,
      });
      if (receipt?.committed && (receipt.status === "ready" || receipt.status === "stored_only")) {
        return { fileId, status: receipt.status, recovered: true };
      }
      const cleanup = await convexCall("mutation", "files:enqueueIngestDerivedCleanup", {
        fileId,
        ingestVersion,
        claimToken,
        extractedTextR2Key: derivedKeys.extractedTextR2Key,
        previewR2Key: derivedKeys.previewR2Key,
      }).catch(() => null) as IngestCleanupEnqueue | null;
      if (cleanup?.committed && (cleanup.status === "ready" || cleanup.status === "stored_only")) {
        return { fileId, status: cleanup.status, recovered: true };
      }
      if (cleanup?.outboxId) {
        await tasks.trigger(
          "jarvis-file-ingest-derived-cleanup",
          { outboxId: cleanup.outboxId },
          { idempotencyKey: `jarvis-file-ingest-derived-cleanup-${cleanup.outboxId}` },
        ).catch(() => undefined);
      }
      if (error instanceof StaleIngestCompletionError && cleanup && !cleanup.conflict) {
        return { fileId, stale: true, reason: error.reason, cleanupQueued: Boolean(cleanup.outboxId) };
      }
      throw error;
    }
    if (hasDerivedKeys) {
      const cleanup = await convexCall("mutation", "files:enqueueIngestDerivedCleanup", {
        fileId,
        ingestVersion,
        claimToken,
        extractedTextR2Key: derivedKeys.extractedTextR2Key,
        previewR2Key: derivedKeys.previewR2Key,
      }).catch(() => null) as IngestCleanupEnqueue | null;
      if (cleanup?.committed && (cleanup.status === "ready" || cleanup.status === "stored_only")) {
        return { fileId, status: cleanup.status, recovered: true };
      }
      if (cleanup?.outboxId) {
        await tasks.trigger(
          "jarvis-file-ingest-derived-cleanup",
          { outboxId: cleanup.outboxId },
          { idempotencyKey: `jarvis-file-ingest-derived-cleanup-${cleanup.outboxId}` },
        ).catch(() => undefined);
      }
      throw error;
    }
    const extractionError = error instanceof FileExtractionError ? error : null;
    await convexCall("mutation", "files:failIngest", {
      fileId,
      ingestVersion,
      claimToken,
      errorCode: extractionError?.code ?? `ingest_failed:${String(error).slice(0, 80)}`,
      quarantined: extractionError?.quarantined ?? false,
    }).catch(() => undefined);
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
