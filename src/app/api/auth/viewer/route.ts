import { randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";
import {
  adminSessionHash,
  controlMutation,
  isSameOriginRequest,
  validateAdminSession,
} from "@/lib/control-session";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) {
    return Response.json({ ok: false }, { status: 403 });
  }
  const authTokenHash = await adminSessionHash(req);
  if (!(await validateAdminSession(authTokenHash))) {
    return Response.json({ ok: false }, { status: 401 });
  }
  const viewerToken = randomBytes(32).toString("hex");
  const issued = await controlMutation("controlAuth:createViewerSession", {
    authTokenHash,
    viewerToken,
  }).catch(() => null) as { token?: string; expiresAt?: number } | null;
  if (!issued?.token || !issued.expiresAt) {
    return Response.json({ ok: false }, { status: 503 });
  }
  return Response.json(
    { ok: true, viewerToken: issued.token, expiresAt: issued.expiresAt },
    { headers: { "cache-control": "no-store" } },
  );
}
