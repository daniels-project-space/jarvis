import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const mock = vi.hoisted(() => ({
  controlActor: vi.fn(),
  executeTool: vi.fn(),
  reportIncident: vi.fn(),
}));

vi.mock("@/lib/request-auth", () => ({
  controlActor: mock.controlActor,
  actorAdminHash: () => "admin-hash",
  isOwnerActor: (actor: { kind?: string }) => actor.kind === "owner",
}));
vi.mock("@/lib/context", () => ({ reportIncident: mock.reportIncident }));
vi.mock("@/lib/tools", () => ({
  executeTool: mock.executeTool,
  TOOL_DEFS: [{ name: "show" }],
}));
vi.mock("@/lib/tool-belts", () => ({
  TOOL_BELTS: { core: new Set(["show"]) },
  slimToolDefinition: (value: unknown) => value,
}));

import { POST } from "./route";

function request(body: Record<string, unknown>) {
  return new Request("https://jarvis.test/api/tools", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

describe("owner direct-tool invocation context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.controlActor.mockResolvedValue({ kind: "owner" });
    mock.executeTool.mockResolvedValue("shown");
  });

  it("accepts a bounded request id but ignores unproven chat-message provenance", async () => {
    const response = await POST(request({
      name: "show",
      args: { kind: "markdown", value: "hello" },
      requestId: " direct-request ",
      userMessageId: "spoofed-message",
      invocationContext: {
        requestId: "spoofed-request",
        userMessageId: "spoofed-message",
      },
    }));

    expect(response.status).toBe(200);
    expect(mock.executeTool).toHaveBeenCalledWith(
      "show",
      { kind: "markdown", value: "hello" },
      {
        authTokenHash: "admin-hash",
        invocationContext: { requestId: "direct-request" },
      },
    );
  });

  it("does not execute a direct tool with an oversized request id", async () => {
    const response = await POST(request({
      name: "show",
      args: {},
      requestId: "x".repeat(121),
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: "Tool failed: requestId is invalid" });
    expect(mock.executeTool).not.toHaveBeenCalled();
  });
});
