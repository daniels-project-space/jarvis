import { randomBytes, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { ADMIN_COOKIE, ADMIN_SESSION_SECONDS, controlMutation, isSameOriginRequest, sha256Hex } from "@/lib/control-session";

export const runtime = "nodejs";

function matchesEnrollmentToken(supplied: string, configured: string): boolean {
  if (!configured || supplied.length !== configured.length) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(configured));
}

// This is deliberately the one external identity boundary. Until an operator
// supplies a separately provisioned enrollment token, every browser remains a
// guest; merely loading Jarvis can never create an owner session.
export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) return Response.json({ ok: false }, { status: 403 });
  const configured = process.env.JARVIS_OWNER_ENROLLMENT_TOKEN ?? "";
  const body = await req.json().catch(() => ({}));
  if (!matchesEnrollmentToken(String(body?.token ?? ""), configured)) {
    return Response.json({ ok: false }, { status: configured ? 401 : 503 });
  }
  const workerToken = process.env.JARVIS_WORKER_TOKEN;
  if (!workerToken) return Response.json({ ok: false }, { status: 503 });
  const ownerToken = randomBytes(32).toString("base64url");
  const created = await controlMutation("controlAuth:createOpenSession", {
    ownerTokenHash: await sha256Hex(ownerToken),
    userAgent: req.headers.get("user-agent") ?? undefined,
    workerToken,
  }).catch(() => null) as { expiresAt?: number } | null;
  if (!created?.expiresAt) return Response.json({ ok: false }, { status: 503 });
  const response = NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  response.cookies.set(ADMIN_COOKIE, ownerToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: ADMIN_SESSION_SECONDS,
  });
  return response;
}
