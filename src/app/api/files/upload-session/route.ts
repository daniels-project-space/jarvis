import type { NextRequest } from "next/server";
import { controlMutation, isSameOriginRequest } from "@/lib/control-session";
import { CHAT_FILE_LIMITS, type UploadFileDescriptor } from "@/lib/chat-files";
import { assertPrivateR2Configured } from "@/lib/private-r2";
import { controlActor, controlCredentials, isOwnerActor } from "@/lib/request-auth";

export const runtime = "nodejs";

type ReservedBatch = {
  batchId: string;
  expiresAt: number;
  files: Array<{
    clientId: string;
    fileId: string;
    name: string;
    relativePath: string;
    mimeType: string;
    sizeBytes: number;
    status: string;
  }>;
};

const MAX_MANIFEST_BYTES = 128 * 1024;

class UploadManifestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function readUploadManifest(req: NextRequest): Promise<{
  requestId?: unknown;
  threadId?: unknown;
  files?: unknown;
}> {
  if (!req.body) throw new UploadManifestError(400, "upload manifest is missing");
  const reader = req.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  let text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_MANIFEST_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new UploadManifestError(413, "upload manifest is too large");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new UploadManifestError(400, "invalid upload manifest");
    }
    return parsed as { requestId?: unknown; threadId?: unknown; files?: unknown };
  } catch (error) {
    if (error instanceof UploadManifestError) throw error;
    throw new UploadManifestError(400, "invalid upload manifest");
  } finally {
    reader.releaseLock();
  }
}

export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) return Response.json({ error: "cross-origin upload rejected" }, { status: 403 });
  const actor = await controlActor(req);
  if (!actor) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!isOwnerActor(actor)) return Response.json({ error: "owner enrollment required" }, { status: 403 });

  // Do not create durable reservations that can never reach their required
  // private destination.
  try {
    await assertPrivateR2Configured();
  } catch {
    return Response.json({ error: "private file storage is unavailable" }, { status: 503 });
  }

  const declaredLength = Number(req.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_MANIFEST_BYTES) return Response.json({ error: "upload manifest is too large" }, { status: 413 });
  let body: Awaited<ReturnType<typeof readUploadManifest>>;
  try {
    body = await readUploadManifest(req);
  } catch (error) {
    const status = error instanceof UploadManifestError ? error.status : 400;
    return Response.json({ error: error instanceof Error ? error.message : "invalid upload manifest" }, { status });
  }
  if (!Array.isArray(body.files)) return Response.json({ error: "invalid upload manifest" }, { status: 400 });

  const files = body.files.slice(0, CHAT_FILE_LIMITS.maxFilesPerBatch + 1) as UploadFileDescriptor[];
  try {
    const batch = await controlMutation("files:reserveBatch", {
      requestId: String(body.requestId ?? ""),
      threadId: String(body.threadId ?? "main"),
      files,
      ...controlCredentials(actor),
    }) as ReservedBatch;
    return Response.json({
      ok: true,
      batchId: batch.batchId,
      expiresAt: batch.expiresAt,
      limits: {
        maxFileBytes: CHAT_FILE_LIMITS.maxFileBytes,
        maxBatchBytes: CHAT_FILE_LIMITS.maxBatchBytes,
        maxFilesPerBatch: CHAT_FILE_LIMITS.maxFilesPerBatch,
      },
      files: batch.files.map((file) => ({
        ...file,
        uploadUrl: `/api/files/upload/${encodeURIComponent(file.fileId)}?batchId=${encodeURIComponent(batch.batchId)}`,
      })),
    }, { status: 201, headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return Response.json({ error: String(error).slice(0, 240) }, { status: 409 });
  }
}
