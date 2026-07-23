import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest, type TestConvex } from "convex-test";

import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import {
  ensureWorkAttempt,
  insertJobWithRuntime,
  patchJobWithRuntime,
  readAttemptExecutionAuthority,
} from "./controlPlane";
import {
  applySupervisorJobRuntimePatchBatch,
  preflightSupervisorJobControlBatch,
  refreshSupervisorJobControlGroups,
  transitionSupervisorJobWorkOrderRevision,
} from "./supervisorJobControl";
import { testProjectSourceAdmission } from "./testSourceAdmission";

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>;
  }
}

const modules = import.meta.glob("./**/*.ts");
const NOW = new Date("2026-07-23T10:00:00.000Z");
type Harness = TestConvex<typeof schema>;

type Fixture = {
  missionId: Id<"missions">;
  stateId: Id<"missionSupervisorState">;
  jobIds: Id<"jobs">[];
};

async function seedSupervisorJobs(
  t: Harness,
  statuses: readonly string[] = ["pending", "pending", "pending"],
): Promise<Fixture> {
  const admissions = await Promise.all([
    testProjectSourceAdmission("daniels-project-space/jarvis"),
    testProjectSourceAdmission("daniels-project-space/jarvis"),
    testProjectSourceAdmission("daniels-project-space/rental-manager-v2"),
  ]);
  return await t.run(async (ctx) => {
    const missionId = await ctx.db.insert("missions", {
      admissionProtocolVersion: 2,
      goal: "Control a bounded supervisor job batch.",
      mode: "supervised",
      status: "running",
      agentCount: statuses.length,
      originThreadId: "main",
      priority: 90,
      phase: "executing",
      percent: 20,
      projectAdmissions: admissions,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const decisionKey = "decision-supervisor-batch-1";
    const jobIds: Id<"jobs">[] = [];
    for (let ordinal = 0; ordinal < statuses.length; ordinal += 1) {
      const admission = admissions[ordinal] ?? admissions[0];
      const jobId = await insertJobWithRuntime(ctx, {
        admissionProtocolVersion: 2,
        projectAdmission: admission,
        requireFreshSourceAdmission: false,
        missionId: String(missionId),
        supervisorEpoch: 1,
        supervisorDecisionKey: decisionKey,
        supervisorJobOrdinal: ordinal,
        task: `Implement bounded supervisor batch member ${ordinal + 1}.`,
        label: `batch member ${ordinal + 1}`,
        repo: admission.repository,
        model: "luna",
        agentId: "paul",
        readonly: false,
        approvalRequired: false,
        risk: "high",
        priority: 90 - ordinal,
        acceptanceCriteria: ["Persist exact bounded control evidence."],
        dependsOn: [],
        dispatchReady: true,
        originThreadId: "main",
        visibility: "conversation",
        status: statuses[ordinal],
        stage: statuses[ordinal] === "running" ? "running" : "queued",
        percent: 0,
        progressAt: Date.now(),
        heartbeatAt: Date.now(),
        attempt: 1,
        maxAttempts: 12,
        nextRunAt: Date.now(),
        createdAt: Date.now(),
      });
      jobIds.push(jobId);
    }
    await ctx.db.insert("missionSupervisorDecisions", {
      protocolVersion: 1,
      missionId,
      epoch: 1,
      sequence: 1,
      decisionKey,
      observedInputRevision: 4,
      snapshotDigest: "snapshot-digest-batch-1",
      kind: "delegate",
      payloadJson: "{}",
      payloadDigest: "payload-digest-batch-1",
      rationale: "Delegate one bounded batch.",
      decisionOrigin: "model",
      modelProvider: "codex-subscription",
      modelTier: "terra",
      modelId: "gpt-test",
      reasoningEffort: "high",
      tierReason: "bounded batch test",
      supervisorPromptVersion: "test-v1",
      leaseVersion: 1,
      triggerRunId: "trigger-batch-test",
      createdJobIds: jobIds,
      chatMessageIds: [],
      resultState: "waiting",
      nextTickAt: Date.now() + 30_000,
      createdAt: Date.now(),
    });
    const stateId = await ctx.db.insert("missionSupervisorState", {
      protocolVersion: 1,
      missionId,
      requestKey: "request-supervisor-batch-1",
      requestDigest: "request-digest-batch-1",
      requestPayloadJson: "{}",
      state: "waiting",
      epoch: 1,
      nextDecisionSequence: 2,
      inputRevision: 4,
      handledInputRevision: 4,
      dirtyJobIds: [],
      nextTickAt: Date.now() + 30_000,
      leaseVersion: 0,
      totalJobs: statuses.length,
      maxJobs: 24,
      decisionCount: 1,
      maxDecisions: 64,
      deadlineAt: Date.now() + 86_400_000,
      consecutiveFailures: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return { missionId, stateId, jobIds };
  });
}

async function jobsFor(
  t: Harness,
  jobIds: readonly Id<"jobs">[],
): Promise<Doc<"jobs">[]> {
  return await t.run(async (ctx) => {
    const rows = await Promise.all(jobIds.map((jobId) => ctx.db.get(jobId)));
    if (rows.some((row) => !row)) throw new Error("fixture job missing");
    return rows as Doc<"jobs">[];
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("supervisor job control batch foundation", () => {
  it("suppresses N job wakes and queue rebuilds until one refresh per unique group", async () => {
    const t = convexTest(schema, modules);
    const fixture = await seedSupervisorJobs(t);
    const before = await t.run(async (ctx) => ({
      state: await ctx.db.get(fixture.stateId),
      groups: await ctx.db.query("workGroupScheduling").collect(),
    }));
    const groupUpdatedAt = new Map(
      before.groups.map((group) => [group.groupKey, group.updatedAt]),
    );

    const applied = await t.run(async (ctx) => {
      const jobs = await Promise.all(
        fixture.jobIds.map(async (jobId) => {
          const job = await ctx.db.get(jobId);
          if (!job) throw new Error("fixture job missing");
          return job;
        }),
      );
      const preflight = await preflightSupervisorJobControlBatch(ctx, {
        missionId: fixture.missionId,
        action: "pause",
        jobs,
        expectedTotalJobs: jobs.length,
      });
      if (!preflight.ok) throw new Error(preflight.reason);
      return await applySupervisorJobRuntimePatchBatch(
        ctx,
        preflight.plan,
        preflight.plan.affectedJobIds.map((jobId) => ({
          jobId,
          patch: {
            status: "paused",
            stage: "paused",
            nextRunAt: undefined,
            progress: "paused by one atomic supervisor batch",
          },
        })),
      );
    });

    expect(applied.patchedJobIds).toEqual(fixture.jobIds);
    expect(applied.touchedSchedulingGroupKeys).toHaveLength(2);
    expect(new Set(applied.touchedSchedulingGroupKeys).size).toBe(2);

    const deferred = await t.run(async (ctx) => ({
      state: await ctx.db.get(fixture.stateId),
      jobs: await Promise.all(fixture.jobIds.map((jobId) => ctx.db.get(jobId))),
      runtimes: await Promise.all(fixture.jobIds.map(async (jobId) =>
        await ctx.db
          .query("jobRuntime")
          .withIndex("by_job", (q) => q.eq("jobId", jobId))
          .unique()
      )),
      groups: await ctx.db.query("workGroupScheduling").collect(),
      commands: await ctx.db.query("missionSupervisorCommand").collect(),
    }));
    expect(deferred.state?.inputRevision).toBe(4);
    expect(deferred.state?.dirtyJobIds).toEqual([]);
    expect(deferred.jobs.every((job) => job?.status === "paused")).toBe(true);
    expect(deferred.runtimes.every((runtime) => runtime?.status === "paused"))
      .toBe(true);
    expect(deferred.commands).toHaveLength(0);
    expect(deferred.groups.every((group) =>
      group.updatedAt === groupUpdatedAt.get(group.groupKey)
    )).toBe(true);

    const refreshAt = Date.now() + 1_000;
    const refreshed = await t.run(async (ctx) =>
      await refreshSupervisorJobControlGroups(
        ctx,
        [
          applied.touchedSchedulingGroupKeys[0],
          applied.touchedSchedulingGroupKeys[0],
          applied.touchedSchedulingGroupKeys[1],
        ],
        refreshAt,
      )
    );
    expect(refreshed).toEqual(applied.touchedSchedulingGroupKeys);
    const groupsAfterRefresh = await t.run(async (ctx) =>
      await ctx.db.query("workGroupScheduling").collect()
    );
    expect(groupsAfterRefresh).toHaveLength(2);
    expect(groupsAfterRefresh.every((group) => group.updatedAt === refreshAt))
      .toBe(true);

    await t.run(async (ctx) => {
      const job = await ctx.db.get(fixture.jobIds[0]);
      if (!job) throw new Error("fixture job missing");
      await patchJobWithRuntime(ctx, job, {
        result: "Default patch behavior still signals the supervisor.",
      });
    });
    const defaultPath = await t.run(async (ctx) => ({
      state: await ctx.db.get(fixture.stateId),
      command: await ctx.db
        .query("missionSupervisorCommand")
        .withIndex("by_mission", (q) => q.eq("missionId", fixture.missionId))
        .unique(),
    }));
    expect(defaultPath.state).toMatchObject({
      state: "ready",
      inputRevision: 5,
      dirtyJobIds: [fixture.jobIds[0]],
    });
    expect(defaultPath.command).toMatchObject({
      missionId: fixture.missionId,
      state: "ready",
      inputRevision: 5,
    });
  });

  it("threads batch suppression through append-only work-order activation", async () => {
    const t = convexTest(schema, modules);
    const fixture = await seedSupervisorJobs(t, ["pending"]);
    const transition = await t.run(async (ctx) => {
      const job = await ctx.db.get(fixture.jobIds[0]);
      if (!job) throw new Error("fixture job missing");
      const preflight = await preflightSupervisorJobControlBatch(ctx, {
        missionId: fixture.missionId,
        action: "steer",
        jobs: [job],
        expectedTotalJobs: 1,
      });
      if (!preflight.ok) throw new Error(preflight.reason);
      const instruction = "Preserve the exact control fence in the revised work.";
      return await transitionSupervisorJobWorkOrderRevision(
        ctx,
        preflight.plan.members[0],
        {
          steer: instruction,
          policyTask: `${job.policyTask ?? job.task}\n\nDaniel steering instruction:\n${instruction}`,
        },
        {
          status: "pending",
          stage: "queued",
          steerRevision: 1,
          nextRunAt: Date.now(),
        },
      );
    });
    expect(transition).toMatchObject({
      queueRefreshRequired: true,
      schedulingGroupKey: expect.any(String),
      job: {
        workOrderRevision: 2,
        steerRevision: 1,
      },
    });
    const persisted = await t.run(async (ctx) => ({
      state: await ctx.db.get(fixture.stateId),
      job: await ctx.db.get(fixture.jobIds[0]),
      revisions: await ctx.db
        .query("workOrderRevisions")
        .withIndex("by_job_revision", (q) =>
          q.eq("jobId", fixture.jobIds[0])
        )
        .collect(),
    }));
    expect(persisted.state?.inputRevision).toBe(4);
    expect(persisted.job).toMatchObject({
      workOrderRevision: 2,
      steerRevision: 1,
    });
    expect(persisted.revisions).toHaveLength(2);
  });

  it("allows harmless integration markers but blocks live integration authority", async () => {
    const t = convexTest(schema, modules);
    const fixture = await seedSupervisorJobs(t, ["pending"]);

    const harmless = await t.run(async (ctx) => {
      await ctx.db.patch(fixture.jobIds[0], {
        integrationState: "not_applicable",
      });
      const job = await ctx.db.get(fixture.jobIds[0]);
      if (!job) throw new Error("fixture job missing");
      return await preflightSupervisorJobControlBatch(ctx, {
        missionId: fixture.missionId,
        action: "pause",
        jobs: [job],
        expectedTotalJobs: 1,
      });
    });
    expect(harmless.ok).toBe(true);

    const live = await t.run(async (ctx) => {
      await ctx.db.patch(fixture.jobIds[0], {
        integrationState: "awaiting_review",
      });
      const job = await ctx.db.get(fixture.jobIds[0]);
      if (!job) throw new Error("fixture job missing");
      return await preflightSupervisorJobControlBatch(ctx, {
        missionId: fixture.missionId,
        action: "pause",
        jobs: [job],
        expectedTotalJobs: 1,
      });
    });
    expect(live).toEqual({
      ok: false,
      reason: "supervisor_integration_requires_reconciliation",
      jobId: fixture.jobIds[0],
    });
  });

  it("fails closed on an ambiguous exact attempt before any batch patch", async () => {
    const t = convexTest(schema, modules);
    const fixture = await seedSupervisorJobs(t, ["running"]);
    await t.run(async (ctx) => {
      const job = await ctx.db.get(fixture.jobIds[0]);
      if (!job) throw new Error("fixture job missing");
      const attempt = await ensureWorkAttempt(
        ctx,
        job,
        1,
        "running",
        Date.now(),
      );
      const {
        _id: ignoredId,
        _creationTime: ignoredCreationTime,
        ...duplicate
      } = attempt;
      void ignoredId;
      void ignoredCreationTime;
      await ctx.db.insert("workAttempts", duplicate);
    });

    const result = await t.run(async (ctx) => {
      const job = await ctx.db.get(fixture.jobIds[0]);
      if (!job) throw new Error("fixture job missing");
      return {
        authority: await readAttemptExecutionAuthority(ctx, job, 1),
        preflight: await preflightSupervisorJobControlBatch(ctx, {
          missionId: fixture.missionId,
          action: "pause",
          jobs: [job],
          expectedTotalJobs: 1,
        }),
      };
    });
    expect(result.authority).toBeNull();
    expect(result.preflight).toEqual({
      ok: false,
      reason: "ambiguous_attempt_authority",
      jobId: fixture.jobIds[0],
    });
    await expect(t.run(async (ctx) => {
      const job = await ctx.db.get(fixture.jobIds[0]);
      if (!job) throw new Error("fixture job missing");
      await ensureWorkAttempt(ctx, job, 1, "running", Date.now());
    })).rejects.toThrow("Work attempt authority is ambiguous");

    const untouched = await jobsFor(t, fixture.jobIds);
    expect(untouched[0].status).toBe("running");
  });
});
