import { describe, expect, it } from "vitest";
import {
  GOAL_PLAN_MARKER,
  GOAL_VALIDATION_MARKER,
  goalBranch,
  parseGoalPlan,
  parseGoalValidation,
  routeGoal,
} from "./goal-mode";

describe("Goal Mode contracts", () => {
  it("routes new apps into App Factory and video work into YouTube Studio", () => {
    expect(routeGoal("Build a new app for comparing rental insurance").kind).toBe("app_factory");
    expect(routeGoal("Refine the pacing and thumbnail for my next YouTube video").kind).toBe("youtube_studio");
  });

  it("keeps explicit existing products inside their own repository", () => {
    const route = routeGoal("Massively improve Jarvis long-term agent work");
    expect(route.kind).toBe("existing_project");
    expect(route.primaryRepo).toBe("daniels-project-space/jarvis");
  });

  it("parses and topologically orders a bounded plan", () => {
    const value = parseGoalPlan(`${GOAL_PLAN_MARKER}\n${JSON.stringify({
      summary: "Build and verify it",
      route: "existing_project",
      primaryRepo: "daniels-project-space/jarvis",
      workstreams: [
        { id: "ui", label: "UI", task: "Connect the complete user interface to the durable backend.", dependsOn: ["core"], acceptanceCriteria: ["UI works"] },
        { id: "core", label: "Core", task: "Implement the durable state machine and its recovery transitions.", acceptanceCriteria: ["Transitions are tested"] },
      ],
      validation: { criteria: ["Works end to end"], tests: ["npm test"], liveChecks: ["production smoke"] },
    })}`);
    expect(value.workstreams.map((stream) => stream.id)).toEqual(["core", "ui"]);
    expect(value.workstreams.every((stream) => stream.agentId === "paul")).toBe(true);
  });

  it("rejects cyclic plans", () => {
    expect(() => parseGoalPlan(`${GOAL_PLAN_MARKER}${JSON.stringify({
      workstreams: [
        { id: "a", task: "Implement the first substantial bounded work package.", dependsOn: ["b"] },
        { id: "b", task: "Implement the second substantial bounded work package.", dependsOn: ["a"] },
      ],
    })}`)).toThrow(/cycle/);
  });

  it("requires evidence for a pass and repairs for refine", () => {
    expect(() => parseGoalValidation(`${GOAL_VALIDATION_MARKER}{"verdict":"pass","evidence":["build passed"]}`))
      .toThrow(/two concrete/);
    const value = parseGoalValidation(`${GOAL_VALIDATION_MARKER}${JSON.stringify({
      verdict: "refine",
      summary: "One live gap remains",
      evidence: ["build passed"],
      gaps: ["mobile flow fails"],
      refinements: [{ label: "Mobile repair", task: "Repair the broken mobile flow and verify it with a real browser run." }],
    })}`);
    expect(value.refinements).toHaveLength(1);
  });

  it("creates a stable shared goal branch", () => {
    expect(goalBranch("Build a durable mission system", "abc-123456789")).toBe("jarvis/goal-build-a-durable-mission-system-23456789");
  });
});
