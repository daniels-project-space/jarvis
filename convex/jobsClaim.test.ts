import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import schema from "./schema";

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>;
  }
}

const modules = import.meta.glob("./**/*.ts");
const WORKER = "convex-test-worker";
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const TREE = "c".repeat(40);
const DIFF = "d".repeat(64);
const SIGNATURE = "e".repeat(64);
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

type Policy = "manual" | "read_only" | "branch_only" | "auto_merge";

async function specialistFixture(policy: Policy = "manual", goalStage?: "validating") {
  const t = convexTest(schema, modules);
  const now = Date.now();
  const jobId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("jobs", {
      repo: "daniels-project-space/jarvis", task: "verified repository work", status: "running",
      deliveryMode: policy, readonly: policy === "read_only", workerRunId: "specialist-run",
      dispatchId: "specialist-dispatch", attempt: 1, maxAttempts: 3, priority: 50,
      stage: goalStage ?? "building", percent: 90, branch: "jarvis/reviewed", goalStage,
      createdAt: now, heartbeatAt: now,
    });
    await ctx.db.insert("workAttempts", {
      jobId: id, attempt: 1, status: "running", workerRunId: "specialist-run",
      dispatchId: "specialist-dispatch", lastEventSeq: 0, livenessAt: now,
      progressAt: now, lastEventAt: now, createdAt: now,
    });
    await ctx.db.insert("jobRuntime", {
      jobId: id, task: "verified repository work", repo: "daniels-project-space/jarvis",
      status: "running", priority: 50, stage: goalStage ?? "building", percent: 90,
      active: true, attempt: 1, maxAttempts: 3, heartbeatAt: now, progressAt: now,
      workerRunId: "specialist-run", readonly: policy === "read_only", deliveryMode: policy,
      goalStage, branch: "jarvis/reviewed", createdAt: now, updatedAt: now,
    });
    return id;
  });
  const result = "specialist executed once";
  const note = "supervisor pass";
  const receipt = JSON.stringify({
    version: 1, jobId: String(jobId), attempt: 1, repository: "daniels-project-space/jarvis",
    branch: "jarvis/reviewed", baseSha: BASE, baseTreeSha: TREE, headSha: HEAD,
    headTreeSha: TREE, diffSha256: DIFF, agentEvidenceSha256: "f".repeat(64),
  });
  const commitArgs = {
    jobId, expectedAttempt: 1, specialistRunId: "specialist-run", result, verificationNote: note,
    reviewReceiptJson: receipt, reviewReceiptSignature: SIGNATURE, reviewReceiptKeyId: "current-2026-07",
    reviewDiffSha256: DIFF, resultDigest: sha256(result), evidenceDigest: sha256(note), workerToken: WORKER,
  } as const;
  return { t, jobId, result, note, receipt, commitArgs };
}

async function committedAndClaimed(policy: Policy = "manual", goalStage?: "validating") {
  const fixture = await specialistFixture(policy, goalStage);
  expect(await fixture.t.mutation(api.jobs.markVerifiedForDelivery, fixture.commitArgs)).toBe(true);
  const [{ reservations: first }, { reservations: second }] = await Promise.all([
    fixture.t.mutation(api.jobs.reserveDispatchBatch, { limit: 1, reason: "dispatcher-a", workerToken: WORKER }),
    fixture.t.mutation(api.jobs.reserveDispatchBatch, { limit: 1, reason: "dispatcher-b", workerToken: WORKER }),
  ]);
  const reservations = [...first, ...second];
  expect(reservations).toHaveLength(1);
  const reservation = reservations[0];
  const claim = await fixture.t.mutation(api.jobs.claimDispatched, {
    jobId: fixture.jobId, dispatchId: reservation.dispatchId, workerRunId: "controller-run", workerToken: WORKER,
  });
  expect(claim).toMatchObject({ sourceWorkAttempt: 1, deliveryGeneration: 1, deliveryRunId: "controller-run" });
  const lease = await fixture.t.mutation(api.jobs.linearizeDelivery, {
    jobId: fixture.jobId, expectedAttempt: 1, sourceWorkAttempt: 1, deliveryGeneration: 1,
    deliveryRunId: "controller-run", deliveryAttemptId: claim!.activeDeliveryAttemptId,
    deliveryLeaseOwner: "controller-owner", deliveryLeaseToken: "controller-lease", workerToken: WORKER,
  });
  expect(lease).not.toBeNull();
  const fence = {
    jobId: fixture.jobId, expectedAttempt: 1, sourceWorkAttempt: 1, deliveryGeneration: 1,
    deliveryRunId: "controller-run", deliveryAttemptId: claim!.activeDeliveryAttemptId,
    deliveryLeaseOwner: "controller-owner", deliveryLeaseToken: "controller-lease",
    deliveryLeaseVersion: lease!.version, workerToken: WORKER,
  } as const;
  return { ...fixture, reservation, claim, lease, fence };
}

async function rows(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => ({
    jobs: await ctx.db.query("jobs").collect(), attempts: await ctx.db.query("workAttempts").collect(),
    deliveries: await ctx.db.query("deliveryAttempts").collect(), reviews: await ctx.db.query("reviewReceipts").collect(),
    receipts: await ctx.db.query("workReceipts").collect(), attention: await ctx.db.query("attentionItems").collect(),
  }));
}

beforeEach(() => { process.env.JARVIS_WORKER_TOKEN = WORKER; vi.useRealTimers(); });
afterEach(() => { delete process.env.JARVIS_WORKER_TOKEN; vi.useRealTimers(); });

describe("real Convex specialist/controller race matrix", () => {
  it("fences a steered specialist and allocates a fresh workspace attempt without accepting its late review", async () => {
    const f = await specialistFixture();
    expect(await f.t.mutation(api.jobs.control, {
      jobId: f.jobId, action: "steer", input: "Keep the durable schema but change only the attribution boundary.", workerToken: WORKER,
    })).toBe(true);
    expect(await f.t.mutation(api.jobs.markVerifiedForDelivery, f.commitArgs)).toBe(false);
    const state = await rows(f.t);
    expect(state.jobs[0]).toMatchObject({ status: "steering", steerRevision: 1 });
    expect(state.attempts).toHaveLength(2);
    expect(state.attempts.map((attempt) => attempt.status)).toEqual(["steered", "queued"]);
  });

  it("does not stall a multi-hour task while its exact Trigger heartbeat remains fresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-21T12:00:00Z"));
    const f = await specialistFixture();
    await f.t.run(async (ctx) => {
      const runtime = await ctx.db.query("jobRuntime").withIndex("by_job", (q) => q.eq("jobId", f.jobId)).first();
      await ctx.db.patch(runtime!._id, { progressAt: Date.now() - 3 * 60 * 60_000, heartbeatAt: Date.now() - 1_000 });
    });
    expect(await f.t.mutation(api.jobs.reapStale, { workerToken: WORKER })).toMatchObject({ stalled: [], requeued: [] });
    expect((await rows(f.t)).jobs[0].status).toBe("running");
  });

  it("commits one specialist receipt, replays response loss, and never creates another specialist execution", async () => {
    const f = await specialistFixture();
    expect(await f.t.mutation(api.jobs.markVerifiedForDelivery, f.commitArgs)).toBe(true);
    expect(await f.t.mutation(api.jobs.markVerifiedForDelivery, f.commitArgs)).toBe(true);
    const state = await rows(f.t);
    expect(state.reviews).toHaveLength(1);
    expect(state.deliveries).toHaveLength(1);
    expect(state.attempts).toHaveLength(1);
    expect(state.attempts[0]).toMatchObject({ workerRunId: "specialist-run", status: "done" });
    expect(state.jobs[0]).toMatchObject({ status: "pending", attempt: 1 });
    expect(state.reviews[0]).toMatchObject({ keyId: "current-2026-07" });
    expect(state.deliveries[0]).toMatchObject({ reviewKeyId: "current-2026-07" });
    expect(state.deliveries[0].reviewLineage).toEqual([expect.objectContaining({ keyId: "current-2026-07" })]);
  });

  it("serializes two dispatchers, gives a distinct controller one claim, and replays only that run", async () => {
    const f = await committedAndClaimed();
    const replay = await f.t.mutation(api.jobs.claimDispatched, {
      jobId: f.jobId, dispatchId: f.reservation.dispatchId, workerRunId: "controller-run", workerToken: WORKER,
    });
    const competing = await f.t.mutation(api.jobs.claimDispatched, {
      jobId: f.jobId, dispatchId: f.reservation.dispatchId, workerRunId: "controller-two", workerToken: WORKER,
    });
    expect(replay).toEqual(f.claim);
    expect(competing).toBeNull();
    const state = await rows(f.t);
    expect(state.attempts).toHaveLength(1);
    expect(state.deliveries).toHaveLength(1);
    expect(state.deliveries[0]).toMatchObject({ deliveryRunId: "controller-run", sourceWorkAttempt: 1, generation: 1 });
  });

  it("fences stale runs and controls arriving between preparation and observation", async () => {
    const f = await committedAndClaimed("auto_merge");
    const stale = { ...f.fence, deliveryRunId: "stale-run" };
    expect(await f.t.mutation(api.jobs.prepareDeliveryEffect, {
      ...stale, effectId: "pr:stale", effectKind: "create_pr", reviewedHeadSha: HEAD, reviewedBaseSha: BASE,
    })).toBeNull();
    expect(await f.t.mutation(api.jobs.prepareDeliveryEffect, {
      ...f.fence, effectId: "pr:exact", effectKind: "create_pr", reviewedHeadSha: HEAD, reviewedBaseSha: BASE,
    })).toMatchObject({ replay: false });
    expect(await f.t.mutation(api.jobs.control, { jobId: f.jobId, action: "pause", workerToken: WORKER })).toBe(true);
    expect(await f.t.mutation(api.jobs.observeDeliveryEffect, {
      ...f.fence, effectId: "pr:exact", observation: "applied", pullRequestNumber: 42,
      pullRequestUrl: "https://github.test/pull/42", observedPullRequestHead: HEAD, observedPullRequestBase: BASE,
    })).toBe(false);
    expect(await f.t.mutation(api.jobs.control, { jobId: f.jobId, action: "resume", workerToken: WORKER })).toBe(true);
    const state = await rows(f.t);
    expect(state.attempts).toHaveLength(1);
    expect(state.deliveries).toHaveLength(2);
    expect(state.deliveries[1]).toMatchObject({ generation: 2, cumulativeRetries: 0, parentDeliveryAttemptId: state.deliveries[0]._id, reviewKeyId: "current-2026-07" });
    expect(state.deliveries[1].effects).toEqual(state.deliveries[0].effects);
    expect(state.jobs[0]).toMatchObject({ status: "pending", attempt: 1, activeDeliveryAttemptId: state.deliveries[1]._id });
  });

  it("keeps a live controller fenced and recovers a dead one into one cumulative retry lineage", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-21T10:00:00Z"));
    const f = await committedAndClaimed();
    expect(await f.t.mutation(api.jobs.touchDeliveryHeartbeat, f.fence)).toBe(true);
    vi.advanceTimersByTime(4 * 60_000);
    expect((await f.t.mutation(api.jobs.reapStale, { workerToken: WORKER })).requeued).toHaveLength(0);
    vi.advanceTimersByTime(2 * 60_000);
    expect((await f.t.mutation(api.jobs.reapStale, { workerToken: WORKER })).requeued).toHaveLength(1);
    const state = await rows(f.t);
    expect(state.attempts).toHaveLength(1);
    expect(state.deliveries).toHaveLength(2);
    expect(state.deliveries[1]).toMatchObject({ generation: 2, cumulativeRetries: 1, parentDeliveryAttemptId: state.deliveries[0]._id, reviewKeyId: "current-2026-07" });
    expect(state.deliveries[1].reviewLineage).toEqual(state.deliveries[0].reviewLineage);
  });

  it("allocates one backoff generation when two failure reports race", async () => {
    const f = await committedAndClaimed();
    const reports = await Promise.all([
      f.t.mutation(api.jobs.checkpointAndRequeue, { ...f.fence, checkpoint: "provider timeout a", result: f.result, delayMs: 1 }),
      f.t.mutation(api.jobs.checkpointAndRequeue, { ...f.fence, checkpoint: "provider timeout b", result: f.result, delayMs: 1 }),
    ]);
    expect(reports.filter((report) => report.requeued)).toHaveLength(1);
    expect(reports.filter((report) => report.stale)).toHaveLength(1);
    const state = await rows(f.t);
    expect(state.deliveries).toHaveLength(2);
    expect(state.deliveries[1]).toMatchObject({ generation: 2, cumulativeRetries: 1, parentDeliveryAttemptId: state.deliveries[0]._id });
    expect(state.jobs[0].nextRunAt).toBeGreaterThanOrEqual(Date.now() + 29_000);
  });

  it("exhausts one cumulative retry budget into one redacted attention item without a specialist rerun", async () => {
    const f = await committedAndClaimed();
    await f.t.run(async (ctx) => {
      const delivery = await ctx.db.get(f.claim!.activeDeliveryAttemptId);
      await ctx.db.patch(delivery!._id, { cumulativeRetries: 6 });
    });
    const checkpoint = "provider failed AUTH_TOKEN=never-store-this-value";
    const result = await f.t.mutation(api.jobs.checkpointAndRequeue, {
      ...f.fence, checkpoint, result: f.result, delayMs: 1,
    });
    expect(result).toMatchObject({ exhausted: true, requeued: false });
    const state = await rows(f.t);
    expect(state.attempts).toHaveLength(1);
    expect(state.deliveries).toHaveLength(1);
    expect(state.deliveries[0]).toMatchObject({ outcome: "needs_attention", cumulativeRetries: 7, currentStep: "terminal" });
    expect(state.attention).toHaveLength(1);
    expect(JSON.stringify(state.attention)).not.toContain("never-store-this-value");
  });
});

describe("real Convex delivery policy outcomes", () => {
  it("rejects invented provider identity and an applied observation with a mismatched base", async () => {
    const f = await committedAndClaimed("manual");
    expect(await f.t.mutation(api.jobs.prepareDeliveryEffect, {
      ...f.fence, effectId: "draft:exact", effectKind: "create_draft_pr", reviewedHeadSha: HEAD, reviewedBaseSha: BASE,
    })).toMatchObject({ replay: false });
    expect(await f.t.mutation(api.jobs.setDelivery, {
      ...f.fence, deliveryStatus: "pull_request", pullRequestUrl: "https://github.test/pull/42",
      pullRequestNumber: 42, pullRequestNodeId: "PR_42", pullRequestDraft: true,
      observedPullRequestHead: HEAD, observedPullRequestBase: BASE, outcome: "protected_draft", providerCall: true,
    })).toBe(false);
    expect(await f.t.mutation(api.jobs.observeDeliveryEffect, {
      ...f.fence, effectId: "draft:exact", observation: "applied", pullRequestNumber: 42,
      pullRequestUrl: "https://github.test/pull/42", pullRequestNodeId: "PR_42", pullRequestDraft: true,
      observedPullRequestHead: HEAD, observedPullRequestBase: "8".repeat(40),
    })).toBe(false);
    expect(await f.t.mutation(api.jobs.observeDeliveryEffect, {
      ...f.fence, effectId: "draft:exact", observation: "applied", pullRequestNumber: 42,
      pullRequestUrl: "https://github.test/pull/42", pullRequestNodeId: "PR_42", pullRequestDraft: true,
      observedPullRequestHead: HEAD, observedPullRequestBase: BASE,
    })).toBe(true);
  });

  it.each(["pause", "cancel"] as const)("fences a controller %s after provider observation", async (action) => {
    const f = await committedAndClaimed("manual");
    await f.t.mutation(api.jobs.prepareDeliveryEffect, {
      ...f.fence, effectId: "draft:control", effectKind: "create_draft_pr", reviewedHeadSha: HEAD, reviewedBaseSha: BASE,
    });
    await f.t.mutation(api.jobs.observeDeliveryEffect, {
      ...f.fence, effectId: "draft:control", observation: "applied", pullRequestNumber: 42,
      pullRequestUrl: "https://github.test/pull/42", pullRequestNodeId: "PR_42", pullRequestDraft: true,
      observedPullRequestHead: HEAD, observedPullRequestBase: BASE,
    });
    expect(await f.t.mutation(api.jobs.control, { jobId: f.jobId, action, workerToken: WORKER })).toBe(true);
    expect(await f.t.mutation(api.jobs.setDelivery, {
      ...f.fence, deliveryStatus: "pull_request", pullRequestUrl: "https://github.test/pull/42",
      pullRequestNumber: 42, pullRequestNodeId: "PR_42", pullRequestDraft: true,
      observedPullRequestHead: HEAD, observedPullRequestBase: BASE, outcome: "protected_draft", providerCall: true,
    })).toBe(false);
    expect((await rows(f.t)).attempts).toHaveLength(1);
  });

  it("fences finalize after a control arrives between outcome and terminal receipt", async () => {
    const f = await committedAndClaimed("read_only");
    expect(await f.t.mutation(api.jobs.setDelivery, {
      ...f.fence, deliveryStatus: "branch", outcome: "read_only_complete", providerCall: false,
    })).toBe(true);
    expect(await f.t.mutation(api.jobs.control, { jobId: f.jobId, action: "pause", workerToken: WORKER })).toBe(true);
    expect(await f.t.mutation(api.jobs.finalize, {
      ...f.fence, status: "done", result: f.result, verificationVerdict: "pass", verificationNote: f.note,
      resultDigest: sha256(f.result), evidenceDigest: sha256(f.note), reviewReceiptSignature: SIGNATURE, reviewDiffSha256: DIFF,
    })).toBe(false);
    expect(await f.t.mutation(api.jobs.control, { jobId: f.jobId, action: "resume", workerToken: WORKER })).toBe(true);
    const state = await rows(f.t);
    expect(state.deliveries).toHaveLength(2);
    expect(state.deliveries[1]).toMatchObject({ outcome: "read_only_complete", currentStep: "receipt", reviewKeyId: "current-2026-07" });
    expect(state.attempts).toHaveLength(1);
  });

  it.each([
    ["read_only", "read_only_complete"],
    ["branch_only", "branch_only_complete"],
    ["manual", "no_change"],
    ["auto_merge", "no_change"],
  ] as const)("finalizes %s as %s without a provider effect", async (policy, outcome) => {
    const f = await committedAndClaimed(policy);
    expect(await f.t.mutation(api.jobs.setDelivery, {
      ...f.fence, branch: "jarvis/reviewed", deliveryStatus: "branch", outcome, providerCall: false,
    })).toBe(true);
    const finalResult = `${f.result}:${outcome}`;
    expect(await f.t.mutation(api.jobs.finalize, {
      ...f.fence, status: "done", result: finalResult, verificationVerdict: "pass", verificationNote: f.note,
      resultDigest: sha256(finalResult), evidenceDigest: sha256(f.note), reviewReceiptSignature: SIGNATURE,
      reviewDiffSha256: DIFF,
    })).toBe(true);
    const state = await rows(f.t);
    expect(state.receipts[0]).toMatchObject({ deliveryOutcome: outcome });
    expect(state.deliveries[0]).toMatchObject({ outcome, currentStep: "terminal", status: "done" });
    expect(state.deliveries[0].effects ?? []).toHaveLength(0);
  });

  it("requires an exact draft identity for manual and gives it no integration capability", async () => {
    const f = await committedAndClaimed("manual");
    expect(await f.t.mutation(api.jobs.prepareDeliveryEffect, {
      ...f.fence, effectId: "draft:42", effectKind: "create_draft_pr", reviewedHeadSha: HEAD, reviewedBaseSha: BASE,
    })).toMatchObject({ replay: false });
    expect(await f.t.mutation(api.jobs.observeDeliveryEffect, {
      ...f.fence, effectId: "draft:42", observation: "applied", pullRequestNumber: 42,
      pullRequestUrl: "https://github.test/pull/42", pullRequestNodeId: "PR_42", pullRequestDraft: true,
      observedPullRequestHead: HEAD, observedPullRequestBase: BASE,
    })).toBe(true);
    expect(await f.t.mutation(api.jobs.prepareDeliveryEffect, {
      ...f.fence, effectId: "merge:42", effectKind: "merge_pr", reviewedHeadSha: HEAD, reviewedBaseSha: BASE, pullRequestNumber: 42,
    })).toBeNull();
    expect(await f.t.mutation(api.jobs.setDelivery, {
      ...f.fence, deliveryStatus: "pull_request", pullRequestUrl: "https://github.test/pull/42",
      pullRequestNumber: 42, pullRequestNodeId: "PR_42", pullRequestDraft: true, observedPullRequestHead: HEAD,
      observedPullRequestBase: BASE, outcome: "protected_draft", providerCall: true,
    })).toBe(true);
  });

  it("makes branch-only completion provider-effect-free and identity preserving", async () => {
    const f = await committedAndClaimed("branch_only");
    expect(f.claim).toMatchObject({
      deliveryMode: "branch_only",
      deliveryPolicy: "branch_only",
      deliveryObservedHeadSha: null,
      deliveryObservedBaseSha: null,
    });
    expect(await f.t.mutation(api.jobs.prepareDeliveryEffect, {
      ...f.fence, effectId: "pr:forbidden", effectKind: "create_pr",
      reviewedHeadSha: HEAD, reviewedBaseSha: BASE,
    })).toBeNull();
    expect(await f.t.mutation(api.jobs.setDelivery, {
      ...f.fence, branch: "jarvis/reviewed", deliveryStatus: "pull_request",
      pullRequestUrl: "https://github.test/pull/42", pullRequestNumber: 42,
      pullRequestNodeId: "PR_42", pullRequestDraft: true,
      outcome: "branch_only_complete", providerCall: true,
    })).toBe(false);
    expect(await f.t.mutation(api.jobs.setDelivery, {
      ...f.fence, branch: "jarvis/reviewed", deliveryStatus: "branch",
      outcome: "branch_only_complete", providerCall: false,
    })).toBe(true);
    const state = await rows(f.t);
    expect(state.deliveries[0]).toMatchObject({
      policy: "branch_only", reviewedHeadSha: HEAD, reviewedBaseSha: BASE,
      outcome: "branch_only_complete", currentStep: "receipt",
    });
    expect(state.deliveries[0].effects ?? []).toHaveLength(0);
  });

  it("allows only automatic policy to record the exact merged outcome", async () => {
    const f = await committedAndClaimed("auto_merge");
    for (const [effectId, effectKind] of [["pr:42", "create_pr"], ["merge:42", "merge_pr"]] as const) {
      if (effectKind === "merge_pr") await f.t.mutation(api.jobs.setDelivery, {
        ...f.fence, deliveryStatus: "pull_request", pullRequestUrl: "https://github.test/pull/42",
        pullRequestNumber: 42, pullRequestNodeId: "PR_42", pullRequestDraft: false,
        observedPullRequestHead: HEAD, observedPullRequestBase: BASE, providerCall: true,
      });
      expect(await f.t.mutation(api.jobs.prepareDeliveryEffect, {
        ...f.fence, effectId, effectKind, reviewedHeadSha: HEAD, reviewedBaseSha: BASE,
        pullRequestNumber: effectKind === "merge_pr" ? 42 : undefined,
      })).not.toBeNull();
      expect(await f.t.mutation(api.jobs.observeDeliveryEffect, {
        ...f.fence, effectId, observation: "applied", pullRequestNumber: 42,
        pullRequestUrl: "https://github.test/pull/42", pullRequestNodeId: "PR_42", pullRequestDraft: false,
        observedPullRequestHead: HEAD, observedPullRequestBase: BASE,
        mergeCommitSha: effectKind === "merge_pr" ? "1".repeat(40) : undefined,
      })).toBe(true);
    }
    expect(await f.t.mutation(api.jobs.setDelivery, {
      ...f.fence, deliveryStatus: "merged", pullRequestUrl: "https://github.test/pull/42", pullRequestNumber: 42,
      pullRequestNodeId: "PR_42", pullRequestDraft: false, mergeCommitSha: "1".repeat(40),
      observedPullRequestHead: HEAD, observedPullRequestBase: BASE, outcome: "merged", providerCall: true,
    })).toBe(true);
  });

  it("records moved refs as one stale-review attention outcome", async () => {
    const f = await committedAndClaimed("auto_merge");
    expect(await f.t.mutation(api.jobs.setDelivery, {
      ...f.fence, deliveryStatus: "blocked", observedPullRequestHead: "9".repeat(40),
      observedPullRequestBase: BASE, outcome: "needs_attention", providerCall: false,
    })).toBe(true);
    expect(await f.t.mutation(api.jobs.finalize, {
      ...f.fence, status: "error", result: "reviewed PR head moved",
    })).toBe(true);
    const state = await rows(f.t);
    expect(state.attention).toHaveLength(1);
    expect(state.deliveries[0]).toMatchObject({ outcome: "needs_attention", status: "blocked", currentStep: "terminal" });
    expect(state.deliveries[0].terminalReceiptDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each(["manual", "read_only", "branch_only", "auto_merge"] as const)("records an explicit blocked terminal outcome for %s", async (policy) => {
    const f = await committedAndClaimed(policy);
    expect(await f.t.mutation(api.jobs.setDelivery, {
      ...f.fence, deliveryStatus: "blocked", outcome: "blocked", providerCall: false,
    })).toBe(true);
    expect(await f.t.mutation(api.jobs.finalize, {
      ...f.fence, status: "error", result: "provider policy gate blocked delivery",
    })).toBe(true);
    expect((await rows(f.t)).deliveries[0]).toMatchObject({ outcome: "blocked", currentStep: "terminal", status: "blocked" });
  });

  it("does not complete a validating goal until its active attempt has a terminal receipt", async () => {
    const f = await committedAndClaimed("read_only", "validating");
    expect((await rows(f.t)).jobs[0].status).toBe("running");
    expect(await f.t.mutation(api.jobs.finalize, {
      ...f.fence, status: "done", result: f.result, verificationVerdict: "pass", verificationNote: f.note,
      resultDigest: sha256(f.result), evidenceDigest: sha256(f.note), reviewReceiptSignature: SIGNATURE, reviewDiffSha256: DIFF,
    })).toBe(false);
    await f.t.mutation(api.jobs.setDelivery, {
      ...f.fence, branch: "jarvis/reviewed", deliveryStatus: "branch", outcome: "read_only_complete", providerCall: false,
    });
    expect(await f.t.mutation(api.jobs.finalize, {
      ...f.fence, status: "done", result: f.result, verificationVerdict: "pass", verificationNote: f.note,
      resultDigest: sha256(f.result), evidenceDigest: sha256(f.note), reviewReceiptSignature: SIGNATURE, reviewDiffSha256: DIFF,
    })).toBe(true);
    expect((await rows(f.t)).jobs[0].status).toBe("done");
  });
});
