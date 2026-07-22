import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest, type TestConvex } from "convex-test";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { projectedDispatchCandidates } from "./jobs";
import {
  BACKGROUND_CONCURRENCY_LIMIT,
  DISPATCH_CANDIDATE_WINDOW_MAX,
  MAX_ACTIVE_PER_WORK_GROUP,
  SCHEDULING_PROTOCOL_VERSION,
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
  return await t.mutation(api.jobs.enqueue, {
    task: options.readonly === false
      ? "Implement the isolated scheduler fixture and verify its exact branch lineage."
      : "Inspect the isolated scheduler fixture and report bounded evidence.",
    missionId: options.missionId,
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
  it("selects a 96-row window using only bounded compact projections before authority validation", async () => {
    const rows = Array.from({ length: DISPATCH_CANDIDATE_WINDOW_MAX }, (_, index) => {
      const jobId = `job-${index}`;
      const missionId = `mission-${index % 12}`;
      const authority = workGroupAuthority({ jobId, missionId });
      return {
        jobId, missionId, task: "compact", status: "pending", priority: 50,
        stage: "queued", percent: 0, attempt: 1, maxAttempts: 12,
        heartbeatAt: 1, createdAt: index + 1, updatedAt: index + 1, nextRunAt: 1,
        readonly: true, workspaceLineage: `sandbox:${jobId}:lineage:1`,
        retryLineage: `job:${jobId}:lineage:1`, ...authority,
        schedulingProtocolVersion: SCHEDULING_PROTOCOL_VERSION,
        schedulingAdmissionId: `admission-${index}`,
        schedulingBindingDigest: "a".repeat(64), schedulingBound: true, dispatchReady: true,
      };
    });
    const reads: Array<{ table: string; index?: string; limit?: number; order?: string }> = [];
    const ctx = {
      db: {
        get: async () => { throw new Error("candidate selection must not point-read durable authority"); },
        query(table: string) {
          const read: { table: string; index?: string; limit?: number; order?: string } = { table };
          reads.push(read);
          const builder = {
            withIndex(index: string, apply?: (q: any) => unknown) {
              read.index = index;
              const q: any = { eq: () => q, lte: () => q };
              apply?.(q);
              return builder;
            },
            order(order: string) { read.order = order; return builder; },
            async take(limit: number) {
              read.limit = limit;
              if (read.index === "by_status_scheduling_bound") return [];
              return read.order === "desc" ? rows.slice(-limit).reverse() : rows.slice(0, limit);
            },
            async first() { return null; },
          };
          return builder;
        },
      },
    };

    const result = await projectedDispatchCandidates(ctx, 2, BACKGROUND_CONCURRENCY_LIMIT);
    expect(result.selected).toHaveLength(BACKGROUND_CONCURRENCY_LIMIT);
    expect(reads).toEqual([
      { table: "jobRuntime", index: "by_status_scheduling_bound", limit: BACKGROUND_CONCURRENCY_LIMIT + 1 },
      { table: "jobRuntime", index: "by_status_scheduling_bound", limit: BACKGROUND_CONCURRENCY_LIMIT + 1 },
      { table: "jobRuntime", index: "by_dispatch_ready", order: "asc", limit: DISPATCH_CANDIDATE_WINDOW_MAX / 2 },
      { table: "jobRuntime", index: "by_dispatch_ready", order: "desc", limit: DISPATCH_CANDIDATE_WINDOW_MAX / 2 },
      { table: "dispatchSchedulerState", index: "by_key" },
    ]);
    expect(reads.some((read) => ["jobs", "jobSchedulingAdmissions", "workGroupScheduling"].includes(read.table))).toBe(false);
  });

  it("fills the first bounded wave across an oversized old group and two newly spoken groups", async () => {
    const t = convexTest(schema, modules);
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
      "mission-old": MAX_ACTIVE_PER_WORK_GROUP,
      "mission-new-b": 1,
      "mission-new-c": 1,
    });
    expect(await t.mutation(api.jobs.reserveDispatchBatch, {
      limit: BACKGROUND_CONCURRENCY_LIMIT, reason: "already-saturated", workerToken: WORKER,
    })).toMatchObject({ reservations: [] });

    await finishReservations(t, first.reservations);
    const second = await t.mutation(api.jobs.reserveDispatchBatch, {
      limit: BACKGROUND_CONCURRENCY_LIMIT, reason: "bounded-second-wave", workerToken: WORKER,
    });
    expect(second.reservations).toHaveLength(MAX_ACTIVE_PER_WORK_GROUP);
    expect(second.reservations.every((reservation) => reservation.missionGroupId === "mission-old")).toBe(true);
  });

  it("serves a low-priority group in the next turn instead of allowing priority starvation", async () => {
    const t = convexTest(schema, modules);
    await enqueue(t, { missionId: "mission-high", priority: 100 });
    await enqueue(t, { missionId: "mission-high", priority: 100 });
    await enqueue(t, { missionId: "mission-low", priority: 1 });

    const first = await t.mutation(api.jobs.reserveDispatchBatch, { limit: 1, workerToken: WORKER });
    expect(first.reservations[0]?.missionGroupId).toBe("mission-high");
    await enqueue(t, { missionId: "mission-new-urgent", priority: 100 });
    await finishReservations(t, first.reservations);
    const second = await t.mutation(api.jobs.reserveDispatchBatch, { limit: 1, workerToken: WORKER });
    expect(second.reservations[0]?.missionGroupId).toBe("mission-low");
  });

  it("dispatches same-repository writers from distinct missions in separate immutable lineages", async () => {
    const t = convexTest(schema, modules);
    const firstId = await enqueue(t, { missionId: "mission-repo-a", readonly: false, repo: REPO });
    const secondId = await enqueue(t, { missionId: "mission-repo-b", readonly: false, repo: REPO });
    const jobs = await t.run(async (ctx) => Promise.all([ctx.db.get(firstId), ctx.db.get(secondId)]));
    expect(new Set(jobs.map((job) => job?.schedulingGroupKey)).size).toBe(2);
    expect(new Set(jobs.map((job) => job?.workspaceLineage)).size).toBe(2);

    const batch = await t.mutation(api.jobs.reserveDispatchBatch, { limit: 2, workerToken: WORKER });
    expect(batch.reservations).toHaveLength(2);
    expect(new Set(batch.reservations.map((reservation) => reservation.missionGroupId)))
      .toEqual(new Set(["mission-repo-a", "mission-repo-b"]));
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
      const forgedAuthority = workGroupAuthority({ _id: jobId, missionId: "mission-repo-fence", repo: injected });
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
      const forged = workGroupAuthority({ jobId, missionId: "mission-runtime-forge", repo: injected });
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
