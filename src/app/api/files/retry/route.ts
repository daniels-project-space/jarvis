import { tasks } from "@trigger.dev/sdk/v3";
import type { NextRequest } from "next/server";
import { controlMutation, isSameOriginRequest } from "@/lib/control-session";
import { isFileIngestWakePaused } from "@/lib/file-ingest-wake";
import { controlActor, controlCredentials, isOwnerActor } from "@/lib/request-auth";

export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) return Response.json({ error: "cross-origin retry rejected" }, { status: 403 });
  const actor = await controlActor(req);
  if (!actor) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!isOwnerActor(actor)) return Response.json({ error: "owner enrollment required" }, { status: 403 });
  const body = await req.json().catch(() => null) as { fileId?: unknown } | null;
  const fileId = String(body?.fileId ?? "");
  if (!fileId) return Response.json({ error: "file id is required" }, { status: 400 });
  const retry = await controlMutation("files:retryIngest", { fileId, ...controlCredentials(actor) }).catch(() => null) as {
    fileId: string;
    ingestVersion: number;
  } | null;
  if (!retry) return Response.json({ error: "file cannot be retried" }, { status: 409 });
  const wakePaused = isFileIngestWakePaused();
  if (!wakePaused) {
    await tasks.trigger("jarvis-file-ingest", retry, {
      idempotencyKey: `jarvis-file-${retry.fileId}-v${retry.ingestVersion}`,
    });
  }
  return Response.json({
    ok: true,
    status: "uploaded",
    processingScheduled: !wakePaused,
    ...(wakePaused ? { processingWakePaused: true } : {}),
  }, { status: 202, headers: { "cache-control": "private, no-store" } });
}
