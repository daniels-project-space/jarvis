import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest, type TestConvex } from "convex-test";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import schema from "../../convex/schema";
import { testMissionAdmission } from "../../convex/testSourceAdmission";
import { workGroupAuthority } from "../lib/work-scheduler";

/* eslint-disable @typescript-eslint/no-explicit-any -- the Trigger task registration and convex-test bridge expose dynamic production handler boundaries */

declare global {
  interface ImportMeta { glob(pattern: string): Record<string, () => Promise<unknown>>; }
}

const trigger = vi.hoisted(() => {
  const definitions = new Map<string, any>();
  const metadata = {
    set: vi.fn(),
    flush: vi.fn(async () => undefined),
  } as any;
  metadata.set.mockImplementation(() => metadata);
  return {
    definitions,
    metadata,
    batchTrigger: vi.fn(async () => ({ batchId: "unexpected-batch" })),
  };
});
const boundaries = vi.hoisted(() => ({
  resolveSubscriptionAgentBin: vi.fn<() => string | null>(() => null),
  configuredCloudWorkspaceProvider: vi.fn(() => {
    throw new Error("cloud provider must not be reached by this authority harness");
  }),
}));

vi.mock("@trigger.dev/sdk/v3", () => ({
  metadata: trigger.metadata,
  task: (definition: any) => {
    trigger.definitions.set(definition.id, definition);
    return definition;
  },
  schedules: {
    task: (definition: any) => {
      trigger.definitions.set(definition.id, definition);
      return definition;
    },
  },
  tasks: { batchTrigger: trigger.batchTrigger },
  timeout: { None: "none" },
}));

vi.mock("./subscription-runtime", async (importOriginal) => ({
  ...await importOriginal<typeof import("./subscription-runtime")>(),
  resolveSubscriptionAgentBin: boundaries.resolveSubscriptionAgentBin,
}));

vi.mock("./cloud-workspace-providers", async (importOriginal) => ({
  ...await importOriginal<typeof import("./cloud-workspace-providers")>(),
  configuredCloudWorkspaceProvider: boundaries.configuredCloudWorkspaceProvider,
}));

import { agentWorker, setAgentRunnerBoundaryObserverForTest } from "./agent-runner";

const modules = import.meta.glob("../../convex/**/*.ts");
const WORKER = "production-runner-authority-worker";
const REPO = "daniels-project-space/jarvis";
type HarnessConvex = TestConvex<typeof schema>;

type MutationTrace = { path: string; args: Record<string, unknown> };

function bridgeProductionRunnerToConvex(t: HarnessConvex, beforeCall?: (call: MutationTrace) => Promise<void>) {
  const trace: MutationTrace[] = [];
  const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as MutationTrace;
    trace.push({ path: body.path, args: body.args });
    await beforeCall?.(body);
    let value: unknown;
    switch (body.path) {
      case "jobs:claimDispatched":
        value = await t.mutation(api.jobs.claimDispatched, body.args as any);
        break;
      case "jobs:authorizeExecutionBoundary":
        value = await t.mutation(api.jobs.authorizeExecutionBoundary, body.args as any);
        break;
      case "jobs:checkpointAndRequeue":
        value = await t.mutation(api.jobs.checkpointAndRequeue, body.args as any);
        break;
      case "jobs:reserveDispatchBatch":
        value = await t.mutation(api.jobs.reserveDispatchBatch, body.args as any);
        break;
      default:
        throw new Error(`Unexpected production runner Convex call: ${body.path}`);
    }
    return new Response(JSON.stringify({ status: "success", value }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { trace, fetchMock };
}

async function reservedWritableJob(t: HarnessConvex, key: string) {
  const mission = await testMissionAdmission(t, { key, workerToken: WORKER, repository: REPO });
  const jobId = await t.mutation(api.jobs.enqueueV2, {
    task: "Implement the exact production runner authority fixture and stop before any untrusted checkout.",
    repo: REPO,
    readonly: false,
    missionId: String(mission.missionId),
    label: "identical mutable runner label",
    workerToken: WORKER,
  }) as Id<"jobs">;
  const batch = await t.mutation(api.jobs.reserveDispatchBatch, { limit: 1, workerToken: WORKER });
  const reservation = batch.reservations[0];
  if (!reservation) throw new Error("runner authority fixture was not reserved");
  return { jobId, reservation };
}

async function invokeProductionWorker(payload: Record<string, unknown>, runId: string) {
  const definition = agentWorker as unknown as {
    run: (payload: Record<string, unknown>, context: any) => Promise<Record<string, unknown>>;
  };
  return await definition.run(payload, {
    ctx: { run: { id: runId }, deployment: { version: "trigger-test-deployment" } },
  });
}

beforeEach(() => {
  process.env.JARVIS_WORKER_TOKEN = WORKER;
  boundaries.resolveSubscriptionAgentBin.mockReset();
  boundaries.resolveSubscriptionAgentBin.mockReturnValue(null);
  boundaries.configuredCloudWorkspaceProvider.mockClear();
  trigger.batchTrigger.mockClear();
  trigger.metadata.set.mockClear();
  trigger.metadata.flush.mockClear();
  setAgentRunnerBoundaryObserverForTest();
});

afterEach(() => {
  delete process.env.JARVIS_WORKER_TOKEN;
  vi.unstubAllGlobals();
  setAgentRunnerBoundaryObserverForTest();
});

describe("production Trigger worker authority harness", () => {
  it("fails a wrong-repository ledger injection before subscription, provider, clone, or tools", async () => {
    const t = convexTest(schema, modules);
    const { jobId, reservation } = await reservedWritableJob(t, "runner-wrong-repository");
    await t.run(async (ctx) => {
      const job = await ctx.db.get(jobId);
      const injected = "daniels-project-space/dropship-ai";
      const forged = workGroupAuthority({
        _id: jobId,
        missionId: job?.missionId,
        repo: injected,
        canonicalProjectId: "dropship-ai",
      });
      await ctx.db.patch(jobId, { repo: injected, ...forged });
    });
    const bridge = bridgeProductionRunnerToConvex(t);

    const result = await invokeProductionWorker({
      jobId: String(jobId),
      dispatchId: reservation.dispatchId,
      reason: "same human label",
      repo: "daniels-project-space/dropship-ai",
      branch: "latest",
    }, "trigger-wrong-repository");

    expect(result).toMatchObject({ processed: 0, stale: true, continued: false, runtime: "trigger" });
    expect(bridge.trace.map((entry) => entry.path)).toEqual([
      "jobs:claimDispatched",
      "jobs:reserveDispatchBatch",
    ]);
    expect(boundaries.resolveSubscriptionAgentBin).not.toHaveBeenCalled();
    expect(boundaries.configuredCloudWorkspaceProvider).not.toHaveBeenCalled();
    expect(trigger.batchTrigger).not.toHaveBeenCalled();
    const state = await t.run(async (ctx) => ({
      job: await ctx.db.get(jobId),
      runtime: await ctx.db.query("jobRuntime").withIndex("by_job", (q) => q.eq("jobId", jobId)).first(),
      attempt: await ctx.db.query("workAttempts").withIndex("by_job_attempt", (q) => q.eq("jobId", jobId).eq("attempt", 1)).first(),
    }));
    expect(state.job).toMatchObject({ repo: "daniels-project-space/dropship-ai", status: "dispatching" });
    expect(state.runtime).toMatchObject({ schedulingBound: false, status: "dispatching" });
    expect(state.attempt?.workerRunId).toBeUndefined();
  });

  it("ignores forged payload authority and binds the actual Trigger run to the immutable claim", async () => {
    const t = convexTest(schema, modules);
    const { jobId, reservation } = await reservedWritableJob(t, "runner-payload-forgery");
    const before = await t.run(async (ctx) => ctx.db.get(jobId));
    const bridge = bridgeProductionRunnerToConvex(t);
    const boundariesSeen: Array<Record<string, unknown>> = [];
    setAgentRunnerBoundaryObserverForTest((boundary) => boundariesSeen.push(boundary));

    const result = await invokeProductionWorker({
      jobId: String(jobId),
      dispatchId: reservation.dispatchId,
      reason: "identical mutable runner label",
      repo: "daniels-project-space/dropship-ai",
      branch: "latest-selected-branch",
      missionGroupId: "latest-mission",
      workspaceLineage: "shared-workspace",
    }, "trigger-authoritative-run");

    expect(result).toMatchObject({
      processed: 1,
      error: "no codex binary",
      continued: false,
      runtime: "trigger",
      runId: "trigger-authoritative-run",
    });
    expect(bridge.trace.map((entry) => entry.path)).toEqual([
      "jobs:claimDispatched",
      "jobs:authorizeExecutionBoundary",
      "jobs:checkpointAndRequeue",
      "jobs:reserveDispatchBatch",
    ]);
    const claim = bridge.trace[0];
    expect(claim.args).toEqual({
      jobId: String(jobId),
      dispatchId: reservation.dispatchId,
      workerRunId: "trigger-authoritative-run",
      workerToken: WORKER,
    });
    expect(boundaries.resolveSubscriptionAgentBin).toHaveBeenCalledWith("codex");
    expect(boundaries.configuredCloudWorkspaceProvider).not.toHaveBeenCalled();
    expect(trigger.batchTrigger).not.toHaveBeenCalled();
    const state = await t.run(async (ctx) => ({
      job: await ctx.db.get(jobId),
      attempts: await Promise.all([1, 2].map((attempt) => ctx.db.query("workAttempts")
        .withIndex("by_job_attempt", (q) => q.eq("jobId", jobId).eq("attempt", attempt)).first())),
    }));
    expect(state.job).toMatchObject({
      repo: REPO,
      status: "pending",
      attempt: 2,
      workerBranch: before?.workerBranch,
      workspaceLineage: before?.workspaceLineage,
    });
    expect(state.attempts).toHaveLength(2);
    expect(state.attempts[0]).toMatchObject({
      attempt: 1,
      workerRunId: "trigger-authoritative-run",
      status: "checkpointed",
    });
    expect(boundariesSeen).toEqual([{
      phase: "codex_start",
      authorityDigest: state.attempts[0]?.authorityDigest,
      schedulingBindingDigest: state.attempts[0]?.schedulingBindingDigest,
      workOrderRevisionId: String(state.attempts[0]?.workOrderRevisionId),
      workOrderRevision: state.attempts[0]?.workOrderRevision,
      workOrderRevisionDigest: state.attempts[0]?.workOrderRevisionDigest,
      repository: REPO,
      sourceBranch: state.attempts[0]?.sourceBranch,
      sourceHeadSha: state.attempts[0]?.sourceHeadSha,
    }]);
    expect(state.attempts[1]).toMatchObject({ attempt: 2, status: "pending" });
    expect(state.attempts[1]?.workerRunId).toBeUndefined();
  });

  it("returns a typed hold for a realistic legacy Trigger delivery before subscription or provider startup", async () => {
    const t = convexTest(schema, modules);
    const jobId = await t.mutation(api.jobs.enqueue, {
      task: "legacy work admitted before protocol v2",
      repo: REPO,
      workerToken: WORKER,
    }) as Id<"jobs">;
    const dispatchId = "legacy-dispatch-from-old-production";
    await t.run(async (ctx) => ctx.db.patch(jobId, {
      status: "dispatching",
      stage: "dispatching",
      dispatchId,
      dispatchLeaseUntil: Date.now() + 60_000,
    }));
    const bridge = bridgeProductionRunnerToConvex(t);

    const result = await invokeProductionWorker({ jobId: String(jobId), dispatchId }, "legacy-trigger-replay");

    expect(result).toMatchObject({
      processed: 0,
      executable: false,
      held: true,
      code: "protocol_v1_admission_held",
      runtime: "trigger",
    });
    expect(bridge.trace.map((entry) => entry.path)).toEqual([
      "jobs:claimDispatched",
      "jobs:reserveDispatchBatch",
    ]);
    expect(boundaries.resolveSubscriptionAgentBin).not.toHaveBeenCalled();
    expect(boundaries.configuredCloudWorkspaceProvider).not.toHaveBeenCalled();
  });

  it("fences a source-head change between claim and Codex authorization through the production task", async () => {
    const t = convexTest(schema, modules);
    const { jobId, reservation } = await reservedWritableJob(t, "runner-source-head-race");
    let mutated = false;
    const bridge = bridgeProductionRunnerToConvex(t, async (call) => {
      if (call.path !== "jobs:authorizeExecutionBoundary" || mutated) return;
      mutated = true;
      await t.run(async (ctx) => ctx.db.patch(jobId, { sourceHeadSha: "f".repeat(40) }));
    });

    const result = await invokeProductionWorker({
      jobId: String(jobId), dispatchId: reservation.dispatchId,
    }, "trigger-source-head-race");

    expect(result).toMatchObject({
      processed: 1, stale: true,
      error: "immutable attempt authority rejected before Codex preflight",
      runtime: "trigger",
    });
    expect(bridge.trace.map((entry) => entry.path)).toEqual([
      "jobs:claimDispatched",
      "jobs:authorizeExecutionBoundary",
      "jobs:reserveDispatchBatch",
    ]);
    expect(boundaries.resolveSubscriptionAgentBin).not.toHaveBeenCalled();
    expect(boundaries.configuredCloudWorkspaceProvider).not.toHaveBeenCalled();
    expect(trigger.batchTrigger).not.toHaveBeenCalled();
    const state = await t.run(async (ctx) => ({
      job: await ctx.db.get(jobId),
      attempt: await ctx.db.query("workAttempts")
        .withIndex("by_job_attempt", (q) => q.eq("jobId", jobId).eq("attempt", 1)).first(),
    }));
    expect(state.job).toMatchObject({ status: "running", workerRunId: "trigger-source-head-race" });
    expect(state.attempt).toMatchObject({ status: "running", workerRunId: "trigger-source-head-race" });
  });
});
