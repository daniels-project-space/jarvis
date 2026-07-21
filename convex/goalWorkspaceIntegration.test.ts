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
  expect(await t.mutation(api.jobs.bindWorkspaceSource, {
    jobId: job._id, expectedAttempt: 1, workerRunId,
    sourceBranch: job.sourceBranch, sourceHeadSha: BASE, workerToken: TOKEN,
  })).toBe(true);
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

  it("atomically returns a typed child-mission split for writable work in two repositories", async () => {
    const f = await goalAwaitingPlan();
    const other = "daniels-project-space/jarvis";
    const plan = {
      summary: "Cross-project plan", route: "existing_project", primaryRepo: REPO, assumptions: [],
      workstreams: [
        { id: "catalog", label: "Catalog", task: "Edit catalog", agentId: "paul", repo: REPO, readonly: false, dependsOn: [], acceptanceCriteria: ["done"], mcp: [] },
        { id: "jarvis", label: "Jarvis", task: "Edit Jarvis", agentId: "paul", repo: other, readonly: false, dependsOn: [], acceptanceCriteria: ["done"], mcp: [] },
        { id: "research", label: "Research", task: "Read across projects", agentId: "loki", repo: "daniels-project-space/music-house", readonly: true, dependsOn: [], acceptanceCriteria: ["evidence"], mcp: [] },
      ],
      validation: { criteria: ["split"], tests: [], liveChecks: [] },
    };
    await expect(f.t.mutation(api.goalMode.recordPlan, {
      id: f.missionId, expectedAdvanceAttempt: 1, plan, workerToken: TOKEN,
    })).resolves.toMatchObject({
      advanced: true, stale: false, splitRequired: true,
      code: "WRITABLE_REPOSITORY_SPLIT_REQUIRED",
      repositories: [other, REPO].sort(), parentMissionId: String(f.missionId),
    });
    const state = await f.t.run(async (ctx) => ({
      mission: await ctx.db.get(f.missionId),
      builders: (await ctx.db.query("jobs").withIndex("by_mission", (q) => q.eq("missionId", String(f.missionId))).collect())
        .filter((job) => job.goalStage === "building"),
      integrations: await ctx.db.query("integrationAttempts").collect(),
      missions: await ctx.db.query("missions").collect(),
    }));
    expect(state.builders).toHaveLength(0);
    expect(state.integrations).toHaveLength(0);
    expect(state.mission).toMatchObject({ status: "split", phase: "split", integrationGeneration: 0 });
    const children = state.missions.filter((row) => String((row as any).parentMissionId) === String(f.missionId));
    expect(children).toHaveLength(2);
    expect(new Set(children.map((row) => row.primaryRepo))).toEqual(new Set([REPO, other]));
    expect(children.every((row) => row.status === "running" && row.phase === "planning" && row.planningJobId)).toBe(true);
  });

  it("fails closed when a mission review substitutes a source base other than the first bound head", async () => {
    const f = await plannedGoal();
    const [specialist] = await dispatch(f.t, 1, "source-forgery");
    const job = f.jobs.find((row) => String(row._id) === String(specialist.reservation.jobId))!;
    expect(await f.t.mutation(api.jobs.bindWorkspaceSource, {
      jobId: job._id, expectedAttempt: 1, workerRunId: String(specialist.claim!.workerRunId),
      sourceBranch: String(job.sourceBranch), sourceHeadSha: BASE, workerToken: TOKEN,
    })).toBe(true);
    const result = "forged result";
    const note = "forged review";
    const receipt = JSON.stringify({
      version: 1, jobId: String(job._id), attempt: 1, repository: REPO, branch: job.workerBranch,
      baseSha: "f".repeat(40), baseTreeSha: "2".repeat(40), headSha: "6".repeat(40),
      headTreeSha: "8".repeat(40), diffSha256: "3".repeat(64), agentEvidenceSha256: "4".repeat(64),
    });
    expect(await f.t.mutation(api.jobs.markVerifiedForDelivery, {
      jobId: job._id, expectedAttempt: 1, specialistRunId: String(specialist.claim!.workerRunId),
      result, verificationNote: note, reviewReceiptJson: receipt,
      reviewReceiptSignature: "5".repeat(64), reviewReceiptKeyId: "test-key",
      reviewDiffSha256: "3".repeat(64), resultDigest: sha256(result), evidenceDigest: sha256(note), workerToken: TOKEN,
    })).toBe(false);
    expect(await f.t.run(async (ctx) => ctx.db.query("reviewReceipts").collect())).toHaveLength(0);
    expect(await f.t.run(async (ctx) => ctx.db.query("integrationAttempts").collect())).toHaveLength(0);
  });

  it("enforces the exact parent checkpoint and reviews a two-attempt lineage from the original source", async () => {
    const f = await plannedGoal();
    const [first] = await dispatch(f.t, 1, "continuation-first");
    const job = f.jobs.find((row) => String(row._id) === String(first.reservation.jobId))!;
    expect(await f.t.mutation(api.jobs.bindWorkspaceSource, {
      jobId: job._id, expectedAttempt: 1, workerRunId: String(first.claim!.workerRunId),
      sourceBranch: String(job.sourceBranch), sourceHeadSha: BASE, checkoutHeadSha: BASE, workerToken: TOKEN,
    })).toBe(true);
    const checkpointHead = "a".repeat(40);
    expect(await f.t.mutation(api.jobs.checkpointAndRequeue, {
      jobId: job._id, expectedAttempt: 1, checkpoint: "first segment committed",
      checkpointHeadSha: checkpointHead, result: "segment one", branch: job.workerBranch, workerToken: TOKEN,
    })).toMatchObject({ requeued: true });
    const continuations = await dispatch(f.t, 8, "continuation-second");
    const second = continuations.find((entry) => String(entry.reservation.jobId) === String(job._id))!;
    expect(second.claim).toMatchObject({ attempt: 2, sourceHeadSha: BASE });
    expect(await f.t.mutation(api.jobs.bindWorkspaceSource, {
      jobId: job._id, expectedAttempt: 2, workerRunId: String(second.claim!.workerRunId),
      sourceBranch: String(job.sourceBranch), sourceHeadSha: BASE, checkoutHeadSha: "b".repeat(40), workerToken: TOKEN,
    })).toBe(false);
    expect(await f.t.mutation(api.jobs.bindWorkspaceSource, {
      jobId: job._id, expectedAttempt: 2, workerRunId: String(second.claim!.workerRunId),
      sourceBranch: String(job.sourceBranch), sourceHeadSha: BASE, checkoutHeadSha: checkpointHead, workerToken: TOKEN,
    })).toBe(true);
    const result = "cumulative two-segment result";
    const note = "cumulative source-to-final review passed";
    const receipt = JSON.stringify({
      version: 1, jobId: String(job._id), attempt: 2, repository: REPO, branch: job.workerBranch,
      baseSha: BASE, baseTreeSha: "2".repeat(40), headSha: "c".repeat(40), headTreeSha: "d".repeat(40),
      diffSha256: "3".repeat(64), agentEvidenceSha256: "4".repeat(64),
    });
    expect(await f.t.mutation(api.jobs.markVerifiedForDelivery, {
      jobId: job._id, expectedAttempt: 2, specialistRunId: String(second.claim!.workerRunId),
      result, verificationNote: note, reviewReceiptJson: receipt, reviewReceiptSignature: "5".repeat(64),
      reviewReceiptKeyId: "test-key", reviewDiffSha256: "3".repeat(64),
      resultDigest: sha256(result), evidenceDigest: sha256(note), workerToken: TOKEN,
    })).toBe(true);
    const lineage = await f.t.run(async (ctx) => ctx.db.query("workAttempts")
      .withIndex("by_job_attempt", (q) => q.eq("jobId", job._id)).collect());
    expect(lineage).toEqual(expect.arrayContaining([
      expect.objectContaining({ attempt: 1, checkpointHeadSha: checkpointHead }),
      expect.objectContaining({ attempt: 2, parentAttempt: 1, parentCheckpointHeadSha: checkpointHead, sourceHeadSha: BASE }),
    ]));
    const integration = (await f.t.run(async (ctx) => ctx.db.query("integrationAttempts").collect()))
      .find((row) => row.jobId === job._id);
    expect(integration).toMatchObject({ workAttempt: 2, reviewedBaseSha: BASE, reviewedHeadSha: "c".repeat(40) });
  });

  it("canonicalizes distinct cancelled receipts under mission control without accepting caller digests", async () => {
    const f = await plannedGoal();
    const specialists = await dispatch(f.t, 2, "cancel-specialist");
    const byId = new Map(f.jobs.map((job) => [String(job._id), job]));
    for (let index = 0; index < specialists.length; index += 1) {
      const entry = specialists[index];
      await review(f.t, byId.get(String(entry.reservation.jobId))!, String(entry.claim!.workerRunId), String(index + 6).repeat(40), String(index + 8).repeat(40));
    }
    expect(await f.t.mutation(api.goalMode.control, { id: f.missionId, action: "cancel", workerToken: TOKEN })).toBe(true);
    const rows = await f.t.run(async (ctx) => ({
      attempts: await ctx.db.query("integrationAttempts").collect(),
      terminals: await ctx.db.query("integrationTerminalReceipts").collect(),
    }));
    expect(rows.attempts.every((row) => row.status === "cancelled" && row.terminalReceiptDigest)).toBe(true);
    expect(rows.terminals).toHaveLength(2);
    expect(new Set(rows.terminals.map((row) => row.receiptDigest)).size).toBe(2);
    for (const terminal of rows.terminals) {
      expect(terminal.outcome).toBe("cancelled");
      expect(sha256(terminal.receiptJson)).toBe(terminal.receiptDigest);
      expect(JSON.parse(terminal.receiptJson)).toMatchObject({ terminal: { outcome: "cancelled" } });
    }
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
    expect(controllers).toHaveLength(1);
    const first = integrations[0];
    const second = integrations[1];
    expect(String(controllers[0].reservation.jobId)).toBe(String(first.jobId));
    const claimArgs = (row: any, controller: any, suffix: string) => ({
      id: row._id, controllerRunId: String(controller.claim!.deliveryRunId),
      leaseOwner: `owner-${suffix}`, leaseToken: `lease-${suffix}`, workerToken: TOKEN,
    });
    const firstClaim = await f.t.mutation(api.goalIntegration.claim, claimArgs(first, controllers[0], "one"));
    expect(firstClaim).not.toBeNull();
    const queuedBefore = await f.t.run(async (ctx) => ctx.db.get(second.jobId));
    expect(queuedBefore).toMatchObject({ status: "pending", integrationState: "provider_waiting", deliveryGeneration: 1 });
    expect((queuedBefore as any)?.deliveryRunId).toBeUndefined();

    const finishIntegration = async (row: any, claim: any, head: string, tree: string, suffix: string) => {
      const fence = { id: row._id, controllerRunId: claim.controllerRunId, leaseOwner: claim.leaseOwner,
        leaseToken: claim.leaseToken, leaseVersion: claim.leaseVersion, workerToken: TOKEN };
      const effectId = `effect-${suffix}`;
      expect(await f.t.mutation(api.goalIntegration.prepare, {
        ...fence, effectId, effectKind: "update_ref", provider: "github",
        providerIdentity: `repo-node:refs/heads/${claim.integrationBranch}`, providerMethod: "POST",
        providerTarget: "https://api.github.com/graphql#updateRefs", requestDigest: "9".repeat(64),
        expectedIntegrationRefSha: claim.expectedIntegrationRefSha,
        preparedIntegrationHeadSha: head, preparedIntegrationTreeSha: tree,
      })).toMatchObject({ replay: false });
      expect(await f.t.mutation(api.goalIntegration.observe, {
        ...fence, effectId, observation: "applied", providerHeadSha: head,
        providerResponse: JSON.stringify({ data: { updateRefs: { clientMutationId: effectId } } }),
      })).toBe(true);
      expect(await f.t.mutation(api.goalIntegration.complete, {
        ...fence, effectId,
      })).toBe(true);
    };
    await finishIntegration(first, firstClaim, "a".repeat(40), "b".repeat(40), "one");
    const secondControllers = await dispatch(f.t, 2, "controller-two");
    expect(secondControllers).toHaveLength(1);
    expect(String(secondControllers[0].reservation.jobId)).toBe(String(second.jobId));
    const secondClaim = await f.t.mutation(api.goalIntegration.claim, claimArgs(second, secondControllers[0], "two-retry"));
    expect(secondClaim).toMatchObject({ expectedIntegrationBaseSha: "a".repeat(40) });
    await finishIntegration(second, secondClaim, "c".repeat(40), "d".repeat(40), "two");

    const final = await f.t.run(async (ctx) => ({
      mission: await ctx.db.get(f.missionId), jobs: await ctx.db.query("jobs").withIndex("by_mission", (q) => q.eq("missionId", String(f.missionId))).collect(),
      attempts: await ctx.db.query("workAttempts").collect(), receipts: await ctx.db.query("workReceipts").collect(),
      integrationRows: await ctx.db.query("integrationAttempts").collect(),
      providerEffects: await ctx.db.query("integrationProviderEffects").collect(),
      terminalReceipts: await ctx.db.query("integrationTerminalReceipts").collect(),
    }));
    expect((final.mission as any)?.integrationHeadSha).toBe("c".repeat(40));
    expect(final.jobs.filter((job) => job.goalStage === "building").every((job) => job.status === "done" && job.integrationState === "integrated")).toBe(true);
    expect(final.attempts).toHaveLength(2); // delivery never reran either specialist
    expect(final.receipts).toHaveLength(2);
    expect(final.integrationRows.map((row) => row.status)).toEqual(["integrated", "integrated"]);
    expect(final.integrationRows.every((row) => !(row as any).effects && row.providerEffectCount === 1)).toBe(true);
    expect(final.providerEffects).toHaveLength(2);
    expect(final.providerEffects.every((row) => row.providerResponseDigest === sha256(String(row.providerResponse)))).toBe(true);
    expect(final.terminalReceipts).toHaveLength(2);
    for (const terminal of final.terminalReceipts) {
      expect(sha256(terminal.receiptJson)).toBe(terminal.receiptDigest);
      const canonical = JSON.parse(terminal.receiptJson);
      expect(canonical).toMatchObject({ outcome: "integrated", review: { digest: expect.stringMatching(/^[0-9a-f]{64}$/) } });
      expect(canonical.providerEffects[0]).toMatchObject({ kind: "update_ref", observation: "applied" });
      expect(terminal.receiptDigest).not.toBe(canonical.review.digest);
      expect(terminal.receiptJson).not.toContain("lease-one");
      expect(terminal.receiptJson).not.toContain("lease-two-retry");
    }

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

  it("keeps eight reviewed receipts cold while dispatching exactly one FIFO controller", async () => {
    const t = convexTest(schema, modules);
    const created = await t.mutation(api.goalMode.create, {
      goal: "Integrate eight independent durable repository workstreams safely",
      route: "existing_project", routeReason: "owned product", primaryRepo: REPO,
      infrastructureContext: "Preserve repository isolation.", maxBuildSessions: 8, workerToken: TOKEN,
    });
    await t.run(async (ctx) => ctx.db.patch(created.missionId, { advanceAttempt: 1 }));
    const plan = {
      summary: "Eight independent workstreams", route: "existing_project", primaryRepo: REPO, assumptions: [],
      workstreams: Array.from({ length: 8 }, (_, index) => ({
        id: `stream-${index}`, label: `Stream ${index}`, task: `Implement independent boundary ${index}.`,
        agentId: "paul", repo: REPO, readonly: false, dependsOn: [], acceptanceCriteria: [`boundary ${index}`], mcp: [],
      })),
      validation: { criteria: ["all integrated"], tests: ["npm test"], liveChecks: [] },
    };
    expect(await t.mutation(api.goalMode.recordPlan, {
      id: created.missionId, expectedAdvanceAttempt: 1, plan, workerToken: TOKEN,
    })).toMatchObject({ advanced: true, jobs: 8 });
    const jobs = await t.run(async (ctx) => (await ctx.db.query("jobs")
      .withIndex("by_mission", (q) => q.eq("missionId", String(created.missionId))).collect())
      .filter((job) => job.goalStage === "building"));
    const specialists = await dispatch(t, 8, "fifo-eight-specialist");
    expect(specialists).toHaveLength(8);
    const byId = new Map(jobs.map((job) => [String(job._id), job]));
    for (let index = 0; index < specialists.length; index += 1) {
      const entry = specialists[index];
      await review(t, byId.get(String(entry.reservation.jobId))!, String(entry.claim!.workerRunId),
        "12345678"[index].repeat(40), "9abcdef0"[index].repeat(40));
    }
    const controllers = await dispatch(t, 8, "fifo-eight-controller");
    expect(controllers).toHaveLength(1);
    const state = await t.run(async (ctx) => ({
      attempts: await ctx.db.query("integrationAttempts").collect(),
      workAttempts: await ctx.db.query("workAttempts").collect(),
      deliveries: await ctx.db.query("deliveryAttempts").collect(),
      jobs: await ctx.db.query("jobs").withIndex("by_mission", (q) => q.eq("missionId", String(created.missionId))).collect(),
    }));
    expect(state.attempts).toHaveLength(8);
    expect(state.attempts.filter((row) => row.status === "queued")).toHaveLength(1);
    expect(state.attempts.filter((row) => row.status === "provider_waiting")).toHaveLength(7);
    expect(state.workAttempts).toHaveLength(8); // controllers never create specialist attempts
    expect(state.deliveries).toHaveLength(8);
    expect(state.deliveries.every((row) => row.generation === 1 && row.cumulativeRetries === 0)).toBe(true);
    expect(state.jobs.filter((row) => row.goalStage === "building" && row.deliveryRunId)).toHaveLength(1);
  });

  it("reconciles an unknown provider observation and rechecks the authoritative head at completion", async () => {
    const f = await plannedGoal();
    const specialists = await dispatch(f.t, 2, "lost-specialist");
    const byId = new Map(f.jobs.map((job) => [String(job._id), job]));
    for (let index = 0; index < specialists.length; index += 1) {
      const entry = specialists[index];
      await review(f.t, byId.get(String(entry.reservation.jobId))!, String(entry.claim!.workerRunId), String(index + 6).repeat(40), String(index + 8).repeat(40));
    }
    const [controller] = await dispatch(f.t, 2, "lost-controller");
    const integration = (await f.t.run(async (ctx) => ctx.db.query("integrationAttempts").collect()))
      .sort((left, right) => left.generation - right.generation)[0];
    const claim = await f.t.mutation(api.goalIntegration.claim, {
      id: integration._id, controllerRunId: String(controller.claim!.deliveryRunId),
      leaseOwner: "lost-owner", leaseToken: "lost-secret-token", workerToken: TOKEN,
    });
    const fence = { id: integration._id, controllerRunId: claim!.controllerRunId, leaseOwner: claim!.leaseOwner,
      leaseToken: claim!.leaseToken, leaseVersion: claim!.leaseVersion, workerToken: TOKEN };
    const effectId = "lost-update-ref";
    const prepareArgs = {
      ...fence, effectId, effectKind: "update_ref" as const, provider: "github" as const,
      providerIdentity: "repo-node:refs/heads/integration", providerMethod: "POST" as const,
      providerTarget: "https://api.github.com/graphql#updateRefs", requestDigest: "9".repeat(64),
      expectedIntegrationRefSha: claim!.expectedIntegrationRefSha,
      preparedIntegrationHeadSha: "a".repeat(40), preparedIntegrationTreeSha: "b".repeat(40),
    };
    expect(await f.t.mutation(api.goalIntegration.prepare, prepareArgs)).toMatchObject({ replay: false });
    expect(await f.t.mutation(api.goalIntegration.observe, {
      ...fence, effectId, observation: "unknown", providerResponse: "network:ambiguous",
    })).toBe(true);
    expect(await f.t.mutation(api.goalIntegration.prepare, prepareArgs)).toMatchObject({ replay: true, observation: "unknown" });
    expect(await f.t.mutation(api.goalIntegration.complete, { ...fence, effectId })).toBe(false);
    expect(await f.t.mutation(api.goalIntegration.observe, {
      ...fence, effectId, observation: "applied", providerHeadSha: "a".repeat(40),
      providerResponse: "reconciled:exact-ref",
    })).toBe(true);
    await f.t.run(async (ctx) => ctx.db.patch(f.missionId, { integrationHeadSha: "f".repeat(40) }));
    expect(await f.t.mutation(api.goalIntegration.complete, { ...fence, effectId })).toBe(false);
    await f.t.run(async (ctx) => ctx.db.patch(f.missionId, { integrationHeadSha: undefined }));
    expect(await f.t.mutation(api.goalIntegration.complete, { ...fence, effectId })).toBe(true);
    const terminal = (await f.t.run(async (ctx) => ctx.db.query("integrationTerminalReceipts").collect()))[0];
    expect(terminal.receiptJson).not.toContain("lost-secret-token");
    expect(JSON.parse(terminal.receiptJson).providerEffects).toEqual([
      expect.objectContaining({ effectId, observation: "applied", providerResponse: "reconciled:exact-ref" }),
    ]);
  });

  it("charges only genuine ambiguous provider retries and emits an exhausted terminal receipt", async () => {
    const f = await plannedGoal();
    const specialists = await dispatch(f.t, 2, "retry-specialist");
    const byId = new Map(f.jobs.map((job) => [String(job._id), job]));
    for (let index = 0; index < specialists.length; index += 1) {
      const entry = specialists[index];
      await review(f.t, byId.get(String(entry.reservation.jobId))!, String(entry.claim!.workerRunId), String(index + 6).repeat(40), String(index + 8).repeat(40));
    }
    const integrations = (await f.t.run(async (ctx) => ctx.db.query("integrationAttempts").collect()))
      .sort((left, right) => left.generation - right.generation);
    let [controller] = await dispatch(f.t, 2, "retry-controller-0");
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    for (let retry = 1; retry <= 7; retry += 1) {
      const claim = await f.t.mutation(api.goalIntegration.claim, {
        id: integrations[0]._id, controllerRunId: String(controller.claim!.deliveryRunId),
        leaseOwner: `retry-owner-${retry}`, leaseToken: `retry-token-${retry}`, workerToken: TOKEN,
      });
      expect(claim).not.toBeNull();
      expect(await f.t.mutation(api.goalIntegration.defer, {
        id: integrations[0]._id, controllerRunId: claim!.controllerRunId,
        leaseOwner: claim!.leaseOwner, leaseToken: claim!.leaseToken, leaseVersion: claim!.leaseVersion,
        reasonCode: "provider_observation_pending", reason: "ambiguous response could not yet be reconciled", workerToken: TOKEN,
      })).toBe(true);
      if (retry < 7) {
        vi.setSystemTime(Date.now() + 31 * 60_000);
        const next = await dispatch(f.t, 2, `retry-controller-${retry}`);
        expect(next).toHaveLength(1);
        expect(String(next[0].reservation.jobId)).toBe(String(integrations[0].jobId));
        controller = next[0];
      }
    }
    const final = await f.t.run(async (ctx) => ({
      integration: await ctx.db.get(integrations[0]._id), job: await ctx.db.get(integrations[0].jobId),
      deliveries: await ctx.db.query("deliveryAttempts").collect(),
      terminals: await ctx.db.query("integrationTerminalReceipts").collect(),
      queuedSecond: await ctx.db.get(integrations[1].jobId),
    }));
    expect(final.integration).toMatchObject({ status: "exhausted", outcome: "exhausted", cumulativeRetries: 7 });
    expect(final.job).toMatchObject({ status: "needs_input", integrationState: "exhausted", deliveryGeneration: 7 });
    expect(final.deliveries.filter((row) => row.jobId === integrations[0].jobId)).toHaveLength(7);
    expect(final.terminals).toHaveLength(1);
    expect(final.terminals[0].outcome).toBe("exhausted");
    expect(JSON.parse(final.terminals[0].receiptJson)).toMatchObject({ terminal: { outcome: "exhausted" } });
    expect(final.queuedSecond).toMatchObject({ status: "pending", integrationState: "queued", deliveryGeneration: 1 });
  });

  it.each([
    ["pause", "claimed"],
    ["cancel", "prepared"],
    ["steer", "response-lost"],
    ["cancel", "observed"],
  ] as const)("fences job-level %s control at %s integration state", async (action, stage) => {
    const f = await plannedGoal();
    const specialists = await dispatch(f.t, 2, `control-${action}-${stage}-specialist`);
    const byId = new Map(f.jobs.map((job) => [String(job._id), job]));
    for (let index = 0; index < specialists.length; index += 1) {
      const entry = specialists[index];
      await review(f.t, byId.get(String(entry.reservation.jobId))!, String(entry.claim!.workerRunId), String(index + 6).repeat(40), String(index + 8).repeat(40));
    }
    const integrations = (await f.t.run(async (ctx) => ctx.db.query("integrationAttempts").collect()))
      .sort((left, right) => left.generation - right.generation);
    const [controller] = await dispatch(f.t, 2, `control-${action}-${stage}-controller`);
    const current = integrations[0];
    const claim = await f.t.mutation(api.goalIntegration.claim, {
      id: current._id, controllerRunId: String(controller.claim!.deliveryRunId),
      leaseOwner: `owner-${action}-${stage}`, leaseToken: `secret-${action}-${stage}`, workerToken: TOKEN,
    });
    const fence = { id: current._id, controllerRunId: claim!.controllerRunId, leaseOwner: claim!.leaseOwner,
      leaseToken: claim!.leaseToken, leaseVersion: claim!.leaseVersion, workerToken: TOKEN };
    const effectId = `effect-${action}-${stage}`;
    if (stage !== "claimed") {
      expect(await f.t.mutation(api.goalIntegration.prepare, {
        ...fence, effectId, effectKind: "update_ref", provider: "github",
        providerIdentity: "repo-node:refs/heads/integration", providerMethod: "POST",
        providerTarget: "https://api.github.com/graphql#updateRefs", requestDigest: "9".repeat(64),
        expectedIntegrationRefSha: claim!.expectedIntegrationRefSha,
        preparedIntegrationHeadSha: "a".repeat(40), preparedIntegrationTreeSha: "b".repeat(40),
      })).toMatchObject({ replay: false });
    }
    if (stage === "response-lost" || stage === "observed") expect(await f.t.mutation(api.goalIntegration.observe, {
      ...fence, effectId, observation: stage === "observed" ? "applied" : "unknown",
      providerHeadSha: stage === "observed" ? "a".repeat(40) : undefined,
      providerResponse: stage === "observed" ? "exact-response" : "network:response-lost",
    })).toBe(true);
    expect(await f.t.mutation(api.jobs.control, {
      jobId: current.jobId, action, input: action === "steer" ? "replace the obsolete signed change" : undefined, workerToken: TOKEN,
    })).toBe(true);
    expect(await f.t.mutation(api.goalIntegration.complete, { ...fence, effectId })).toBe(false);
    const state = await f.t.run(async (ctx) => ({
      attempt: await ctx.db.get(current._id), mission: await ctx.db.get(f.missionId), job: await ctx.db.get(current.jobId),
      delivery: controller.claim!.activeDeliveryAttemptId ? await ctx.db.get(controller.claim!.activeDeliveryAttemptId) : null,
      next: await ctx.db.get(integrations[1].jobId), terminals: await ctx.db.query("integrationTerminalReceipts").collect(),
    }));
    expect((state.attempt as any)?.leaseUntil).toBeUndefined();
    expect((state.mission as any)?.activeIntegrationAttemptId).toBeUndefined();
    if (action === "pause") {
      expect(state.attempt).toMatchObject({ status: "queued" });
      expect(state.job).toMatchObject({ status: "paused" });
      expect(state.terminals).toHaveLength(0);
    } else {
      expect(state.attempt).toMatchObject({ status: action === "steer" ? "stale" : "cancelled" });
      expect(state.delivery).toMatchObject({ status: "blocked", currentStep: "terminal" });
      expect(state.next).toMatchObject({ integrationState: "queued" });
      expect(state.terminals).toHaveLength(1);
      expect(state.terminals[0].receiptJson).not.toContain(`secret-${action}-${stage}`);
    }
  });

  it("keeps a healthy long provider wait leased only while causal heartbeats arrive", async () => {
    const f = await plannedGoal();
    const specialists = await dispatch(f.t, 2, "heartbeat-specialist");
    const byId = new Map(f.jobs.map((job) => [String(job._id), job]));
    for (let index = 0; index < specialists.length; index += 1) {
      const entry = specialists[index];
      await review(f.t, byId.get(String(entry.reservation.jobId))!, String(entry.claim!.workerRunId), String(index + 6).repeat(40), String(index + 8).repeat(40));
    }
    const integration = (await f.t.run(async (ctx) => ctx.db.query("integrationAttempts").collect()))
      .sort((left, right) => left.generation - right.generation)[0];
    const [controller] = await dispatch(f.t, 2, "heartbeat-controller");
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    const claim = await f.t.mutation(api.goalIntegration.claim, {
      id: integration._id, controllerRunId: String(controller.claim!.deliveryRunId),
      leaseOwner: "heartbeat-owner", leaseToken: "heartbeat-secret", workerToken: TOKEN,
    });
    const fence = { id: integration._id, controllerRunId: claim!.controllerRunId, leaseOwner: claim!.leaseOwner,
      leaseToken: claim!.leaseToken, leaseVersion: claim!.leaseVersion, workerToken: TOKEN };
    for (let pulse = 0; pulse < 181; pulse += 1) {
      vi.setSystemTime(Date.now() + 40_000);
      expect(await f.t.mutation(api.goalIntegration.heartbeat, {
        ...fence, state: "provider", deadlineAt: Date.now() + 5 * 60 * 60_000,
      })).toBe(true);
    }
    expect(await f.t.run(async (ctx) => ctx.db.get(integration._id))).toMatchObject({
      controllerState: "provider", controllerHeartbeatAt: Date.now(),
    });
    vi.setSystemTime(Date.now() + 46_000);
    expect(await f.t.mutation(api.goalIntegration.heartbeat, {
      ...fence, state: "provider", deadlineAt: Date.now() + 60_000,
    })).toBe(false);
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
      ...fence, effectId: "prepared", effectKind: "update_ref", provider: "github",
      providerIdentity: "repo-node:refs/heads/integration", providerMethod: "POST",
      providerTarget: "https://api.github.com/graphql#updateRefs", requestDigest: "9".repeat(64),
      expectedIntegrationRefSha: claim!.expectedIntegrationRefSha,
      preparedIntegrationHeadSha: "a".repeat(40), preparedIntegrationTreeSha: "b".repeat(40),
    })).toMatchObject({ replay: false });
    expect(await f.t.mutation(api.goalMode.control, { id: f.missionId, action: "pause", workerToken: TOKEN })).toBe(true);
    expect(await f.t.mutation(api.goalIntegration.observe, {
      ...fence, effectId: "prepared", observation: "applied", providerHeadSha: "a".repeat(40),
    })).toBe(false);
    expect(await f.t.mutation(api.goalMode.control, { id: f.missionId, action: "resume", workerToken: TOKEN })).toBe(true);
    const [resumedController] = await dispatch(f.t, 2, "controller-resumed");
    const resumedClaim = await f.t.mutation(api.goalIntegration.claim, {
      id: integration._id, controllerRunId: String(resumedController.claim!.deliveryRunId),
      leaseOwner: "owner-resumed", leaseToken: "lease-resumed", workerToken: TOKEN,
    });
    const resumedFence = { id: integration._id, controllerRunId: resumedClaim!.controllerRunId,
      leaseOwner: resumedClaim!.leaseOwner, leaseToken: resumedClaim!.leaseToken,
      leaseVersion: resumedClaim!.leaseVersion, workerToken: TOKEN };
    const repair = await f.t.mutation(api.goalIntegration.failFocused, {
      ...resumedFence, kind: "conflict", reason: "same semantic block changed independently",
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
