import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mock = vi.hoisted(() => ({
  convexMutation: vi.fn(),
  convexQuery: vi.fn(),
  resolveProjectSourceAdmission: vi.fn(),
  cloudProviderAdmissionReadinessAtRuntime: vi.fn(),
  wakeAgentFleet: vi.fn(),
}));

vi.mock("./context", () => ({
  convexMutation: mock.convexMutation,
  convexQuery: mock.convexQuery,
}));
vi.mock("./control-context", () => ({
  withAdminSession: async (_authTokenHash: unknown, operation: () => Promise<unknown>) => await operation(),
}));
vi.mock("./agent-fleet-dispatch", () => ({ wakeAgentFleet: mock.wakeAgentFleet }));
vi.mock("./source-admission-server", () => ({
  resolveProjectSourceAdmission: mock.resolveProjectSourceAdmission,
}));
vi.mock("./cloud-provider-admission-runtime", () => ({
  cloudProviderAdmissionReadinessAtRuntime: mock.cloudProviderAdmissionReadinessAtRuntime,
}));
vi.mock("./mission-protocol-rollout", () => ({
  admissionMutationName: (kind: "mission" | "job") => kind === "mission" ? "missions:createV2" : "jobs:enqueueV2",
  v2AdmissionEnabled: () => true,
}));

import { executeTool } from "./tools";

const jarvisAdmission = {
  protocolVersion: 2,
  canonicalProjectId: "jarvis",
  repository: "daniels-project-space/jarvis",
  sourceProvider: "github",
  sourceBranch: "main",
  sourceRef: "refs/heads/main",
  sourceHeadSha: "a".repeat(40),
  sourceObservedAt: 1_800_000_000_001,
  sourceAdmissionDigest: "b".repeat(64),
};

const evidenceAdmission = {
  protocolVersion: 2,
  canonicalProjectId: "evidence",
  repository: undefined,
  sourceProvider: "none",
  sourceBranch: undefined,
  sourceRef: undefined,
  sourceHeadSha: undefined,
  sourceObservedAt: 1_800_000_000_001,
  sourceAdmissionDigest: "c".repeat(64),
};

describe("dispatch_agent adaptive work policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.convexQuery.mockResolvedValue("voice-thread");
    mock.convexMutation.mockImplementation(async (path: string) =>
      path === "missions:createV2" ? "mission-voice" : "job-voice",
    );
    mock.resolveProjectSourceAdmission.mockImplementation(async (repository?: string) =>
      repository ? jarvisAdmission : evidenceAdmission,
    );
    mock.cloudProviderAdmissionReadinessAtRuntime.mockResolvedValue({ ready: true });
    mock.wakeAgentFleet.mockResolvedValue(true);
  });

  it("does not create a voice-started mission when the live worker proof is unavailable", async () => {
    mock.cloudProviderAdmissionReadinessAtRuntime.mockResolvedValueOnce({
      ready: false,
      code: "missing_receipt",
    });

    await expect(executeTool("dispatch_agent", {
      task: "Research the current provider choices and summarize the tradeoffs.",
      agent_id: "atlas",
    })).resolves.toContain("Cloud worker release, select Verify release");

    expect(mock.resolveProjectSourceAdmission).not.toHaveBeenCalled();
    expect(mock.convexMutation).not.toHaveBeenCalled();
    expect(mock.wakeAgentFleet).not.toHaveBeenCalled();
  });

  it("persists the adaptive model and reasoning decision before waking a voice-started worker", async () => {
    const result = await executeTool("dispatch_agent", {
      task: "Research the bounded current primary sources and compare the documented provider options.",
      agent_id: "atlas",
    });

    expect(result).toContain("Atlas owns job job-voice");
    expect(mock.convexMutation).toHaveBeenCalledWith("jobs:enqueueV2", expect.objectContaining({
      missionId: "mission-voice",
      originThreadId: "voice-thread",
      agentId: "atlas",
      model: "terra",
      reasoningEffort: "xhigh",
      modelReason: expect.stringMatching(/Research workload/),
    }));
    expect(mock.wakeAgentFleet).toHaveBeenCalledWith("job:job-voice");
  });

  it("does not let a low requested effort weaken a production privacy safety floor", async () => {
    await executeTool("dispatch_agent", {
      task: "Repair production authentication and privacy isolation in Jarvis, then verify the user-visible result end to end.",
      repo: "daniels-project-space/jarvis",
      agent_id: "paul",
      model: "luna",
      reasoning_effort: "low",
    });

    expect(mock.convexMutation).toHaveBeenCalledWith("jobs:enqueueV2", expect.objectContaining({
      agentId: "paul",
      model: "sol",
      reasoningEffort: "max",
      modelReason: expect.stringMatching(/Exceptional security\/privacy safety floor/),
    }));
  });

  it("preserves the Terra reviewer floor for a bounded owned code patch", async () => {
    await executeTool("dispatch_agent", {
      task: "Fix the typo in src/lib/example.ts.",
      repo: "daniels-project-space/jarvis",
      agent_id: "paul",
    });

    expect(mock.convexMutation).toHaveBeenCalledWith("jobs:enqueueV2", expect.objectContaining({
      agentId: "paul",
      model: "terra",
      reasoningEffort: "xhigh",
    }));
  });
});
