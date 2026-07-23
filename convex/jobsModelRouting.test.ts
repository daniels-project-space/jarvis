import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>;
  }
}

const modules = import.meta.glob("./**/*.ts");
const WORKER = "model-routing-test-worker";

beforeEach(() => {
  process.env.JARVIS_WORKER_TOKEN = WORKER;
  vi.useRealTimers();
});

afterEach(() => {
  delete process.env.JARVIS_WORKER_TOKEN;
  vi.useRealTimers();
});

async function claimNext(t: ReturnType<typeof convexTest>, jobId: Id<"jobs">, attempt: number) {
  const batch = await t.mutation(api.jobs.reserveDispatchBatch, {
    limit: 1,
    reason: `model-route-attempt-${attempt}`,
    workerToken: WORKER,
  });
  expect(batch.reservations).toHaveLength(1);
  expect(batch.reservations[0]).toMatchObject({ jobId: String(jobId), attempt });
  const claim = await t.mutation(api.jobs.claimDispatched, {
    jobId,
    dispatchId: batch.reservations[0].dispatchId,
    workerRunId: `model-route-run-${attempt}`,
    workerToken: WORKER,
  });
  expect(claim).toMatchObject({ jobId, attempt });
  return claim!;
}

async function routeState(t: ReturnType<typeof convexTest>, jobId: Id<"jobs">) {
  return await t.run(async (ctx) => {
    const runtimes = await ctx.db.query("jobRuntime").collect();
    const events = await ctx.db.query("workEvents").collect();
    return {
      job: await ctx.db.get(jobId),
      runtime: runtimes.find((row) => row.jobId === jobId),
      events: events.filter((row) => row.jobId === String(jobId)),
    };
  });
}

describe("durable adaptive Codex routing lifecycle", () => {
  it("persists enqueue routing, preserves ordinary retries, and escalates only after repeated evidence", async () => {
    const t = convexTest(schema, modules);
    const jobId = await t.mutation(api.jobs.enqueue, {
      task: "Implement the deterministic bounded known repair in one file",
      repo: "daniels-project-space/jarvis",
      agentId: "paul",
      risk: "medium",
      workerToken: WORKER,
    });
    const initial = await routeState(t, jobId);
    expect(initial.job).toMatchObject({ model: "luna", reasoningEffort: "medium", modelQualityFailures: 0, modelEscalations: 0 });
    expect(initial.runtime).toMatchObject({ model: "luna", reasoningEffort: "medium", modelReason: initial.job!.modelReason });
    expect(initial.job!.modelReason).toMatch(/Deterministic bounded implementation/);
    const persistedReason = initial.job!.modelReason;

    await claimNext(t, jobId, 1);
    expect(await t.mutation(api.jobs.checkpointAndRequeue, {
      jobId, expectedAttempt: 1, checkpoint: "Provider transport ended; work quality was not assessed", workerToken: WORKER,
    })).toMatchObject({ requeued: true, exhausted: false, stale: false });
    const ordinaryRetry = await routeState(t, jobId);
    expect(ordinaryRetry.job).toMatchObject({ attempt: 2, model: "luna", reasoningEffort: "medium", modelReason: persistedReason, modelQualityFailures: 0, modelEscalations: 0 });
    expect(ordinaryRetry.runtime).toMatchObject({ attempt: 2, model: "luna", reasoningEffort: "medium", modelReason: persistedReason });

    await claimNext(t, jobId, 2);
    expect(await t.mutation(api.jobs.checkpointAndRequeue, {
      jobId, expectedAttempt: 2, checkpoint: "Supervisor requested another pass",
      modelQualityFailure: "The required contract assertion was absent", workerToken: WORKER,
    })).toMatchObject({ requeued: true, exhausted: false, stale: false });
    const firstConcern = await routeState(t, jobId);
    expect(firstConcern.job).toMatchObject({ attempt: 3, model: "luna", reasoningEffort: "medium", modelReason: persistedReason, modelQualityFailures: 1, modelEscalations: 0 });
    expect(firstConcern.events.filter((event) => event.type === "model_escalated")).toHaveLength(0);

    await claimNext(t, jobId, 3);
    expect(await t.mutation(api.jobs.checkpointAndRequeue, {
      jobId, expectedAttempt: 3, checkpoint: "Supervisor found the repeated quality gap",
      modelQualityFailure: "The same required contract assertion remained absent", workerToken: WORKER,
    })).toMatchObject({ requeued: true, exhausted: false, stale: false });
    const escalated = await routeState(t, jobId);
    expect(escalated.job).toMatchObject({ attempt: 4, model: "terra", reasoningEffort: "high", modelQualityFailures: 0, modelEscalations: 1 });
    expect(escalated.runtime).toMatchObject({ attempt: 4, model: "terra", reasoningEffort: "high", modelReason: escalated.job!.modelReason });
    expect(escalated.job!.modelReason).toMatch(/after 2 evidenced quality failures/);
    expect(escalated.events.filter((event) => event.type === "model_escalated")).toEqual([
      expect.objectContaining({
        evidenceKind: "model_policy",
        data: expect.objectContaining({ fromModel: "luna", toModel: "terra", toEffort: "high" }),
      }),
    ]);
  });

  it("backfills the safety floor before continuing an already-running legacy job", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const jobId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("jobs", {
        task: "Repair production authentication and privacy isolation for customer data",
        repo: "daniels-project-space/jarvis", agentId: "paul", risk: "high", readonly: false,
        status: "running", stage: "executing", percent: 50, priority: 90,
        attempt: 1, maxAttempts: 4, workerRunId: "legacy-run", createdAt: now, heartbeatAt: now,
      });
      await ctx.db.insert("workAttempts", {
        jobId: id, attempt: 1, status: "running", workerRunId: "legacy-run",
        lastEventSeq: 0, livenessAt: now, progressAt: now, lastEventAt: now, createdAt: now,
      });
      return id;
    });

    expect(await t.mutation(api.jobs.checkpointAndRequeue, {
      jobId, expectedAttempt: 1, checkpoint: "Legacy worker checkpoint", workerToken: WORKER,
    })).toMatchObject({ requeued: true, exhausted: false, stale: false });
    const state = await routeState(t, jobId);
    expect(state.job).toMatchObject({ attempt: 2, model: "sol", reasoningEffort: "max", modelQualityFailures: 0, modelEscalations: 0 });
    expect(state.runtime).toMatchObject({ attempt: 2, model: "sol", reasoningEffort: "max", modelReason: state.job!.modelReason });
    expect(state.job!.modelReason).toMatch(/Security\/privacy safety floor/);
    expect(state.events.filter((event) => event.type === "model_escalated")).toHaveLength(0);
  });
});
