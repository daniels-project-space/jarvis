import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { projectJobRuntime, projectMissionRuntime } from "./controlPlane";
import { syncMissionSupervisorCommand } from "./missionSupervisorCommand";

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
    question?: string;
    inputTargeted?: boolean;
    totalJobs?: number;
    priority?: number;
    originThreadId?: string;
  },
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const missionStatus = options.missionStatus
      ?? (options.state === "paused"
        ? "paused"
        : options.state === "needs_input"
          ? "needs_input"
          : options.state === "terminal"
            ? "done"
            : "running");
    const mission = {
      goal: `Supervised ${options.state} mission`,
      mode: "supervised",
      status: missionStatus,
      agentCount: options.totalJobs ?? 0,
      originThreadId: options.originThreadId ?? THREAD,
      managerAgentId: "jarvis",
      priority: options.priority ?? 92,
      risk: "medium",
      phase: options.state === "paused"
        ? "paused"
        : options.state === "needs_input"
          ? "needs_input"
          : options.state === "terminal"
            ? missionStatus
            : "planning",
      percent: 0,
      steerRevision: 3,
      ...(options.question === undefined
        ? {}
        : { failureReason: options.question }),
      createdAt: now,
      updatedAt: now,
    };
    const missionId = await ctx.db.insert("missions", mission);
    await ctx.db.insert("missionRuntime", projectMissionRuntime({ ...mission, _id: missionId }));
    const stateId = await ctx.db.insert("missionSupervisorState", {
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
      totalJobs: options.totalJobs ?? 0,
      maxJobs: 24,
      decisionCount: 0,
      maxDecisions: 64,
      deadlineAt: now + 86_400_000,
      consecutiveFailures: 0,
      createdAt: now,
      updatedAt: now,
    });
    const [missionRow, stateRow] = await Promise.all([
      ctx.db.get(missionId),
      ctx.db.get(stateId),
    ]);
    if (!missionRow || !stateRow) throw new Error("Supervisor fixture missing");
    await syncMissionSupervisorCommand(
      ctx,
      missionRow,
      stateRow,
      options.question === undefined
        ? { mode: "clear" }
        : { mode: "set", question: options.question },
      options.inputTargeted ?? false,
    );
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
      controls: ["pause", "cancel", "steer"],
      supervisor: {
        protocolVersion: 1,
        state: "ready",
        inputRevision: 0,
        steerRevision: 3,
        deadlineAt: expect.any(Number),
      },
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
      totalJobs: 1,
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
    expect(result.fleet).toMatchObject({
      supervisor: {
        state: "ready",
        inputRevision: 0,
      },
      controls: [],
    });
    expect(jobs.map((job) => job.jobId)).toEqual([jobId]);
    expect(jobs.some((job) => job.projectionKind === "supervisor_planning")).toBe(false);
  });

  it.each([
    {
      state: "ready" as const,
      nextTickAt: Date.now() + 60_000,
      activeStatus: "queued",
      stage: "planning scheduled",
      controls: ["pause", "cancel", "steer"],
    },
    {
      state: "waiting" as const,
      nextTickAt: Date.now() + 60_000,
      activeStatus: "queued",
      stage: "waiting to retry",
      controls: ["pause", "cancel", "steer"],
    },
    {
      state: "paused" as const,
      activeStatus: "paused",
      stage: "paused",
      controls: ["resume", "cancel"],
    },
    {
      state: "needs_input" as const,
      activeStatus: "needs_input",
      stage: "waiting for Daniel",
      controls: ["provide_input", "cancel"],
      question: "Choose the exact delivery boundary.",
    },
  ])("shows every nonterminal $state command honestly", async (fixture) => {
    const t = convexTest(schema, modules);
    const missionId = await seedSupervisedMission(t, fixture);
    const result = await snapshot(t);

    expect(result.active).toMatchObject({
      id: `supervisor:${missionId}`,
      status: fixture.activeStatus,
      stage: fixture.stage,
      needsDaniel: fixture.state === "needs_input",
    });
    expect(result.fleet).toMatchObject({
      controls: fixture.controls,
      supervisor: {
        state: fixture.state,
        inputRevision: 0,
        steerRevision: 3,
        ...(fixture.question === undefined
          ? {}
          : { question: fixture.question }),
      },
    });
  });

  it("does not let routine work suppress a meaningful supervisor command", async () => {
    const healthOnly = convexTest(schema, modules);
    const healthMission = await seedSupervisedMission(healthOnly, { state: "waiting" });
    await seedActiveJob(healthOnly, healthMission, {
      task: "Run provider health check",
      label: "Cloud health audit",
      stage: "heartbeat",
    });
    expect((await snapshot(healthOnly)).active?.id).toBe(
      `supervisor:${healthMission}`,
    );
  });

  it("shows active and expired leases but hides terminal authority", async () => {
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
    const expiredMission = await seedSupervisedMission(expired, {
      state: "leased",
      leaseUntil: Date.now() - 1,
    });
    expect(await snapshot(expired)).toMatchObject({
      active: {
        id: `supervisor:${expiredMission}`,
        status: "running",
        stage: "lease expired · recovery due",
      },
      fleet: { supervisor: { state: "leased" } },
    });

    const inactive = convexTest(schema, modules);
    await seedSupervisedMission(inactive, {
      state: "terminal",
      missionStatus: "done",
    });
    expect(await snapshot(inactive)).toEqual({ active: null, fleet: null, hierarchy: [] });
  });

  it("cannot starve this thread behind more than eight other-thread commands", async () => {
    const t = convexTest(schema, modules);
    for (let index = 0; index < 12; index += 1) {
      await seedSupervisedMission(t, {
        state: "ready",
        originThreadId: `other-thread-${index}`,
        priority: 100,
      });
    }
    const current = await seedSupervisedMission(t, {
      state: "waiting",
      priority: 1,
    });

    expect(await snapshot(t)).toMatchObject({
      active: { id: `supervisor:${current}` },
      fleet: { id: current },
    });
  });

  it("keeps low-priority targeted input authority for a real attention job", async () => {
    const t = convexTest(schema, modules);
    for (let index = 0; index < 9; index += 1) {
      await seedSupervisedMission(t, {
        state: "ready",
        priority: 100 - index,
      });
    }
    const target = await seedSupervisedMission(t, {
      state: "needs_input",
      totalJobs: 1,
      priority: 1,
      question: "Which exact recovery boundary should Paul apply?",
      inputTargeted: true,
    });
    const jobId = await seedActiveJob(t, target, {
      status: "needs_input",
      priority: 1,
      stage: "needs Daniel",
      progress: "Waiting for the receipt-targeted answer",
    });

    const result = await snapshot(t);
    expect(result.active?.id).toBe(jobId);
    expect(result.fleet).toMatchObject({
      id: target,
      controls: ["provide_input", "cancel"],
      supervisor: {
        state: "needs_input",
        inputRevision: 0,
        question: "Which exact recovery boundary should Paul apply?",
      },
    });
    const jobs = result.hierarchy.flatMap((mission: {
      projects: Array<{ jobs: Array<{ jobId: string }> }>;
    }) => mission.projects.flatMap((project) => project.jobs));
    expect(jobs.filter((job: { jobId: string }) =>
      job.jobId === `supervisor:${target}`
    )).toHaveLength(0);
  });
});
