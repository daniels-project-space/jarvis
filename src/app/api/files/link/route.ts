import type { NextRequest } from "next/server";
import { controlMutation, isSameOriginRequest } from "@/lib/control-session";
import { controlActor, controlCredentials, isOwnerActor } from "@/lib/request-auth";

export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) return Response.json({ error: "cross-origin link rejected" }, { status: 403 });
  const actor = await controlActor(req);
  if (!actor) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!isOwnerActor(actor)) return Response.json({ error: "owner enrollment required" }, { status: 403 });
  const body = await req.json().catch(() => null) as { fileId?: unknown; threadId?: unknown } | null;
  const fileId = String(body?.fileId ?? "");
  const threadId = String(body?.threadId ?? "main");
  if (!fileId || !threadId) return Response.json({ error: "file and chat are required" }, { status: 400 });
  const linkId = await controlMutation("files:linkToThread", {
    fileId,
    threadId,
    ...controlCredentials(actor),
  }).catch(() => null);
  return linkId
    ? Response.json({ ok: true, linkId }, { headers: { "cache-control": "private, no-store" } })
    : Response.json({ error: "file could not be linked to this chat" }, { status: 409 });
}
