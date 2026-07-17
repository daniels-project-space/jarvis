import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  ADMIN_COOKIE,
  ADMIN_SESSION_SECONDS,
  adminSessionStatus,
  adminSessionHash,
  controlMutation,
  isSameOriginRequest,
} from "@/lib/control-session";
import { issueViewerToken } from "@/lib/viewer-jwt";

export const runtime = "nodejs";
const REFRESH_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;

export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) {
    return Response.json({ ok: false }, { status: 403 });
  }

  const ownerToken = req.cookies.get(ADMIN_COOKIE)?.value;
  const authTokenHash = await adminSessionHash(req);
  const ownerSession = await adminSessionStatus(authTokenHash);
  if (!ownerSession.valid || !ownerToken || !authTokenHash) {
    return Response.json({ ok: false, error: "unpaired device" }, { status: 401 });
  }

  const refreshOwner = Number(ownerSession.expiresAt ?? 0) < Date.now() + REFRESH_WINDOW_MS;
  if (refreshOwner) {
    const refreshed = await controlMutation("controlAuth:refreshSession", { tokenHash: authTokenHash }).catch(() => null);
    if (!refreshed) return Response.json({ ok: false }, { status: 503 });
  }

  const issued = await issueViewerToken().catch(() => null);
  if (!issued) return Response.json({ ok: false }, { status: 503 });

  const response = NextResponse.json(
    { ok: true, viewerToken: issued.token, expiresAt: issued.expiresAt },
    { headers: { "cache-control": "no-store" } },
  );
  if (refreshOwner) {
    response.cookies.set(ADMIN_COOKIE, ownerToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: ADMIN_SESSION_SECONDS,
    });
  }
  return response;
}
