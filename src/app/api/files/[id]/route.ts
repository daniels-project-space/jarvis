import type { NextRequest } from "next/server";
import { tasks } from "@trigger.dev/sdk/v3";
import { controlMutation, controlQuery, isSameOriginRequest } from "@/lib/control-session";
import { privateR2Delete, privateR2Get } from "@/lib/private-r2";
import { controlActor, controlCredentials, isOwnerActor } from "@/lib/request-auth";

export const runtime = "nodejs";
export const maxDuration = 30;

type PrivateFileRow = {
  _id: string;
  originalName: string;
  mimeType: string;
  detectedMimeType?: string;
  status: string;
  r2Key: string;
};

function disposition(name: string, download: boolean): string {
  const safe = name.replace(/[\r\n"]/g, "_").slice(0, 160) || "file";
  return `${download ? "attachment" : "inline"}; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

const SAFE_INLINE_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await controlActor(req);
  if (!actor) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!isOwnerActor(actor)) return Response.json({ error: "owner enrollment required" }, { status: 403 });
  const { id: fileId } = await context.params;
  const file = await controlQuery("files:getForOwner", { fileId, ...controlCredentials(actor) }).catch(() => null) as PrivateFileRow | null;
  if (!file || ["reserved", "deleting", "deleted"].includes(file.status)) {
    return Response.json({ error: "file not found" }, { status: 404 });
  }
  const upstream = await privateR2Get(file.r2Key, req.headers.get("range") ?? undefined).catch(() => null);
  if (!upstream || (!upstream.ok && upstream.status !== 206)) {
    return Response.json({ error: "private file content is unavailable" }, { status: 502 });
  }
  const detected = file.detectedMimeType?.toLowerCase();
  const inline = ["ready", "stored_only"].includes(file.status) && Boolean(detected && SAFE_INLINE_MIME.has(detected));
  const headers = new Headers({
    "content-type": inline ? detected! : "application/octet-stream",
    "content-disposition": disposition(file.originalName, !inline || req.nextUrl.searchParams.get("download") === "1"),
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "cross-origin-resource-policy": "same-origin",
    "accept-ranges": upstream.headers.get("accept-ranges") ?? "bytes",
  });
  for (const name of ["content-length", "content-range", "etag", "last-modified"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}

export async function DELETE(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  if (!isSameOriginRequest(req)) return Response.json({ error: "cross-origin delete rejected" }, { status: 403 });
  const actor = await controlActor(req);
  if (!actor) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!isOwnerActor(actor)) return Response.json({ error: "owner enrollment required" }, { status: 403 });
  const { id: fileId } = await context.params;
  const credentials = controlCredentials(actor);
  const begun = await controlMutation("files:beginDelete", { fileId, ...credentials }).catch(() => null) as {
    ok?: boolean;
    reason?: string;
    deferred?: boolean;
    r2Keys?: string[];
  } | null;
  if (!begun) return Response.json({ error: "file not found or busy" }, { status: 409 });
  if (!begun.ok) return Response.json({ error: begun.reason ?? "file is still referenced" }, { status: 409 });
  if (begun.deferred) {
    const queued = await tasks.trigger("jarvis-file-cleanup", { fileId }).catch(() => null);
    return queued
      ? Response.json({ ok: false, cleanupQueued: true }, { status: 202, headers: { "cache-control": "private, no-store" } })
      : Response.json({ error: "private file deletion is durable but cleanup could not be started; retry delete" }, { status: 503 });
  }
  try {
    for (const key of begun.r2Keys ?? []) await privateR2Delete(key);
    const finished = await controlMutation("files:finishDelete", { fileId, ...credentials });
    if (!finished) throw new Error("delete finalization was not acknowledged");
    return Response.json({ ok: true }, { headers: { "cache-control": "private, no-store" } });
  } catch {
    const queued = await tasks.trigger("jarvis-file-cleanup", { fileId }).catch(() => null);
    return queued
      ? Response.json({ ok: false, cleanupQueued: true }, { status: 202, headers: { "cache-control": "private, no-store" } })
      : Response.json({ error: "private file deletion is durable but cleanup could not be started; retry delete" }, { status: 503 });
  }
}
