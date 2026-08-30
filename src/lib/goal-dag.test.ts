import { describe, expect, it } from "vitest";
import { canonicalGoalPlan, canonicalGoalPlanJson, goalDagEdgeId, topologicalGoalWorkstreams } from "./goal-dag";
import type { GoalPlan } from "./goal-mode";

const plan = (workstreams: GoalPlan["workstreams"]): GoalPlan => ({
  summary: "bounded plan", route: "existing_project", primaryRepo: "daniels-project-space/jarvis",
  assumptions: ["b", "a"],
  outcome: {
    objective: "Make the bounded product outcome measurably true",
    metric: "verified successful journeys",
    baseline: "Current production result is observed before the change",
    target: "Every accepted journey succeeds",
    measurementWindow: "One production validation window",
    evidenceSources: ["Provider lineage", "Browser journey"],
    stopConditions: ["Target evidenced"],
  },
  crew: {
    process: "hierarchical", manager: "jarvis",
    delegationRules: ["Only necessary specialists"],
    humanEscalation: ["Only protected decisions"],
    reportingCadence: "Event-driven checkpoints",
  },
  workstreams,
  validation: { criteria: ["outcome"], tests: ["npm test"], liveChecks: [] },
});

describe("immutable GoalPlan canonical authority", () => {
  it("canonicalizes semantically identical node and dependency ordering to one digest input", () => {
    const a = { id: "a", label: "A", task: "inspect", agentId: "paul" as const, readonly: true,
      dependsOn: [] as string[], acceptanceCriteria: ["evidence"], deliverable: {
        kind: "research_brief" as const, description: "A source-backed inspection brief", requiredEvidence: ["source evidence"],
      }, guardrails: ["read-only"], mcp: [] as [] };
    const b = { id: "b", label: "B", task: "build", agentId: "paul" as const,
      repo: "https://github.com/daniels-project-space/jarvis.git", readonly: false,
      dependsOn: ["a"], acceptanceCriteria: ["tests"], deliverable: {
        kind: "code_change" as const, description: "A tested source change", requiredEvidence: ["test evidence"],
      }, guardrails: ["no deployment"], mcp: ["context7" as const] };
    expect(canonicalGoalPlanJson(plan([b, a]))).toBe(canonicalGoalPlanJson(plan([a, b])));
    expect(canonicalGoalPlanJson(plan([b, a]))).toContain("daniels-project-space/jarvis");
  });

  it("topologically executes independent siblings before their dependent without changing ids", () => {
    const node = (id: string, dependsOn: string[] = []) => ({ id, label: id, task: id, agentId: "paul" as const,
      readonly: true, dependsOn, acceptanceCriteria: [id], deliverable: {
        kind: "research_brief" as const, description: `Evidence for ${id}`, requiredEvidence: [id],
      }, guardrails: ["read-only"], mcp: [] as [] });
    expect(topologicalGoalWorkstreams([node("downstream", ["upstream"]), node("sibling"), node("upstream")])
      .map((item) => item.id)).toEqual(["sibling", "upstream", "downstream"]);
    expect(goalDagEdgeId("upstream", "downstream")).toBe("upstream->downstream");
  });

  it("upgrades an already-accepted legacy plan for safe rolling materialization", () => {
    const legacy = {
      summary: "Legacy accepted plan",
      route: "existing_project",
      assumptions: [],
      workstreams: [{
        id: "legacy",
        label: "Legacy node",
        task: "Finish the already accepted legacy mission node",
        agentId: "paul",
        readonly: true,
        dependsOn: [],
        acceptanceCriteria: ["Legacy evidence is verified"],
        mcp: [],
      }],
      validation: { criteria: ["Legacy mission is complete"], tests: [], liveChecks: [] },
    } as unknown as GoalPlan;
    const upgraded = canonicalGoalPlan(legacy);
    expect(upgraded.outcome.metric).toBe("accepted outcome criteria proven end to end");
    expect(upgraded.crew).toMatchObject({ process: "hierarchical", manager: "jarvis" });
    expect(upgraded.workstreams[0]).toMatchObject({
      deliverable: { kind: "research_brief", requiredEvidence: ["Legacy evidence is verified"] },
      guardrails: ["Preserve the mission's existing consequence and delivery boundaries"],
    });
  });
});
