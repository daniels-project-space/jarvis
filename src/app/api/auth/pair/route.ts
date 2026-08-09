import { randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  ADMIN_COOKIE,
  ADMIN_SESSION_SECONDS,
  LEGACY_ADMIN_COOKIE,
  controlMutation,
  isSameOriginRequest,
  sha256Hex,
} from "@/lib/control-session";

export const runtime = "nodejs";
const GUEST_COOKIE = "jarvis_guest";

export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) return Response.json({ ok: false }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const ticket = String(body?.ticket ?? "");
  if (!/^[A-Za-z0-9_-]{40,128}$/.test(ticket)) {
    return Response.json({ ok: false, error: "invalid_or_expired_pairing" }, { status: 401 });
  }

  const ownerToken = randomBytes(32).toString("base64url");
  const ownerTokenHash = await sha256Hex(ownerToken);
  let created: { expiresAt?: number } | null;
  try {
    created = await controlMutation("controlAuth:consumeOwnerPairingTicket", {
      tokenHash: await sha256Hex(ticket),
      ownerTokenHash,
      userAgent: req.headers.get("user-agent") ?? undefined,
    }) as { expiresAt?: number } | null;
  } catch {
    return Response.json(
      { ok: false, error: "pairing_service_temporarily_unavailable" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
  if (!created?.expiresAt) {
    return Response.json(
      { ok: false, error: "invalid_or_expired_pairing" },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }

  const legacyGuestId = req.cookies.get(GUEST_COOKIE)?.value;
  if (legacyGuestId && /^[A-Za-z0-9_-]{32,128}$/.test(legacyGuestId)) {
    await controlMutation("guestMigration:recoverGuestConversation", {
      authTokenHash: ownerTokenHash,
      guestId: legacyGuestId,
    }).catch(() => null);
  }

  const response = NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  response.cookies.set(ADMIN_COOKIE, ownerToken, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: ADMIN_SESSION_SECONDS,
  });
  response.cookies.set(LEGACY_ADMIN_COOKIE, "", { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0 });
  response.cookies.set(GUEST_COOKIE, "", { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0 });
  return response;
}
