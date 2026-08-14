import { createHash, randomUUID } from "node:crypto";
import { task } from "@trigger.dev/sdk/v3";
import { FileExtractionError, extractPrivateFile, type FileExtractionResult } from "../lib/file-extraction";
import { trustedReadyDuplicate, type ReadyDuplicateRecord } from "../lib/file-dedupe";
import { privateFileObjectKey, privateR2Delete, privateR2Get, privateR2Put } from "../lib/private-r2";
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
    if (!completion?.ok) {
      for (const key of Object.values(derivedKeys)) if (key) await privateR2Delete(key).catch(() => undefined);
      return { fileId, stale: true, reason: completion?.reason };
    }
    return { fileId, status: result.status, chunks: result.chunks.length, extractedChars: result.text.length, reused: Boolean(reused) };
  } catch (error) {
    for (const key of Object.values(derivedKeys)) if (key) await privateR2Delete(key).catch(() => undefined);
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
