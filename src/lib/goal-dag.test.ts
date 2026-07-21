import { describe, expect, it } from "vitest";
import { canonicalGoalPlanJson, goalDagEdgeId, topologicalGoalWorkstreams } from "./goal-dag";
import type { GoalPlan } from "./goal-mode";

const plan = (workstreams: GoalPlan["workstreams"]): GoalPlan => ({
  summary: "bounded plan", route: "existing_project", primaryRepo: "daniels-project-space/jarvis",
  assumptions: ["b", "a"], workstreams,
  validation: { criteria: ["outcome"], tests: ["npm test"], liveChecks: [] },
});

describe("immutable GoalPlan canonical authority", () => {
  it("canonicalizes semantically identical node and dependency ordering to one digest input", () => {
    const a = { id: "a", label: "A", task: "inspect", agentId: "paul" as const, readonly: true,
      dependsOn: [] as string[], acceptanceCriteria: ["evidence"], mcp: [] as [] };
    const b = { id: "b", label: "B", task: "build", agentId: "paul" as const,
      repo: "https://github.com/daniels-project-space/jarvis.git", readonly: false,
      dependsOn: ["a"], acceptanceCriteria: ["tests"], mcp: ["context7" as const] };
    expect(canonicalGoalPlanJson(plan([b, a]))).toBe(canonicalGoalPlanJson(plan([a, b])));
    expect(canonicalGoalPlanJson(plan([b, a]))).toContain("daniels-project-space/jarvis");
  });

  it("topologically executes independent siblings before their dependent without changing ids", () => {
    const node = (id: string, dependsOn: string[] = []) => ({ id, label: id, task: id, agentId: "paul" as const,
      readonly: true, dependsOn, acceptanceCriteria: [id], mcp: [] as [] });
    expect(topologicalGoalWorkstreams([node("downstream", ["upstream"]), node("sibling"), node("upstream")])
      .map((item) => item.id)).toEqual(["sibling", "upstream", "downstream"]);
    expect(goalDagEdgeId("upstream", "downstream")).toBe("upstream->downstream");
  });
});
