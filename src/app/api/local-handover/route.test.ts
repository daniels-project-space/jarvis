import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const mock = vi.hoisted(() => ({
  controlActor: vi.fn(),
  controlQuery: vi.fn(),
  controlMutation: vi.fn(),
}));

vi.mock("@/lib/request-auth", () => ({
  controlActor: mock.controlActor,
  controlCredentials: () => ({ authTokenHash: "owner-hash" }),
  isOwnerActor: (actor: { kind?: string }) => actor.kind === "owner",
}));
vi.mock("@/lib/control-session", () => ({
  controlQuery: mock.controlQuery,
  controlMutation: mock.controlMutation,
}));

import { GET, POST } from "./route";

function request(method: "GET" | "POST", body?: unknown) {
  return new Request("https://jarvis.test/api/local-handover", {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as unknown as NextRequest;
}

describe("local VPS handover API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.controlActor.mockResolvedValue({ kind: "owner" });
    mock.controlQuery.mockResolvedValue({
      provider: "codex",
      targetRuntime: "vps_codex",
      updatedAt: 1_800_000_000_000,
    });
    mock.controlMutation.mockImplementation(async (_path: string, args: { provider: "codex" | "claude" }) => ({
      provider: args.provider,
      targetRuntime: args.provider === "claude" ? "vps_claude" : "vps_codex",
      updatedAt: 1_800_000_000_100,
    }));
  });

  it("returns the persisted target only to an owner", async () => {
    const response = await GET(request("GET"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      ok: true,
      status: {
        provider: "codex",
        targetRuntime: "vps_codex",
        updatedAt: 1_800_000_000_000,
      },
    });
    expect(mock.controlQuery).toHaveBeenCalledWith("ui:getLocalCodingProvider", { authTokenHash: "owner-hash" });
  });

  it("persists Codex to Claude and returns the confirmed Claude target", async () => {
    const response = await POST(request("POST", { provider: "claude" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      status: { provider: "claude", targetRuntime: "vps_claude" },
    });
    expect(mock.controlMutation).toHaveBeenCalledWith("ui:setLocalCodingProvider", {
      authTokenHash: "owner-hash",
      provider: "claude",
    });
  });

  it("persists Claude back to Codex through the same owner-only route", async () => {
    const response = await POST(request("POST", { provider: "codex" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      status: { provider: "codex", targetRuntime: "vps_codex" },
    });
    expect(mock.controlMutation).toHaveBeenCalledWith("ui:setLocalCodingProvider", {
      authTokenHash: "owner-hash",
      provider: "codex",
    });
  });

  it("rejects unauthenticated and guest callers before any durable read or write", async () => {
    mock.controlActor.mockResolvedValueOnce(null);
    const missing = await GET(request("GET"));
    expect(missing.status).toBe(401);

    mock.controlActor.mockResolvedValueOnce({ kind: "guest" });
    const guest = await POST(request("POST", { provider: "claude" }));
    expect(guest.status).toBe(403);
    expect(mock.controlQuery).not.toHaveBeenCalled();
    expect(mock.controlMutation).not.toHaveBeenCalled();
  });

  it("rejects arbitrary provider values without a mutation", async () => {
    const response = await POST(request("POST", { provider: "api-key-fallback" }));

    expect(response.status).toBe(400);
    expect(mock.controlMutation).not.toHaveBeenCalled();
  });
});
