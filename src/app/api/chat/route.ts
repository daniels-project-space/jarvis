import type { NextRequest } from "next/server";
import { tasks } from "@trigger.dev/sdk/v3";
import { convexMutation, convexQuery, reportIncident } from "@/lib/context";
import { actorAdminHash, controlActor, controlCredentials, type ControlActor } from "@/lib/request-auth";
import { CHAT_FILE_LIMITS } from "@/lib/chat-files";
import { visibleTurnText } from "@/lib/host-context";
import { promoteSpeculativeResearchReceipt } from "@/lib/speculative-research-receipt.server";
import { SPECULATIVE_RESEARCH_LIMITS } from "@/lib/speculative-research";

// Conversation transport only. The durable answer is produced by a trusted
// Trigger worker running Codex with Daniel's subscription; neither the browser
// nor Vercel receives the subscription credential. Convex is committed before
// the wake-up request, so the minute recovery task can drain a lost trigger.
export const runtime = "nodejs";
export const maxDuration = 30;

function guestRateLimit(error: unknown): { retryAfterMs: number } | null {
  const data = error && typeof error === "object" && "data" in error
    ? (error as { data?: unknown }).data
    : null;
  if (data && typeof data === "object" && (data as { code?: unknown }).code === "GUEST_CHAT_RATE_LIMITED") {
    return { retryAfterMs: Math.max(1_000, Number((data as { retryAfterMs?: unknown }).retryAfterMs ?? 60_000)) };
  }
  return String(error).includes("GUEST_CHAT_RATE_LIMITED") ? { retryAfterMs: 60_000 } : null;
}

function missingCombinedAdmission(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return message.includes("sendmessagewithrunnerlease") &&
    (message.includes("could not find") || message.includes("function not found") || message.includes("not a function"));
}

async function handlePost(req: NextRequest, actor: ControlActor) {
  let text = "";
  let threadId = "main";
  let requestId = "";
  let fileIds: string[] = [];
  let researchReceipt: unknown;
  try {
    const body = await req.json();
    text = String(body?.text ?? "").trim();
    threadId = String(body?.threadId ?? "main").trim() || "main";
    requestId = String(body?.requestId ?? "").trim().slice(0, 120);
    researchReceipt = body?.researchReceipt;
    if (
      researchReceipt !== undefined &&
      (typeof researchReceipt !== "string" || researchReceipt.length > SPECULATIVE_RESEARCH_LIMITS.receiptChars)
    ) {
      return Response.json({ error: "invalid research receipt" }, { status: 400 });
    }
    if (body?.fileIds !== undefined && !Array.isArray(body.fileIds)) {
      return Response.json({ error: "invalid file selection" }, { status: 400 });
    }
    fileIds = (body?.fileIds ?? []).map((fileId: unknown) => String(fileId).trim()).filter(Boolean);
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }
  if (fileIds.length > CHAT_FILE_LIMITS.maxFilesPerMessage || new Set(fileIds).size !== fileIds.length) {
    return Response.json({ error: "invalid file selection" }, { status: 400 });
  }
  if (actor.kind === "guest" && fileIds.length) return Response.json({ error: "private files require owner access" }, { status: 403 });
  if (actor.kind === "guest" && researchReceipt) return Response.json({ error: "private research requires owner access" }, { status: 403 });
  if (!text && !fileIds.length) return Response.json({ error: "empty" }, { status: 400 });
  if (!text) text = "Please analyze the attached files.";

  const adminHash = actorAdminHash(actor);
  const researchPrefetch = researchReceipt && adminHash && requestId
    ? promoteSpeculativeResearchReceipt(
        researchReceipt,
        adminHash,
        threadId,
        requestId,
        visibleTurnText(text),
      )
    : null;

  const credentials = actor.kind === "guest" ? { guestId: actor.guestId } : controlCredentials(actor);
  let messageId: unknown;
  let warm: boolean | undefined;
  try {
    const admissionArgs = {
      threadId,
      text: text.slice(0, actor.kind === "guest" ? 2_000 : 12_000),
      requestId: requestId || undefined,
      fileIds: fileIds.length ? fileIds : undefined,
      researchPrefetch: researchPrefetch ?? undefined,
      ...credentials,
    };
    const admission = await convexMutation("chatQueue:sendMessageWithRunnerLease", admissionArgs)
      .catch(async (error) => {
        // Convex is deployed before Vercel normally. During an out-of-order
        // rolling deploy, fall back only when the new function is provably
        // absent; never replay an ambiguous failed admission.
        if (!missingCombinedAdmission(error)) throw error;
        return await convexMutation("chatQueue:sendMessage", admissionArgs);
      });
    if (admission && typeof admission === "object" && "messageId" in admission) {
      messageId = (admission as { messageId: unknown }).messageId;
      const warmRunner = (admission as { warmRunner?: unknown }).warmRunner;
      if (typeof warmRunner === "boolean") warm = warmRunner;
    } else {
      // Rolling-deploy compatibility: an older Convex function returns only
      // the message Id, so retain the old read until both sides converge.
      messageId = admission;
    }
  } catch (error) {
    const limited = actor.kind === "guest" ? guestRateLimit(error) : null;
    if (!limited) throw error;
    return Response.json(
      { error: "Guest chat is busy. Wait a moment before sending another message." },
      {
        status: 429,
        headers: { "retry-after": String(Math.max(1, Math.ceil(limited.retryAfterMs / 1_000))) },
      },
    );
  }
  if (warm === undefined) {
    const lease = await convexQuery("chatQueue:runnerLease", credentials)
      .catch(() => null) as { updatedAt?: number } | null;
    warm = Boolean(lease?.updatedAt && Date.now() - lease.updatedAt < 25_000);
  }
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
    messageId: String(messageId),
    immediate: Boolean(warm || handle),
    researchPrefetchAccepted: Boolean(researchPrefetch),
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
