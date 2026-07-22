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

function guestId(value: string | undefined): string | null {
  return value && /^[A-Za-z0-9_-]{32,128}$/.test(value) ? value : null;
}

export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) {
    return Response.json({ ok: false }, { status: 403 });
  }

  const ownerToken = req.cookies.get(ADMIN_COOKIE)?.value;
  const ownerSession = ownerToken
    ? await adminSessionStatus(await adminSessionHash(req))
    : { valid: false };
  const owner = ownerSession.valid;
  const existingGuest = guestId(req.cookies.get(GUEST_COOKIE)?.value);
  const newGuest = existingGuest ?? crypto.randomUUID().replace(/-/g, "");
  const issued = await issueViewerToken(owner ? { kind: "owner" } : { kind: "guest", guestId: newGuest }).catch(() => null);
  if (!issued) return Response.json({ ok: false }, { status: 503 });

  const response = NextResponse.json(
    { ok: true, viewerToken: issued.token, expiresAt: issued.expiresAt, actor: owner ? "owner" : "guest" },
    { headers: { "cache-control": "no-store" } },
  );
  if (!owner && !existingGuest) {
    // Do not make this cookie a control credential. It only makes anonymous
    // conversation history stable inside this browser partition.
    response.cookies.set(GUEST_COOKIE, newGuest, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 7 * 24 * 60 * 60,
    });
  }
  return response;
}
