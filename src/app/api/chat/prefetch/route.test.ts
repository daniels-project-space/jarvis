import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  sameOrigin: vi.fn(),
  controlActor: vi.fn(),
  searchWeb: vi.fn(),
  issueReceipt: vi.fn(),
}));

vi.mock("@/lib/control-session", () => ({ isSameOriginRequest: mock.sameOrigin }));
vi.mock("@/lib/request-auth", () => ({
  controlActor: mock.controlActor,
  isOwnerActor: (actor: { kind?: string }) => actor?.kind === "owner",
}));
vi.mock("@/lib/search", () => ({ searchWeb: mock.searchWeb }));
vi.mock("@/lib/speculative-research-receipt.server", () => ({ issueSpeculativeResearchReceipt: mock.issueReceipt }));

import { POST } from "./route";

const PARTIAL = "Look into how Sesame is training its conversational voice agents";

function request(body: unknown, init: { origin?: string; contentLength?: string } = {}) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    origin: init.origin ?? "https://jarvis.example",
  };
  if (init.contentLength) headers["content-length"] = init.contentLength;
  return new NextRequest("https://jarvis.example/api/chat/prefetch", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/chat/prefetch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.sameOrigin.mockReturnValue(true);
    mock.controlActor.mockResolvedValue({ kind: "owner", authTokenHash: "a".repeat(64) });
    mock.searchWeb.mockResolvedValue({
      results: [{ title: "Sesame research", link: "https://example.com/sesame", snippet: "A useful external summary." }],
    });
    mock.issueReceipt.mockReturnValue({
      receipt: "sr1.payload.signature",
      query: PARTIAL,
      sources: [{ title: "Sesame research", url: "https://example.com/sesame", snippet: "A useful external summary." }],
      expiresAt: 123_456,
    });
  });

  it("rejects cross-origin, unauthenticated, and guest requests before search", async () => {
    mock.sameOrigin.mockReturnValueOnce(false);
    expect((await POST(request({ partialText: PARTIAL, threadId: "main", requestId: "voice:1" }))).status).toBe(403);
    mock.controlActor.mockResolvedValueOnce(null);
    expect((await POST(request({ partialText: PARTIAL, threadId: "main", requestId: "voice:2" }))).status).toBe(401);
    mock.controlActor.mockResolvedValueOnce({ kind: "guest", guestId: "guest-1" });
    expect((await POST(request({ partialText: PARTIAL, threadId: "main", requestId: "voice:3" }))).status).toBe(403);
    expect(mock.searchWeb).not.toHaveBeenCalled();
  });

  it("rejects chatter, extra fields, and oversized bodies without provider work", async () => {
    const chatter = await POST(request({ partialText: "Hey Jarvis, how are you?", threadId: "main", requestId: "voice:1" }));
    expect(chatter.status).toBe(400);
    const expanded = await POST(request({ partialText: PARTIAL, threadId: "main", requestId: "voice:2", tool: "dispatch_agent" }));
    expect(expanded.status).toBe(400);
    const oversized = await POST(request({ partialText: PARTIAL, threadId: "main", requestId: "voice:3" }, { contentLength: "12001" }));
    expect(oversized.status).toBe(413);
    expect(mock.searchWeb).not.toHaveBeenCalled();
  });

  it("fans out across three bounded keyless evidence lanes and returns the stable receipt contract", async () => {
    const response = await POST(request({ partialText: PARTIAL, threadId: "main", requestId: "voice:1" }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      receipt: "sr1.payload.signature",
      query: PARTIAL,
      sources: [{ title: "Sesame research", url: "https://example.com/sesame" }],
      expiresAt: 123_456,
    });
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mock.searchWeb).toHaveBeenCalledTimes(3);
    expect(mock.searchWeb).toHaveBeenCalledWith(PARTIAL, 4, "us", expect.objectContaining({
      signal: expect.any(AbortSignal),
      timeoutMs: 6_000,
      providerOrder: "keyless-first",
      maxPaidAttempts: 0,
      cacheTtlMs: 45_000,
    }));
    expect(mock.searchWeb).toHaveBeenCalledWith(
      `${PARTIAL} official documentation primary source`,
      4,
      "us",
      expect.objectContaining({ maxPaidAttempts: 0 }),
    );
    expect(mock.issueReceipt).toHaveBeenCalledWith(expect.objectContaining({
      actorAuthHash: "a".repeat(64),
      threadId: "main",
      requestId: "voice:1",
      basis: PARTIAL,
    }));
  });

  it("contains no agent, tool, task, or durable-state execution path", () => {
    const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
    for (const forbidden of ["@trigger.dev", "convexMutation", "convexQuery", "executeTool", "agent-tool", "Codex", "Mastra", "tasks.trigger"]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
