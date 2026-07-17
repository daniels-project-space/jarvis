import { randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  ADMIN_COOKIE,
  ADMIN_SESSION_SECONDS,
  controlMutation,
  isSameOriginRequest,
  sha256Hex,
} from "@/lib/control-session";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) return Response.json({ ok: false }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const pairingToken = String(body?.pairingToken ?? "");
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(pairingToken)) {
    return Response.json({ ok: false }, { status: 401 });
  }

  const ownerToken = randomBytes(32).toString("base64url");
  const accepted = await controlMutation("controlAuth:redeemDevicePairing", {
    tokenHash: await sha256Hex(pairingToken),
    ownerTokenHash: await sha256Hex(ownerToken),
    userAgent: req.headers.get("user-agent") ?? undefined,
  }).catch(() => false);
  if (accepted !== true) return Response.json({ ok: false }, { status: 401 });

  const response = NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  response.cookies.set(ADMIN_COOKIE, ownerToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: ADMIN_SESSION_SECONDS,
  });
  return response;
}
