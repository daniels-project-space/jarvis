import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import schema from "./schema";
import { MAX_TEXT_WORK_ORDER_BYTES, textWorkOrderByteLength } from "../src/lib/work-order";
import { GENERATED_GATED_ACTION_MATRIX } from "../src/mastra/fixtures/action-scope-regressions";
import { testMissionAdmission } from "./testSourceAdmission";
import { triggerClaimAuthority } from "../src/lib/trigger-machine";

declare global {
  interface ImportMeta { glob(pattern: string): Record<string, () => Promise<unknown>>; }
}

const modules = import.meta.glob("./**/*.ts");
const WORKER = "work-order-test-worker";
const REPO = "daniels-project-space/jarvis";
const FIXTURE_SHA256 = "d48d26ff68ae0789b70fbc9520aefe45a3de204bfef79fef95fe3c4ef57f7130";
const fixture = readFileSync(
  new URL("../src/mastra/fixtures/cloud-sandbox-approval-task.txt", import.meta.url),
  "utf8",
);
const CLAUSE_BOUNDARY_AND_LIFECYCLE_EXPLOITS = [
  "Audit Sandbox.get({ resume: false }); pay the supplier.",
  "Audit Sandbox.get({ resume: false }); publish the findings publicly.",
  "Audit Sandbox.get({ resume: false }); delete production records.",
  "Audit Sandbox.get({ resume: false }); send the tenant reply.",
  "Review Sandbox.get({ resume: false }); trade the selected shares.",
  "Ensure the failed final delete remains scheduled against customer records in Convex.",
] as const;

beforeEach(() => {
  process.env.JARVIS_WORKER_TOKEN = WORKER;
  vi.useRealTimers();
});

afterEach(() => {
  delete process.env.JARVIS_WORKER_TOKEN;
  vi.useRealTimers();
});

async function enqueueFixture(t: ReturnType<typeof convexTest>, input: {
  task: string;
  repo?: string;
  readonly?: boolean;
  model?: string;
  risk?: string;
  approvalRequired?: boolean;
  workerToken: string;
}) {
  const admitted = await testMissionAdmission(t, {
    key: "bounded-exact-work-orders",
    workerToken: WORKER,
    repository: input.repo,
  });
  return await t.mutation(api.jobs.enqueueV2, {
    ...input,
    missionId: String(admitted.missionId),
  });
}

describe("bounded exact textual work orders", () => {
  it("persists the calculated route instead of a static agent default or cheap override", async () => {
    const t = convexTest(schema, modules);
    const boundedTask = "Rename one UI label.";
    const hardTask = "Trace the root cause and redesign this multi-repo Convex architecture.";

    const boundedId = await enqueueFixture(t, {
      task: boundedTask,
      repo: REPO,
      workerToken: WORKER,
    });
    const hardId = await enqueueFixture(t, {
      task: hardTask,
      repo: REPO,
      model: "luna",
      workerToken: WORKER,
    });
    const [bounded, hard] = await t.run(async (ctx) => [
      await ctx.db.get(boundedId),
      await ctx.db.get(hardId),
    ]);

    // Paul defaults to Sol, but a short one-line rename is intentionally Luna.
    expect(bounded).toMatchObject({ agentId: "paul", model: "luna" });
    // A caller's cheap requested tier may never lower hard engineering work
    // below the normal Terra durable-work floor.
    expect(hard).toMatchObject({ agentId: "paul", model: "terra" });
  });

  it("persists every reproduced policy exploit behind the approval gate", async () => {
    const t = convexTest(schema, modules);
    for (const task of CLAUSE_BOUNDARY_AND_LIFECYCLE_EXPLOITS) {
      const jobId = await enqueueFixture(t, {
        task,
        repo: REPO,
        readonly: true,
        risk: "low",
        approvalRequired: false,
        workerToken: WORKER,
      });
      expect(await t.run(async (ctx) => await ctx.db.get(jobId)), task).toMatchObject({
        task,
        approvalRequired: true,
        status: "awaiting_approval",
        deliveryMode: "manual",
      });
    }
  });

  it("persists the complete 320-case action-scope matrix behind the gate despite caller hints", async () => {
    expect(GENERATED_GATED_ACTION_MATRIX).toHaveLength(320);
    const t = convexTest(schema, modules);
    for (const task of GENERATED_GATED_ACTION_MATRIX) {
      const jobId = await enqueueFixture(t, {
        task,
        repo: REPO,
        readonly: true,
        risk: "low",
        approvalRequired: false,
        workerToken: WORKER,
      });
      expect(await t.run(async (ctx) => await ctx.db.get(jobId)), task).toMatchObject({
        task,
        approvalRequired: true,
        status: "awaiting_approval",
        deliveryMode: "manual",
      });
    }
  });

  it("classifies, persists and claims every accepted fixture byte without hot-projection duplication", async () => {
    expect(textWorkOrderByteLength(fixture)).toBe(7_876);
    expect(createHash("sha256").update(fixture).digest("hex")).toBe(FIXTURE_SHA256);

    const t = convexTest(schema, modules);
    const jobId = await enqueueFixture(t, {
      task: fixture,
      repo: REPO,
      workerToken: WORKER,
    });
    const stored = await t.run(async (ctx) => ({
      job: await ctx.db.get(jobId),
      runtime: await ctx.db.query("jobRuntime").withIndex("by_job", (q) => q.eq("jobId", jobId)).first(),
      revision: await ctx.db.query("workOrderRevisions")
        .withIndex("by_job_revision", (q) => q.eq("jobId", jobId).eq("revision", 1)).first(),
    }));

    expect(stored.job).toMatchObject({
      task: fixture,
      approvalRequired: false,
      status: "pending",
      workOrderProtocolVersion: 2,
      triggerMachinePreset: "medium-2x",
      triggerMachineReason: "admitted_write_or_hard",
    });
    expect(stored.revision).toMatchObject({
      protocolVersion: 2,
      triggerMachinePreset: "medium-2x",
      triggerMachineReason: "admitted_write_or_hard",
    });
    const durableTask = (stored.job as { task: string } | null)?.task;
    expect(durableTask).toBe(fixture);
    expect(textWorkOrderByteLength(durableTask!)).toBe(7_876);
    expect(createHash("sha256").update(durableTask!).digest("hex")).toBe(FIXTURE_SHA256);
    expect(stored.runtime?.task).toBe(fixture.slice(0, 600));

    const reserved = await t.mutation(api.jobs.reserveDispatchBatch, {
      limit: 1,
      reason: "exact-work-order-test",
      workerToken: WORKER,
    });
    expect(reserved.reservations).toHaveLength(1);
    const claim = await t.mutation(api.jobs.claimDispatched, {
      jobId,
      dispatchId: reserved.reservations[0].dispatchId,
      ...triggerClaimAuthority(reserved.reservations[0]),
      workerRunId: "exact-work-order-run",
      workerToken: WORKER,
    });
    expect(claim?.task).toBe(fixture);
    expect(textWorkOrderByteLength(claim!.task)).toBe(7_876);
    expect(createHash("sha256").update(claim!.task).digest("hex")).toBe(FIXTURE_SHA256);
  });

  it("rejects an oversized UTF-8 task explicitly before policy or durable storage", async () => {
    const t = convexTest(schema, modules);
    const oversized = `Email the verified user.\n${"é".repeat(MAX_TEXT_WORK_ORDER_BYTES / 2)}`;
    expect(textWorkOrderByteLength(oversized)).toBeGreaterThan(MAX_TEXT_WORK_ORDER_BYTES);

    await expect(enqueueFixture(t, {
      task: oversized,
      repo: REPO,
      workerToken: WORKER,
    })).rejects.toThrow(
      `Text work order exceeds the ${MAX_TEXT_WORK_ORDER_BYTES}-byte UTF-8 limit`,
    );
    expect(await t.run(async (ctx) => await ctx.db.query("jobs").collect())).toHaveLength(0);
  });

  it("classifies the same post-6000-byte consequential tail that it persists", async () => {
    const t = convexTest(schema, modules);
    const task = `Inspect the repository context.\n${"technical context ".repeat(420)}\nEmail the verified user.`;
    expect(textWorkOrderByteLength(task)).toBeGreaterThan(6_000);

    const jobId = await enqueueFixture(t, {
      task,
      repo: REPO,
      workerToken: WORKER,
    });
    const stored = await t.run(async (ctx) => await ctx.db.get(jobId));
    expect(stored).toMatchObject({
      task,
      approvalRequired: true,
      status: "awaiting_approval",
      deliveryMode: "manual",
    });
  });
});
