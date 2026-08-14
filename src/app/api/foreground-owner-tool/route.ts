import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { controlMutation, controlQuery } from "@/lib/control-session";
import { reportIncident } from "@/lib/context";
import {
  verifyForegroundOwnerToolReceipt,
  type ForegroundOwnerToolReceiptPayload,
} from "@/lib/foreground-owner-tool-receipt.server";
import {
  FOREGROUND_OWNER_TOOL_NAMES,
  TOOL_BELTS,
  isForegroundOwnerToolName,
  isToolBeltName,
  slimToolDefinition,
} from "@/lib/tool-belts";
import { TOOL_DEFS, executeTool } from "@/lib/tools";

export const runtime = "nodejs";
export const maxDuration = 120;

const OWNER_RECEIPT_HEADER = "x-jarvis-owner-tool-receipt";

function dispatchAuthorized(req: NextRequest): boolean {
  const expected = process.env.JARVIS_DISPATCH_TOKEN ?? "";
  const supplied = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!expected || expected.length !== supplied.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
}

function workerToken(): string | null {
  const token = process.env.JARVIS_WORKER_TOKEN ?? "";
  return token.length >= 32 ? token : null;
}

function receiptFor(
  req: NextRequest,
  operation: "discover" | "invoke",
  target: string,
): ForegroundOwnerToolReceiptPayload | null {
  const secret = workerToken();
  if (!secret) return null;
  const receipt = verifyForegroundOwnerToolReceipt(req.headers.get(OWNER_RECEIPT_HEADER), secret);
  if (!receipt || receipt.operation !== operation || receipt.target !== target) return null;
  return receipt;
}

function resultArgs(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export async function GET(req: NextRequest) {
  if (!dispatchAuthorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const requestedBelt = new URL(req.url).searchParams.get("belt") ?? "core";
  if (!isToolBeltName(requestedBelt)) {
    return Response.json({ error: "owner foreground tool access denied" }, { status: 403 });
  }
  const receipt = receiptFor(req, "discover", requestedBelt);
  const worker = workerToken();
  if (!receipt || !worker) {
    return Response.json({ error: "owner foreground tool access denied" }, { status: 403 });
  }
  try {
    const gate = await controlQuery("chatQueue:foregroundOwnerToolDefinitionsForWorker", {
      messageId: receipt.messageId,
      assistantId: receipt.assistantId,
      claimToken: receipt.claimToken,
      belt: requestedBelt,
      workerToken: worker,
    }) as { allowed?: boolean; toolNames?: unknown };
    const allowedNames = Array.isArray(gate?.toolNames)
      ? gate.toolNames.filter((name): name is string => typeof name === "string" && isForegroundOwnerToolName(name))
      : [];
    if (!gate?.allowed || !allowedNames.length) {
      return Response.json({ error: "owner foreground tool access denied" }, { status: 403 });
    }
    return Response.json(
      TOOL_DEFS
        .filter((tool) => TOOL_BELTS[requestedBelt].has(tool.name) && allowedNames.includes(tool.name))
        .map(slimToolDefinition),
    );
  } catch {
    await reportIncident("api/foreground-owner-tool", "owner-tool-discovery-failed", "Owner foreground tool discovery could not be verified.");
    return Response.json({ error: "owner foreground tool access denied" }, { status: 403 });
  }
}

export async function POST(req: NextRequest) {
  if (!dispatchAuthorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  let toolName = "unknown";
  try {
    const body = await req.json();
    toolName = String(body?.name ?? "").trim();
    if (!isForegroundOwnerToolName(toolName) || !FOREGROUND_OWNER_TOOL_NAMES.has(toolName)) {
      return Response.json({ result: "Tool unavailable to this foreground owner conversation." }, { status: 403 });
    }
    const receipt = receiptFor(req, "invoke", toolName);
    const worker = workerToken();
    if (!receipt || !worker) {
      return Response.json({ result: "Tool unavailable to this foreground owner conversation." }, { status: 403 });
    }
    const gate = await controlMutation("chatQueue:redeemForegroundOwnerToolForWorker", {
      messageId: receipt.messageId,
      assistantId: receipt.assistantId,
      claimToken: receipt.claimToken,
      callId: receipt.callId,
      toolName,
      workerToken: worker,
    }) as { allowed?: boolean };
    if (!gate?.allowed) {
      return Response.json({ result: "Tool unavailable to this foreground owner conversation." }, { status: 403 });
    }
    // A successful redemption is the provider-call linearization point. Do
    // not add a second cancellation check here: cancellation can race after
    // this atomic commit, and pretending it revoked a call would be false.
    // Do not accept caller-supplied invocation context. The receipt already
    // reconstructed the immutable owner message, while no browser auth hash or
    // `_subscription_reasoner` ever crosses into this route.
    const result = await executeTool(toolName, resultArgs(body?.args), {
      invocationContext: { userMessageId: receipt.messageId },
    });
    return Response.json({ result });
  } catch {
    // Deliberately do not reflect receipt data or upstream provider errors to
    // the model transcript. Calendar writes remain approval cards inside
    // executeTool; this endpoint never clicks the external approval route.
    await reportIncident("api/foreground-owner-tool", `owner-tool:${toolName.slice(0, 120)}`, "Owner foreground tool execution failed.");
    return Response.json({ result: "Owner foreground tool execution failed." }, { status: 200 });
  }
}
