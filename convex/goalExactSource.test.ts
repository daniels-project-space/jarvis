import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import schema from "./schema";
import {
  GOAL_AUTOMATIC_ATTEMPT_LIMITS,
} from "../src/lib/goal-mode";
import {
  SOURCE_ADMISSION_PROTOCOL_VERSION,
  canonicalProjectIdForRepository,
  sealProjectSourceAdmission,
} from "../src/lib/source-admission";

declare global {
  interface ImportMeta { glob(pattern: string): Record<string, () => Promise<unknown>>; }
}

const modules = import.meta.glob("./**/*.ts");
const TOKEN = "goal-exact-source-test-worker";
const REPOSITORY = "daniels-project-space/youtube-studio-ai";
const SOURCE_BRANCH = "continuation/youtube-studio-overhaul";
const SOURCE_HEAD_SHA = "c".repeat(40);

describe("Goal Mode exact source lineage", () => {
  beforeEach(() => { process.env.JARVIS_WORKER_TOKEN = TOKEN; });
  afterEach(() => { delete process.env.JARVIS_WORKER_TOKEN; });

  it("preserves the sealed branch through adaptively routed bounded work", async () => {
    const canonicalProjectId = canonicalProjectIdForRepository(REPOSITORY);
    if (!canonicalProjectId) throw new Error("YouTube Studio test repository is not registered");
    const projectAdmission = await sealProjectSourceAdmission({
      protocolVersion: SOURCE_ADMISSION_PROTOCOL_VERSION,
      canonicalProjectId,
      repository: REPOSITORY,
      sourceProvider: "github",
      sourceBranch: SOURCE_BRANCH,
      sourceRef: `refs/heads/${SOURCE_BRANCH}`,
      sourceHeadSha: SOURCE_HEAD_SHA,
      sourceObservedAt: Date.now(),
    });
    const t = convexTest(schema, modules);

    const created = await t.mutation(api.goalMode.createV2, {
      goal: "Overhaul YouTube Studio from the exact continuation branch",
      route: "youtube_studio",
      routeReason: "The existing YouTube Studio product owns this outcome.",
      primaryRepo: REPOSITORY,
      infrastructureContext: "Reuse the existing production pipeline.",
      projectAdmission,
      workerToken: TOKEN,
    });

    const persisted = await t.run(async (ctx) => {
      const mission = await ctx.db.get(created.missionId);
      const plannerJob = await ctx.db.get(created.plannerJobId);
      const schedulingAdmission = await ctx.db.query("jobSchedulingAdmissions")
        .filter((query) => query.eq(query.field("jobId"), created.plannerJobId))
        .first();
      return { mission, plannerJob, schedulingAdmission };
    });
    const expectedSource = {
      canonicalProjectId,
      sourceBranch: SOURCE_BRANCH,
      sourceRef: `refs/heads/${SOURCE_BRANCH}`,
      sourceHeadSha: SOURCE_HEAD_SHA,
      sourceAdmissionDigest: projectAdmission.sourceAdmissionDigest,
    };

    expect(persisted.mission).toMatchObject({
      ...expectedSource,
      projectAdmissions: [expect.objectContaining(expectedSource)],
    });
    expect(persisted.plannerJob).toMatchObject(expectedSource);
    expect(persisted.plannerJob).toMatchObject({
      model: "terra",
      reasoningEffort: "ultra",
      maxAttempts: GOAL_AUTOMATIC_ATTEMPT_LIMITS.planning,
    });
    expect(persisted.schedulingAdmission).toMatchObject(expectedSource);

    const plan = {
      summary: "Inspect cheaply, then fix the real production root cause.",
      route: "youtube_studio",
      primaryRepo: REPOSITORY,
      assumptions: [],
      workstreams: [
        {
          id: "bounded-evidence",
          label: "Bounded evidence",
          task: "Run a bounded deterministic read-only audit and verify the exact configuration evidence.",
          agentId: "atlas",
          repo: REPOSITORY,
          readonly: true,
          dependsOn: [],
          acceptanceCriteria: ["Record the exact current configuration"],
          mcp: [],
        },
        {
          id: "production-root-cause",
          label: "Production root cause",
          task: "Fix the recurring production root cause across the media generation pipeline and deployment validation.",
          agentId: "paul",
          repo: REPOSITORY,
          readonly: false,
          dependsOn: ["bounded-evidence"],
          acceptanceCriteria: ["Root cause is fixed and deeply validated"],
          mcp: ["context7"],
        },
      ],
      validation: {
        criteria: ["The production root cause is fixed"],
        tests: ["Run focused and full tests"],
        liveChecks: ["Verify the exact production deployment"],
      },
    };
    const recorded = await t.mutation(api.goalMode.recordPlanV2, {
      id: created.missionId,
      expectedAdvanceAttempt: 0,
      plan,
      workerToken: TOKEN,
    });
    expect(recorded).toMatchObject({ advanced: true, materializing: true });
    const materialized = await t.mutation(api.goalMode.materializePlanBatch, {
      id: created.missionId,
      planDigest: String(recorded.planDigest),
      workerToken: TOKEN,
    });
    expect(materialized).toMatchObject({ advanced: true, complete: true, jobs: 2 });

    const builders = await t.run(async (ctx) => await ctx.db.query("jobs")
      .filter((query) => query.eq(query.field("missionId"), String(created.missionId)))
      .collect());
    const evidence = builders.find((job) => job.goalWorkstreamId === "bounded-evidence");
    const rootCause = builders.find((job) => job.goalWorkstreamId === "production-root-cause");
    expect(evidence).toMatchObject({
      ...expectedSource,
      model: "luna",
      reasoningEffort: "medium",
      maxAttempts: GOAL_AUTOMATIC_ATTEMPT_LIMITS.building,
    });
    expect(rootCause).toMatchObject({
      ...expectedSource,
      model: "terra",
      reasoningEffort: "xhigh",
      maxAttempts: GOAL_AUTOMATIC_ATTEMPT_LIMITS.building,
    });
  });

  it("reserves Sol/max goal planning for an explicitly critical production-security outcome", async () => {
    const canonicalProjectId = canonicalProjectIdForRepository(REPOSITORY);
    if (!canonicalProjectId) throw new Error("YouTube Studio test repository is not registered");
    const projectAdmission = await sealProjectSourceAdmission({
      protocolVersion: SOURCE_ADMISSION_PROTOCOL_VERSION,
      canonicalProjectId,
      repository: REPOSITORY,
      sourceProvider: "github",
      sourceBranch: SOURCE_BRANCH,
      sourceRef: `refs/heads/${SOURCE_BRANCH}`,
      sourceHeadSha: SOURCE_HEAD_SHA,
      sourceObservedAt: Date.now(),
    });
    const t = convexTest(schema, modules);
    const created = await t.mutation(api.goalMode.createV2, {
      goal: "Repair the live production authentication and privacy isolation breach",
      route: "youtube_studio",
      routeReason: "The existing YouTube Studio product owns this outcome.",
      primaryRepo: REPOSITORY,
      infrastructureContext: "Reuse the existing production pipeline.",
      risk: "critical",
      projectAdmission,
      workerToken: TOKEN,
    });
    const planner = await t.run(async (ctx) => ctx.db.get(created.plannerJobId));
    expect(planner).toMatchObject({ model: "sol", reasoningEffort: "max" });
  });
});
