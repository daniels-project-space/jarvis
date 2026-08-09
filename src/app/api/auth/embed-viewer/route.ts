import type { NextRequest } from "next/server";
import { isSameOriginRequest } from "@/lib/control-session";
import { controlActor, isOwnerActor } from "@/lib/request-auth";
import { issueViewerToken } from "@/lib/viewer-jwt";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) return Response.json({ ok: false }, { status: 403 });
  const actor = await controlActor(req);
  if (!actor || !isOwnerActor(actor)) return Response.json({ ok: false }, { status: 401 });
  const issued = await issueViewerToken({ kind: "owner" }).catch(() => null);
  if (!issued) return Response.json({ ok: false }, { status: 503 });
  return Response.json(
    { ok: true, viewerToken: issued.token, expiresAt: issued.expiresAt, actor: "owner" },
    { headers: { "cache-control": "no-store" } },
  );
}
