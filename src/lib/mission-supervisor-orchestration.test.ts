import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectSourceAdmission } from "./source-admission";
import {
  missionSupervisorRequestKey,
  missionSupervisorRolloutMode,
  selectMissionSupervisorRollout,
  startSupervisedOrchestrationIfSelected,
  type SupervisedOrchestrationDependencies,
} from "./mission-supervisor-orchestration";

const TOOLS_SOURCE = readFileSync(new URL("./tools.ts", import.meta.url), "utf8");

function toolCaseSource(name: string, nextName: string): string {
  const start = TOOLS_SOURCE.indexOf(`case "${name}"`);
  const end = TOOLS_SOURCE.indexOf(`case "${nextName}"`, start + 1);
  if (start < 0 || end < 0) {
    throw new Error(`Could not locate ${name} tool case`);
  }
  return TOOLS_SOURCE.slice(start, end);
}

function admission(repository: string): ProjectSourceAdmission {
  return {
    protocolVersion: 2,
    canonicalProjectId: repository.split("/")[1],
    repository,
    sourceProvider: "github",
    sourceBranch: "main",
    sourceRef: "refs/heads/main",
    sourceHeadSha: "a".repeat(40),
    sourceObservedAt: 1_700_000_000_000,
    sourceAdmissionDigest: "b".repeat(64),
  };
}

function dependencies(
  overrides: Partial<SupervisedOrchestrationDependencies> = {},
): SupervisedOrchestrationDependencies {
  return {
    getOriginThreadId: vi.fn().mockResolvedValue("thread-main"),
    resolveProjectAdmissions: vi.fn().mockResolvedValue([
      admission("daniels-project-space/jarvis"),
    ]),
    mutate: vi.fn().mockResolvedValue({
      missionId: "mission-1",
      replayed: false,
      wakeTicket: null,
    }),
    dispatchWakeTicket: vi.fn().mockResolvedValue({
      dispatched: false,
      reason: "no_wake_ticket",
    }),
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("mission supervisor orchestrate rollout", () => {
  it("recognizes only the four exact modes and fails closed to dormant", () => {
    expect(missionSupervisorRolloutMode("dormant")).toBe("dormant");
    expect(missionSupervisorRolloutMode("canary")).toBe("canary");
    expect(missionSupervisorRolloutMode("active")).toBe("active");
    expect(missionSupervisorRolloutMode("rollback")).toBe("rollback");
    expect(missionSupervisorRolloutMode(undefined)).toBe("dormant");
    expect(missionSupervisorRolloutMode(" active ")).toBe("dormant");
    expect(missionSupervisorRolloutMode("enabled")).toBe("dormant");
  });

  it("preserves legacy orchestration in dormant and rollback", () => {
    for (const rollout of ["dormant", "rollback"] as const) {
      expect(selectMissionSupervisorRollout(
        { userMessageId: "message-1" },
        { rollout },
      )).toEqual({ supervised: false, mode: rollout });
    }
  });

  it("selects active with durable host identity and rejects missing identity", () => {
    expect(selectMissionSupervisorRollout(
      { requestId: "request-1", userMessageId: "message-1" },
      { rollout: "active" },
    )).toEqual({
      supervised: true,
      mode: "active",
      identity: { kind: "userMessageId", value: "message-1" },
    });
    expect(() => selectMissionSupervisorRollout(
      undefined,
      { rollout: "active" },
    )).toThrow("requires a durable requestId or userMessageId");
  });

  it("activates canary only for an exact valid internal allowlist identity", () => {
    const allowlist = JSON.stringify([
      "userMessageId:message-allowed",
      "requestId:request-allowed",
    ]);
    expect(selectMissionSupervisorRollout(
      {
        requestId: "request-other",
        userMessageId: "message-allowed",
      },
      { rollout: "canary", canaryAllowlist: allowlist },
    )).toEqual({
      supervised: true,
      mode: "canary",
      identity: { kind: "userMessageId", value: "message-allowed" },
    });
    expect(selectMissionSupervisorRollout(
      { userMessageId: "message-other" },
      { rollout: "canary", canaryAllowlist: allowlist },
    )).toEqual({ supervised: false, mode: "canary" });
    expect(selectMissionSupervisorRollout(
      { requestId: "request-allowed" },
      { rollout: "canary", canaryAllowlist: "not-json" },
    )).toEqual({ supervised: false, mode: "canary" });
    expect(selectMissionSupervisorRollout(
      { requestId: "request-allowed" },
      {
        rollout: "canary",
        canaryAllowlist: JSON.stringify(["requestId:request-allowed", 7]),
      },
    )).toEqual({ supervised: false, mode: "canary" });
  });

  it("does not let model or user tool arguments control rollout", async () => {
    vi.stubEnv("JARVIS_MISSION_SUPERVISOR_ROLLOUT", "dormant");
    const deps = dependencies();
    const result = await startSupervisedOrchestrationIfSelected({
      mission: "Coordinate a durable mission without user-controlled rollout",
      invocationContext: { requestId: "request-1" },
      // This simulates arbitrary extra JSON fields on a model-authored tool
      // payload. Runtime selection reads only host provenance and server env.
      rollout: "active",
      canaryAllowlist: ["requestId:request-1"],
    } as never, deps);

    expect(result).toBeNull();
    expect(deps.getOriginThreadId).not.toHaveBeenCalled();
    expect(deps.mutate).not.toHaveBeenCalled();
  });
});

describe("mission supervisor orchestrate request identity", () => {
  it("creates a replay-stable bounded key from normalized identity and thread", async () => {
    const identity = { kind: "requestId" as const, value: "request-1" };
    const first = await missionSupervisorRequestKey(identity, " thread-main ");
    const replay = await missionSupervisorRequestKey(identity, "thread-main");

    expect(replay).toBe(first);
    expect(first).toMatch(/^orchestrate-v1:[a-f0-9]{64}$/);
    expect(first.length).toBeLessThanOrEqual(160);
  });

  it("separates identity kind, identity value, and origin thread", async () => {
    const requestKey = await missionSupervisorRequestKey(
      { kind: "requestId", value: "same-value" },
      "thread-a",
    );
    const messageKey = await missionSupervisorRequestKey(
      { kind: "userMessageId", value: "same-value" },
      "thread-a",
    );
    const otherRequestKey = await missionSupervisorRequestKey(
      { kind: "requestId", value: "other-value" },
      "thread-a",
    );
    const otherThreadKey = await missionSupervisorRequestKey(
      { kind: "requestId", value: "same-value" },
      "thread-b",
    );

    expect(new Set([
      requestKey,
      messageKey,
      otherRequestKey,
      otherThreadKey,
    ])).toHaveLength(4);
  });

  it("rejects invalid identity and thread inputs instead of collapsing keys", async () => {
    await expect(missionSupervisorRequestKey(
      { kind: "requestId", value: "x".repeat(121) },
      "thread-main",
    )).rejects.toThrow("requestId is invalid");
    await expect(missionSupervisorRequestKey(
      { kind: "requestId", value: "request-1" },
      " ",
    )).rejects.toThrow("requires a valid origin thread");
  });
});

describe("supervised orchestrate admission and dispatch", () => {
  it("starts only startV1 with routed authority and dispatches its exact wake ticket", async () => {
    vi.stubEnv("JARVIS_MISSION_SUPERVISOR_ROLLOUT", "active");
    const jarvis = admission("daniels-project-space/jarvis");
    const rentals = admission("daniels-project-space/rental-manager-v2");
    const wakeTicket = {
      protocolVersion: 1,
      missionId: "mission-42",
      expectedLeaseVersion: 0,
      expectedEpoch: 1,
      expectedDecisionSequence: 1,
      expectedInputRevision: 1,
    };
    const mutate = vi.fn().mockResolvedValue({
      missionId: "mission-42",
      replayed: false,
      wakeTicket,
    });
    const dispatchWakeTicket = vi.fn().mockResolvedValue({
      dispatched: true,
      runId: "trigger-run-1",
    });
    const resolveProjectAdmissions = vi.fn().mockResolvedValue([
      jarvis,
      rentals,
    ]);
    const deps = dependencies({
      getOriginThreadId: vi.fn().mockResolvedValue("thread-42"),
      resolveProjectAdmissions,
      mutate,
      dispatchWakeTicket,
    });
    const expectedRequestKey = await missionSupervisorRequestKey(
      { kind: "userMessageId", value: "message-42" },
      "thread-42",
    );

    const result = await startSupervisedOrchestrationIfSelected({
      mission:
        "Coordinate a supervised Jarvis rollout across two admitted repositories.",
      primaryRepo: "jarvis",
      context: "Preserve the production safety boundary.",
      acceptanceCriteria: [
        "Keep external actions gated.",
        "Keep external actions gated.",
      ],
      requestedWorkstreams: [
        {
          task:
            "Implement the admitted Jarvis orchestration boundary with focused tests.",
          label: "Paul · rollout",
          model: "luna",
          reasoningEffort: "high",
          agentId: "paul",
          readonly: false,
        },
        {
          task:
            "Research current rental return failures using primary-source evidence.",
          label: "Atlas · evidence",
          repo: "rental-manager-v2",
          model: "terra",
          agentId: "atlas",
          readonly: true,
          acceptanceCriteria: ["Cite the exact evidence used."],
        },
      ],
      invocationContext: {
        requestId: "request-42",
        userMessageId: "message-42",
      },
      authTokenHash: "admin-hash",
    }, deps);

    expect(resolveProjectAdmissions).toHaveBeenCalledWith([
      "daniels-project-space/jarvis",
      "daniels-project-space/jarvis",
      "daniels-project-space/rental-manager-v2",
    ]);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith(
      "missionSupervisor:startV1",
      {
        authTokenHash: "admin-hash",
        requestKey: expectedRequestKey,
        goal:
          "Coordinate a supervised Jarvis rollout across two admitted repositories.",
        profile: "short_fleet",
        context: "Preserve the production safety boundary.",
        repo: "daniels-project-space/jarvis",
        desiredWorkstreams: 2,
        requestedWorkstreams: [
          {
            task:
              "Implement the admitted Jarvis orchestration boundary with focused tests.",
            label: "Paul · rollout",
            repo: "daniels-project-space/jarvis",
            model: "terra",
            reasoningEffort: "high",
            modelReason: expect.stringContaining("requested Luna/high floor"),
            agentId: "paul",
            readonly: false,
            approvalRequired: false,
            risk: "medium",
            acceptanceCriteria: [
              "Deliver the requested outcome with concrete evidence, not a progress-only report",
              "Inspect current callers and data before editing",
              "Run relevant typecheck/tests/build and report results",
            ],
          },
          {
            task:
              "Research current rental return failures using primary-source evidence.",
            label: "Atlas · evidence",
            repo: "daniels-project-space/rental-manager-v2",
            model: "terra",
            reasoningEffort: "medium",
            modelReason: expect.stringContaining("requested Terra/default floor"),
            agentId: "atlas",
            readonly: true,
            approvalRequired: false,
            risk: "medium",
            acceptanceCriteria: ["Cite the exact evidence used."],
          },
        ],
        acceptanceCriteria: ["Keep external actions gated."],
        projectAdmissions: [jarvis, rentals],
        originThreadId: "thread-42",
        priority: 45,
        risk: "medium",
      },
    );
    expect(dispatchWakeTicket).toHaveBeenCalledTimes(1);
    expect(dispatchWakeTicket).toHaveBeenCalledWith(wakeTicket);
    expect(result).toEqual({
      mode: "active",
      missionId: "mission-42",
      replayed: false,
      requestKey: expectedRequestKey,
      requestedWorkstreams: 2,
      wakeDispatched: true,
      dispatch: { dispatched: true, runId: "trigger-run-1" },
    });
    expect(mutate.mock.calls.map(([path]) => path)).not.toContain(
      "missions:create",
    );
    expect(mutate.mock.calls.map(([path]) => path)).not.toContain(
      "jobs:enqueue",
    );
  });

  it("does not touch admissions or legacy creation when active identity is missing", async () => {
    vi.stubEnv("JARVIS_MISSION_SUPERVISOR_ROLLOUT", "active");
    const deps = dependencies();

    await expect(startSupervisedOrchestrationIfSelected({
      mission: "Coordinate this mission without a durable invocation identity.",
    }, deps)).rejects.toThrow(
      "requires a durable requestId or userMessageId",
    );
    expect(deps.getOriginThreadId).not.toHaveBeenCalled();
    expect(deps.resolveProjectAdmissions).not.toHaveBeenCalled();
    expect(deps.mutate).not.toHaveBeenCalled();
  });

  it("propagates dispatch failure after durable start without any API fallback", async () => {
    vi.stubEnv("JARVIS_MISSION_SUPERVISOR_ROLLOUT", "active");
    const mutate = vi.fn().mockResolvedValue({
      missionId: "mission-1",
      replayed: false,
      wakeTicket: { exact: "ticket" },
    });
    const dispatchWakeTicket = vi.fn().mockRejectedValue(
      new Error("ambiguous dispatch"),
    );
    const deps = dependencies({ mutate, dispatchWakeTicket });

    await expect(startSupervisedOrchestrationIfSelected({
      mission: "Coordinate one replay-safe supervised mission and wake it.",
      invocationContext: { requestId: "request-1" },
    }, deps)).rejects.toThrow("ambiguous dispatch");
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0]?.[0]).toBe("missionSupervisor:startV1");
    expect(dispatchWakeTicket).toHaveBeenCalledWith({ exact: "ticket" });
  });

  it("rejects an unconfirmed dispatch result for a non-null wake ticket", async () => {
    vi.stubEnv("JARVIS_MISSION_SUPERVISOR_ROLLOUT", "active");
    const mutate = vi.fn().mockResolvedValue({
      missionId: "mission-1",
      replayed: false,
      wakeTicket: { exact: "ticket" },
    });
    const dispatchWakeTicket = vi.fn().mockResolvedValue({
      dispatched: false,
      reason: "no_wake_ticket",
    });
    const deps = dependencies({ mutate, dispatchWakeTicket });

    await expect(startSupervisedOrchestrationIfSelected({
      mission: "Coordinate one supervised mission with a confirmed exact wake.",
      invocationContext: { requestId: "request-1" },
    }, deps)).rejects.toThrow("wake dispatch was not confirmed");
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(dispatchWakeTicket).toHaveBeenCalledWith({ exact: "ticket" });
  });
});

describe("orchestrate tool wiring", () => {
  it("returns a supervised selection before any legacy plan or creation", () => {
    const source = toolCaseSource("orchestrate", "work_control");
    const selection = source.indexOf(
      "startSupervisedOrchestrationIfSelected",
    );
    const selectedReturn = source.indexOf("if (supervised)", selection);
    const legacyPlan = source.indexOf(
      'await import("../mastra/supervisor")',
    );
    const legacyMission = source.indexOf(
      'convexMutation(admissionMutationName("mission")',
    );
    const legacyJob = source.indexOf(
      'convexMutation(admissionMutationName("job")',
    );

    expect(selection).toBeGreaterThan(-1);
    expect(selectedReturn).toBeGreaterThan(selection);
    expect(source.slice(selectedReturn, legacyPlan)).toContain(
      "return `JARVIS",
    );
    expect(legacyPlan).toBeGreaterThan(selectedReturn);
    expect(legacyMission).toBeGreaterThan(legacyPlan);
    expect(legacyJob).toBeGreaterThan(legacyMission);
  });

  it("forwards bounded host provenance from creative_sprint", () => {
    const source = toolCaseSource("creative_sprint", "visual_scene");

    expect(source).toMatch(
      /return await executeTool\("orchestrate",[\s\S]*\}, boundedHostContext\);/,
    );
  });
});
