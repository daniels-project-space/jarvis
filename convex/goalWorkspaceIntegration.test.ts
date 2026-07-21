import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import schema from "./schema";

declare global {
  interface ImportMeta { glob(pattern: string): Record<string, () => Promise<unknown>>; }
}

const modules = import.meta.glob("./**/*.ts");
const TOKEN = "goal-integration-test-worker";
const REPO = "daniels-project-space/dropship-ai";
const BASE = "1".repeat(40);
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

beforeEach(() => { process.env.JARVIS_WORKER_TOKEN = TOKEN; vi.useRealTimers(); });
afterEach(() => { delete process.env.JARVIS_WORKER_TOKEN; vi.useRealTimers(); });

async function plannedGoal() {
  const { t, missionId } = await goalAwaitingPlan();
  const plan = {
    summary: "Two independent owned workstreams",
    route: "existing_project",
    primaryRepo: REPO,
    assumptions: [],
    workstreams: [
      { id: "cj-durability", label: "CJ durability", task: "Implement the durable CJ catalogue boundary with real integration coverage.", agentId: "paul", repo: REPO, readonly: false, dependsOn: [], acceptanceCriteria: ["CJ tests pass"], mcp: ["context7"] },
      { id: "content-metrics", label: "Content metrics", task: "Implement independent content metric persistence with exact attribution tests.", agentId: "paul", repo: REPO, readonly: false, dependsOn: [], acceptanceCriteria: ["Metrics tests pass"], mcp: ["context7"] },
    ],
    validation: { criteria: ["Integrated result works"], tests: ["npm test"], liveChecks: [] },
  };
  expect(await t.mutation(api.goalMode.recordPlan, {
    id: missionId, expectedAdvanceAttempt: 1, plan, workerToken: TOKEN,
  })).toMatchObject({ advanced: true, jobs: 2 });
  const jobs = await t.run(async (ctx) => (await ctx.db.query("jobs")
    .withIndex("by_mission", (q) => q.eq("missionId", String(missionId))).collect())
    .filter((job) => job.goalStage === "building"));
  return { t, missionId, jobs };
}

async function goalAwaitingPlan() {
  const t = convexTest(schema, modules);
  const created = await t.mutation(api.goalMode.create, {
    goal: "Make the Dropship catalogue and content metrics durable in parallel",
    route: "existing_project", routeReason: "owned product", primaryRepo: REPO,
    infrastructureContext: "Preserve the owned Dropship infrastructure.", maxBuildSessions: 4,
    workerToken: TOKEN,
  });
  await t.run(async (ctx) => {
    const mission = await ctx.db.get(created.missionId);
    await ctx.db.patch(created.missionId, { advanceAttempt: 1 });
    const runtime = await ctx.db.query("missionRuntime")
      .withIndex("by_mission", (q) => q.eq("missionId", created.missionId)).first();
    if (runtime) await ctx.db.patch(runtime._id, { updatedAt: Date.now() });
    expect(mission).not.toBeNull();
  });
  return { t, missionId: created.missionId };
}

async function dispatch(t: ReturnType<typeof convexTest>, count: number, prefix: string) {
  const batches = await Promise.all([
    t.mutation(api.jobs.reserveDispatchBatch, { limit: count, reason: `${prefix}-a`, workerToken: TOKEN }),
    t.mutation(api.jobs.reserveDispatchBatch, { limit: count, reason: `${prefix}-b`, workerToken: TOKEN }),
  ]);
  const reservations = batches.flatMap((batch) => batch.reservations);
  return await Promise.all(reservations.map(async (reservation, index) => ({
    reservation,
    claim: await t.mutation(api.jobs.claimDispatched, {
      jobId: reservation.jobId as any, dispatchId: reservation.dispatchId,
      workerRunId: `${prefix}-run-${index}`, workerToken: TOKEN,
    }),
  })));
}

async function review(t: ReturnType<typeof convexTest>, job: any, workerRunId: string, head: string, tree: string) {
  const result = `specialist result for ${job.goalWorkstreamId}`;
  const note = `review passed for ${job.workerBranch}`;
  const receipt = JSON.stringify({
    version: 1, jobId: String(job._id), attempt: 1, repository: REPO,
    branch: job.workerBranch, baseSha: BASE, baseTreeSha: "2".repeat(40), headSha: head,
    headTreeSha: tree, diffSha256: "3".repeat(64), agentEvidenceSha256: "4".repeat(64),
  });
  expect(await t.mutation(api.jobs.markVerifiedForDelivery, {
    jobId: job._id, expectedAttempt: 1, specialistRunId: workerRunId,
    result, verificationNote: note, reviewReceiptJson: receipt,
    reviewReceiptSignature: "5".repeat(64), reviewReceiptKeyId: "test-key",
    reviewDiffSha256: "3".repeat(64), resultDigest: sha256(result), evidenceDigest: sha256(note),
    workerToken: TOKEN,
  })).toBe(true);
}

describe("real Convex multi-agent workspace and integration races", () => {
  it("rejects invalid DAG authority records before dispatch creates a specialist", async () => {
    const f = await goalAwaitingPlan();
    const plan = (workstreams: Array<{ id: string; dependsOn: string[] }>) => ({ workstreams });
    await expect(f.t.mutation(api.goalMode.recordPlan, {
      id: f.missionId, expectedAdvanceAttempt: 1,
      plan: plan([{ id: "same", dependsOn: [] }, { id: "same", dependsOn: [] }]), workerToken: TOKEN,
    })).rejects.toThrow(/duplicate workstream id/);
    await expect(f.t.mutation(api.goalMode.recordPlan, {
      id: f.missionId, expectedAdvanceAttempt: 1,
      plan: plan([{ id: "a", dependsOn: ["missing"] }, { id: "b", dependsOn: [] }]), workerToken: TOKEN,
    })).rejects.toThrow(/unknown workstream/);
    await expect(f.t.mutation(api.goalMode.recordPlan, {
      id: f.missionId, expectedAdvanceAttempt: 1,
      plan: plan([{ id: "a", dependsOn: ["b"] }, { id: "b", dependsOn: ["a"] }]), workerToken: TOKEN,
    })).rejects.toThrow(/cycle/);
    await expect(f.t.mutation(api.goalMode.recordPlan, {
      id: f.missionId, expectedAdvanceAttempt: 1,
      plan: plan(Array.from({ length: 5 }, (_, index) => ({ id: `fanout-${index}`, dependsOn: [] }))), workerToken: TOKEN,
    })).rejects.toThrow(/budget/);
    const buildJobs = await f.t.run(async (ctx) => (await ctx.db.query("jobs")
      .withIndex("by_mission", (q) => q.eq("missionId", String(f.missionId))).collect())
      .filter((job) => job.goalStage === "building"));
    expect(buildJobs).toHaveLength(0);
  });

  it("eliminates the shared goal branch bug and serializes exact attributed receipts", async () => {
    const f = await plannedGoal();
    expect(new Set(f.jobs.map((job) => job.workerBranch)).size).toBe(2);
    expect(new Set(f.jobs.map((job) => job.workspaceLineage)).size).toBe(2);
    expect(f.jobs.every((job) => job.branch === job.workerBranch && job.branch !== job.integrationBranch)).toBe(true);
    expect(f.jobs.every((job) => (job.dependsOn ?? []).length === 0)).toBe(true);

    const specialists = await dispatch(f.t, 2, "specialist");
    expect(specialists).toHaveLength(2);
    expect(specialists.every(({ claim }) => claim?.goalStage === "building")).toBe(true);
    const running = await f.t.run(async (ctx) => await ctx.db.query("workAttempts").collect());
    expect(running.filter((attempt) => attempt.status === "running")).toHaveLength(2);
    expect(new Set(running.map((attempt) => attempt.workspaceLineage)).size).toBe(2);

    const byId = new Map(f.jobs.map((job) => [String(job._id), job]));
    for (let index = 0; index < specialists.length; index += 1) {
      const specialist = specialists[index];
      const job = byId.get(String(specialist.reservation.jobId))!;
      await review(f.t, job, String(specialist.claim!.workerRunId), String(index + 6).repeat(40), String(index + 8).repeat(40));
    }
    const integrations = await f.t.run(async (ctx) => (await ctx.db.query("integrationAttempts").collect())
      .sort((left, right) => left.generation - right.generation));
    expect(integrations).toHaveLength(2);
    expect(integrations.map((row) => row.workerBranch)).toEqual(
      integrations.map((row) => byId.get(String(row.jobId))!.workerBranch),
    );
    expect(new Set(integrations.map((row) => row.reviewedHeadSha))).toEqual(new Set(["6".repeat(40), "7".repeat(40)]));

    const controllers = await dispatch(f.t, 2, "controller");
    expect(controllers).toHaveLength(2);
    const controllerByJob = new Map(controllers.map((entry) => [String(entry.reservation.jobId), entry]));
    const first = integrations[0];
    const second = integrations[1];
    const claimArgs = (row: any, suffix: string) => ({
      id: row._id, controllerRunId: String(controllerByJob.get(String(row.jobId))!.claim!.deliveryRunId),
      leaseOwner: `owner-${suffix}`, leaseToken: `lease-${suffix}`, workerToken: TOKEN,
    });
    const [firstClaim, competingClaim] = await Promise.all([
      f.t.mutation(api.goalIntegration.claim, claimArgs(first, "one")),
      f.t.mutation(api.goalIntegration.claim, claimArgs(second, "two")),
    ]);
    expect(firstClaim).not.toBeNull();
    expect(competingClaim).toBeNull();

    const finishIntegration = async (row: any, claim: any, head: string, tree: string, suffix: string) => {
      const fence = { id: row._id, controllerRunId: claim.controllerRunId, leaseOwner: claim.leaseOwner,
        leaseToken: claim.leaseToken, leaseVersion: claim.leaseVersion, workerToken: TOKEN };
      const effectId = `effect-${suffix}`;
      expect(await f.t.mutation(api.goalIntegration.prepare, {
        ...fence, effectId, expectedIntegrationBaseSha: claim.expectedIntegrationBaseSha,
        preparedIntegrationHeadSha: head, preparedIntegrationTreeSha: tree,
      })).toMatchObject({ replay: false });
      expect(await f.t.mutation(api.goalIntegration.observe, {
        ...fence, effectId, observation: "applied", providerHeadSha: head,
      })).toBe(true);
      expect(await f.t.mutation(api.goalIntegration.complete, {
        ...fence, effectId, terminalReceiptDigest: sha256(`${row._id}:${head}`),
      })).toBe(true);
    };
    await finishIntegration(first, firstClaim, "a".repeat(40), "b".repeat(40), "one");
    const secondClaim = await f.t.mutation(api.goalIntegration.claim, claimArgs(second, "two-retry"));
    expect(secondClaim).toMatchObject({ expectedIntegrationBaseSha: "a".repeat(40) });
    await finishIntegration(second, secondClaim, "c".repeat(40), "d".repeat(40), "two");

    const final = await f.t.run(async (ctx) => ({
      mission: await ctx.db.get(f.missionId), jobs: await ctx.db.query("jobs").withIndex("by_mission", (q) => q.eq("missionId", String(f.missionId))).collect(),
      attempts: await ctx.db.query("workAttempts").collect(), receipts: await ctx.db.query("workReceipts").collect(),
      integrationRows: await ctx.db.query("integrationAttempts").collect(),
    }));
    expect((final.mission as any)?.integrationHeadSha).toBe("c".repeat(40));
    expect(final.jobs.filter((job) => job.goalStage === "building").every((job) => job.status === "done" && job.integrationState === "integrated")).toBe(true);
    expect(final.attempts).toHaveLength(2); // delivery never reran either specialist
    expect(final.receipts).toHaveLength(2);
    expect(final.integrationRows.map((row) => row.status)).toEqual(["integrated", "integrated"]);

    expect(await f.t.mutation(api.goalMode.claimAdvance, { workerToken: TOKEN })).toMatchObject({ kind: "advanced", phase: "validating" });
    const validator = await f.t.run(async (ctx) => (await ctx.db.query("jobs")
      .withIndex("by_mission", (q) => q.eq("missionId", String(f.missionId))).collect())
      .find((job) => job.goalStage === "validating"));
    expect(validator).toMatchObject({ readonly: true, branch: (final.mission as any)?.integrationBranch, sourceHeadSha: "c".repeat(40) });
    await f.t.run(async (ctx) => {
      await ctx.db.patch(validator!._id, {
        status: "done", result: "validator passed", verificationVerdict: "pass", completedAt: Date.now(),
      });
      const runtime = await ctx.db.query("jobRuntime").withIndex("by_job", (q) => q.eq("jobId", validator!._id)).first();
      if (runtime) await ctx.db.patch(runtime._id, { status: "done", active: false, completedAt: Date.now(), updatedAt: Date.now() });
    });
    const validationClaim = await f.t.mutation(api.goalMode.claimAdvance, { workerToken: TOKEN });
    expect(validationClaim).toMatchObject({ kind: "validation", missionId: f.missionId });
    expect(await f.t.mutation(api.goalMode.recordValidation, {
      id: f.missionId, expectedAdvanceAttempt: Number(validationClaim!.expectedAdvanceAttempt),
      validation: { verdict: "pass", summary: "integrated mission passed", evidence: ["two signed receipts", "pinned validator head"], gaps: [], refinements: [] },
      workerToken: TOKEN,
    })).toMatchObject({ advanced: true, status: "done" });
    expect(((await f.t.run(async (ctx) => ctx.db.get(f.missionId))) as any)?.status).toBe("done");
  });

  it("fences stale controllers and creates one focused conflict repair without replaying siblings", async () => {
    const f = await plannedGoal();
    const specialists = await dispatch(f.t, 2, "specialist");
    const byId = new Map(f.jobs.map((job) => [String(job._id), job]));
    for (let index = 0; index < specialists.length; index += 1) {
      const entry = specialists[index];
      await review(f.t, byId.get(String(entry.reservation.jobId))!, String(entry.claim!.workerRunId), String(index + 6).repeat(40), String(index + 8).repeat(40));
    }
    const controllers = await dispatch(f.t, 2, "controller");
    const integration = (await f.t.run(async (ctx) => await ctx.db.query("integrationAttempts").collect()))
      .sort((left, right) => left.generation - right.generation)[0];
    const controller = controllers.find((entry) => String(entry.reservation.jobId) === String(integration.jobId))!;
    const claim = await f.t.mutation(api.goalIntegration.claim, {
      id: integration._id, controllerRunId: String(controller.claim!.deliveryRunId),
      leaseOwner: "owner", leaseToken: "lease", workerToken: TOKEN,
    });
    const fence = { id: integration._id, controllerRunId: claim!.controllerRunId, leaseOwner: claim!.leaseOwner,
      leaseToken: claim!.leaseToken, leaseVersion: claim!.leaseVersion, workerToken: TOKEN };
    expect(await f.t.mutation(api.goalIntegration.prepare, {
      ...fence, effectId: "prepared", expectedIntegrationBaseSha: claim!.expectedIntegrationBaseSha,
      preparedIntegrationHeadSha: "a".repeat(40), preparedIntegrationTreeSha: "b".repeat(40),
    })).toMatchObject({ replay: false });
    await f.t.run(async (ctx) => ctx.db.patch(f.missionId, { status: "paused" }));
    expect(await f.t.mutation(api.goalIntegration.observe, {
      ...fence, effectId: "prepared", observation: "applied", providerHeadSha: "a".repeat(40),
    })).toBe(false);
    await f.t.run(async (ctx) => ctx.db.patch(f.missionId, { status: "running" }));
    const repair = await f.t.mutation(api.goalIntegration.failFocused, {
      ...fence, kind: "conflict", reason: "same semantic block changed independently",
    });
    expect(repair?.repairJobId).toBeTruthy();
    const rows = await f.t.run(async (ctx) => ({
      jobs: await ctx.db.query("jobs").withIndex("by_mission", (q) => q.eq("missionId", String(f.missionId))).collect(),
      integrations: await ctx.db.query("integrationAttempts").collect(), attempts: await ctx.db.query("workAttempts").collect(),
    }));
    const repairJob = rows.jobs.find((job) => job._id === repair!.repairJobId);
    expect(repairJob).toMatchObject({ parentJobId: String(integration.jobId), sourceBranch: integration.integrationBranch });
    expect(repairJob?.workerBranch).not.toBe(integration.workerBranch);
    expect(rows.jobs.filter((job) => job.goalStage === "building")).toHaveLength(3);
    expect(rows.attempts.filter((attempt) => attempt.workerRunId?.startsWith("specialist"))).toHaveLength(2);
  });
});
