import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/request-auth", () => ({
  controlActor: vi.fn(),
  controlCredentials: vi.fn(() => ({ authTokenHash: "scoped" })),
  isOwnerActor: (actor: { kind?: string }) => actor.kind === "owner",
}));
vi.mock("@/lib/control-session", () => ({
  controlMutation: vi.fn(),
  controlQuery: vi.fn(),
}));
vi.mock("@/lib/agent-fleet-dispatch", () => ({
  wakeAgentFleet: vi.fn(),
}));
vi.mock("@/lib/mission-supervisor-dispatch-server", () => ({
  dispatchMissionSupervisorWakeTicket: vi.fn(),
}));

import { wakeAgentFleet } from "@/lib/agent-fleet-dispatch";
import { controlMutation, controlQuery } from "@/lib/control-session";
import { dispatchMissionSupervisorWakeTicket } from "@/lib/mission-supervisor-dispatch-server";
import { controlActor } from "@/lib/request-auth";
import { POST } from "./route";

const requestKey = "ui:11111111-1111-4111-8111-111111111111";
const wakeTicket = {
  protocolVersion: 1 as const,
  missionId: "mission-supervised-1",
  expectedLeaseVersion: 3,
  expectedEpoch: 2,
  expectedDecisionSequence: 7,
  expectedInputRevision: 8,
};

function request(body: unknown) {
  return new Request(
    "https://jarvis-orcin-six.vercel.app/api/work-control",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  ) as unknown as NextRequest;
}

function supervisorRequest(overrides: Record<string, unknown> = {}) {
  return {
    protocol: "supervisor_v1",
    missionId: "mission-supervised-1",
    action: "steer",
    requestKey,
    expectedInputRevision: 7,
    input: "Prioritize the exact acceptance boundary.",
    ...overrides,
  };
}

function supervisorReceipt(overrides: Record<string, unknown> = {}) {
  return {
    applied: true,
    replayed: false,
    noop: false,
    reason: "steered",
    scope: "planning_only_zero_jobs",
    requestDigest: "must-not-leak",
    controlReceiptId: "must-not-leak",
    state: "ready",
    inputRevision: 8,
    wakeTicket,
    ...overrides,
  };
}

describe("authenticated work controls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(controlActor).mockResolvedValue({
      kind: "owner",
      authTokenHash: "scoped",
    });
    vi.mocked(controlMutation).mockResolvedValue(supervisorReceipt());
    vi.mocked(controlQuery).mockResolvedValue(null);
    vi.mocked(dispatchMissionSupervisorWakeTicket).mockResolvedValue({
      dispatched: true,
      runId: "run-supervisor-1",
      handle: {
        id: "run-supervisor-1",
        publicAccessToken: "must-not-leak",
      },
      payload: wakeTicket,
      idempotencyKey: "must-not-leak",
    });
  });

  it("returns 401 before reading or mutating work without a controller actor", async () => {
    vi.mocked(controlActor).mockResolvedValue(null);
    const response = await POST(
      request({ jobId: "job-1", action: "pause" }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false });
    expect(controlMutation).not.toHaveBeenCalled();
  });

  it("rejects a guest before reading or mutating privileged control", async () => {
    vi.mocked(controlActor).mockResolvedValue({
      kind: "guest",
      guestId: "g".repeat(32),
    });
    const response = await POST(
      request({ jobId: "job-1", action: "pause" }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      ok: false,
      error: "owner enrollment required",
    });
    expect(controlMutation).not.toHaveBeenCalled();
  });

  it("requires the exact strict supervisor_v1 request shape", async () => {
    const invalid = [
      supervisorRequest({ unexpected: true }),
      supervisorRequest({ requestKey: "control-without-ui-uuid" }),
      supervisorRequest({ input: undefined }),
      supervisorRequest({ action: "pause", input: "not allowed" }),
      supervisorRequest({ protocol: "supervisor_v2" }),
    ];
    for (const body of invalid) {
      const response = await POST(request(body));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        ok: false,
        error: "Invalid supervisor control request.",
      });
    }
    expect(controlMutation).not.toHaveBeenCalled();
  });

  it("passes exact owner-fenced arguments and returns only minimal dispatch identity", async () => {
    const response = await POST(
      request(supervisorRequest({
        input: "  Prioritize the exact acceptance boundary.  ",
      })),
    );
    expect(controlMutation).toHaveBeenCalledWith(
      "missionSupervisor:controlV1",
      {
        missionId: "mission-supervised-1",
        action: "steer",
        requestKey,
        expectedInputRevision: 7,
        input: "Prioritize the exact acceptance boundary.",
        authTokenHash: "scoped",
      },
    );
    expect(dispatchMissionSupervisorWakeTicket)
      .toHaveBeenCalledWith(wakeTicket);
    expect(wakeAgentFleet).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual({
      ok: true,
      replayed: false,
      noop: false,
      state: "ready",
      inputRevision: 8,
      dispatched: true,
      runId: "run-supervisor-1",
    });
    expect(JSON.stringify(payload)).not.toContain("publicAccessToken");
    expect(JSON.stringify(payload)).not.toContain("idempotencyKey");
    expect(JSON.stringify(payload)).not.toContain("wakeTicket");
    expect(JSON.stringify(payload)).not.toContain("requestDigest");
    expect(JSON.stringify(payload)).not.toContain("controlReceiptId");
  });

  it("treats an immutable replayed no-op as successful without dispatch", async () => {
    vi.mocked(controlMutation).mockResolvedValue(supervisorReceipt({
      applied: false,
      replayed: true,
      noop: true,
      reason: "terminal_noop",
      state: "terminal",
      wakeTicket: null,
    }));
    const response = await POST(request(supervisorRequest({
      action: "cancel",
      input: undefined,
    })));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      replayed: true,
      noop: true,
      state: "terminal",
      inputRevision: 8,
      dispatched: false,
    });
    expect(dispatchMissionSupervisorWakeTicket).not.toHaveBeenCalled();
    expect(wakeAgentFleet).not.toHaveBeenCalled();
  });

  it("returns a stale revision as a definitive 409 without waking anything", async () => {
    vi.mocked(controlMutation).mockResolvedValue(supervisorReceipt({
      applied: false,
      noop: false,
      reason: "stale_input_revision",
      state: "paused",
      inputRevision: 11,
      wakeTicket: null,
    }));
    const response = await POST(request(supervisorRequest({
      action: "pause",
      input: undefined,
    })));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      error: "Jarvis changed this mission after the controls loaded. Review the latest state and try again.",
      reason: "stale_input_revision",
      state: "paused",
      latestRevision: 11,
    });
    expect(dispatchMissionSupervisorWakeTicket).not.toHaveBeenCalled();
    expect(wakeAgentFleet).not.toHaveBeenCalled();
  });

  it("returns other supervisor receipt rejections as definitive 409 responses", async () => {
    vi.mocked(controlMutation).mockResolvedValue(supervisorReceipt({
      applied: false,
      noop: false,
      reason: "active_jobs_require_batch_control",
      inputRevision: 7,
      wakeTicket: null,
    }));
    const response = await POST(request(supervisorRequest({
      action: "pause",
      input: undefined,
    })));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false,
      reason: "active_jobs_require_batch_control",
      state: "ready",
      inputRevision: 7,
    });
    expect(dispatchMissionSupervisorWakeTicket).not.toHaveBeenCalled();
  });

  it("returns 503 for ambiguous dispatch and safely replays the same control receipt", async () => {
    vi.mocked(controlMutation)
      .mockResolvedValueOnce(supervisorReceipt())
      .mockResolvedValueOnce(supervisorReceipt({ replayed: true }));
    vi.mocked(dispatchMissionSupervisorWakeTicket)
      .mockRejectedValueOnce(new Error("transport failed after acceptance"))
      .mockResolvedValueOnce({
        dispatched: true,
        runId: "run-reconciled",
        handle: { id: "run-reconciled" },
        payload: wakeTicket,
        idempotencyKey: "same-exact-ticket",
      });
    const body = supervisorRequest();
    const first = await POST(request(body));
    expect(first.status).toBe(503);
    expect(await first.json()).toEqual({
      ok: false,
      retryable: true,
      error: "The control was recorded, but its supervisor wake is not yet confirmed. Retry the same request.",
    });
    const retry = await POST(request(body));
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({
      ok: true,
      replayed: true,
      dispatched: true,
      runId: "run-reconciled",
    });
    expect(vi.mocked(controlMutation).mock.calls[0])
      .toEqual(vi.mocked(controlMutation).mock.calls[1]);
    expect(dispatchMissionSupervisorWakeTicket)
      .toHaveBeenNthCalledWith(1, wakeTicket);
    expect(dispatchMissionSupervisorWakeTicket)
      .toHaveBeenNthCalledWith(2, wakeTicket);
    expect(wakeAgentFleet).not.toHaveBeenCalled();
  });

  it("returns 503 when the immutable control receipt may have committed before mutation transport failed", async () => {
    vi.mocked(controlMutation).mockRejectedValue(
      new Error("response lost after commit"),
    );
    const response = await POST(request(supervisorRequest()));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      ok: false,
      retryable: true,
    });
    expect(dispatchMissionSupervisorWakeTicket).not.toHaveBeenCalled();
  });

  it("preserves the legacy exact-job control branch", async () => {
    vi.mocked(controlMutation).mockResolvedValue(true);
    vi.mocked(controlQuery).mockResolvedValue({
      jobId: "job-1",
      status: "paused",
    });
    const response = await POST(
      request({ jobId: "job-1", action: "pause" }),
    );
    expect(controlMutation).toHaveBeenCalledWith("jobs:control", {
      jobId: "job-1",
      action: "pause",
      input: undefined,
      authTokenHash: "scoped",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      monitoring: { jobId: "job-1", status: "paused" },
    });
    expect(dispatchMissionSupervisorWakeTicket).not.toHaveBeenCalled();
    expect(wakeAgentFleet).not.toHaveBeenCalled();
  });
});
