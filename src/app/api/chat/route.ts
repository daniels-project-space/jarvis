import type { NextRequest } from "next/server";
import { tasks } from "@trigger.dev/sdk/v3";
import { convexMutation, reportIncident } from "@/lib/context";
import { adminSessionHash, validateAdminSession } from "@/lib/control-session";
import { withAdminSession } from "@/lib/control-context";

// Conversation transport only. The durable answer is produced by a trusted
// Trigger worker running Codex with Daniel's subscription; neither the browser
// nor Vercel receives the subscription credential. Convex is committed before
// the wake-up request, so the minute recovery task can drain a lost trigger.
export const runtime = "nodejs";
export const maxDuration = 30;

async function handlePost(req: NextRequest, authTokenHash: string) {
  let text = "";
  let threadId = "main";
  try {
    const body = await req.json();
    text = String(body?.text ?? "").trim();
    threadId = String(body?.threadId ?? "main").trim() || "main";
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }
  if (!text) return Response.json({ error: "empty" }, { status: 400 });

  const messageId = await convexMutation("chatQueue:sendMessage", {
    threadId,
    text: text.slice(0, 12_000),
    authTokenHash,
  });
  const handle = await tasks
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
        authTokenHash,
      );
      return null;
    });

  return Response.json({
    ok: true,
    queued: true,
    immediate: Boolean(handle),
    model: "codex-adaptive",
  });
}

export async function POST(req: NextRequest) {
  const authTokenHash = await adminSessionHash(req);
  if (!authTokenHash || !(await validateAdminSession(authTokenHash))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return withAdminSession(authTokenHash, () => handlePost(req, authTokenHash));
}
