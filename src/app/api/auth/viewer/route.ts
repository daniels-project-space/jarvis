import { randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  ADMIN_COOKIE,
  ADMIN_SESSION_SECONDS,
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

  const ownerToken = req.cookies.get(ADMIN_COOKIE)?.value;
  const authTokenHash = await adminSessionHash(req);
  if (!(await validateAdminSession(authTokenHash))) {
    return Response.json({ ok: false, error: "unpaired device" }, { status: 401 });
  }

  const refreshed = await controlMutation("controlAuth:refreshSession", { tokenHash: authTokenHash }).catch(() => null);
  if (!refreshed || !ownerToken) return Response.json({ ok: false }, { status: 503 });

  const viewerToken = randomBytes(32).toString("hex");
  const issued = await controlMutation("controlAuth:createViewerSession", {
    authTokenHash,
    viewerToken,
  }).catch(() => null) as { token?: string; expiresAt?: number } | null;
  if (!issued?.token || !issued.expiresAt) {
    return Response.json({ ok: false }, { status: 503 });
  }

  const response = NextResponse.json(
    { ok: true, viewerToken: issued.token, expiresAt: issued.expiresAt },
    { headers: { "cache-control": "no-store" } },
  );
  response.cookies.set(ADMIN_COOKIE, ownerToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: ADMIN_SESSION_SECONDS,
  });
  return response;
}
