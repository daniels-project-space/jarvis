import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  ADMIN_COOKIE,
  adminSessionHash,
  adminSessionStatus,
  isSameOriginRequest,
} from "@/lib/control-session";
import { issueViewerToken } from "@/lib/viewer-jwt";

export const runtime = "nodejs";
export const GUEST_COOKIE = "jarvis_guest";

export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) {
    return Response.json({ ok: false }, { status: 403 });
  }

  const ownerToken = req.cookies.get(ADMIN_COOKIE)?.value;
  const ownerSession = ownerToken
    ? await adminSessionStatus(await adminSessionHash(req))
    : { valid: false };
  if (!ownerSession.valid) {
    const response = NextResponse.json(
      { ok: false, error: "owner_pairing_required" },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
    response.cookies.set(GUEST_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
    return response;
  }

  const issued = await issueViewerToken({ kind: "owner" }).catch(() => null);
  if (!issued) return Response.json({ ok: false }, { status: 503 });

  return NextResponse.json(
    { ok: true, viewerToken: issued.token, expiresAt: issued.expiresAt, actor: "owner" },
    { headers: { "cache-control": "no-store" } },
  );
}
