import type { NextRequest } from "next/server";
import { hubContextReadiness } from "@/lib/hub-context";
import { controlActor, isOwnerActor } from "@/lib/request-auth";

export const runtime = "nodejs";

const PRIVATE_HEADERS = { "cache-control": "private, no-store" };

function noStore(body: Record<string, unknown>, status = 200) {
  return Response.json(body, { status, headers: PRIVATE_HEADERS });
}

/**
 * This is intentionally a configuration readiness check, not a probe carrying
 * the capability. It lets the owner see why cross-app context is unavailable
 * without disclosing any credential or making another Hub read on every panel
 * render.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const actor = await controlActor(req);
  if (!actor) return noStore({ ok: false }, 401);
  if (!isOwnerActor(actor)) return noStore({ ok: false, error: "owner enrollment required" }, 403);

  return noStore({ ok: true, ...hubContextReadiness() });
}
