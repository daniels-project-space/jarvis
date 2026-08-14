import type { NextRequest } from "next/server";

import { novitaPatchProposerConfigurationReadiness } from "@/lib/novita-patch-proposer-runtime-config.server";
import { controlActor, isOwnerActor } from "@/lib/request-auth";

export const runtime = "nodejs";

const PRIVATE_HEADERS = { "cache-control": "private, no-store" };

function noStore(body: Record<string, unknown>, status = 200) {
  return Response.json(body, { status, headers: PRIVATE_HEADERS });
}

/**
 * An owner-facing explanation for a deliberately optional delegate. It is a
 * local attestation check only: no endpoint, credential, Vault read, or Novita
 * request can occur through this route.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const actor = await controlActor(req);
  if (!actor) return noStore({ ok: false }, 401);
  if (!isOwnerActor(actor)) return noStore({ ok: false, error: "owner enrollment required" }, 403);

  return noStore({ ok: true, ...novitaPatchProposerConfigurationReadiness() });
}
