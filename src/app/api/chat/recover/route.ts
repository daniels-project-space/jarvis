import type { NextRequest } from "next/server";
import { tasks } from "@trigger.dev/sdk/v3";
import { convexMutation, reportIncident } from "@/lib/context";
import { actorAdminHash, controlActor, controlCredentials } from "@/lib/request-auth";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const actor = await controlActor(req);
  if (!actor) return Response.json({ error: "unauthorized" }, { status: 401 });

  let messageId = "";
  let threadId = "main";
  try {
    const body = await req.json();
    messageId = String(body?.messageId ?? "").trim();
    threadId = String(body?.threadId ?? "main").trim() || "main";
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }
  if (!messageId) return Response.json({ error: "messageId is required" }, { status: 400 });

  const credentials = actor.kind === "guest" ? { guestId: actor.guestId } : controlCredentials(actor);
  const recovery = await convexMutation("chatQueue:requestRecovery", {
    messageId,
    threadId,
    ...credentials,
  }) as { status: string; messageId?: string; attemptCount?: number; dispatchEpoch?: number };

  if (recovery.status === "missing") return Response.json({ error: "turn not found" }, { status: 404 });
  if (recovery.status === "cancelled") {
    return Response.json({ ok: false, recovery: "cancelled" }, { status: 409 });
  }
  if (recovery.status === "failed") {
    return Response.json({ ok: false, recovery: "failed", attemptCount: recovery.attemptCount }, { status: 409 });
  }

  let handle: { id: string } | null = null;
  if (recovery.status === "pending" || recovery.status === "requeued") {
    handle = await tasks.trigger(
      "jarvis-chat-turn",
      { source: "recovery", threadId, messageId: recovery.messageId ?? messageId },
      { idempotencyKey: `jarvis-chat-recovery-${messageId}-${recovery.dispatchEpoch ?? 0}` },
    ).catch(async (error) => {
      await reportIncident(
        "api/chat/recover",
        `chat-recovery:${messageId}:${recovery.dispatchEpoch ?? 0}`,
        `Foreground recovery wake-up failed: ${String(error).slice(0, 300)}`,
        undefined,
        actorAdminHash(actor),
      );
      return null;
    });
  }

  if ((recovery.status === "pending" || recovery.status === "requeued") && !handle) {
    return Response.json({
      ok: false,
      error: "recovery wake-up unavailable",
      recovery: recovery.status,
      attemptCount: recovery.attemptCount,
      dispatchEpoch: recovery.dispatchEpoch,
    }, { status: 503 });
  }

  return Response.json({
    ok: true,
    recovery: recovery.status,
    attemptCount: recovery.attemptCount,
    dispatchEpoch: recovery.dispatchEpoch,
    immediate: Boolean(handle) || recovery.status === "active" || recovery.status === "completed",
  });
}
