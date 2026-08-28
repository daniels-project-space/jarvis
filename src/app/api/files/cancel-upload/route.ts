import type { NextRequest } from "next/server";
import { tasks } from "@trigger.dev/sdk/v3";
import { controlMutation, isSameOriginRequest } from "@/lib/control-session";
import { isFileIngestCutoverPaused } from "@/lib/file-ingest-wake";
import { privateR2Delete } from "@/lib/private-r2";
import { controlActor, controlCredentials, isOwnerActor } from "@/lib/request-auth";

export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) return Response.json({ error: "cross-origin cancellation rejected" }, { status: 403 });
  const actor = await controlActor(req);
  if (!actor) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!isOwnerActor(actor)) return Response.json({ error: "owner enrollment required" }, { status: 403 });
  if (isFileIngestCutoverPaused()) {
    return Response.json({ error: "upload cancellation is temporarily paused during the ingest protocol cutover" }, {
      status: 503,
      headers: { "retry-after": "60", "cache-control": "private, no-store" },
    });
  }
  const body = await req.json().catch(() => null) as { batchId?: unknown } | null;
  const batchId = String(body?.batchId ?? "");
  if (!batchId) return Response.json({ error: "upload batch is required" }, { status: 400 });
  const credentials = controlCredentials(actor);
  const cancelled = await controlMutation("files:cancelBatch", { batchId, ...credentials }).catch(() => null) as {
    retired: number;
    cleanup: Array<{ fileId: string; r2Keys: string[]; deferred: boolean }>;
  } | null;
  if (!cancelled) return Response.json({ error: "upload batch could not be cancelled" }, { status: 409 });
  const queued: string[] = [];
  for (const cleanup of cancelled.cleanup) {
    let completed = false;
    if (!cleanup.deferred) {
      try {
        await Promise.all(cleanup.r2Keys.map((key) => privateR2Delete(key)));
        completed = Boolean(await controlMutation("files:finishDelete", { fileId: cleanup.fileId, ...credentials }));
      } catch {
        completed = false;
      }
    }
    if (!completed) {
      const handle = await tasks.trigger("jarvis-file-cleanup", { fileId: cleanup.fileId }).catch(() => null);
      if (!handle) return Response.json({ error: "cleanup is durable but its worker could not be started; retry cancellation" }, { status: 503 });
      queued.push(cleanup.fileId);
    }
  }
  return Response.json({ ok: true, retired: cancelled.retired, cleanupQueued: queued.length }, {
    status: queued.length ? 202 : 200,
    headers: { "cache-control": "private, no-store" },
  });
}
