import type { NextRequest } from "next/server";
import { tasks } from "@trigger.dev/sdk/v3";
import { convexMutation, convexQuery, reportIncident } from "@/lib/context";
import { actorAdminHash, controlActor, controlCredentials, type ControlActor } from "@/lib/request-auth";

// Conversation transport only. The durable answer is produced by a trusted
// Trigger worker running Codex with Daniel's subscription; neither the browser
// nor Vercel receives the subscription credential. Convex is committed before
// the wake-up request, so the minute recovery task can drain a lost trigger.
export const runtime = "nodejs";
export const maxDuration = 30;

async function handlePost(req: NextRequest, actor: ControlActor) {
  let text = "";
  let threadId = "main";
  let requestId = "";
  try {
    const body = await req.json();
    text = String(body?.text ?? "").trim();
    threadId = String(body?.threadId ?? "main").trim() || "main";
    requestId = String(body?.requestId ?? "").trim().slice(0, 120);
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }
  if (!text) return Response.json({ error: "empty" }, { status: 400 });

  const credentials = actor.kind === "guest" ? { guestId: actor.guestId } : controlCredentials(actor);
  const messageId = await convexMutation("chatQueue:sendMessage", {
    threadId,
    text: text.slice(0, 12_000),
    requestId: requestId || undefined,
    ...credentials,
  });
  const lease = actor.kind === "guest"
    ? null
    : await convexQuery("chatQueue:runnerLease", credentials).catch(() => null) as { updatedAt?: number } | null;
  const warm = Boolean(lease?.updatedAt && Date.now() - lease.updatedAt < 25_000);
  const handle = warm ? null : await tasks
    .trigger(
      "jarvis-chat-turn",
      { source: "conversation", threadId, messageId: String(messageId) },
      { idempotencyKey: `jarvis-chat-${String(messageId)}` },
    )
    .catch(async (error) => {
      await reportIncident(
        "api/chat",
        `chat-trigger:${String(messageId)}`,
        `Immediate subscription wake-up failed; durable recovery remains queued: ${String(error).slice(0, 300)}`,
        undefined,
        actorAdminHash(actor),
      );
      return null;
    });

  return Response.json({
    ok: true,
    queued: true,
    immediate: Boolean(warm || handle),
    model: "codex-adaptive",
  });
}

export async function POST(req: NextRequest) {
  const actor = await controlActor(req);
  if (!actor) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    return await handlePost(req, actor);
  } catch (error) {
    if (/worker capability is unavailable/i.test(String(error))) {
      return Response.json({ error: "conversation transport unavailable" }, { status: 503 });
    }
    throw error;
  }
}
