import { describe, expect, it } from "vitest";
import {
  GOAL_AUTOMATIC_ATTEMPT_LIMITS,
  GOAL_PLAN_MARKER,
  GOAL_PLAN_RESULT_MAX_CHARS,
  GOAL_VALIDATION_MARKER,
  GOAL_VALIDATOR_TASK_MAX_CHARS,
  goalJobRunnableForMission,
  goalJobMatchesMissionPhase,
  goalBranch,
  parseGoalPlan,
  parseGoalValidation,
  plannerTask,
  routeGoal,
  selectGoalWorkstreamPolicy,
  summarizeGoalPhase,
  validatorTask,
} from "./goal-mode";

describe("Goal Mode contracts", () => {
  it("keeps automatic continuation budgets stage-bounded and explicitly resumable", () => {
    expect(GOAL_AUTOMATIC_ATTEMPT_LIMITS).toEqual({
      planning: 3,
      building: 4,
      validating: 3,
      refining: 3,
    });
  });

  it("uses Luna only for bounded low-risk evidence and preserves stronger quality floors", () => {
    const evidence = selectGoalWorkstreamPolicy({
      task: "Run a bounded deterministic read-only audit and verify the exact configuration evidence.",
      agentId: "atlas",
      repo: "daniels-project-space/youtube-studio-ai",
      readonly: true,
      mcp: [],
    });
    expect(evidence).toMatchObject({
      model: "luna",
      reasoningEffort: "medium",
      workType: "research",
      complexity: "bounded",
      productionRisk: "low",
    });

    const protectedTasks = [
      {
        task: "Fix the recurring production root cause across the media generation pipeline.",
        readonly: false,
      },
      {
        task: "Implement reliable thumbnail media generation with real render validation.",
        readonly: false,
      },
      {
        task: "Verify the production deployment and provider surfaces end to end.",
        readonly: true,
      },
    ] as const;
    for (const candidate of protectedTasks) {
      const selection = selectGoalWorkstreamPolicy({
        ...candidate,
        agentId: candidate.readonly ? "sentry" : "paul",
        repo: "daniels-project-space/youtube-studio-ai",
        mcp: ["context7"],
      });
      expect(selection.model).not.toBe("luna");
    }
  });

  it("routes new apps into App Factory and video work into YouTube Studio", () => {
    expect(routeGoal("Build a new app for comparing rental insurance").kind).toBe("app_factory");
    expect(routeGoal("Refine the pacing and thumbnail for my next YouTube video").kind).toBe("youtube_studio");
  });

  it("keeps explicit existing products inside their own repository", () => {
    const route = routeGoal("Massively improve Jarvis long-term agent work");
    expect(route.kind).toBe("existing_project");
    expect(route.primaryRepo).toBe("daniels-project-space/jarvis");
    expect(routeGoal("Fix the video overlay inside Jarvis").primaryRepo).toBe("daniels-project-space/jarvis");
    expect(routeGoal("Build a new video editing app").kind).toBe("app_factory");
    expect(routeGoal("Refine this video", "daniels-project-space/media-engine").primaryRepo)
      .toBe("daniels-project-space/media-engine");
    const dropship = routeGoal("Make Dropship AI launch-ready", "daniels-project-space/dropship-ai");
    expect(dropship.infrastructureContext).toContain("peaceful-panda-894");
    expect(dropship.infrastructureContext).toContain("proj_ebwgqvfufapbqnhjxhnc");
    expect(dropship.infrastructureContext).not.toContain("tangible-goose-318");
  });

  it("classifies failed dependency phases instead of waiting forever", () => {
    expect(summarizeGoalPhase([
      { _id: "a", status: "error" },
      { _id: "b", status: "pending" },
    ])).toMatchObject({ state: "blocked", failed: [{ _id: "a", status: "error" }] });
    expect(summarizeGoalPhase([{ status: "done" }, { status: "done" }]).state).toBe("complete");
    expect(summarizeGoalPhase([{ status: "done" }, { status: "running" }]).state).toBe("active");
  });

  it("fences goal jobs to the mission's active phase and repair wave", () => {
    expect(goalJobMatchesMissionPhase(
      { goalStage: "building", goalWave: 0 },
      { mode: "goal", status: "running", phase: "building", revisionWave: 0 },
    )).toBe(true);
    expect(goalJobMatchesMissionPhase(
      { goalStage: "refining", goalWave: 1 },
      { mode: "goal", status: "running", phase: "refining", revisionWave: 2 },
    )).toBe(false);
    expect(goalJobMatchesMissionPhase(
      { goalStage: "building", goalWave: 0 },
      { mode: "goal", status: "paused", phase: "building", revisionWave: 0 },
    )).toBe(false);
  });

  it("wakes specialist workers only for runnable work", () => {
    const mission = { mode: "goal", status: "running", phase: "building", revisionWave: 0 };
    expect(goalJobRunnableForMission(
      { status: "pending", goalStage: "building", goalWave: 0, dependsOn: ["plan"], nextRunAt: 100 },
      mission,
      new Set(["plan"]),
      100,
    )).toBe(true);
    expect(goalJobRunnableForMission(
      { status: "pending", goalStage: "building", goalWave: 0, dependsOn: ["plan"], nextRunAt: 100 },
      mission,
      new Set(),
      100,
    )).toBe(false);
    expect(goalJobRunnableForMission(
      { status: "pending", goalStage: "building", goalWave: 0, approvalRequired: true, approvalStatus: "pending" },
      mission,
      new Set(),
      100,
    )).toBe(false);
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

  it("gives complex plans a useful durable response envelope", () => {
    const prompt = plannerTask(
      "Make a mature commerce application launch-ready end to end",
      routeGoal("Make Dropship AI launch-ready", "daniels-project-space/dropship-ai"),
      ["Verify every external pipeline", "Preserve all consequential approval gates"],
      8,
    );
    expect(GOAL_PLAN_RESULT_MAX_CHARS).toBeGreaterThanOrEqual(8_000);
    expect(prompt).toContain("7,500 characters");
    expect(prompt).toContain("fix their generation, render, configuration, or data root cause");
    expect(prompt).toContain("a rejection-only gate does not satisfy the outcome");
  });

  it("rejects cyclic plans", () => {
    expect(() => parseGoalPlan(`${GOAL_PLAN_MARKER}${JSON.stringify({
      workstreams: [
        { id: "a", task: "Implement the first substantial bounded work package.", dependsOn: ["b"] },
        { id: "b", task: "Implement the second substantial bounded work package.", dependsOn: ["a"] },
      ],
    })}`)).toThrow(/cycle/);
  });

  it.each([
    ["duplicate ids", [
      { id: "same", task: "Implement the first substantial bounded work package." },
      { id: "same", task: "Implement the second substantial bounded work package." },
    ], /duplicate workstream id/],
    ["missing dependency", [
      { id: "a", task: "Implement the first substantial bounded work package.", dependsOn: ["missing"] },
      { id: "b", task: "Implement the second substantial bounded work package." },
    ], /unknown workstream/],
    ["duplicate edge", [
      { id: "a", task: "Implement the first substantial bounded work package." },
      { id: "b", task: "Implement the second substantial bounded work package.", dependsOn: ["a", "a"] },
    ], /duplicate dependency/],
  ])("rejects %s before dispatch", (_label, workstreams, expected) => {
    expect(() => parseGoalPlan(`${GOAL_PLAN_MARKER}${JSON.stringify({ workstreams })}`)).toThrow(expected as RegExp);
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

  it("keeps deep validator evidence and its machine contract inside the durable task budget", () => {
    const repeated = (count: number, prefix: string) => Array.from(
      { length: count },
      (_, index) => `${prefix} ${index} ${"evidence ".repeat(80)}`,
    );
    const task = validatorTask({
      goal: "Validate the complete production outcome. ".repeat(40),
      plan: {
        summary: "Skeptically validate every protected and public surface. ".repeat(40),
        route: "existing_project",
        assumptions: [],
        workstreams: [],
        validation: {
          criteria: repeated(12, "criterion"),
          tests: repeated(12, "test"),
          liveChecks: repeated(12, "live check"),
        },
      },
      acceptanceCriteria: repeated(10, "acceptance"),
      buildEvidence: repeated(8, "builder").map((result, index) => ({
        label: `Workstream ${index}`,
        status: "done",
        result,
      })),
      revisionWave: 3,
      externalContext: "provider evidence ".repeat(500),
      auditSnapshot: "protected snapshot evidence ".repeat(500),
    });
    expect(task.length).toBeLessThanOrEqual(GOAL_VALIDATOR_TASK_MAX_CHARS);
    expect(task).toContain("Delivery-controller audit snapshot");
    expect(task).toContain("caller-supplied field");
    expect(task).toContain("persisted lineage");
    expect(task).toContain(GOAL_VALIDATION_MARKER);
    expect(task).toContain('"verdict":"pass|refine|blocked"');
  });

  it("creates a stable shared goal branch", () => {
    expect(goalBranch("Build a durable mission system", "abc-123456789")).toBe("jarvis/goal-build-a-durable-mission-system-23456789");
  });
});
