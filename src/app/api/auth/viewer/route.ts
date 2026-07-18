import { randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  ADMIN_COOKIE,
  ADMIN_SESSION_SECONDS,
  adminSessionStatus,
  adminSessionHash,
  controlMutation,
  isSameOriginRequest,
  sha256Hex,
} from "@/lib/control-session";
import { issueViewerToken } from "@/lib/viewer-jwt";

export const runtime = "nodejs";
const REFRESH_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;

export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) {
    return Response.json({ ok: false }, { status: 403 });
  }

  // The Hub iframe authenticates every API call with this signed capability.
  // Browsers that block third-party cookies could never retain jarvis_admin,
  // so minting a fresh one-year Convex session on every embed reload only
  // created orphan rows and delayed startup. The main app still receives the
  // cookie for routes such as direct artifact downloads.
  if (req.headers.get("x-jarvis-embed") === "1") {
    const issued = await issueViewerToken().catch(() => null);
    if (!issued) return Response.json({ ok: false }, { status: 503 });
    return NextResponse.json(
      { ok: true, viewerToken: issued.token, expiresAt: issued.expiresAt },
      { headers: { "cache-control": "no-store" } },
    );
  }

  let ownerToken = req.cookies.get(ADMIN_COOKIE)?.value;
  let authTokenHash = await adminSessionHash(req);
  let ownerSession = await adminSessionStatus(authTokenHash);
  let setOwnerCookie = false;

  if (!ownerSession.valid || !ownerToken || !authTokenHash) {
    const workerToken = process.env.JARVIS_WORKER_TOKEN;
    if (!workerToken) return Response.json({ ok: false, error: "session unavailable" }, { status: 503 });

    ownerToken = randomBytes(32).toString("base64url");
    authTokenHash = await sha256Hex(ownerToken);
    const created = await controlMutation("controlAuth:createOpenSession", {
      ownerTokenHash: authTokenHash,
      userAgent: req.headers.get("user-agent") ?? undefined,
      workerToken,
    }).catch(() => null) as { expiresAt?: number } | null;
    if (!created?.expiresAt) return Response.json({ ok: false, error: "session unavailable" }, { status: 503 });
    ownerSession = { valid: true, expiresAt: created.expiresAt };
    setOwnerCookie = true;
  }

  const refreshOwner = Number(ownerSession.expiresAt ?? 0) < Date.now() + REFRESH_WINDOW_MS;
  // The Project Hub loads JARVIS in a first-party-controlled iframe. The
  // owner session is minted only from JARVIS itself, but it must be eligible
  // to travel with that embed; SameSite=Strict silently turned every embed
  // request into an anonymous 401. Re-issue on viewer bootstrap so existing
  // devices migrate off the old Strict cookie without a sign-out/login dance.
  const needsEmbedCookie = ownerSession.valid && !!ownerToken && !!authTokenHash;
  if (refreshOwner && !setOwnerCookie) {
    const refreshed = await controlMutation("controlAuth:refreshSession", { tokenHash: authTokenHash }).catch(() => null);
    if (!refreshed) return Response.json({ ok: false }, { status: 503 });
  }

  const issued = await issueViewerToken().catch(() => null);
  if (!issued) return Response.json({ ok: false }, { status: 503 });

  const response = NextResponse.json(
    { ok: true, viewerToken: issued.token, expiresAt: issued.expiresAt },
    { headers: { "cache-control": "no-store" } },
  );
  if (setOwnerCookie || refreshOwner || needsEmbedCookie) {
    response.cookies.set(ADMIN_COOKIE, ownerToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "none",
      path: "/",
      maxAge: ADMIN_SESSION_SECONDS,
    });
  }
  return response;
}
