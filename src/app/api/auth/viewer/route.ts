import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  ADMIN_COOKIE,
  ADMIN_SESSION_SECONDS,
  type AdminSessionStatus,
  adminSessionHash,
  adminSessionStatus,
  controlMutation,
  isSameOriginRequest,
  sha256Hex,
} from "@/lib/control-session";
import { openOwnerSessionToken } from "@/lib/open-owner-session";
import { issueViewerToken } from "@/lib/viewer-jwt";

export const runtime = "nodejs";
const GUEST_COOKIE = "jarvis_guest";
const SESSION_REFRESH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) {
    return Response.json({ ok: false }, { status: 403 });
  }

  let ownerToken = req.cookies.get(ADMIN_COOKIE)?.value;
  let ownerTokenHash = ownerToken ? await adminSessionHash(req) : null;
  let ownerSession: AdminSessionStatus = ownerTokenHash
    ? await adminSessionStatus(ownerTokenHash)
    : { valid: false, unavailable: false } as const;
  if (!ownerSession.valid) {
    if (ownerSession.unavailable) {
      return Response.json(
        { ok: false, error: "owner_session_temporarily_unavailable" },
        { status: 503, headers: { "cache-control": "no-store" } },
      );
    }
    const workerToken = process.env.JARVIS_WORKER_TOKEN;
    if (!workerToken) {
      return Response.json(
        { ok: false, error: "owner_session_temporarily_unavailable" },
        { status: 503, headers: { "cache-control": "no-store" } },
      );
    }

    ownerToken = openOwnerSessionToken(workerToken);
    ownerTokenHash = await sha256Hex(ownerToken);
    ownerSession = await adminSessionStatus(ownerTokenHash);
    if (!ownerSession.valid) {
      if (ownerSession.unavailable) {
        return Response.json(
          { ok: false, error: "owner_session_temporarily_unavailable" },
          { status: 503, headers: { "cache-control": "no-store" } },
        );
      }
      const created = await controlMutation("controlAuth:createOpenSession", {
        ownerTokenHash,
        userAgent: req.headers.get("user-agent") ?? undefined,
        workerToken,
      }).catch(() => null) as { expiresAt?: number } | null;
      if (!created?.expiresAt) {
        return Response.json(
          { ok: false, error: "owner_session_temporarily_unavailable" },
          { status: 503, headers: { "cache-control": "no-store" } },
        );
      }
      ownerSession = { valid: true, expiresAt: created.expiresAt };
    }
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
  response.cookies.set(GUEST_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return response;
}
