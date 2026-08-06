import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mock = vi.hoisted(() => ({
  controlActor: vi.fn(),
  controlCredentials: vi.fn(),
  convexMutation: vi.fn(),
}));

vi.mock("@/lib/request-auth", () => ({
  controlActor: mock.controlActor,
  controlCredentials: mock.controlCredentials,
}));
vi.mock("@/lib/context", () => ({ convexMutation: mock.convexMutation }));

import { POST } from "./route";

function request(body: unknown) {
  return new NextRequest("https://jarvis.test/api/chat/cancel", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/chat/cancel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.controlActor.mockResolvedValue({ kind: "owner", email: "owner@example.com" });
    mock.controlCredentials.mockReturnValue({ authTokenHash: "owner-hash" });
  });

  it("returns the exact transactional fence receipt required before retry", async () => {
    mock.convexMutation.mockResolvedValue({
      status: "cancelled",
      messageId: "message-1",
      fenceReceipt: "message-1:2:1786017600000",
    });
    const response = await POST(request({ messageId: "message-1", threadId: "main" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      cancellation: "cancelled",
      messageId: "message-1",
      fenceReceipt: "message-1:2:1786017600000",
    });
    expect(mock.convexMutation).toHaveBeenCalledWith("chatQueue:cancelTurn", {
      messageId: "message-1",
      threadId: "main",
      authTokenHash: "owner-hash",
    });
  });

  it("fails closed when Convex does not confirm the exact turn and fence", async () => {
    mock.convexMutation.mockResolvedValue({
      status: "cancelled",
      messageId: "another-message",
      fenceReceipt: "ambiguous-receipt",
    });
    const response = await POST(request({ messageId: "message-1" }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "cancellation fence unavailable" });
  });

  it("does not authorize a retry fence when the original reply won the race", async () => {
    mock.convexMutation.mockResolvedValue({ status: "completed" });
    const response = await POST(request({ messageId: "message-1" }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ ok: false, cancellation: "completed" });
  });
});
