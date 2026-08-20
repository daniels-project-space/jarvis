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
  TOOL_DEFS: [
    { name: "show" },
    { name: "email_support" },
    { name: "google_calendar_create" },
  ],
}));
vi.mock("@/lib/tool-belts", () => ({
  TOOL_BELTS: { core: new Set(["show", "email_support", "google_calendar_create"]) },
  isForegroundOwnerToolName: (name: unknown) => name === "email_support" || name === "google_calendar_create" || name === "browser_errand_run",
  slimToolDefinition: (value: unknown) => value,
}));

import { GET, POST } from "./route";

function request(body: Record<string, unknown>) {
  return new Request("https://jarvis.test/api/tools", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function getRequest(path = "/api/tools?live=1") {
  return new Request(`https://jarvis.test${path}`) as unknown as NextRequest;
}

describe("owner direct-tool invocation context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.controlActor.mockResolvedValue({ kind: "owner" });
    mock.executeTool.mockResolvedValue("shown");
  });

  it("does not expose foreground-only Gmail or Calendar tools through the live browser catalogue", async () => {
    const response = await GET(getRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([{ name: "show" }]);
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

  it("does not let an owner-session browser route bypass the one-time foreground execution receipt", async () => {
    const response = await POST(request({
      name: "browser_errand_run",
      args: { errand_id: "browserErrand123" },
    }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      result: "Browser errands require a one-time foreground owner execution receipt.",
    });
    expect(mock.executeTool).not.toHaveBeenCalled();
  });

  it.each(["email_support", "google_calendar_create"]) (
    "does not let an owner-session browser route invoke foreground-only %s without its verified turn",
    async (name) => {
      const response = await POST(request({ name, args: {} }));

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        result: "This owner-only tool requires a verified foreground owner turn.",
      });
      expect(mock.executeTool).not.toHaveBeenCalled();
    },
  );
});
