import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const mock = vi.hoisted(() => ({
  controlQuery: vi.fn(),
  controlMutation: vi.fn(),
}));

vi.mock("@/lib/control-session", () => ({
  controlQuery: mock.controlQuery,
  controlMutation: mock.controlMutation,
}));

import { GET, POST } from "./route";

function request(method: "GET" | "POST", body?: unknown, token = "r".repeat(48)) {
  return new Request("https://jarvis.test/api/local-handover/runner", {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as unknown as NextRequest;
}

function heartbeat(overrides: Record<string, unknown> = {}) {
  return {
    operation: "heartbeat",
    status: {
      version: "1.0.0",
      policyRevision: 3,
      managedSessions: 2,
      deferredSessions: 0,
      quotaState: "available",
      remainingPercent: 7,
      resetsAt: 1_800_000_000,
    },
    ...overrides,
  };
}

const codexPolicy = {
  provider: "codex",
  targetRuntime: "vps_codex",
  updatedAt: 1_800_000_000_000,
  handoverRevision: 3,
  automatic: { codexWeeklyRemainingPercent: 1 },
};

function thresholdHeartbeat(overrides: Record<string, unknown> = {}) {
  return heartbeat({
    operation: "auto_failover",
    observedUsedPercent: 99,
    status: {
      ...heartbeat().status,
      quotaState: "threshold",
      remainingPercent: 1,
    },
    ...overrides,
  });
}

describe("local VPS handover runner API", () => {
  beforeEach(() => {
    vi.stubEnv("JARVIS_LOCAL_HANDOVER_RUNNER_TOKEN", "r".repeat(48));
    vi.stubEnv("JARVIS_DISPATCH_TOKEN", "d".repeat(48));
    vi.clearAllMocks();
    mock.controlQuery.mockResolvedValue(codexPolicy);
    mock.controlMutation.mockResolvedValue({ ...codexPolicy, provider: "claude", targetRuntime: "vps_claude", handoverRevision: 4 });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("exposes only the compact policy to the paired outbound runner", async () => {
    const response = await GET(request("GET"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, policy: codexPolicy });
    expect(mock.controlQuery).toHaveBeenCalledWith("ui:getLocalCodingProvider", { dispatchToken: "d".repeat(48) });
  });

  it("rejects a missing or wrong runner capability before any Convex call", async () => {
    const response = await GET(request("GET", undefined, "wrong"));

    expect(response.status).toBe(401);
    expect(mock.controlQuery).not.toHaveBeenCalled();
  });

  it("records a narrow heartbeat at the server-confirmed policy revision", async () => {
    const response = await POST(request("POST", heartbeat()));

    expect(response.status).toBe(200);
    expect(mock.controlMutation).toHaveBeenCalledWith("ui:recordLocalCodingRunnerStatus", {
      dispatchToken: "d".repeat(48),
      status: expect.objectContaining({ policyRevision: 3, managedSessions: 2 }),
    });
  });

  it("allows the documented one-percent Codex event to move only to Claude", async () => {
    const response = await POST(request("POST", thresholdHeartbeat()));

    expect(response.status).toBe(200);
    expect(mock.controlMutation).toHaveBeenNthCalledWith(1, "ui:setLocalCodingProvider", {
      dispatchToken: "d".repeat(48),
      provider: "claude",
      reason: "quota",
      expectedHandoverRevision: 3,
    });
    expect(mock.controlMutation).toHaveBeenNthCalledWith(2, "ui:recordLocalCodingRunnerStatus", {
      dispatchToken: "d".repeat(48),
      status: expect.objectContaining({ policyRevision: 4 }),
    });
  });

  it("rejects an automatic failover without the threshold evidence", async () => {
    const response = await POST(request("POST", heartbeat({ operation: "auto_failover" })));

    expect(response.status).toBe(400);
    expect(mock.controlMutation).not.toHaveBeenCalled();
  });

  it("rejects an automatic failover whose compact evidence is not the threshold", async () => {
    const response = await POST(request("POST", heartbeat({ operation: "auto_failover", observedUsedPercent: 99 })));

    expect(response.status).toBe(400);
    expect(mock.controlMutation).not.toHaveBeenCalled();
  });

  it("does not let a stale runner observation overwrite a newer owner toggle", async () => {
    const response = await POST(request("POST", thresholdHeartbeat({
      status: { ...thresholdHeartbeat().status, policyRevision: 2 },
    })));

    expect(response.status).toBe(409);
    expect(mock.controlMutation).not.toHaveBeenCalled();
  });
});
