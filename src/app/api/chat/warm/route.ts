import type { NextRequest } from "next/server";
import { tasks } from "@trigger.dev/sdk/v3";
import { convexQuery } from "@/lib/context";
import {
  controlActor,
  controlCredentials,
  isOwnerActor,
} from "@/lib/request-auth";
import {
  foregroundDispatchFailure,
  foregroundDispatchMode,
  type ForegroundRunnerLease,
} from "@/lib/foreground-runner-mode";

export const runtime = "nodejs";
export const maxDuration = 15;

const PREWARM_BUCKET_MS = 60_000;

/**
 * Start the trusted foreground runner while Daniel is still speaking.
 *
 * This route admits no message and sends no transcript. It only advances the
 * same authenticated Trigger runner that `/api/chat` would otherwise start
 * after endpointing and transcription. The Convex lease makes duplicate wake
 * signals a cheap no-op once a runner is ready.
 */
export async function POST(req: NextRequest) {
  const actor = await controlActor(req);
  if (!actor) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!isOwnerActor(actor)) {
    return Response.json({ error: "owner enrollment required" }, { status: 403 });
  }

  const shouldReadLease = process.env.JARVIS_SELF_HOSTED_FOREGROUND === "live"
    || process.env.JARVIS_FOREGROUND_HOLD_REASON !== "trigger_billing_limit";
  const lease = shouldReadLease
    ? await convexQuery(
        "chatQueue:runnerLease",
        controlCredentials(actor),
      ).catch(() => null) as ForegroundRunnerLease
    : null;
  const dispatchMode = foregroundDispatchMode(process.env, lease);
  const dispatchFailure = foregroundDispatchFailure(dispatchMode);
  if (dispatchFailure) {
    return Response.json({
      ok: false,
      warm: false,
      code: dispatchFailure.code,
    }, { status: 503, headers: { "cache-control": "private, no-store" } });
  }

  if (dispatchMode === "selfhost") {
    return Response.json(
      { ok: true, warm: true, started: false },
      { headers: { "cache-control": "private, no-store" } },
    );
  }

  const leaseAgeMs = Date.now() - Number(lease?.updatedAt);
  const warm = Number.isFinite(leaseAgeMs) && leaseAgeMs >= 0 && leaseAgeMs < 25_000;
  if (warm) {
    return Response.json(
      { ok: true, warm: true, started: false },
      { headers: { "cache-control": "private, no-store" } },
    );
  }

  const bucket = Math.floor(Date.now() / PREWARM_BUCKET_MS);
  const handle = await tasks.trigger(
    "jarvis-chat-turn",
    { source: "voice-prewarm" },
    { idempotencyKey: `jarvis-voice-prewarm-${bucket}` },
  ).catch(() => null);

  return handle
    ? Response.json(
        { ok: true, warm: false, started: true },
        { headers: { "cache-control": "private, no-store" } },
      )
    : Response.json(
        { ok: false, warm: false, started: false },
        { status: 503, headers: { "cache-control": "private, no-store" } },
      );
}
