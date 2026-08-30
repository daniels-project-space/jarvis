import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

const mock = vi.hoisted(() => ({
  controlActor: vi.fn(),
  controlCredentials: vi.fn(),
  actorAdminHash: vi.fn(),
  convexMutation: vi.fn(),
  convexQuery: vi.fn(),
  trigger: vi.fn(),
  getSecret: vi.fn(),
  executeTool: vi.fn(),
  privateR2Put: vi.fn(),
}));

vi.mock("@/lib/request-auth", () => ({
  controlActor: mock.controlActor,
  controlCredentials: mock.controlCredentials,
  actorAdminHash: mock.actorAdminHash,
  isOwnerActor: (actor: { kind?: string }) => actor.kind === "owner",
}));
vi.mock("@/lib/context", () => ({
  convexMutation: mock.convexMutation,
  convexQuery: mock.convexQuery,
  reportIncident: vi.fn(),
}));
vi.mock("@trigger.dev/sdk/v3", () => ({ tasks: { trigger: mock.trigger } }));
vi.mock("@/lib/vault", () => ({ getSecret: mock.getSecret }));
vi.mock("@/lib/sttvocab", () => ({ STT_PROMPT: "" }));
vi.mock("@/lib/transcript", () => ({
  cleanSpeechTranscript: (text: string) => text,
  hasConfidentSpeechSegments: () => true,
  isMeaningfulSpeechTranscript: (text: string) => Boolean(text),
  shouldIgnoreHandsFreeTranscript: () => false,
}));
vi.mock("@/lib/control-session", () => ({ isSameOriginRequest: vi.fn(() => true) }));
vi.mock("@/lib/tools", () => ({ TOOL_DEFS: [{ name: "dispatch_agent" }], executeTool: mock.executeTool }));
vi.mock("@/lib/tool-belts", () => ({ TOOL_BELTS: { core: new Set(["dispatch_agent"]) }, slimToolDefinition: (value: unknown) => value }));
vi.mock("@/lib/private-r2", () => ({
  privateR2Put: mock.privateR2Put,
  privateCaptureObjectKey: (captureId: string) => `owners/daniel/captures/${captureId}/image`,
}));

import { POST as chatPost } from "./chat/route";
import { POST as cancelChatPost } from "./chat/cancel/route";
import { POST as recoverChatPost } from "./chat/recover/route";
import { POST as sttPost } from "./stt/route";
import { GET as ttsGet } from "./tts/route";
import { GET as toolsGet, POST as toolsPost } from "./tools/route";
import { POST as seePost } from "./see/route";
import { issueSpeculativeResearchReceipt } from "@/lib/speculative-research-receipt.server";

const guest = { kind: "guest" as const, guestId: "g".repeat(32) };

function request(path: string, init: RequestInit = {}) {
  return new Request(`https://jarvis.test${path}`, init) as unknown as NextRequest;
}

describe("guest foreground boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.controlActor.mockResolvedValue(guest);
    mock.convexMutation.mockResolvedValue("message-1");
    mock.convexQuery.mockResolvedValue(null);
    mock.trigger.mockResolvedValue({ id: "trigger-1" });
  });

  it("accepts a guest text turn into only its private conversation partition", async () => {
    const response = await chatPost(request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Hello", threadId: "main", requestId: "guest-turn" }),
    }));

    expect(response.status).toBe(200);
    expect(mock.convexMutation).toHaveBeenCalledWith("chatQueue:sendMessageWithRunnerLease", expect.objectContaining({
      guestId: guest.guestId, threadId: "main", text: "Hello",
    }));
    expect(mock.convexQuery).toHaveBeenCalledWith("chatQueue:runnerLease", { guestId: guest.guestId });
  });

  it("fails visibly before durable admission while production reply workers are billing-paused", async () => {
    const previous = process.env.JARVIS_FOREGROUND_HOLD_REASON;
    process.env.JARVIS_FOREGROUND_HOLD_REASON = "trigger_billing_limit";
    mock.controlActor.mockResolvedValue({ kind: "owner", authTokenHash: "owner-scope" });
    try {
      const response = await chatPost(request("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Can you hear me?", requestId: "held-turn" }),
      }));

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        code: "FOREGROUND_WORKERS_BILLING_PAUSED",
        retryable: true,
        actionUrl: expect.stringContaining("/settings/billing-limits"),
      });
      expect(mock.convexMutation).not.toHaveBeenCalled();
      expect(mock.trigger).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.JARVIS_FOREGROUND_HOLD_REASON;
      else process.env.JARVIS_FOREGROUND_HOLD_REASON = previous;
    }
  });

  it("rejects speculative research receipts at the guest foreground boundary", async () => {
    const response = await chatPost(request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "Research the latest satellite launch",
        requestId: "guest-research",
        researchReceipt: "sr1.not-a-real-receipt.signature",
      }),
    }));

    expect(response.status).toBe(403);
    expect(mock.convexMutation).not.toHaveBeenCalled();
    expect(mock.trigger).not.toHaveBeenCalled();
  });

  it("promotes a fresh owner-bound research receipt into the durable turn", async () => {
    const ownerHash = "a".repeat(64);
    const priorSecret = process.env.JARVIS_SPECULATIVE_RESEARCH_RECEIPT_SECRET;
    process.env.JARVIS_SPECULATIVE_RESEARCH_RECEIPT_SECRET = "jarvis-test-receipt-secret-material-123456789";
    mock.controlActor.mockResolvedValue({ kind: "owner", authTokenHash: ownerHash });
    mock.actorAdminHash.mockReturnValue(ownerHash);
    mock.controlCredentials.mockReturnValue({ adminHash: ownerHash });
    const basis = "Look up the latest OpenAI voice research announcements";
    const largeSources = Array.from({ length: 5 }, (_, index) => ({
      title: `Source ${index + 1} ${"voice research ".repeat(14)}`,
      url: `https://example.com/${index}/${"u".repeat(570)}`,
      snippet: "Recent evidence about natural conversational voice systems. ".repeat(9),
    }));
    const issued = issueSpeculativeResearchReceipt({
      actorAuthHash: ownerHash,
      threadId: "main",
      requestId: "owner-live-research",
      basis,
      sources: largeSources,
    });
    expect(issued.receipt.length).toBeGreaterThan(8_000);

    try {
      const response = await chatPost(request("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: `${basis} and summarize them`,
          threadId: "main",
          requestId: "owner-live-research",
          researchReceipt: issued.receipt,
        }),
      }));

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ researchPrefetchAccepted: true });
      expect(mock.convexMutation).toHaveBeenCalledWith("chatQueue:sendMessageWithRunnerLease", expect.objectContaining({
        adminHash: ownerHash,
        researchPrefetch: expect.objectContaining({
          basis,
          context: expect.stringContaining("UNTRUSTED WEB RESEARCH PREFETCH"),
          expiresAt: issued.expiresAt,
        }),
      }));
    } finally {
      if (priorSecret === undefined) delete process.env.JARVIS_SPECULATIVE_RESEARCH_RECEIPT_SECRET;
      else process.env.JARVIS_SPECULATIVE_RESEARCH_RECEIPT_SECRET = priorSecret;
    }
  });

  it("does not dispatch a duplicate guest worker while the shared runner is warm", async () => {
    mock.convexQuery.mockResolvedValue({ updatedAt: Date.now() });
    const response = await chatPost(request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "follow up", requestId: "guest-follow-up" }),
    }));

    expect(response.status).toBe(200);
    expect(mock.trigger).not.toHaveBeenCalled();
  });

  it("uses the combined admission receipt without a second Convex lease read", async () => {
    mock.convexMutation.mockResolvedValue({ messageId: "message-fast", warmRunner: true });
    const response = await chatPost(request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "fast follow up", requestId: "guest-combined-admission" }),
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ messageId: "message-fast", immediate: true });
    expect(mock.convexMutation).toHaveBeenCalledWith(
      "chatQueue:sendMessageWithRunnerLease",
      expect.objectContaining({ requestId: "guest-combined-admission" }),
    );
    expect(mock.convexQuery).not.toHaveBeenCalled();
    expect(mock.trigger).not.toHaveBeenCalled();
  });

  it("returns a bounded retry response when Convex rejects guest admission", async () => {
    mock.convexMutation.mockRejectedValue({
      data: { code: "GUEST_CHAT_RATE_LIMITED", retryAfterMs: 90_000 },
    });
    const response = await chatPost(request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "too much", requestId: "guest-limited" }),
    }));

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("90");
    expect(mock.trigger).not.toHaveBeenCalled();
  });

  it("keeps recovery scoped to the guest and reports a failed wake honestly", async () => {
    mock.convexMutation.mockResolvedValue({
      status: "pending",
      messageId: "message-1",
      attemptCount: 0,
      dispatchEpoch: 1,
    });
    mock.trigger.mockRejectedValue(new Error("Trigger unavailable"));
    const response = await recoverChatPost(request("/api/chat/recover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: "message-1", threadId: "main" }),
    }));

    expect(response.status).toBe(503);
    expect(mock.convexMutation).toHaveBeenCalledWith("chatQueue:requestRecovery", {
      messageId: "message-1",
      threadId: "main",
      guestId: guest.guestId,
    });
  });

  it("keeps an authoritative cancellation fence inside the guest partition", async () => {
    mock.convexMutation.mockResolvedValue({
      status: "cancelled",
      messageId: "message-1",
      fenceReceipt: "message-1:1:1786017600000",
    });
    const response = await cancelChatPost(request("/api/chat/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: "message-1", threadId: "main" }),
    }));

    expect(response.status).toBe(200);
    expect(mock.convexMutation).toHaveBeenCalledWith("chatQueue:cancelTurn", {
      messageId: "message-1",
      threadId: "main",
      guestId: guest.guestId,
    });
    expect(mock.trigger).not.toHaveBeenCalled();
  });

  it("never revives a guest turn after its cancellation fence is committed", async () => {
    mock.convexMutation.mockResolvedValue({ status: "cancelled", messageId: "message-1" });
    const response = await recoverChatPost(request("/api/chat/recover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: "message-1", threadId: "main" }),
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ ok: false, recovery: "cancelled" });
    expect(mock.trigger).not.toHaveBeenCalled();
  });

  it("accepts a guest STT and TTS foreground transport", async () => {
    const stt = await sttPost(request("/api/stt", {
      method: "POST",
      headers: { "content-type": "audio/wav" },
      body: new Uint8Array(256),
    }));
    const tts = await ttsGet(request("/api/tts"));

    expect(stt.status).toBe(200);
    await expect(stt.json()).resolves.toEqual({ text: "" });
    expect(tts.status).toBe(204);
  });

  it("denies guests the capability catalogue, tool execution, and visual upload", async () => {
    const [catalogue, tool, visual] = await Promise.all([
      toolsGet(request("/api/tools?live=1")),
      toolsPost(request("/api/tools", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "dispatch_agent", args: {} }),
      })),
      seePost(request("/api/see", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ image: "data:image/jpeg;base64,AA==" }),
      })),
    ]);

    expect(catalogue.status).toBe(403);
    expect(tool.status).toBe(403);
    expect(visual.status).toBe(403);
    expect(mock.executeTool).not.toHaveBeenCalled();
    expect(mock.privateR2Put).not.toHaveBeenCalled();
  });
});
