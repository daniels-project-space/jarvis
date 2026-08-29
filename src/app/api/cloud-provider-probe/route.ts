import { tasks } from "@trigger.dev/sdk/v3";
import { NextResponse, type NextRequest } from "next/server";
import { CLOUD_PROVIDER_PROBE_CONFIRMATION } from "@/lib/cloud-provider-probe-control";
import { isSameOriginRequest } from "@/lib/control-session";
import { controlActor, isOwnerActor } from "@/lib/request-auth";
import type { cloudProviderProbeBootstrap } from "@/trigger/cloud-provider-probe-bootstrap";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 256;
const PRIVATE_HEADERS = { "cache-control": "private, no-store" };

function response(body: { ok: boolean; status: "queued" | "unavailable" }, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: PRIVATE_HEADERS });
}

/**
 * Starts exactly one owner-approved, deployment-bound provider attestation.
 * It deliberately has neither a caller-supplied task name nor a task payload.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isSameOriginRequest(req)) return response({ ok: false, status: "unavailable" }, 403);
  const actor = await controlActor(req);
  if (!actor) return response({ ok: false, status: "unavailable" }, 401);
  if (!isOwnerActor(actor)) return response({ ok: false, status: "unavailable" }, 403);

  const length = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) return response({ ok: false, status: "unavailable" }, 413);
  const body = await req.json().catch(() => null) as { confirm?: unknown } | null;
  if (body?.confirm !== CLOUD_PROVIDER_PROBE_CONFIRMATION) {
    return response({ ok: false, status: "unavailable" }, 400);
  }

  try {
    await tasks.trigger<typeof cloudProviderProbeBootstrap>("jarvis-cloud-provider-probe-bootstrap", undefined);
    return response({ ok: true, status: "queued" }, 202);
  } catch {
    return response({ ok: false, status: "unavailable" }, 503);
  }
}
