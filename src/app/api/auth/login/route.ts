import { randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  ADMIN_COOKIE,
  ADMIN_SESSION_SECONDS,
  controlMutation,
  sha256Hex,
} from "@/lib/control-session";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const password = String(body?.password ?? "");
  if (!password || password.length > 256) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const token = randomBytes(32).toString("base64url");
  const tokenHash = await sha256Hex(token);
  const accepted = await controlMutation("controlAuth:createSession", {
    password,
    tokenHash,
    userAgent: req.headers.get("user-agent") ?? undefined,
  }).catch(() => false);
  if (accepted !== true) {
    // Keep the response deliberately generic: neither deployment state nor
    // password correctness should be distinguishable from the public edge.
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const response = NextResponse.json({ ok: true });
  response.cookies.set(ADMIN_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: ADMIN_SESSION_SECONDS,
  });
  return response;
}
