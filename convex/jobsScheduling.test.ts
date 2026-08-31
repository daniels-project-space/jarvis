import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest, type TestConvex } from "convex-test";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { testMissionAdmission } from "./testSourceAdmission";
import {
  BACKGROUND_CONCURRENCY_LIMIT,
  DISPATCH_CANDIDATE_WINDOW_MAX,
  integrationLineageForAuthority,
  MAX_ACTIVE_PER_WORK_GROUP,
  workGroupAuthority,
} from "../src/lib/work-scheduler";
import { triggerClaimAuthority } from "../src/lib/trigger-machine";

declare global {
  interface ImportMeta { glob(pattern: string): Record<string, () => Promise<unknown>>; }
}

const modules = import.meta.glob("./**/*.ts");
const WORKER = "fair-scheduler-test-worker";
const REPO = "daniels-project-space/jarvis";
type SchedulerTest = TestConvex<typeof schema>;

beforeEach(() => {
  process.env.JARVIS_WORKER_TOKEN = WORKER;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-22T12:00:00Z"));
});

afterEach(() => {
  delete process.env.JARVIS_WORKER_TOKEN;
  vi.useRealTimers();
});

async function enqueue(t: SchedulerTest, options: {
  missionId: string;
  priority?: number;
  readonly?: boolean;
  repo?: string;
  label?: string;
}): Promise<Id<"jobs">> {
  const admitted = await testMissionAdmission(t, {
    key: options.missionId,
    workerToken: WORKER,
    repository: options.repo,
  });
  return await t.mutation(api.jobs.enqueueV2, {
    task: options.readonly === false
      ? "Implement the isolated scheduler fixture and verify its exact branch lineage."
      : "Inspect the isolated scheduler fixture and report bounded evidence.",
    missionId: String(admitted.missionId),
    priority: options.priority ?? 50,
    readonly: options.readonly ?? true,
    repo: options.repo,
    label: options.label ?? "identical human label",
    workerToken: WORKER,
  }) as Id<"jobs">;
}

async function finishReservations(t: SchedulerTest, reservations: Array<{ jobId: string }>) {
  await t.run(async (ctx) => {
    for (const reservation of reservations) {
      const jobId = ctx.db.normalizeId("jobs", reservation.jobId)!;
      await ctx.db.patch(jobId, { status: "done", completedAt: Date.now() });
      const runtime = await ctx.db.query("jobRuntime").withIndex("by_job", (q) => q.eq("jobId", jobId)).first();
      if (runtime) await ctx.db.patch(runtime._id, {
        status: "done", active: false, completedAt: Date.now(), updatedAt: Date.now(),
      });
    }
  });
}

describe("project-group fair reservation authority", () => {
  it("leaves pre-activation backlog untouched while admitting newer work in the same project group", async () => {
    const t = convexTest(schema, modules);
    const oldJobId = await enqueue(t, {
      missionId: "activation-cutoff",
      label: "Historic queued work",
    });
    vi.setSystemTime(new Date("2026-07-22T12:05:00Z"));
    const createdAtFloor = Date.now() - 1;
    const newJobId = await enqueue(t, {
      missionId: "activation-cutoff",
      label: "New spoken work",
    });

    const batch = await t.mutation(api.jobs.reserveDispatchBatch, {
      limit: 2,
      reason: "selfhost-activation",
      createdAtFloor,
      workerToken: WORKER,
    });

    expect(batch.reservations.map((reservation) => reservation.jobId)).toEqual([String(newJobId)]);
    const oldJob = await t.run(async (ctx) => ctx.db.get(oldJobId));
    expect(oldJob).toMatchObject({ status: "pending" });
    expect(oldJob).not.toHaveProperty("dispatchId");
    expect(await t.run(async (ctx) => ctx.db.get(newJobId))).toMatchObject({
      status: "dispatching",
    });
  });

  it("binds admitted dynamic machines, holds old workers, and records only Trigger OOM escalation", async () => {
    const t = convexTest(schema, modules);
    const readId = await enqueue(t, { missionId: "mission-bounded-read" });
    const writeId = await enqueue(t, {
      missionId: "mission-hard-build",
      readonly: false,
      repo: REPO,
    });
    const batch = await t.mutation(api.jobs.reserveDispatchBatch, {
      limit: 2,
      reason: "machine-authority",
      workerToken: WORKER,
    });
    const read = batch.reservations.find((reservation) => reservation.jobId === String(readId))!;
    const write = batch.reservations.find((reservation) => reservation.jobId === String(writeId))!;
    expect(read).toMatchObject({
      triggerMachinePreset: "medium-1x",
      triggerMachineReason: "admitted_bounded_read",
      authorityDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      workOrderRevisionDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(write).toMatchObject({
      triggerMachinePreset: "medium-2x",
      triggerMachineReason: "admitted_write_or_hard",
    });
    expect(await t.mutation(api.jobs.markDispatchLaunchUnknown, {
      jobId: writeId,
      dispatchId: write.dispatchId,
      reason: "Trigger response lost after request write",
      workerToken: WORKER,
    })).toBe(true);
    expect(await t.run(async (ctx) => ctx.db.get(writeId))).toMatchObject({
      status: "dispatching",
      dispatchId: write.dispatchId,
      providerRunState: "reconciling",
    });

    expect(await t.mutation(api.jobs.claimDispatched, {
      jobId: readId,
      dispatchId: read.dispatchId,
      workerRunId: "old-worker-without-envelope",
      workerToken: WORKER,
    })).toMatchObject({ executable: false, held: true, code: "trigger_launch_authority_held" });
    expect(await t.mutation(api.jobs.claimDispatched, {
      jobId: readId,
      dispatchId: read.dispatchId,
      ...triggerClaimAuthority(read, "medium-2x", 1),
      workerRunId: "unproven-escalation",
      workerToken: WORKER,
    })).toMatchObject({ executable: false, held: true, code: "trigger_launch_authority_held" });

    expect(await t.mutation(api.jobs.claimDispatched, {
      jobId: readId,
      dispatchId: read.dispatchId,
      ...triggerClaimAuthority(read, "medium-2x", 2),
      workerRunId: "oom-retry-run",
      workerToken: WORKER,
    })).toMatchObject({
      triggerObservedMachinePreset: "medium-2x",
      triggerObservedMachineReason: "trigger_oom_retry_escalation",
      triggerPlatformAttempt: 2,
    });
    const rows = await t.run(async (ctx) => ({
      job: await ctx.db.get(readId),
      runtime: await ctx.db.query("jobRuntime").withIndex("by_job", (q) => q.eq("jobId", readId)).first(),
      attempt: await ctx.db.query("workAttempts")
        .withIndex("by_job_attempt", (q) => q.eq("jobId", readId).eq("attempt", 1)).first(),
    }));
    for (const row of [rows.job, rows.runtime, rows.attempt]) {
      expect(row).toMatchObject({
        triggerMachinePreset: "medium-1x",
        triggerObservedMachinePreset: "medium-2x",
        triggerObservedMachineReason: "trigger_oom_retry_escalation",
        triggerPlatformAttempt: 2,
      });
    }
  });

  it("keeps a middle project group visible through more than three legacy sampling windows", async () => {
    const t = convexTest(schema, modules);
    const backlog = DISPATCH_CANDIDATE_WINDOW_MAX * 3 + 1;
    for (let index = 0; index < 110; index += 1) {
      await enqueue(t, { missionId: "mission-deep-old", priority: 50 });
    }
    const middle = await enqueue(t, { missionId: "mission-middle", priority: 100 });
    for (let index = 111; index < backlog; index += 1) {
      await enqueue(t, { missionId: "mission-deep-new", priority: 50 });
    }

    const batch = await t.mutation(api.jobs.reserveDispatchBatch, {
      limit: BACKGROUND_CONCURRENCY_LIMIT,
      reason: "durable-group-head-starvation-proof",
      workerToken: WORKER,
    });
    expect(batch.reservations.map((reservation) => reservation.jobId)).toContain(String(middle));
    const projection = await t.run(async (ctx) => await ctx.db.query("workGroupScheduling").collect());
    expect(projection).toHaveLength(3);
    expect(projection.every((group) => group.queueHeadJobId || group.queueEligible === false)).toBe(true);
  });

  it("excludes drained groups at the due index boundary before taking the bounded page", async () => {
    const t = convexTest(schema, modules);
    const liveJobId = await enqueue(t, { missionId: "mission-live-future-head" });
    const now = Date.now();
    const dueAt = now + 60_000;
    const historicalUpdatedAt = now - 60_000;

    await t.run(async (ctx) => {
      const job = await ctx.db.get(liveJobId);
      const runtime = await ctx.db.query("jobRuntime")
        .withIndex("by_job", (q) => q.eq("jobId", liveJobId)).first();
      const group = job?.schedulingGroupKey
        ? await ctx.db.query("workGroupScheduling")
          .withIndex("by_group", (q) => q.eq("groupKey", job.schedulingGroupKey!)).first()
        : null;
      if (!job || !runtime || !group) throw new Error("live scheduler fixture was not fully admitted");

      await ctx.db.patch(liveJobId, { nextRunAt: dueAt });
      await ctx.db.patch(runtime._id, { nextRunAt: dueAt, updatedAt: now });
      await ctx.db.patch(group._id, {
        queueHeadJobId: liveJobId,
        queueHeadNextRunAt: dueAt,
        queueEligible: false,
        updatedAt: now,
      });
      for (let index = 0; index < 100; index += 1) {
        const suffix = String(index).padStart(3, "0");
        await ctx.db.insert("workGroupScheduling", {
          groupKey: `empty-${suffix}`,
          missionGroupId: `drained-mission-${suffix}`,
          projectGroupId: `drained-project-${suffix}`,
          canonicalProjectId: "evidence",
          queueEligible: false,
          lastServedSequence: 0,
          reservationCount: 0,
          createdAt: historicalUpdatedAt,
          updatedAt: historicalUpdatedAt,
        });
      }
    });

    vi.setSystemTime(dueAt + 1);
    const batch = await t.mutation(api.jobs.reserveDispatchBatch, {
      limit: 1,
      reason: "empty-due-page-starvation-proof",
      workerToken: WORKER,
    });
    expect(batch.reservations.map((reservation) => reservation.jobId)).toEqual([String(liveJobId)]);

    const drained = await t.run(async (ctx) => (await ctx.db.query("workGroupScheduling").collect())
      .filter((group) => group.groupKey.startsWith("empty-")));
    expect(drained).toHaveLength(100);
    expect(drained.every((group) => group.queueEligible === false
      && group.queueHeadNextRunAt === undefined
      && group.updatedAt === historicalUpdatedAt)).toBe(true);
  });

  it("fills the first bounded wave across an oversized old group and two newly spoken groups", async () => {
    const t = convexTest(schema, modules);
    const old = await testMissionAdmission(t, { key: "mission-old", workerToken: WORKER });
    const newerB = await testMissionAdmission(t, { key: "mission-new-b", workerToken: WORKER });
    const newerC = await testMissionAdmission(t, { key: "mission-new-c", workerToken: WORKER });
    // Eighty old rows exceed the scheduler's bounded candidate window; the
    // newest-side sample must still admit both later mission groups.
    for (let index = 0; index < 80; index += 1) await enqueue(t, { missionId: "mission-old" });
    vi.advanceTimersByTime(1);
    await enqueue(t, { missionId: "mission-new-b" });
    await enqueue(t, { missionId: "mission-new-c" });

    const first = await t.mutation(api.jobs.reserveDispatchBatch, {
      limit: BACKGROUND_CONCURRENCY_LIMIT, reason: "bounded-first-wave", workerToken: WORKER,
    });
    const counts = first.reservations.reduce<Record<string, number>>((result, reservation) => {
      result[String(reservation.missionGroupId)] = (result[String(reservation.missionGroupId)] ?? 0) + 1;
      return result;
    }, {});
    expect(first.reservations).toHaveLength(BACKGROUND_CONCURRENCY_LIMIT);
    expect(counts).toEqual({
      [String(old.missionId)]: MAX_ACTIVE_PER_WORK_GROUP,
      [String(newerB.missionId)]: 1,
      [String(newerC.missionId)]: 1,
    });
    expect(await t.mutation(api.jobs.reserveDispatchBatch, {
      limit: BACKGROUND_CONCURRENCY_LIMIT, reason: "already-saturated", workerToken: WORKER,
    })).toMatchObject({ reservations: [] });

    await finishReservations(t, first.reservations);
    const second = await t.mutation(api.jobs.reserveDispatchBatch, {
      limit: BACKGROUND_CONCURRENCY_LIMIT, reason: "bounded-second-wave", workerToken: WORKER,
    });
    expect(second.reservations).toHaveLength(MAX_ACTIVE_PER_WORK_GROUP);
    expect(second.reservations.every((reservation) => reservation.missionGroupId === String(old.missionId))).toBe(true);
  });

  it("serves a low-priority group in the next turn instead of allowing priority starvation", async () => {
    const t = convexTest(schema, modules);
    const high = await testMissionAdmission(t, { key: "mission-high", workerToken: WORKER });
    const low = await testMissionAdmission(t, { key: "mission-low", workerToken: WORKER });
    await enqueue(t, { missionId: "mission-high", priority: 100 });
    await enqueue(t, { missionId: "mission-high", priority: 100 });
    await enqueue(t, { missionId: "mission-low", priority: 1 });

    const first = await t.mutation(api.jobs.reserveDispatchBatch, { limit: 1, workerToken: WORKER });
    expect(first.reservations[0]?.missionGroupId).toBe(String(high.missionId));
    // A newly arriving urgent project starts behind the already-due low group.
    await enqueue(t, { missionId: "mission-new-urgent-0", priority: 100 });
    await finishReservations(t, first.reservations);
    const second = await t.mutation(api.jobs.reserveDispatchBatch, { limit: 1, workerToken: WORKER });
    expect(second.reservations[0]?.missionGroupId).toBe(String(low.missionId));
  });

  it("dispatches same-repository writers from distinct missions in separate immutable lineages", async () => {
    const t = convexTest(schema, modules);
    const firstMission = await testMissionAdmission(t, { key: "mission-repo-a", workerToken: WORKER, repository: REPO });
    const secondMission = await testMissionAdmission(t, { key: "mission-repo-b", workerToken: WORKER, repository: REPO });
    const firstId = await enqueue(t, { missionId: "mission-repo-a", readonly: false, repo: REPO });
    const secondId = await enqueue(t, { missionId: "mission-repo-b", readonly: false, repo: REPO });
    const jobs = await t.run(async (ctx) => Promise.all([ctx.db.get(firstId), ctx.db.get(secondId)]));
    expect(new Set(jobs.map((job) => job?.schedulingGroupKey)).size).toBe(2);
    expect(new Set(jobs.map((job) => job?.workspaceLineage)).size).toBe(2);

    const batch = await t.mutation(api.jobs.reserveDispatchBatch, { limit: 2, workerToken: WORKER });
    expect(batch.reservations).toHaveLength(2);
    expect(new Set(batch.reservations.map((reservation) => reservation.missionGroupId)))
      .toEqual(new Set([String(firstMission.missionId), String(secondMission.missionId)]));
  });

  it("fails a same-mission shared-workspace injection closed before overlapping dispatch", async () => {
    const t = convexTest(schema, modules);
    const firstId = await enqueue(t, { missionId: "mission-shared", readonly: false, repo: REPO });
    const secondId = await enqueue(t, { missionId: "mission-shared", readonly: false, repo: REPO });
    const first = await t.run(async (ctx) => ctx.db.get(firstId));
    if (!first) throw new Error("first scheduler fixture job was not persisted");
    await t.run(async (ctx) => {
      await ctx.db.patch(secondId, { workspaceLineage: first.workspaceLineage });
      const runtime = await ctx.db.query("jobRuntime").withIndex("by_job", (q) => q.eq("jobId", secondId)).first();
      if (runtime) await ctx.db.patch(runtime._id, { workspaceLineage: first.workspaceLineage });
    });

    const batch = await t.mutation(api.jobs.reserveDispatchBatch, { limit: 2, workerToken: WORKER });
    expect(batch.reservations).toHaveLength(1);
    expect(batch.reservations[0]?.jobId).toBe(String(firstId));
  });

  it("rejects even a wholesale repository/group substitution against the immutable admission ledger", async () => {
    const t = convexTest(schema, modules);
    const jobId = await enqueue(t, { missionId: "mission-repo-fence", readonly: false, repo: REPO });
    await t.run(async (ctx) => {
      const injected = "daniels-project-space/dropship-ai";
      const persisted = await ctx.db.get(jobId);
      const forgedAuthority = workGroupAuthority({ _id: jobId, missionId: persisted?.missionId, repo: injected });
      await ctx.db.patch(jobId, { repo: injected, ...forgedAuthority });
      const runtime = await ctx.db.query("jobRuntime").withIndex("by_job", (q) => q.eq("jobId", jobId)).first();
      if (runtime) await ctx.db.patch(runtime._id, { repo: injected, ...forgedAuthority });
    });

    expect(await t.mutation(api.jobs.reserveDispatchBatch, { limit: 1, workerToken: WORKER }))
      .toMatchObject({ reservations: [] });
    const fenced = await t.run(async (ctx) => ({
      job: await ctx.db.get(jobId),
      admission: await ctx.db.query("jobSchedulingAdmissions").withIndex("by_job", (q) => q.eq("jobId", jobId)).first(),
    }));
    expect(fenced.job).toMatchObject({ repo: "daniels-project-space/dropship-ai", status: "pending" });
    expect(fenced.admission).toMatchObject({ projectRepository: REPO });
  });

  it("repairs a forged compact projection but never reserves it as authority", async () => {
    const t = convexTest(schema, modules);
    const jobId = await enqueue(t, { missionId: "mission-runtime-forge", readonly: false, repo: REPO });
    await t.run(async (ctx) => {
      const runtime = await ctx.db.query("jobRuntime").withIndex("by_job", (q) => q.eq("jobId", jobId)).first();
      const injected = "daniels-project-space/dropship-ai";
      const persisted = await ctx.db.get(jobId);
      const forged = workGroupAuthority({ jobId, missionId: persisted?.missionId, repo: injected });
      await ctx.db.patch(runtime!._id, { repo: injected, ...forged });
    });

    expect(await t.mutation(api.jobs.reserveDispatchBatch, { limit: 1, workerToken: WORKER }))
      .toMatchObject({ reservations: [] });
    const runtime = await t.run(async (ctx) => ctx.db.query("jobRuntime")
      .withIndex("by_job", (q) => q.eq("jobId", jobId)).first());
    expect(runtime).toMatchObject({ repo: REPO, schedulingBound: true, dispatchReady: true });
  });

  it("counts a full poisoned active page before bounded repair can reveal saturated real workers", async () => {
    const t = convexTest(schema, modules);
    for (let index = 0; index < MAX_ACTIVE_PER_WORK_GROUP; index += 1) {
      await enqueue(t, { missionId: "mission-real-active-a" });
    }
    for (let index = MAX_ACTIVE_PER_WORK_GROUP; index < BACKGROUND_CONCURRENCY_LIMIT; index += 1) {
      await enqueue(t, { missionId: "mission-real-active-b" });
    }
    const active = await t.mutation(api.jobs.reserveDispatchBatch, {
      limit: BACKGROUND_CONCURRENCY_LIMIT,
      reason: "fill-real-background-capacity",
      workerToken: WORKER,
    });
    expect(active.reservations).toHaveLength(BACKGROUND_CONCURRENCY_LIMIT);

    const poisonedIds: Id<"jobs">[] = [];
    for (let index = 0; index < BACKGROUND_CONCURRENCY_LIMIT + 1; index += 1) {
      poisonedIds.push(await enqueue(t, { missionId: `mission-poison-${index}`, priority: 0 }));
    }
    const waiting = await enqueue(t, { missionId: "mission-must-stay-waiting", priority: 100 });
    await t.run(async (ctx) => {
      for (const [index, jobId] of poisonedIds.entries()) {
        const job = await ctx.db.get(jobId);
        const runtime = await ctx.db.query("jobRuntime").withIndex("by_job", (q) => q.eq("jobId", jobId)).first();
        if (!job || !runtime) throw new Error("poisoned capacity fixture was not admitted");
        const activeProjection = {
          status: "dispatching",
          active: true,
          priority: 0,
          dispatchId: `forged-dispatch-${index}`,
          workerRunId: `forged-worker-${index}`,
          updatedAt: Date.now(),
        };
        if (index === 0) {
          // This row is locally self-consistent, including its immutable-looking
          // group and lineage fields. Only the admission point-read proves that
          // the alternate repository/group never had execution authority.
          const injected = "daniels-project-space/dropship-ai";
          const forged = workGroupAuthority({
            jobId,
            missionId: job.missionId,
            repo: injected,
            canonicalProjectId: "dropship-ai",
          });
          await ctx.db.patch(runtime._id, {
            ...activeProjection,
            repo: injected,
            ...forged,
            integrationLineage: integrationLineageForAuthority(forged),
          });
        } else {
          // Syntactically bound rows that fail their local projection hash used
          // to be filtered out before the bounded page was counted.
          await ctx.db.patch(runtime._id, {
            ...activeProjection,
            schedulingBindingDigest: "not-an-authority-digest",
          });
        }
      }
    });

    const remainingPoisoned = async () => await t.run(async (ctx) => {
      const rows = await Promise.all(poisonedIds.map((jobId) => ctx.db.query("jobRuntime")
        .withIndex("by_job", (q) => q.eq("jobId", jobId)).first()));
      return rows.filter((row) => row?.status === "dispatching").length;
    });

    expect(await remainingPoisoned()).toBe(BACKGROUND_CONCURRENCY_LIMIT + 1);
    for (const expectedRemaining of [6, 3, 0, 0]) {
      const batch = await t.mutation(api.jobs.reserveDispatchBatch, {
        limit: BACKGROUND_CONCURRENCY_LIMIT,
        reason: "projection-poison-capacity-audit",
        workerToken: WORKER,
      });
      expect(batch.reservations).toEqual([]);
      expect(await remainingPoisoned()).toBe(expectedRemaining);
    }
    const state = await t.run(async (ctx) => ({
      waiting: await ctx.db.get(waiting),
      activeRuntimes: (await ctx.db.query("jobRuntime").collect())
        .filter((row) => row.status === "dispatching" && row.workerRunId === undefined),
    }));
    expect(state.waiting?.status).toBe("pending");
    expect(state.activeRuntimes).toHaveLength(BACKGROUND_CONCURRENCY_LIMIT);
  });

  it("preserves a valid expired V2 reservation for its byte-identical reoffer", async () => {
    const t = convexTest(schema, modules);
    const jobId = await enqueue(t, { missionId: "mission-valid-expired-reoffer" });
    const first = await t.mutation(api.jobs.reserveDispatchBatch, {
      limit: 1,
      reason: "valid-expired-reoffer",
      workerToken: WORKER,
    });
    const reservation = first.reservations[0]!;

    vi.advanceTimersByTime(2 * 60_000 + 1);
    expect(await t.mutation(api.jobs.reapStale, { workerToken: WORKER }))
      .toMatchObject({
        releasedDispatches: ["Inspect the isolated scheduler fixture and report bounded evidence."],
        quarantinedDispatches: [],
      });
    const reoffered = await t.mutation(api.jobs.reserveDispatchBatch, {
      limit: 1,
      reason: "exact-expired-reoffer",
      workerToken: WORKER,
    });
    expect(reoffered.reservations).toEqual([reservation]);
    const state = await t.run(async (ctx) => {
      const job = await ctx.db.get(jobId);
      return {
        job,
        receipt: job?.dispatchReceiptId ? await ctx.db.get(job.dispatchReceiptId) : null,
      };
    });
    expect(state.job).toMatchObject({ status: "dispatching", dispatchId: reservation.dispatchId });
    expect(state.receipt).toMatchObject({
      status: "reserved",
      receiptDigest: reservation.dispatchReceiptDigest,
      payloadDigest: reservation.dispatchPayloadDigest,
    });
  });

  it("quarantines an expired V2 dispatch with a missing receipt exactly once", async () => {
    const t = convexTest(schema, modules);
    const jobId = await enqueue(t, { missionId: "mission-missing-receipt" });
    const batch = await t.mutation(api.jobs.reserveDispatchBatch, {
      limit: 1,
      reason: "missing-receipt-fixture",
      workerToken: WORKER,
    });
    const reservation = batch.reservations[0]!;
    await t.run(async (ctx) => {
      const job = await ctx.db.get(jobId);
      if (!job?.dispatchReceiptId) throw new Error("dispatch receipt fixture was not persisted");
      await ctx.db.delete(job.dispatchReceiptId);
    });

    vi.advanceTimersByTime(2 * 60_000 + 1);
    expect(await t.mutation(api.jobs.reapStale, { workerToken: WORKER }))
      .toMatchObject({
        quarantinedDispatches: ["Inspect the isolated scheduler fixture and report bounded evidence."],
      });
    const first = await t.run(async (ctx) => ({
      job: await ctx.db.get(jobId),
      runtime: await ctx.db.query("jobRuntime").withIndex("by_job", (q) => q.eq("jobId", jobId)).first(),
      attempt: await ctx.db.query("workAttempts")
        .withIndex("by_job_attempt", (q) => q.eq("jobId", jobId).eq("attempt", 1)).first(),
      events: await ctx.db.query("workEvents")
        .withIndex("by_job", (q) => q.eq("jobId", String(jobId))).collect(),
      attention: (await ctx.db.query("attentionItems").collect())
        .filter((item) => item.jobId === String(jobId)),
    }));
    expect(first.job).toMatchObject({
      status: "needs_input",
      stage: "needs dispatch review",
      providerRunState: "quarantined",
    });
    expect(first.job?.dispatchId).toBeUndefined();
    expect(first.job?.dispatchReceiptId).toBeUndefined();
    expect(first.job?.workerRunId).toBeUndefined();
    expect(first.runtime).toMatchObject({ status: "needs_input", stage: "needs dispatch review" });
    expect(first.attempt).toMatchObject({ status: "needs_input" });
    expect(first.events.filter((event) => event.type === "dispatch_quarantined")).toHaveLength(1);
    expect(first.attention).toMatchObject([{
      status: "open",
      title: "Worker reservation needs review",
      actionClass: "ask",
    }]);

    expect(await t.mutation(api.jobs.reserveDispatchBatch, {
      limit: 1,
      reason: "must-not-relaunch-missing-receipt",
      workerToken: WORKER,
    })).toMatchObject({ reservations: [] });
    expect(await t.mutation(api.jobs.reapStale, { workerToken: WORKER }))
      .toMatchObject({ quarantinedDispatches: [] });
    const second = await t.run(async (ctx) => ({
      events: await ctx.db.query("workEvents")
        .withIndex("by_job", (q) => q.eq("jobId", String(jobId))).collect(),
      attention: (await ctx.db.query("attentionItems").collect())
        .filter((item) => item.jobId === String(jobId)),
    }));
    expect(second.events.filter((event) => event.type === "dispatch_quarantined")).toHaveLength(1);
    expect(second.attention).toHaveLength(1);
    expect(reservation.dispatchId).toBeTruthy();
  });

  it("releases capacity held by expired receipt-invalid dispatches", async () => {
    const t = convexTest(schema, modules);
    const invalidIds: Id<"jobs">[] = [];
    for (let index = 0; index < BACKGROUND_CONCURRENCY_LIMIT; index += 1) {
      invalidIds.push(await enqueue(t, { missionId: `mission-invalid-dispatch-${index}` }));
    }
    const active = await t.mutation(api.jobs.reserveDispatchBatch, {
      limit: BACKGROUND_CONCURRENCY_LIMIT,
      reason: "fill-invalid-dispatch-capacity",
      workerToken: WORKER,
    });
    expect(active.reservations).toHaveLength(BACKGROUND_CONCURRENCY_LIMIT);
    const waiting = await enqueue(t, { missionId: "mission-waits-for-quarantine", priority: 100 });
    expect(await t.mutation(api.jobs.reserveDispatchBatch, {
      limit: 1,
      reason: "still-capacity-blocked",
      workerToken: WORKER,
    })).toMatchObject({ reservations: [] });
    await t.run(async (ctx) => {
      for (const jobId of invalidIds) {
        const job = await ctx.db.get(jobId);
        if (!job?.dispatchReceiptId) throw new Error("invalid dispatch fixture has no receipt");
        await ctx.db.delete(job.dispatchReceiptId);
      }
    });

    vi.advanceTimersByTime(2 * 60_000 + 1);
    const reaped = await t.mutation(api.jobs.reapStale, { workerToken: WORKER });
    expect(reaped.quarantinedDispatches).toHaveLength(BACKGROUND_CONCURRENCY_LIMIT);
    const resumed = await t.mutation(api.jobs.reserveDispatchBatch, {
      limit: 1,
      reason: "capacity-released-after-quarantine",
      workerToken: WORKER,
    });
    expect(resumed.reservations.map((reservation) => reservation.jobId)).toEqual([String(waiting)]);
  });

  it("quarantines a legacy expired dispatch without fabricating a worker launch", async () => {
    const t = convexTest(schema, modules);
    const jobId = await t.run(async (ctx) => {
      const now = Date.now();
      const id = await ctx.db.insert("jobs", {
        task: "Legacy dispatch must stop for human review.",
        status: "dispatching",
        stage: "dispatching",
        priority: 50,
        percent: 1,
        attempt: 1,
        maxAttempts: 3,
        dispatchId: "legacy-unprovable-dispatch",
        dispatchLeaseUntil: now - 1,
        heartbeatAt: now - 1,
        providerRunState: "reconciling",
        createdAt: now,
      });
      await ctx.db.insert("jobRuntime", {
        jobId: id,
        task: "Legacy dispatch must stop for human review.",
        status: "dispatching",
        stage: "dispatching",
        priority: 50,
        percent: 1,
        attempt: 1,
        maxAttempts: 3,
        heartbeatAt: now - 1,
        dispatchId: "legacy-unprovable-dispatch",
        dispatchLeaseUntil: now - 1,
        createdAt: now,
        updatedAt: now,
      });
      return id;
    });
    expect(await t.mutation(api.jobs.reapStale, { workerToken: WORKER }))
      .toMatchObject({ quarantinedDispatches: ["Legacy dispatch must stop for human review."] });
    const first = await t.run(async (ctx) => ({
      job: await ctx.db.get(jobId),
      runtime: await ctx.db.query("jobRuntime").withIndex("by_job", (q) => q.eq("jobId", jobId)).first(),
      events: await ctx.db.query("workEvents")
        .withIndex("by_job", (q) => q.eq("jobId", String(jobId))).collect(),
      attention: (await ctx.db.query("attentionItems").collect())
        .filter((item) => item.jobId === String(jobId)),
    }));
    expect(first.job).toMatchObject({ status: "needs_input", providerRunState: "quarantined" });
    expect(first.job?.dispatchId).toBeUndefined();
    expect(first.job?.workerRunId).toBeUndefined();
    expect(first.runtime?.status).toBe("needs_input");
    expect(first.events.filter((event) => event.type === "dispatch_quarantined")).toHaveLength(1);
    expect(first.attention).toHaveLength(1);

    expect(await t.mutation(api.jobs.reapStale, { workerToken: WORKER }))
      .toMatchObject({ quarantinedDispatches: [] });
    const second = await t.run(async (ctx) => ({
      events: await ctx.db.query("workEvents")
        .withIndex("by_job", (q) => q.eq("jobId", String(jobId))).collect(),
      attention: (await ctx.db.query("attentionItems").collect())
        .filter((item) => item.jobId === String(jobId)),
    }));
    expect(second.events.filter((event) => event.type === "dispatch_quarantined")).toHaveLength(1);
    expect(second.attention).toHaveLength(1);
  });

  it("keeps historical unbound rows non-executable without admitting them in a poll", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const now = Date.now();
      const jobId = await ctx.db.insert("jobs", {
        task: "legacy unbound row", status: "pending", priority: 50, stage: "queued",
        percent: 0, attempt: 1, maxAttempts: 3, nextRunAt: now, createdAt: now,
      });
      await ctx.db.insert("jobRuntime", {
        jobId, task: "legacy unbound row", status: "pending", priority: 50, stage: "queued",
        percent: 0, attempt: 1, maxAttempts: 3, heartbeatAt: now, nextRunAt: now,
        createdAt: now, updatedAt: now,
      });
    });
    expect(await t.mutation(api.jobs.reserveDispatchBatch, { limit: 1, workerToken: WORKER }))
      .toMatchObject({ reservations: [] });
    expect(await t.run(async (ctx) => ctx.db.query("jobSchedulingAdmissions").collect())).toHaveLength(0);
  });
});
