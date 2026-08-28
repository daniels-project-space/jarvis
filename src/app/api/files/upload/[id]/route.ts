import { createHash, randomUUID } from "node:crypto";
import { tasks } from "@trigger.dev/sdk/v3";
import type { NextRequest } from "next/server";
import { CHAT_FILE_LIMITS, normalizeUploadMime, normalizeUploadSha256 } from "@/lib/chat-files";
import { controlMutation, isSameOriginRequest } from "@/lib/control-session";
import { reportIncident } from "@/lib/context";
import { isFileIngestWakePaused } from "@/lib/file-ingest-wake";
import { privateFileObjectKey, privateR2Delete, privateR2Put } from "@/lib/private-r2";
import { actorAdminHash, controlActor, controlCredentials, isOwnerActor } from "@/lib/request-auth";

export const runtime = "nodejs";
export const maxDuration = 30;

type UploadClaim = {
  claimed: boolean;
  idempotent: boolean;
  status: string;
  r2Key?: string;
  sizeBytes?: number;
  mimeType?: string;
  expectedSha256?: string;
  ingestVersion: number;
  expiresAt?: number;
  retryAfterMs?: number;
};

class UploadBodyError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function readBoundedBody(req: Request, maxBytes: number): Promise<Uint8Array> {
  if (!req.body) throw new UploadBodyError(400, "upload body is missing");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new UploadBodyError(413, "file exceeds the 4 MB private upload limit");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  if (!total) throw new UploadBodyError(400, "upload body is empty");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export async function PUT(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  if (!isSameOriginRequest(req)) return Response.json({ error: "cross-origin upload rejected" }, { status: 403 });
  const actor = await controlActor(req);
  if (!actor) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!isOwnerActor(actor)) return Response.json({ error: "owner enrollment required" }, { status: 403 });

  const { id: fileId } = await context.params;
  const batchId = req.nextUrl.searchParams.get("batchId")?.trim() ?? "";
  const contentLength = Number(req.headers.get("content-length") ?? NaN);
  if (Number.isFinite(contentLength) && contentLength > CHAT_FILE_LIMITS.maxFileBytes) {
    return Response.json({ error: "file exceeds the 4 MB private upload limit" }, { status: 413 });
  }
  if (!batchId || !fileId) return Response.json({ error: "upload reservation is missing" }, { status: 400 });

  const contentType = normalizeUploadMime(req.headers.get("content-type"));
  const suppliedSha256 = normalizeUploadSha256(req.headers.get("x-jarvis-sha256"));
  if (!contentType || !suppliedSha256) return Response.json({ error: "upload metadata is invalid" }, { status: 409 });
  const credentials = controlCredentials(actor);
  const claimToken = randomUUID();
  const claim = await controlMutation("files:claimUpload", {
    batchId,
    fileId,
    claimToken,
    contentType,
    sha256: suppliedSha256,
    ...credentials,
  }).catch(() => null) as UploadClaim | null;
  if (!claim) return Response.json({ error: "upload reservation was not found or is no longer writable" }, { status: 409 });
  if (!claim.claimed) {
    if (claim.idempotent) return Response.json({ ok: true, fileId, status: claim.status, idempotent: true }, { headers: { "cache-control": "private, no-store" } });
    return Response.json({ error: "this upload is already in progress", retryAfterMs: claim.retryAfterMs }, {
      status: 409,
      headers: { "retry-after": String(Math.max(1, Math.ceil(Number(claim.retryAfterMs ?? 1_000) / 1_000))) },
    });
  }
  const expectedKey = privateFileObjectKey(fileId, claim.ingestVersion, "original");
  if (claim.r2Key !== expectedKey || !claim.sizeBytes || claim.expiresAt === undefined) {
    await controlMutation("files:releaseUploadClaim", { fileId, claimToken, ...credentials }).catch(() => undefined);
    return Response.json({ error: "private upload identity is invalid" }, { status: 409 });
  }
  let stored = false;
  try {
    const bytes = await readBoundedBody(req, CHAT_FILE_LIMITS.maxFileBytes);
    if (bytes.byteLength !== claim.sizeBytes) throw new UploadBodyError(409, "upload size does not match its reservation");
    const actualSha256 = createHash("sha256").update(bytes).digest("hex");
    if (actualSha256 !== claim.expectedSha256) throw new UploadBodyError(409, "upload digest does not match its reservation");
    if (claim.expiresAt <= Date.now() + 5_000) throw new UploadBodyError(409, "upload reservation expired before storage");
    const storedObject = await privateR2Put(expectedKey, bytes, contentType, { sha256: actualSha256 });
    stored = true;
    const completed = await controlMutation("files:markUploaded", {
      batchId,
      fileId,
      sizeBytes: bytes.byteLength,
      contentType,
      sha256: actualSha256,
      etag: storedObject.etag,
      claimToken,
      ...credentials,
    }) as { ok?: boolean; cancelled?: boolean; r2Keys?: string[]; ingestVersion?: number };
    if (completed?.cancelled) {
      for (const key of completed.r2Keys ?? [expectedKey]) await privateR2Delete(key);
      await controlMutation("files:finishDelete", { fileId, ...credentials });
      return Response.json({ error: "upload was cancelled" }, { status: 409 });
    }
    const ingestVersion = Number(completed?.ingestVersion ?? claim.ingestVersion);
    const wakePaused = isFileIngestWakePaused();
    const handle = wakePaused
      ? null
      : await tasks.trigger(
        "jarvis-file-ingest",
        { fileId, ingestVersion },
        { idempotencyKey: `jarvis-file-${fileId}-v${ingestVersion}` },
      ).catch(async (error) => {
        await reportIncident(
          "api/files/upload",
          `file-ingest-trigger:${fileId}:v${ingestVersion}`,
          `Private file was durably uploaded but its immediate ingest wake-up failed: ${String(error).slice(0, 240)}`,
          "jarvis",
          actorAdminHash(actor),
        );
        return null;
      });
    return Response.json({
      ok: true,
      fileId,
      status: "uploaded",
      processingScheduled: Boolean(handle),
      retryAvailable: !handle,
      ...(wakePaused ? { processingWakePaused: true } : {}),
    }, { status: 201, headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    if (!stored) await controlMutation("files:releaseUploadClaim", { fileId, claimToken, ...credentials }).catch(() => undefined);
    const status = error instanceof UploadBodyError ? error.status : 502;
    return Response.json({ error: String(error instanceof Error ? error.message : error).slice(0, 240) }, { status });
  }
}
