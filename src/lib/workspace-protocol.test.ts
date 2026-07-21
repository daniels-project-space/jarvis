import { describe, expect, it } from "vitest";
import { attemptWorkspaceKey, validateWorkDag, workItemIdentity } from "./workspace-protocol";

describe("multi-agent workspace protocol", () => {
  it("gives unrelated work items stable distinct writable lineages across retries", () => {
    const first = workItemIdentity({ missionId: "goal-1", jobId: "job-a", workstreamId: "catalog", readonly: false });
    const second = workItemIdentity({ missionId: "goal-1", jobId: "job-b", workstreamId: "metrics", readonly: false });
    expect(first.workerBranch).not.toBe(second.workerBranch);
    expect(first.workspaceLineage).not.toBe(second.workspaceLineage);
    expect(workItemIdentity({ missionId: "goal-1", jobId: "job-a", workstreamId: "catalog", readonly: false })).toEqual(first);
    expect(attemptWorkspaceKey(first.workspaceLineage, 1)).not.toBe(attemptWorkspaceKey(first.workspaceLineage, 2));
  });

  it("does not collapse distinct immutable ids that normalize to the same label", () => {
    const punctuation = workItemIdentity({ missionId: "goal-1", jobId: "job/a", workstreamId: "same", readonly: false });
    const dash = workItemIdentity({ missionId: "goal-1", jobId: "job-a", workstreamId: "same", readonly: false });
    expect(punctuation.workerBranch).not.toBe(dash.workerBranch);
    expect(punctuation.workerBranch).toContain("6a6f622f61");
  });

  it("assigns no writable ref to read-only work", () => {
    expect(workItemIdentity({ missionId: "goal-1", jobId: "audit", readonly: true }).workerBranch).toBeUndefined();
  });

  it("validates explicit bounded acyclic edges", () => {
    expect(() => validateWorkDag([{ id: "a", dependsOn: [] }, { id: "b", dependsOn: ["a"] }], 4)).not.toThrow();
    expect(() => validateWorkDag([{ id: "a", dependsOn: ["b"] }, { id: "b", dependsOn: ["a"] }], 4)).toThrow(/cycle/);
  });
});
