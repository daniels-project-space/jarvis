import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { issueForegroundOwnerToolReceipt } from "@/lib/foreground-owner-tool-receipt.server";

const mock = vi.hoisted(() => ({
  controlQuery: vi.fn(),
  controlMutation: vi.fn(),
  executeTool: vi.fn(),
  reportIncident: vi.fn(),
}));

vi.mock("@/lib/control-session", () => ({
  controlQuery: mock.controlQuery,
  controlMutation: mock.controlMutation,
}));
vi.mock("@/lib/context", () => ({ reportIncident: mock.reportIncident }));
vi.mock("@/lib/tools", () => ({
  executeTool: mock.executeTool,
  TOOL_DEFS: [
    { name: "gmail_search", description: "Search Gmail." },
    { name: "gmail_draft_reply", description: "Create a Gmail draft." },
    { name: "google_calendar_create", description: "Create an approval card." },
    { name: "work_control", description: "Must never be exposed here." },
  ],
}));

import { GET, POST } from "./route";

const DISPATCH = "d".repeat(48);
const WORKER = "w".repeat(48);
const turn = {
  messageId: "message-1",
  assistantId: "assistant-1",
  claimToken: "claim-1",
};

function receipt(operation: "discover" | "invoke", target: string, callId = "call-1") {
  return issueForegroundOwnerToolReceipt({
    secret: WORKER,
    turn,
    operation,
    target,
    callId,
    now: Date.now(),
  });
}

function request(
  method: "GET" | "POST",
  path: string,
  options: { body?: Record<string, unknown>; receipt?: string; token?: string } = {},
) {
  return new Request(`https://jarvis.test${path}`, {
    method,
    headers: {
      authorization: `Bearer ${options.token ?? DISPATCH}`,
      ...(options.receipt ? { "x-jarvis-owner-tool-receipt": options.receipt } : {}),
      ...(options.body ? { "content-type": "application/json" } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  }) as unknown as NextRequest;
}

describe("foreground owner Gmail/Google tool endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("JARVIS_DISPATCH_TOKEN", DISPATCH);
    vi.stubEnv("JARVIS_WORKER_TOKEN", WORKER);
    mock.controlQuery.mockResolvedValue({ allowed: true, toolNames: ["gmail_search"] });
    mock.controlMutation.mockResolvedValue({ allowed: true });
    mock.executeTool.mockResolvedValue("owner result");
  });

  afterEach(() => vi.unstubAllEnvs());

  it("exposes only the server-authorized fixed Gmail/Google subset", async () => {
    const response = await GET(request("GET", "/api/foreground-owner-tool?belt=work", {
      receipt: receipt("discover", "work"),
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ name: "gmail_search", description: "Search Gmail." }]);
    expect(mock.controlQuery).toHaveBeenCalledWith("chatQueue:foregroundOwnerToolDefinitionsForWorker", {
      ...turn,
      belt: "work",
      workerToken: WORKER,
    });
  });

  it("redeems the signed active turn, ignores caller provenance, and never marks it subscription-reasoned", async () => {
    const response = await POST(request("POST", "/api/foreground-owner-tool", {
      receipt: receipt("invoke", "gmail_search", "call-gmail-1"),
      body: {
        name: "gmail_search",
        args: { query: "from:hotel" },
        invocationContext: { userMessageId: "attacker-message", requestId: "attacker-request" },
      },
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: "owner result" });
    expect(mock.controlMutation).toHaveBeenCalledWith("chatQueue:redeemForegroundOwnerToolForWorker", {
      ...turn,
      callId: "call-gmail-1",
      toolName: "gmail_search",
      workerToken: WORKER,
    });
    expect(mock.executeTool).toHaveBeenCalledWith(
      "gmail_search",
      { query: "from:hotel" },
      { invocationContext: { userMessageId: "message-1" } },
    );
    expect(JSON.stringify(mock.executeTool.mock.calls)).not.toContain("_subscription_reasoner");
  });

  it("continues a redeemed provider call when cancellation lands after its commit point", async () => {
    let cancellationLandedAfterRedemption = false;
    mock.controlMutation.mockImplementation(async (name: string) => {
      if (name === "chatQueue:redeemForegroundOwnerToolForWorker") {
        // The real mutation has atomically inserted the irrevocable receipt;
        // model a cancellation landing immediately before executeTool starts.
        cancellationLandedAfterRedemption = true;
        return { allowed: true };
      }
      return { allowed: false };
    });
    mock.executeTool.mockImplementation(async () => {
      expect(cancellationLandedAfterRedemption).toBe(true);
      return "committed owner result";
    });

    const response = await POST(request("POST", "/api/foreground-owner-tool", {
      receipt: receipt("invoke", "gmail_search", "committed-call"),
      body: { name: "gmail_search", args: { query: "hotel" } },
    }));

    expect(await response.json()).toEqual({ result: "committed owner result" });
    expect(mock.executeTool).toHaveBeenCalledTimes(1);
  });

  it("fails closed for missing, mismatched, replayed, or non-allowlisted requests", async () => {
    await expect(POST(request("POST", "/api/foreground-owner-tool", {
      body: { name: "gmail_search", args: {} },
    }))).resolves.toMatchObject({ status: 403 });

    await expect(POST(request("POST", "/api/foreground-owner-tool", {
      receipt: receipt("invoke", "gmail_search"),
      body: { name: "gmail_unsubscribe", args: {} },
    }))).resolves.toMatchObject({ status: 403 });

    mock.controlMutation.mockResolvedValueOnce({ allowed: false });
    await expect(POST(request("POST", "/api/foreground-owner-tool", {
      receipt: receipt("invoke", "gmail_search", "replayed-call"),
      body: { name: "gmail_search", args: {} },
    }))).resolves.toMatchObject({ status: 403 });

    const wrongTarget = await GET(request("GET", "/api/foreground-owner-tool?belt=work", {
      receipt: receipt("discover", "core"),
    }));
    expect(wrongTarget.status).toBe(403);
    expect(mock.executeTool).not.toHaveBeenCalled();
  });
});
