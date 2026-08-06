import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mock = vi.hoisted(() => ({
  convexMutation: vi.fn(),
  convexQuery: vi.fn(),
  resolveProjectSourceAdmission: vi.fn(),
  v2AdmissionEnabled: vi.fn(),
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
  admissionMutationName: () => "goalMode:createV2",
  v2AdmissionEnabled: mock.v2AdmissionEnabled,
}));
vi.mock("./goal-mode", () => ({
  routeGoal: () => ({
    kind: "youtube_studio",
    reason: "video work belongs to YouTube Studio",
    primaryRepo: "daniels-project-space/youtube-studio-ai",
    infrastructureContext: "test",
  }),
}));

import { executeTool, TOOL_DEFS } from "./tools";

describe("goal_mode exact source admission", () => {
  const projectAdmission = {
    protocolVersion: 2,
    canonicalProjectId: "youtube-studio-ai",
    repository: "daniels-project-space/youtube-studio-ai",
    sourceProvider: "github",
    sourceBranch: "continuation/youtube-studio-overhaul",
    sourceRef: "refs/heads/continuation/youtube-studio-overhaul",
    sourceHeadSha: "c".repeat(40),
    sourceObservedAt: 1_800_000_000_001,
    sourceAdmissionDigest: "d".repeat(64),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mock.convexQuery.mockResolvedValue("main");
    mock.convexMutation.mockResolvedValue({ missionId: "mission-1", held: false });
    mock.resolveProjectSourceAdmission.mockResolvedValue(projectAdmission);
    mock.v2AdmissionEnabled.mockReturnValue(true);
    mock.wakeAgentFleet.mockResolvedValue(true);
  });

  it("exposes the exact branch parameter in the owner tool contract", () => {
    const definition = TOOL_DEFS.find((candidate) => candidate.name === "goal_mode") as unknown as {
      parameters: { properties: Record<string, { type?: string }> };
    };
    expect(definition.parameters.properties.source_branch).toMatchObject({
      type: "string",
    });
  });

  it("passes the exact branch into v2 source observation and the durable mission mutation", async () => {
    const result = await executeTool("goal_mode", {
      action: "start",
      goal: "Overhaul YouTube Studio from the exact continuation branch",
      repo: "daniels-project-space/youtube-studio-ai",
      source_branch: "continuation/youtube-studio-overhaul",
    });

    expect(result).toContain("Goal Mode mission-1 is live");
    expect(mock.resolveProjectSourceAdmission).toHaveBeenCalledWith(
      "daniels-project-space/youtube-studio-ai",
      "continuation/youtube-studio-overhaul",
    );
    expect(mock.convexMutation).toHaveBeenCalledWith(
      "goalMode:createV2",
      expect.objectContaining({ projectAdmission }),
    );
    expect(mock.wakeAgentFleet).toHaveBeenCalledWith("goal:mission-1");
  });

  it("rejects an invalid branch without observing source or creating a mission", async () => {
    const result = await executeTool("goal_mode", {
      action: "start",
      goal: "Overhaul YouTube Studio from the requested continuation branch",
      source_branch: "continuation/../main",
    });

    expect(result).toContain("Explicit source branch is invalid");
    expect(mock.resolveProjectSourceAdmission).not.toHaveBeenCalled();
    expect(mock.convexMutation).not.toHaveBeenCalled();
    expect(mock.wakeAgentFleet).not.toHaveBeenCalled();
  });

  it("does not silently discard an explicit branch while v2 admission is inactive", async () => {
    mock.v2AdmissionEnabled.mockReturnValue(false);

    const result = await executeTool("goal_mode", {
      action: "start",
      goal: "Overhaul YouTube Studio from the requested continuation branch",
      source_branch: "continuation/youtube-studio-overhaul",
    });

    expect(result).toContain("requires the v2 mission protocol");
    expect(mock.resolveProjectSourceAdmission).not.toHaveBeenCalled();
    expect(mock.convexMutation).not.toHaveBeenCalled();
  });

  it("returns a clear no-mission recovery message when exact source observation fails", async () => {
    mock.resolveProjectSourceAdmission.mockRejectedValue(
      new Error("GitHub source-ref observation failed (404)"),
    );

    const result = await executeTool("goal_mode", {
      action: "start",
      goal: "Overhaul YouTube Studio from the requested continuation branch",
      repo: "daniels-project-space/youtube-studio-ai",
      source_branch: "continuation/youtube-studio-overhaul",
    });

    expect(result).toContain("did not create a mission");
    expect(result).toContain("source-ref observation failed (404)");
    expect(mock.convexMutation).not.toHaveBeenCalled();
    expect(mock.wakeAgentFleet).not.toHaveBeenCalled();
  });
});
