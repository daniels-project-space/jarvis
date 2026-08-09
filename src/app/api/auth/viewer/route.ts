import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  ADMIN_COOKIE,
  ADMIN_SESSION_SECONDS,
  adminSessionHash,
  adminSessionStatus,
  controlMutation,
  isSameOriginRequest,
} from "@/lib/control-session";
import { issueViewerToken } from "@/lib/viewer-jwt";

export const runtime = "nodejs";
const GUEST_COOKIE = "jarvis_guest";
const SESSION_REFRESH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) {
    return Response.json({ ok: false }, { status: 403 });
  }

  const ownerToken = req.cookies.get(ADMIN_COOKIE)?.value;
  const ownerTokenHash = ownerToken ? await adminSessionHash(req) : null;
  const ownerSession = ownerTokenHash
    ? await adminSessionStatus(ownerTokenHash)
    : { valid: false, unavailable: false } as const;
  if (!ownerSession.valid) {
    if (ownerSession.unavailable) {
      return Response.json(
        { ok: false, error: "owner_session_temporarily_unavailable" },
        { status: 503, headers: { "cache-control": "no-store" } },
      );
    }
    const response = NextResponse.json(
      { ok: false, error: "owner_pairing_required" },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
    response.cookies.set(GUEST_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
    return response;
  }

  const issued = await issueViewerToken({ kind: "owner" }).catch(() => null);
  if (!issued) return Response.json({ ok: false }, { status: 503 });

  if (ownerTokenHash && ownerSession.expiresAt <= Date.now() + SESSION_REFRESH_WINDOW_MS) {
    // One bounded write near expiry keeps an actively used owner device valid
    // indefinitely without adding a mutation to normal viewer refreshes.
    await controlMutation("controlAuth:refreshSession", { tokenHash: ownerTokenHash }).catch(() => null);
  }

  const response = NextResponse.json(
    { ok: true, viewerToken: issued.token, expiresAt: issued.expiresAt, actor: "owner" },
    { headers: { "cache-control": "no-store" } },
  );
  // Slide the browser cookie on every successful viewer refresh. This is only a
  // response header and adds no Convex/Trigger billing.
  response.cookies.set(ADMIN_COOKIE, ownerToken!, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: ADMIN_SESSION_SECONDS,
  });
  return response;
}
