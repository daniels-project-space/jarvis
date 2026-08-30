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
  type GoalCrewCharter,
  type GoalOutcomeContract,
} from "./goal-mode";

const outcome: GoalOutcomeContract = {
  objective: "Make the requested product outcome measurably true",
  metric: "verified successful user journeys",
  baseline: "Current production journey and provider evidence are measured before changes",
  target: "Every accepted journey succeeds against the exact production revision",
  measurementWindow: "One complete post-deployment validation window",
  evidenceSources: ["Provider response lineage and production browser checks"],
  stopConditions: ["The target is evidenced and no accepted critical gap remains"],
};

const crew: GoalCrewCharter = {
  process: "hierarchical",
  manager: "jarvis",
  delegationRules: ["Create only necessary specialist workstreams"],
  humanEscalation: ["Escalate only protected decisions after safe independent work is exhausted"],
  reportingCadence: "Event-driven durable checkpoints; no idle polling",
};

const workstream = (value: Record<string, unknown>) => ({
  deliverable: {
    kind: "code_change",
    description: "A scoped verified change with an evidence-rich handoff",
    requiredEvidence: ["Exact relevant tests and caller evidence"],
  },
  guardrails: ["Do not perform protected external actions"],
  ...value,
});

describe("Goal Mode contracts", () => {
  it("keeps automatic continuation budgets stage-bounded and explicitly resumable", () => {
    expect(GOAL_AUTOMATIC_ATTEMPT_LIMITS).toEqual({
      planning: 3,
      building: 4,
      validating: 3,
      refining: 3,
    });
  });

  it("uses Luna only for explicit low-latency bounded evidence and preserves Terra by default", () => {
    const normalEvidence = selectGoalWorkstreamPolicy({
      task: "Run a bounded deterministic read-only audit and verify the exact configuration evidence.",
      agentId: "atlas",
      repo: "daniels-project-space/youtube-studio-ai",
      readonly: true,
      mcp: [],
    });
    expect(normalEvidence).toMatchObject({
      model: "terra",
      reasoningEffort: "xhigh",
      workType: "research",
      complexity: "bounded",
      productionRisk: "low",
    });

    const evidence = selectGoalWorkstreamPolicy({
      task: "Low-latency: run a bounded deterministic read-only audit and verify the exact configuration evidence.",
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
      outcome,
      crew,
      workstreams: [
        workstream({ id: "ui", label: "UI", task: "Connect the complete user interface to the durable backend.", dependsOn: ["core"], acceptanceCriteria: ["UI works"] }),
        workstream({ id: "core", label: "Core", task: "Implement the durable state machine and its recovery transitions.", acceptanceCriteria: ["Transitions are tested"] }),
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
      outcome,
      crew,
      workstreams: [
        workstream({ id: "a", task: "Implement the first substantial bounded work package.", dependsOn: ["b"] }),
        workstream({ id: "b", task: "Implement the second substantial bounded work package.", dependsOn: ["a"] }),
      ],
    })}`)).toThrow(/cycle/);
  });

  it.each([
    ["duplicate ids", [
      workstream({ id: "same", task: "Implement the first substantial bounded work package." }),
      workstream({ id: "same", task: "Implement the second substantial bounded work package." }),
    ], /duplicate workstream id/],
    ["missing dependency", [
      workstream({ id: "a", task: "Implement the first substantial bounded work package.", dependsOn: ["missing"] }),
      workstream({ id: "b", task: "Implement the second substantial bounded work package." }),
    ], /unknown workstream/],
    ["duplicate edge", [
      workstream({ id: "a", task: "Implement the first substantial bounded work package." }),
      workstream({ id: "b", task: "Implement the second substantial bounded work package.", dependsOn: ["a", "a"] }),
    ], /duplicate dependency/],
  ])("rejects %s before dispatch", (_label, workstreams, expected) => {
    expect(() => parseGoalPlan(`${GOAL_PLAN_MARKER}${JSON.stringify({ outcome, crew, workstreams })}`)).toThrow(expected as RegExp);
  });

  it("requires evidence for a pass and repairs for refine", () => {
    expect(() => parseGoalValidation(`${GOAL_VALIDATION_MARKER}{"verdict":"pass","evidence":["build passed","tests passed"]}`))
      .toThrow(/measured target evidence/);
    const value = parseGoalValidation(`${GOAL_VALIDATION_MARKER}${JSON.stringify({
      verdict: "refine",
      summary: "One live gap remains",
      evidence: ["build passed"],
      gaps: ["mobile flow fails"],
      refinements: [{ label: "Mobile repair", task: "Repair the broken mobile flow and verify it with a real browser run.", readonly: true }],
    })}`);
    expect(value.refinements).toEqual([expect.objectContaining({ readonly: true })]);
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
        outcome,
        crew,
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

  it("creates only the necessary crew and makes profit goals impossible to pass on sales proxies", () => {
    const planned = parseGoalPlan(`${GOAL_PLAN_MARKER}${JSON.stringify({
      summary: "Measure the shop, repair the highest-leverage constraint, and prove profit",
      route: "existing_project",
      primaryRepo: "daniels-project-space/dropship-ai",
      assumptions: [],
      outcome: {
        objective: "Make the Snuffelo Shopify store measurably more profitable",
        metric: "net contribution profit after refunds, fees, fulfilment and attributable advertising spend",
        baseline: "A reconciled pre-change Shopify, payment, fulfilment and advertising cohort",
        target: "Positive net contribution profit above the reconciled baseline",
        measurementWindow: "One statistically comparable post-change cohort",
        evidenceSources: ["Shopify orders and refunds", "Payment fees", "Fulfilment costs", "Advertising spend"],
        stopConditions: ["The target is met in reconciled source data", "No protected campaign or pricing action is pending"],
      },
      crew,
      workstreams: [workstream({
        id: "baseline",
        label: "Atlas · profit baseline",
        task: "Reconcile the authoritative commerce data and identify the binding profitability constraint.",
        agentId: "atlas",
        readonly: true,
      })],
      validation: { criteria: ["Net profit improves"], tests: [], liveChecks: ["Reconcile provider totals"] },
    })}`, 6);
    expect(planned.workstreams).toHaveLength(1);
    expect(planned.outcome.metric).toContain("net contribution profit");

    expect(() => parseGoalValidation(`${GOAL_VALIDATION_MARKER}${JSON.stringify({
      verdict: "pass",
      summary: "Sales increased",
      evidence: ["Deployment succeeded", "Shopify revenue increased"],
      outcomeAchieved: false,
      outcomeEvidence: ["Revenue increased"],
      stopConditionsSatisfied: [],
      observedOutcome: {
        metric: "revenue",
        baseline: "£1,000",
        observed: "£1,200",
        target: "positive profit",
        measurementWindow: "one week",
      },
    })}`)).toThrow(/measured target evidence/);

    const validation = parseGoalValidation(`${GOAL_VALIDATION_MARKER}${JSON.stringify({
      verdict: "pass",
      summary: "The reconciled target is met",
      evidence: ["Shopify cohort reconciled", "Costs reconciled"],
      outcomeAchieved: true,
      outcomeEvidence: ["Provider-sourced net contribution improved from -£40 to £85", "Refunds, fees, fulfilment and ads reconcile to the order cohort"],
      stopConditionsSatisfied: ["The target is met in reconciled source data", "No protected action remains"],
      observedOutcome: {
        metric: "net contribution profit",
        baseline: "-£40",
        observed: "£85",
        target: "positive and above baseline",
        measurementWindow: "comparable seven-day cohort",
      },
    })}`);
    expect(validation.outcomeAchieved).toBe(true);
  });

  it("creates a stable shared goal branch", () => {
    expect(goalBranch("Build a durable mission system", "abc-123456789")).toBe("jarvis/goal-build-a-durable-mission-system-23456789");
  });
});
