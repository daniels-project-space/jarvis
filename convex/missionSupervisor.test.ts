import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest, type TestConvex } from "convex-test";
import { makeFunctionReference } from "convex/server";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { testProjectSourceAdmission } from "./testSourceAdmission";
import {
  evidenceProjectSourceAdmission,
  type ProjectSourceAdmission,
} from "../src/lib/source-admission";
import {
  MISSION_SUPERVISOR_LEASE_MS,
  MISSION_SUPERVISOR_MAX_DUE,
  MISSION_SUPERVISOR_MAX_JOBS,
} from "./missionSupervisor";

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>;
  }
}

const modules = import.meta.glob("./**/*.ts");
const WORKER = "mission-supervisor-test-worker";
const DISPATCHER = "mission-supervisor-test-dispatcher";
const START_AT = Date.parse("2026-07-23T12:00:00Z");
const supervisorApi = {
  startV1: makeFunctionReference<"mutation">("missionSupervisor:startV1"),
  dueV1: makeFunctionReference<"query">("missionSupervisor:dueV1"),
  claimV1: makeFunctionReference<"mutation">("missionSupervisor:claimV1"),
  renewV1: makeFunctionReference<"mutation">("missionSupervisor:renewV1"),
  releaseFailureV1: makeFunctionReference<"mutation">(
    "missionSupervisor:releaseFailureV1",
  ),
};

type SupervisorTest = TestConvex<typeof schema>;
type StartResult = {
  replayed: boolean;
  missionId: Id<"missions">;
  stateId: Id<"missionSupervisorState">;
  requestDigest: string;
  deadlineAt: number;
};
type StartOptions = {
  goal?: string;
  profile?: "short_fleet" | "durable_goal";
  context?: string;
  repo?: string;
  desiredWorkstreams?: number;
  requestedWorkstreams?: Array<{
    task: string;
    label?: string;
    repo?: string;
    model?: "luna" | "terra" | "sol";
    agentId?: "paul" | "atlas" | "iris" | "maya" | "sentry";
    readonly?: boolean;
    approvalRequired?: boolean;
    risk?: "low" | "medium" | "high" | "consequential";
    acceptanceCriteria?: string[];
  }>;
  acceptanceCriteria?: string[];
  projectAdmissions?: ProjectSourceAdmission[];
  originThreadId?: string;
  priority?: number;
  risk?: "low" | "medium" | "high" | "consequential";
  deadlineMs?: number;
};

beforeEach(() => {
  process.env.JARVIS_WORKER_TOKEN = WORKER;
  process.env.JARVIS_DISPATCH_TOKEN = DISPATCHER;
  vi.useFakeTimers();
  vi.setSystemTime(START_AT);
});

afterEach(() => {
  delete process.env.JARVIS_WORKER_TOKEN;
  delete process.env.JARVIS_DISPATCH_TOKEN;
  vi.useRealTimers();
});

async function start(
  t: SupervisorTest,
  requestKey: string,
  options: StartOptions = {},
): Promise<StartResult> {
  const projectAdmissions =
    options.projectAdmissions ?? [await testProjectSourceAdmission()];
  return await t.mutation(supervisorApi.startV1, {
    requestKey,
    goal: options.goal ?? `Supervise bounded request ${requestKey}`,
    projectAdmissions,
    dispatchToken: DISPATCHER,
    ...(options.profile === undefined ? {} : { profile: options.profile }),
    ...(options.context === undefined ? {} : { context: options.context }),
    ...(options.repo === undefined ? {} : { repo: options.repo }),
    ...(options.desiredWorkstreams === undefined
      ? {}
      : { desiredWorkstreams: options.desiredWorkstreams }),
    ...(options.requestedWorkstreams === undefined
      ? {}
      : { requestedWorkstreams: options.requestedWorkstreams }),
    ...(options.acceptanceCriteria === undefined
      ? {}
      : { acceptanceCriteria: options.acceptanceCriteria }),
    ...(options.originThreadId === undefined
      ? {}
      : { originThreadId: options.originThreadId }),
    ...(options.priority === undefined ? {} : { priority: options.priority }),
    ...(options.risk === undefined ? {} : { risk: options.risk }),
    ...(options.deadlineMs === undefined
      ? {}
      : { deadlineMs: options.deadlineMs }),
  }) as StartResult;
}

async function supervisorState(
  t: SupervisorTest,
  missionId: Id<"missions">,
) {
  return await t.run(async (ctx) =>
    await ctx.db
      .query("missionSupervisorState")
      .withIndex("by_mission", (q) => q.eq("missionId", missionId))
      .unique()
  );
}

async function claim(
  t: SupervisorTest,
  missionId: Id<"missions">,
  expectedLeaseVersion: number,
  leaseOwner = "worker-one",
  leaseToken = `lease-token-${leaseOwner}-0001`,
) {
  return await t.mutation(supervisorApi.claimV1, {
    missionId,
    leaseOwner,
    leaseToken,
    expectedLeaseVersion,
    workerToken: WORKER,
  });
}

function exactFence(
  missionId: Id<"missions">,
  claimed: {
    epoch: number;
    nextDecisionSequence: number;
    inputRevision: number;
    leaseVersion: number;
  },
  leaseOwner = "worker-one",
  leaseToken = `lease-token-${leaseOwner}-0001`,
) {
  return {
    missionId,
    leaseOwner,
    leaseToken,
    leaseVersion: claimed.leaseVersion,
    expectedEpoch: claimed.epoch,
    expectedDecisionSequence: claimed.nextDecisionSequence,
    expectedInputRevision: claimed.inputRevision,
    workerToken: WORKER,
  };
}

describe("dormant mission supervisor authority", () => {
  it("starts atomically, replays one canonical request, rejects conflicts, and creates no jobs", async () => {
    const t = convexTest(schema, modules);
    const [jarvis, rentals] = await Promise.all([
      testProjectSourceAdmission("daniels-project-space/jarvis"),
      testProjectSourceAdmission("daniels-project-space/rental-manager-v2"),
    ]);
    const request = {
      requestKey: "canonical-start-1",
      goal: "Coordinate one bounded cross-project supervisor mission",
      profile: "durable_goal" as const,
      repo: "daniels-project-space/jarvis",
      desiredWorkstreams: 2,
      requestedWorkstreams: [{
        task: "Inspect the admitted Jarvis authority without changing production.",
        repo: "daniels-project-space/jarvis",
        model: "terra" as const,
        agentId: "paul" as const,
        readonly: true,
        acceptanceCriteria: ["Report exact evidence."],
      }],
      acceptanceCriteria: ["Keep all consequential actions gated."],
      projectAdmissions: [rentals, jarvis],
      dispatchToken: DISPATCHER,
    };

    const first = await t.mutation(supervisorApi.startV1, request);
    expect(first).toMatchObject({ replayed: false });
    const state = await supervisorState(t, first.missionId);
    const persisted = await t.run(async (ctx) => {
      const mission = await ctx.db.get(first.missionId);
      const runtime = await ctx.db
        .query("missionRuntime")
        .withIndex("by_mission", (q) => q.eq("missionId", first.missionId))
        .unique();
      const jobs = await ctx.db
        .query("jobs")
        .withIndex("by_mission", (q) => q.eq("missionId", String(first.missionId)))
        .collect();
      return { mission, runtime, jobs };
    });
    expect(state).toMatchObject({
      requestKey: request.requestKey,
      requestDigest: first.requestDigest,
      state: "ready",
      maxJobs: 24,
      maxDecisions: 64,
      totalJobs: 0,
      decisionCount: 0,
    });
    expect(persisted.mission).toMatchObject({
      mode: "supervised",
      status: "running",
      agentCount: 0,
    });
    expect(persisted.runtime).toMatchObject({
      missionId: first.missionId,
      mode: "supervised",
      status: "running",
    });
    expect(persisted.jobs).toEqual([]);

    vi.advanceTimersByTime(11 * 60_000);
    const replay = await t.mutation(supervisorApi.startV1, {
      ...request,
      projectAdmissions: [jarvis, rentals],
    });
    expect(replay).toMatchObject({
      replayed: true,
      missionId: first.missionId,
      stateId: first.stateId,
      requestDigest: first.requestDigest,
    });
    await expect(t.mutation(supervisorApi.startV1, {
      ...request,
      goal: `${request.goal} with conflicting scope`,
    })).rejects.toThrow("conflicts with a different payload");

    const counts = await t.run(async (ctx) => ({
      missions: (await ctx.db.query("missions").collect()).length,
      states: (await ctx.db.query("missionSupervisorState").collect()).length,
      jobs: (await ctx.db.query("jobs").collect()).length,
    }));
    expect(counts).toEqual({ missions: 1, states: 1, jobs: 0 });
  });

  it("rejects stale, invalid, and aggregate-oversized admission payloads without partial rows", async () => {
    const t = convexTest(schema, modules);
    const authorizedAdmission = await testProjectSourceAdmission();
    await expect(t.mutation(supervisorApi.startV1, {
      requestKey: "unauthorized-start",
      goal: "This request must not create partial supervisor authority.",
      projectAdmissions: [authorizedAdmission],
      dispatchToken: "wrong-dispatcher-capability",
    })).rejects.toThrow("Authentication required");

    const stale = await evidenceProjectSourceAdmission(
      Date.now() - 10 * 60_000 - 1,
    );
    await expect(start(t, "stale-admission", {
      projectAdmissions: [stale],
    })).rejects.toThrow("requires fresh canonical project admissions");

    const fresh = await testProjectSourceAdmission();
    await expect(start(t, "invalid-admission", {
      projectAdmissions: [{
        ...fresh,
        sourceAdmissionDigest: "0".repeat(64),
      }],
    })).rejects.toThrow("requires fresh canonical project admissions");

    await expect(start(t, "short-goal", {
      goal: "too short",
      projectAdmissions: [fresh],
    })).rejects.toThrow("goal must be between 12 and 500 UTF-8 bytes");
    await expect(start(t, "short-task", {
      projectAdmissions: [fresh],
      requestedWorkstreams: [{
        task: "short",
        acceptanceCriteria: ["Return bounded evidence."],
      }],
    })).rejects.toThrow(
      "requestedWorkstreams[0].task must be between 12 and 4000 UTF-8 bytes",
    );
    await expect(start(t, "short-label", {
      projectAdmissions: [fresh],
      requestedWorkstreams: [{
        task: "Inspect this bounded workstream safely.",
        label: "ab",
        acceptanceCriteria: ["Return bounded evidence."],
      }],
    })).rejects.toThrow(
      "requestedWorkstreams[0].label must be between 3 and 80 UTF-8 bytes",
    );
    await expect(start(t, "missing-criteria", {
      projectAdmissions: [fresh],
      requestedWorkstreams: [{
        task: "Inspect this bounded workstream safely.",
      }],
    })).rejects.toThrow(
      "requestedWorkstreams[0].acceptanceCriteria must contain at least 1 item",
    );
    await expect(start(t, "undersized-durable-fleet", {
      profile: "durable_goal",
      desiredWorkstreams: 1,
      projectAdmissions: [fresh],
    })).rejects.toThrow("desiredWorkstreams must be an integer between 2 and 6");

    await expect(start(t, "oversized-payload", {
      projectAdmissions: [fresh],
      requestedWorkstreams: Array.from({ length: 6 }, (_, index) => ({
        task: `${index}:${"x".repeat(3_000)}`,
        acceptanceCriteria: ["Return bounded evidence."],
      })),
    })).rejects.toThrow("Canonical request payload exceeds");

    const counts = await t.run(async (ctx) => ({
      missions: (await ctx.db.query("missions").collect()).length,
      runtimes: (await ctx.db.query("missionRuntime").collect()).length,
      states: (await ctx.db.query("missionSupervisorState").collect()).length,
      jobs: (await ctx.db.query("jobs").collect()).length,
    }));
    expect(counts).toEqual({
      missions: 0,
      runtimes: 0,
      states: 0,
      jobs: 0,
    });
  });

  it("returns at most eight exact ready, waiting, or expired-lease rows", async () => {
    const t = convexTest(schema, modules);
    const admission = await testProjectSourceAdmission();
    const starts: StartResult[] = [];
    for (let index = 0; index < 12; index += 1) {
      starts.push(await start(t, `due-${index}`, {
        projectAdmissions: [admission],
      }));
    }
    const now = Date.now();
    await t.run(async (ctx) => {
      const rows = [];
      for (const started of starts) {
        rows.push((await ctx.db
          .query("missionSupervisorState")
          .withIndex("by_mission", (q) => q.eq("missionId", started.missionId))
          .unique())!);
      }
      await ctx.db.patch(rows[0]._id, { state: "ready", nextTickAt: now - 9_000 });
      await ctx.db.patch(rows[1]._id, { state: "waiting", nextTickAt: now - 8_000 });
      await ctx.db.patch(rows[2]._id, {
        state: "leased",
        nextTickAt: undefined,
        leaseOwner: "old-worker",
        leaseToken: "lease-token-old-worker-0001",
        leaseUntil: now - 7_000,
      });
      await ctx.db.patch(rows[3]._id, { state: "ready", nextTickAt: undefined });
      await ctx.db.patch(rows[4]._id, { state: "waiting", nextTickAt: now + 1 });
      await ctx.db.patch(rows[5]._id, {
        state: "leased",
        nextTickAt: undefined,
        leaseOwner: "fresh-worker",
        leaseToken: "lease-token-fresh-worker-0001",
        leaseUntil: now + 1,
      });
      for (let index = 6; index < rows.length; index += 1) {
        await ctx.db.patch(rows[index]._id, {
          state: "ready",
          nextTickAt: now - (12 - index) * 1_000,
        });
      }
    });

    const due = await t.query(supervisorApi.dueV1, {
      limit: MISSION_SUPERVISOR_MAX_DUE,
      workerToken: WORKER,
    });
    expect(due).toHaveLength(MISSION_SUPERVISOR_MAX_DUE);
    expect(new Set(due.map((row: { state: string }) => row.state))).toEqual(
      new Set(["ready", "waiting", "leased"]),
    );
    const returned = new Set(
      due.map((row: { missionId: Id<"missions"> }) => String(row.missionId)),
    );
    expect(returned.has(String(starts[3].missionId))).toBe(false);
    expect(returned.has(String(starts[4].missionId))).toBe(false);
    expect(returned.has(String(starts[5].missionId))).toBe(false);
  });

  it("claims exclusively and reclaims only after the exact ten-minute lease expires", async () => {
    const t = convexTest(schema, modules);
    const started = await start(t, "exclusive-claim");
    const first = await claim(t, started.missionId, 0);
    expect(first).toMatchObject({
      claimed: true,
      missionId: started.missionId,
      leaseVersion: 1,
    });
    expect(first.leaseUntil).toBe(Date.now() + MISSION_SUPERVISOR_LEASE_MS);

    expect(await claim(
      t,
      started.missionId,
      0,
      "worker-two",
      "lease-token-worker-two-0001",
    )).toMatchObject({
      claimed: false,
      reason: "lease_version_mismatch",
    });
    expect(await claim(
      t,
      started.missionId,
      1,
      "worker-two",
      "lease-token-worker-two-0001",
    )).toMatchObject({ claimed: false, reason: "not_due" });

    vi.setSystemTime(first.leaseUntil + 1);
    const reclaimed = await claim(
      t,
      started.missionId,
      1,
      "worker-two",
      "lease-token-worker-two-0001",
    );
    expect(reclaimed).toMatchObject({
      claimed: true,
      leaseVersion: 2,
    });
  });

  it("enforces every renewal fence and releases a stale input revision", async () => {
    const t = convexTest(schema, modules);
    const started = await start(t, "renew-fences");
    const claimed = await claim(t, started.missionId, 0);
    expect(claimed.claimed).toBe(true);
    const fence = exactFence(started.missionId, claimed);

    for (const mismatch of [
      { leaseOwner: "worker-two" },
      { leaseToken: "lease-token-worker-two-0001" },
      { leaseVersion: claimed.leaseVersion + 1 },
      { expectedEpoch: claimed.epoch + 1 },
      { expectedDecisionSequence: claimed.nextDecisionSequence + 1 },
    ]) {
      expect(await t.mutation(supervisorApi.renewV1, {
        ...fence,
        ...mismatch,
      })).toMatchObject({ renewed: false, reason: "fence_mismatch" });
    }

    expect(await t.mutation(supervisorApi.releaseFailureV1, {
      ...fence,
      leaseVersion: claimed.leaseVersion + 1,
      errorCode: "bounded_worker_failure",
    })).toMatchObject({ released: false, reason: "fence_mismatch" });
    await expect(t.mutation(supervisorApi.releaseFailureV1, {
      ...fence,
      errorCode: "raw error containing secret-like text",
    })).rejects.toThrow("redacted lower-case code");
    expect(await t.mutation(supervisorApi.renewV1, fence)).toMatchObject({
      renewed: true,
      leaseVersion: claimed.leaseVersion,
    });

    await t.run(async (ctx) => {
      const state = (await ctx.db
        .query("missionSupervisorState")
        .withIndex("by_mission", (q) => q.eq("missionId", started.missionId))
        .unique())!;
      await ctx.db.patch(state._id, {
        inputRevision: state.inputRevision + 1,
        updatedAt: Date.now(),
      });
    });
    expect(await t.mutation(supervisorApi.renewV1, fence)).toMatchObject({
      renewed: false,
      reason: "input_revision_changed",
      stale: true,
      released: true,
      inputRevision: claimed.inputRevision + 1,
    });
    const releasedState = await supervisorState(t, started.missionId);
    expect(releasedState?.state).toBe("ready");
    expect(releasedState?.leaseOwner).toBeUndefined();
    expect(releasedState?.leaseToken).toBeUndefined();
    expect(releasedState?.leaseUntil).toBeUndefined();
  });

  it("keeps the authoritative snapshot digest stable across UI and heartbeat churn", async () => {
    const t = convexTest(schema, modules);
    const started = await start(t, "stable-snapshot");
    const jobId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("jobs", {
        task: "Inspect durable supervisor snapshot boundaries.",
        missionId: String(started.missionId),
        label: "snapshot boundary",
        status: "running",
        stage: "working",
        percent: 10,
        progress: "starting",
        log: "transient log one",
        checkpoint: "transient checkpoint one",
        heartbeatAt: Date.now(),
        progressAt: Date.now(),
        attempt: 1,
        maxAttempts: 2,
        createdAt: Date.now(),
      });
      const state = (await ctx.db
        .query("missionSupervisorState")
        .withIndex("by_mission", (q) => q.eq("missionId", started.missionId))
        .unique())!;
      await ctx.db.patch(state._id, {
        totalJobs: 1,
        dirtyJobIds: [id],
        updatedAt: Date.now(),
      });
      return id;
    });
    const first = await claim(t, started.missionId, 0);
    expect(first.claimed).toBe(true);

    await t.run(async (ctx) => {
      await ctx.db.patch(jobId, {
        stage: "still-working",
        percent: 91,
        progress: "transient progress changed",
        log: "transient log two",
        checkpoint: "transient checkpoint two",
        heartbeatAt: Date.now() + 100_000,
        progressAt: Date.now() + 100_000,
      });
    });
    vi.setSystemTime(first.leaseUntil + 1);
    const second = await claim(
      t,
      started.missionId,
      1,
      "worker-two",
      "lease-token-worker-two-0001",
    );
    expect(second).toMatchObject({
      claimed: true,
      snapshotDigest: first.snapshotDigest,
    });
  });

  it("fails closed when a mission exceeds its bounded job authority", async () => {
    const t = convexTest(schema, modules);
    const started = await start(t, "job-overflow");
    await t.run(async (ctx) => {
      for (let index = 0; index < MISSION_SUPERVISOR_MAX_JOBS + 1; index += 1) {
        await ctx.db.insert("jobs", {
          task: `Bounded overflow fixture ${index}`,
          missionId: String(started.missionId),
          status: "pending",
          createdAt: Date.now() + index,
        });
      }
    });

    expect(await claim(t, started.missionId, 0)).toMatchObject({
      claimed: false,
      reason: "supervisor_job_limit",
      escalated: true,
    });
    const persisted = await t.run(async (ctx) => ({
      state: await ctx.db
        .query("missionSupervisorState")
        .withIndex("by_mission", (q) => q.eq("missionId", started.missionId))
        .unique(),
      mission: await ctx.db.get(started.missionId),
      attention: await ctx.db
        .query("attentionItems")
        .withIndex("by_fingerprint", (q) =>
          q.eq(
            "fingerprint",
            `mission-supervisor:${String(started.missionId)}:needs-input`,
          )
        )
        .collect(),
    }));
    expect(persisted.state?.state).toBe("needs_input");
    expect(persisted.mission?.status).toBe("needs_input");
    expect(persisted.attention).toHaveLength(1);
  });

  it("backs off exponentially, then escalates once with a deduplicated attention item", async () => {
    const t = convexTest(schema, modules);
    const started = await start(t, "failure-backoff");
    const expectedBackoffs = [30_000, 60_000, 120_000, 240_000];

    for (let failure = 1; failure <= 5; failure += 1) {
      const claimed = await claim(t, started.missionId, failure - 1);
      expect(claimed.claimed).toBe(true);
      const released = await t.mutation(supervisorApi.releaseFailureV1, {
        ...exactFence(started.missionId, claimed),
        errorCode: "bounded_worker_failure",
      });
      if (failure < 5) {
        expect(released).toMatchObject({
          released: true,
          escalated: false,
          failures: failure,
          backoffMs: expectedBackoffs[failure - 1],
        });
        vi.setSystemTime(released.nextTickAt);
      } else {
        expect(released).toMatchObject({
          released: true,
          escalated: true,
          failures: 5,
        });
      }
    }

    const persisted = await t.run(async (ctx) => ({
      state: await ctx.db
        .query("missionSupervisorState")
        .withIndex("by_mission", (q) => q.eq("missionId", started.missionId))
        .unique(),
      mission: await ctx.db.get(started.missionId),
      runtime: await ctx.db
        .query("missionRuntime")
        .withIndex("by_mission", (q) => q.eq("missionId", started.missionId))
        .unique(),
      attention: await ctx.db
        .query("attentionItems")
        .withIndex("by_fingerprint", (q) =>
          q.eq(
            "fingerprint",
            `mission-supervisor:${String(started.missionId)}:needs-input`,
          )
        )
        .collect(),
    }));
    expect(persisted.state).toMatchObject({
      state: "needs_input",
      consecutiveFailures: 5,
      lastErrorCode: "bounded_worker_failure",
    });
    expect(persisted.mission).toMatchObject({
      status: "needs_input",
      phase: "needs_input",
    });
    expect(persisted.runtime).toMatchObject({
      status: "needs_input",
      phase: "needs_input",
    });
    expect(persisted.attention).toHaveLength(1);
  });

  it("escalates an exact failed lease at the bounded mission deadline", async () => {
    const t = convexTest(schema, modules);
    const started = await start(t, "deadline-escalation", {
      deadlineMs: 10 * 60_000,
    });
    const claimed = await claim(t, started.missionId, 0);
    expect(claimed.claimed).toBe(true);
    vi.setSystemTime(started.deadlineAt + 1);

    expect(await t.mutation(supervisorApi.releaseFailureV1, {
      ...exactFence(started.missionId, claimed),
      errorCode: "bounded_deadline_failure",
    })).toMatchObject({
      released: true,
      escalated: true,
      failures: 1,
    });
    expect(await supervisorState(t, started.missionId)).toMatchObject({
      state: "needs_input",
      consecutiveFailures: 1,
      lastErrorCode: "bounded_deadline_failure",
    });
  });
});
