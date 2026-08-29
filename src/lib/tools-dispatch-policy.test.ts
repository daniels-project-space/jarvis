import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mock = vi.hoisted(() => ({
  convexMutation: vi.fn(),
  convexQuery: vi.fn(),
  resolveProjectSourceAdmission: vi.fn(),
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
    mock.wakeAgentFleet.mockResolvedValue(true);
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
      model: "luna",
      reasoningEffort: "high",
      modelReason: expect.stringMatching(/Bounded research specialist/),
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
      modelReason: expect.stringMatching(/Security\/privacy safety floor/),
    }));
  });
});
