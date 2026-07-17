import { randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";
import { controlMutation, sha256Hex } from "@/lib/control-session";
import { validPairingRequestBearer } from "@/lib/pairing-request-auth";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const supplied = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!validPairingRequestBearer(process.env.JARVIS_PAIRING_REQUEST_TOKEN, supplied)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const dispatchToken = process.env.JARVIS_DISPATCH_TOKEN;
  if (!dispatchToken) return Response.json({ ok: false, error: "recovery unavailable" }, { status: 503 });

  const pairingToken = randomBytes(32).toString("base64url");
  const created = await controlMutation("controlAuth:createDevicePairingForDispatcher", {
    tokenHash: await sha256Hex(pairingToken),
    dispatchToken,
  }).catch(() => null) as { expiresAt?: number } | null;
  if (!created?.expiresAt) return Response.json({ ok: false, error: "recovery unavailable" }, { status: 503 });

  return Response.json(
    {
      ok: true,
      url: `https://jarvis-orcin-six.vercel.app/#pair=${pairingToken}`,
      expiresAt: created.expiresAt,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
