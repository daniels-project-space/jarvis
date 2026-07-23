import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const mock = vi.hoisted(() => ({
  executeTool: vi.fn(),
  reportIncident: vi.fn(),
}));

vi.mock("@/lib/tools", () => ({
  executeTool: mock.executeTool,
  TOOL_DEFS: [{ name: "show" }],
}));
vi.mock("@/lib/context", () => ({ reportIncident: mock.reportIncident }));
vi.mock("@/lib/tool-belts", () => ({
  SUBSCRIPTION_TOOL_NAMES: new Set(["show"]),
  TOOL_BELTS: { core: new Set(["show"]) },
  slimToolDefinition: (value: unknown) => value,
}));

import { POST } from "./route";

function request(body: Record<string, unknown>, token = "dispatch-token") {
  return new Request("https://jarvis.test/api/agent-tool", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

describe("foreground agent-tool invocation context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("JARVIS_DISPATCH_TOKEN", "dispatch-token");
    mock.executeTool.mockResolvedValue("shown");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("forwards worker-authenticated chat provenance in typed host context", async () => {
    const response = await POST(request({
      name: "show",
      args: { kind: "markdown", value: "hello" },
      invocationContext: {
        requestId: "request-1",
        userMessageId: "message-1",
      },
    }));

    expect(response.status).toBe(200);
    expect(mock.executeTool).toHaveBeenCalledWith(
      "show",
      { kind: "markdown", value: "hello", _subscription_reasoner: true },
      {
        invocationContext: {
          requestId: "request-1",
          userMessageId: "message-1",
        },
      },
    );
  });

  it("rejects unbounded worker metadata before tool execution", async () => {
    const response = await POST(request({
      name: "show",
      args: {},
      invocationContext: { requestId: "x".repeat(121) },
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: "Tool failed: requestId is invalid" });
    expect(mock.executeTool).not.toHaveBeenCalled();
  });
});
