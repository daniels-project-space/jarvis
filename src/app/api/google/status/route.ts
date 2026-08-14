import type { NextRequest } from "next/server";

import { isGoogleOAuthConfigurationReady } from "@/lib/google-oauth";
import { controlActor, isOwnerActor } from "@/lib/request-auth";

export const runtime = "nodejs";

const PRIVATE_HEADERS = { "cache-control": "private, no-store" };

function noStore(body: Record<string, unknown>, status = 200) {
  return Response.json(body, { status, headers: PRIVATE_HEADERS });
}

/**
 * Owner-only, non-secret state for the UI. This deliberately checks only
 * local server configuration; it neither loads the encrypted refresh token
 * nor asks Google to refresh it whenever the Options panel opens.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const actor = await controlActor(req);
  if (!actor) return noStore({ ok: false }, 401);
  if (!isOwnerActor(actor)) return noStore({ ok: false, error: "owner enrollment required" }, 403);

  return noStore({ ok: true, configured: isGoogleOAuthConfigurationReady() });
}
