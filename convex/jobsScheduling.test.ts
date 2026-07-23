import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest, type TestConvex } from "convex-test";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { testMissionAdmission } from "./testSourceAdmission";
import {
  BACKGROUND_CONCURRENCY_LIMIT,
  DISPATCH_CANDIDATE_WINDOW_MAX,
  MAX_ACTIVE_PER_WORK_GROUP,
  workGroupAuthority,
} from "../src/lib/work-scheduler";

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
