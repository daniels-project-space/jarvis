import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { projectJobRuntime, projectMissionRuntime } from "./controlPlane";

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>;
  }
}

const modules = import.meta.glob("./**/*.ts");
const THREAD = "supervised-thread";
const VIEWER = {
  issuer: "https://jarvis-orcin-six.vercel.app",
  subject: "daniel-owner",
};

type SupervisorState = "ready" | "leased" | "waiting" | "paused" | "needs_input" | "terminal";

async function seedSupervisedMission(
  t: ReturnType<typeof convexTest>,
  options: {
    state: SupervisorState;
    missionStatus?: string;
    nextTickAt?: number;
    leaseUntil?: number;
  },
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const mission = {
      goal: `Supervised ${options.state} mission`,
      mode: "supervised",
      status: options.missionStatus ?? "running",
      agentCount: 0,
      originThreadId: THREAD,
      managerAgentId: "jarvis",
      priority: 92,
      risk: "medium",
      phase: "planning",
      percent: 0,
      createdAt: now,
      updatedAt: now,
    };
    const missionId = await ctx.db.insert("missions", mission);
    await ctx.db.insert("missionRuntime", projectMissionRuntime({ ...mission, _id: missionId }));
    await ctx.db.insert("missionSupervisorState", {
      protocolVersion: 1,
      missionId,
      requestKey: `request:${missionId}`,
      requestDigest: "a".repeat(64),
      requestPayloadJson: "{}",
      state: options.state,
      epoch: 1,
      nextDecisionSequence: 1,
      inputRevision: 0,
      handledInputRevision: 0,
      dirtyJobIds: [],
      ...(options.nextTickAt === undefined ? {} : { nextTickAt: options.nextTickAt }),
      ...(options.state === "leased"
        ? {
            leaseOwner: "trigger:supervisor",
            leaseToken: `lease:${missionId}`,
            leaseVersion: 1,
            leaseUntil: options.leaseUntil ?? now + 60_000,
          }
        : {
            leaseVersion: 0,
          }),
      totalJobs: 0,
      maxJobs: 24,
      decisionCount: 0,
      maxDecisions: 64,
      deadlineAt: now + 86_400_000,
      consecutiveFailures: 0,
      createdAt: now,
      updatedAt: now,
    });
    return missionId;
  });
}

async function seedActiveJob(
  t: ReturnType<typeof convexTest>,
  missionId: Id<"missions">,
  overrides: Record<string, unknown> = {},
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const job = {
      task: "Implement the supervised mission",
      label: "Paul · supervised implementation",
      missionId: String(missionId),
      visibility: "conversation",
      originThreadId: THREAD,
      status: "running",
      priority: 90,
      stage: "implementation",
      percent: 12,
      progress: "Implementing the admitted work",
      agentId: "paul",
      attempt: 1,
      maxAttempts: 12,
      heartbeatAt: now,
      progressAt: now,
      createdAt: now,
      ...overrides,
    };
    const jobId = await ctx.db.insert("jobs", job);
    await ctx.db.insert("jobRuntime", projectJobRuntime({ ...job, _id: jobId }));
    return jobId;
  });
}

async function snapshot(t: ReturnType<typeof convexTest>) {
  return await t.withIdentity(VIEWER).query(api.commandCenter.snapshot, { threadId: THREAD });
}

describe("supervised mission command-center projection", () => {
  it("shows an immediate honest planning item for a due ready admission", async () => {
    const t = convexTest(schema, modules);
    const missionId = await seedSupervisedMission(t, { state: "ready" });

    const result = await snapshot(t);

    expect(result.active).toMatchObject({
      id: `supervisor:${missionId}`,
      missionId,
      label: "Planning · Supervised ready mission",
      status: "queued",
      stage: "ready to plan",
      percent: 0,
      extraCount: 0,
      needsDaniel: false,
    });
    expect(result.fleet).toMatchObject({
      id: missionId,
      mode: "supervised",
      status: "running",
      phase: "planning",
      percent: 0,
      controls: [],
    });
    expect(result.hierarchy).toHaveLength(1);
    expect(result.hierarchy[0].projects[0].jobs).toEqual([
      expect.objectContaining({
        jobId: `supervisor:${missionId}`,
        projectionKind: "supervisor_planning",
        progress: "",
        progressAt: null,
        workerRuntime: null,
      }),
    ]);
  });

  it("uses real mission jobs without duplicating the supervisor planning item", async () => {
    const t = convexTest(schema, modules);
    const missionId = await seedSupervisedMission(t, {
      state: "ready",
      nextTickAt: Date.now() - 1,
    });
    const jobId = await seedActiveJob(t, missionId);

    const result = await snapshot(t);
    const hierarchy = result.hierarchy as Array<{
      projects: Array<{
        jobs: Array<{ jobId: string; projectionKind?: string }>;
      }>;
    }>;
    const jobs = hierarchy.flatMap((mission) =>
      mission.projects.flatMap((project) => project.jobs),
    );

    expect(result.active?.id).toBe(jobId);
    expect(jobs.map((job) => job.jobId)).toEqual([jobId]);
    expect(jobs.some((job) => job.projectionKind === "supervisor_planning")).toBe(false);
  });

  it("hides waiting and routine-health-only missions but keeps a waiting mission relevant through real active work", async () => {
    const waiting = convexTest(schema, modules);
    const waitingMission = await seedSupervisedMission(waiting, { state: "waiting" });
    expect(await snapshot(waiting)).toEqual({ active: null, fleet: null, hierarchy: [] });

    const jobId = await seedActiveJob(waiting, waitingMission);
    expect((await snapshot(waiting)).active?.id).toBe(jobId);

    const healthOnly = convexTest(schema, modules);
    const healthMission = await seedSupervisedMission(healthOnly, { state: "waiting" });
    await seedActiveJob(healthOnly, healthMission, {
      task: "Run provider health check",
      label: "Cloud health audit",
      stage: "heartbeat",
    });
    expect(await snapshot(healthOnly)).toEqual({ active: null, fleet: null, hierarchy: [] });
  });

  it("shows only a valid live lease and hides expired leases or inactive missions", async () => {
    const valid = convexTest(schema, modules);
    const validMission = await seedSupervisedMission(valid, {
      state: "leased",
      leaseUntil: Date.now() + 60_000,
    });
    expect(await snapshot(valid)).toMatchObject({
      active: {
        id: `supervisor:${validMission}`,
        status: "running",
        stage: "planning",
      },
      fleet: { mode: "supervised" },
    });

    const expired = convexTest(schema, modules);
    await seedSupervisedMission(expired, {
      state: "leased",
      leaseUntil: Date.now() - 1,
    });
    expect(await snapshot(expired)).toEqual({ active: null, fleet: null, hierarchy: [] });

    const inactive = convexTest(schema, modules);
    await seedSupervisedMission(inactive, {
      state: "ready",
      missionStatus: "done",
      nextTickAt: Date.now() - 1,
    });
    expect(await snapshot(inactive)).toEqual({ active: null, fleet: null, hierarchy: [] });
  });
});
