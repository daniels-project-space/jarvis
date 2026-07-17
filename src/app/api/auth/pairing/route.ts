import { randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";
import {
  adminSessionHash,
  controlMutation,
  isSameOriginRequest,
  sha256Hex,
  validateAdminSession,
} from "@/lib/control-session";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) return Response.json({ ok: false }, { status: 403 });
  const authTokenHash = await adminSessionHash(req);
  if (!(await validateAdminSession(authTokenHash)) || !authTokenHash) {
    return Response.json({ ok: false }, { status: 401 });
  }

  const pairingToken = randomBytes(32).toString("base64url");
  const created = await controlMutation("controlAuth:createDevicePairing", {
    tokenHash: await sha256Hex(pairingToken),
    authTokenHash,
  }).catch(() => null) as { expiresAt?: number } | null;
  if (!created?.expiresAt) return Response.json({ ok: false }, { status: 503 });
  const origin = req.nextUrl.origin;
  return Response.json(
    { ok: true, url: `${origin}/#pair=${pairingToken}`, expiresAt: created.expiresAt },
    { headers: { "cache-control": "no-store" } },
  );
}
