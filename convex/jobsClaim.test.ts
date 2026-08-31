import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import schema from "./schema";
import { testMissionAdmission } from "./testSourceAdmission";
import { triggerClaimAuthority } from "../src/lib/trigger-machine";

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
const REVIEW_KEY_ID = "current-2026-07";
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

type Policy = "manual" | "read_only" | "auto_merge";

async function specialistFixture(
  policy: Policy = "manual",
  goalStage?: "validating",
  heartbeatProtocolVersion: 2 | null = 2,
) {
  const t = convexTest(schema, modules);
  const admitted = await testMissionAdmission(t, {
    key: `specialist-${policy}-${goalStage ?? "work"}`,
    workerToken: WORKER,
    repository: "daniels-project-space/jarvis",
    sourceHeadSha: BASE,
  });
  const task = policy === "manual"
    ? "Publish verified repository work to the reviewed Git ref"
    : "verified repository work";
  const jobId = await t.mutation(api.jobs.enqueueV2, {
    repo: "daniels-project-space/jarvis", task,
    readonly: policy === "read_only",
    maxAttempts: 3, goalStage, missionId: String(admitted.missionId),
    workerToken: WORKER,
  });
  if (policy === "manual") {
    expect(await t.mutation(api.approvals.decide, {
      jobId: String(jobId), decision: "approved", workerToken: WORKER,
    })).toBe(true);
  }
  const batch = await t.mutation(api.jobs.reserveDispatchBatch, {
    limit: 1, reason: "specialist-fixture", workerToken: WORKER,
  });
  expect(batch.reservations).toHaveLength(1);
  const claim = await t.mutation(api.jobs.claimDispatched, {
    jobId, dispatchId: batch.reservations[0].dispatchId,
    ...triggerClaimAuthority(batch.reservations[0]),
    workerRunId: "specialist-run",
    ...(heartbeatProtocolVersion === 2 ? { heartbeatProtocolVersion } : {}),
    workerToken: WORKER,
  });
  expect(claim).toMatchObject({
    jobId, authorityDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    workOrderRevisionDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    deliveryMode: policy,
    backgroundExecutionProfile: {
      version: 1,
      provider: "codex-subscription",
      authority: { external: false, apps: false, secrets: false, network: false },
    },
  });
  const result = "specialist executed once";
  const note = "supervisor pass";
  const receipt = JSON.stringify({
    version: 2, jobId: String(jobId), attempt: 1,
    workOrderRevisionDigest: claim.workOrderRevisionDigest,
    repository: "daniels-project-space/jarvis",
    branch: String(claim.workerBranch ?? claim.branch ?? ""), baseSha: BASE, baseTreeSha: TREE, headSha: HEAD,
    headTreeSha: TREE, diffSha256: DIFF, agentEvidenceSha256: "f".repeat(64),
  });
  const commitArgs = {
    jobId, expectedAttempt: 1, authorityDigest: claim.authorityDigest,
    specialistRunId: "specialist-run", result, verificationNote: note,
    reviewReceiptJson: receipt, reviewReceiptSignature: SIGNATURE, reviewReceiptKeyId: REVIEW_KEY_ID,
    reviewDiffSha256: DIFF, resultDigest: sha256(result), evidenceDigest: sha256(note), workerToken: WORKER,
  } as const;
  return {
    t, jobId, result, note, receipt, authorityDigest: claim.authorityDigest,
    reservation: batch.reservations[0], commitArgs,
  };
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
    jobId: fixture.jobId, dispatchId: reservation.dispatchId,
    ...triggerClaimAuthority(reservation),
    workerRunId: "controller-run", workerToken: WORKER,
  });
  expect(claim).toMatchObject({ sourceWorkAttempt: 1, deliveryGeneration: 1, deliveryRunId: "controller-run" });
  const lease = await fixture.t.mutation(api.jobs.linearizeDelivery, {
    jobId: fixture.jobId, expectedAttempt: 1, authorityDigest: fixture.authorityDigest,
    sourceWorkAttempt: 1, deliveryGeneration: 1,
    deliveryRunId: "controller-run", deliveryAttemptId: claim!.activeDeliveryAttemptId,
    deliveryLeaseOwner: "controller-owner", deliveryLeaseToken: "controller-lease", workerToken: WORKER,
  });
  expect(lease).not.toBeNull();
  const fence = {
    jobId: fixture.jobId, expectedAttempt: 1, authorityDigest: fixture.authorityDigest,
    sourceWorkAttempt: 1, deliveryGeneration: 1,
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
    dispatches: await ctx.db.query("dispatchReceipts").collect(),
  }));
}

async function unclaimedDispatchFixture(key: string) {
  const t = convexTest(schema, modules);
  const admitted = await testMissionAdmission(t, {
    key,
    workerToken: WORKER,
    repository: "daniels-project-space/jarvis",
    sourceHeadSha: BASE,
  });
  const jobId = await t.mutation(api.jobs.enqueueV2, {
    repo: "daniels-project-space/jarvis",
    task: "Inspect the immutable dispatch lifecycle and report bounded evidence.",
    readonly: true,
    missionId: String(admitted.missionId),
    workerToken: WORKER,
  });
  const batch = await t.mutation(api.jobs.reserveDispatchBatch, {
    limit: 1,
    reason: "initial-supervisor",
    workerToken: WORKER,
  });
  return { t, jobId, reservation: batch.reservations[0] };
}

beforeEach(() => { process.env.JARVIS_WORKER_TOKEN = WORKER; vi.useRealTimers(); });
afterEach(() => { delete process.env.JARVIS_WORKER_TOKEN; vi.useRealTimers(); });

describe("real Convex specialist/controller race matrix", () => {
  it("records the self-hosted controller runtime on the exact claimed job", async () => {
    const f = await unclaimedDispatchFixture("selfhost-runtime-claim");
    expect(await f.t.mutation(api.jobs.claimDispatched, {
      jobId: f.jobId,
      dispatchId: f.reservation.dispatchId,
      ...triggerClaimAuthority(f.reservation),
      workerRunId: "selfhost-agent:daniel-vps:run-1",
      workerRuntime: "selfhost",
      workerToken: WORKER,
    })).toMatchObject({ workerRunId: "selfhost-agent:daniel-vps:run-1" });
    const state = await rows(f.t);
    expect(state.jobs[0]).toMatchObject({
      workerRuntime: "selfhost",
      workerRunId: "selfhost-agent:daniel-vps:run-1",
    });
  });

  it("cancels an unclaimed reservation and fences every delayed worker", async () => {
    const f = await unclaimedDispatchFixture("cancel-unclaimed-dispatch");
    expect(await f.t.mutation(api.jobs.control, {
      jobId: f.jobId,
      action: "cancel",
      workerToken: WORKER,
    })).toBe(true);

    const state = await rows(f.t);
    expect(state.jobs[0]).toMatchObject({
      status: "cancelled",
      stage: "cancelled",
      progress: "cancelled by Daniel",
    });
    expect(state.jobs[0]).not.toHaveProperty("dispatchId");
    expect(state.jobs[0]).not.toHaveProperty("workerRunId");
    expect(state.dispatches).toEqual([
      expect.objectContaining({
        status: "closed",
        closeReason: "job cancelled by owner control",
      }),
    ]);

    expect(await f.t.mutation(api.jobs.claimDispatched, {
      jobId: f.jobId,
      dispatchId: f.reservation.dispatchId,
      ...triggerClaimAuthority(f.reservation),
      workerRunId: "delayed-trigger-run",
      workerToken: WORKER,
    })).toMatchObject({
      jobId: f.jobId,
      held: true,
      executable: false,
      code: "trigger_launch_authority_held",
    });
    expect(await f.t.mutation(api.jobs.control, {
      jobId: f.jobId,
      action: "cancel",
      workerToken: WORKER,
    })).toBe(true);
  });

  it("resumes only a cleared controller-session hold into a fresh attempt", async () => {
    const f = await specialistFixture("read_only");
    expect(await f.t.mutation(api.jobs.requestInput, {
      jobId: f.jobId,
      expectedAttempt: 1,
      authorityDigest: f.authorityDigest,
      workerRunId: "specialist-run",
      question: "Reconnect the controller-managed ChatGPT session.",
      controllerSessionHoldCode: "rotation_uncertain",
      workerToken: WORKER,
    })).toBe(true);
    expect(await f.t.mutation(api.jobs.control, {
      jobId: f.jobId,
      action: "resume",
      workerToken: WORKER,
    })).toBe(false);

    await f.t.mutation(api.controllerSession.confirmRepair, {
      workerToken: WORKER,
      sessionVersion: 1,
      tokenExpiresAt: Date.now() + 4 * 60 * 60_000,
    });
    expect(await f.t.mutation(api.jobs.control, {
      jobId: f.jobId,
      action: "resume",
      workerToken: WORKER,
    })).toBe(true);
    const state = await rows(f.t);
    expect(state.jobs[0]).toMatchObject({
      status: "pending",
      attempt: 2,
      progress: "ChatGPT connection restored — fresh attempt queued",
    });
    expect(state.jobs[0]).not.toHaveProperty("controllerSessionRepairRequired");
    expect(state.attempts.map((attempt) => [attempt.attempt, attempt.status])).toEqual([
      [1, "needs_input"],
      [2, "pending"],
    ]);
  });

  it("closes the exact claimed dispatch when a legacy goal cancellation is replayed", async () => {
    const f = await unclaimedDispatchFixture("cancel-claimed-goal-worker");
    expect(await f.t.mutation(api.jobs.claimDispatched, {
      jobId: f.jobId,
      dispatchId: f.reservation.dispatchId,
      ...triggerClaimAuthority(f.reservation),
      workerRunId: "cancelled-goal-run",
      workerToken: WORKER,
    })).toMatchObject({ workerRunId: "cancelled-goal-run" });
    expect(await f.t.mutation(api.jobs.control, {
      jobId: f.jobId,
      action: "cancel",
      workerToken: WORKER,
    })).toBe(true);
    // The same owner command is idempotent and must not leave a claimed
    // dispatch that can poison a later mission repair.
    expect(await f.t.mutation(api.jobs.control, {
      jobId: f.jobId,
      action: "cancel",
      workerToken: WORKER,
    })).toBe(true);
    const state = await rows(f.t);
    expect(state.jobs[0]).toMatchObject({ status: "cancelled" });
    expect(state.jobs[0]).not.toHaveProperty("dispatchId");
    expect(state.jobs[0]).not.toHaveProperty("workerRunId");
    expect(state.attempts[0]).toMatchObject({ status: "cancelled" });
    expect(state.dispatches).toEqual([expect.objectContaining({ status: "closed" })]);
  });

  it("fences a worker input hold and closes its exact claimed dispatch without retrying", async () => {
    const f = await specialistFixture("read_only");
    expect(await f.t.mutation(api.jobs.requestInput, {
      jobId: f.jobId,
      expectedAttempt: 1,
      authorityDigest: "0".repeat(64),
      workerRunId: "specialist-run",
      question: "A provider configuration decision is required.",
      workerToken: WORKER,
    })).toBe(false);
    expect(await f.t.mutation(api.jobs.requestInput, {
      jobId: f.jobId,
      expectedAttempt: 1,
      authorityDigest: f.authorityDigest,
      workerRunId: "different-run",
      question: "A provider configuration decision is required.",
      workerToken: WORKER,
    })).toBe(false);
    expect(await f.t.mutation(api.jobs.requestInput, {
      jobId: f.jobId,
      expectedAttempt: 1,
      authorityDigest: f.authorityDigest,
      workerRunId: "specialist-run",
      question: "A provider configuration decision is required.",
      checkpoint: "Provider authority is durably blocked.",
      workerToken: WORKER,
    })).toBe(true);

    const state = await f.t.run(async (ctx) => ({
      job: await ctx.db.get(f.jobId),
      attempts: await ctx.db
        .query("workAttempts")
        .withIndex("by_job_attempt", (q) => q.eq("jobId", f.jobId))
        .collect(),
      dispatches: await ctx.db
        .query("dispatchReceipts")
        .withIndex("by_job_generation", (q) => q.eq("jobId", f.jobId))
        .collect(),
    }));
    expect(state.job).toMatchObject({ status: "needs_input", attempt: 1 });
    expect(state.job).not.toHaveProperty("nextRunAt");
    expect(state.attempts).toHaveLength(1);
    expect(state.attempts[0]).toMatchObject({
      attempt: 1,
      status: "needs_input",
    });
    expect(state.dispatches).toHaveLength(1);
    expect(state.dispatches[0]).toMatchObject({ status: "closed" });
    expect((await f.t.mutation(api.jobs.reserveDispatchBatch, {
      limit: 1,
      reason: "input hold must not redispatch",
      workerToken: WORKER,
    })).reservations).toEqual([]);
  });

  it("cancels an input-held worker after confirming its exact closed dispatch", async () => {
    const f = await specialistFixture("read_only");
    expect(await f.t.mutation(api.jobs.requestInput, {
      jobId: f.jobId,
      expectedAttempt: 1,
      authorityDigest: f.authorityDigest,
      workerRunId: "specialist-run",
      question: "Production evidence is still required.",
      checkpoint: "The worker has already stopped and released its provider workspace.",
      workerToken: WORKER,
    })).toBe(true);

    const closedDispatch = (await rows(f.t)).dispatches[0];
    await f.t.run(async (ctx) => ctx.db.patch(closedDispatch._id, {
      payloadDigest: "0".repeat(64),
    }));
    expect(await f.t.mutation(api.jobs.control, {
      jobId: f.jobId,
      action: "cancel",
      workerToken: WORKER,
    })).toBe(false);
    await f.t.run(async (ctx) => ctx.db.patch(closedDispatch._id, {
      payloadDigest: closedDispatch.payloadDigest,
    }));

    expect(await f.t.mutation(api.jobs.control, {
      jobId: f.jobId,
      action: "cancel",
      workerToken: WORKER,
    })).toBe(true);

    const state = await rows(f.t);
    expect(state.jobs[0]).toMatchObject({
      status: "cancelled",
      progress: "cancelled by Daniel",
    });
    expect(state.jobs[0]).not.toHaveProperty("dispatchId");
    expect(state.jobs[0]).not.toHaveProperty("workerRunId");
    expect(state.dispatches).toEqual([
      expect.objectContaining({ status: "closed" }),
    ]);
    expect(state.attempts).toEqual([
      expect.objectContaining({ status: "needs_input" }),
    ]);
    expect(state.attention).toEqual([
      expect.objectContaining({ status: "resolved" }),
    ]);
    expect(await f.t.mutation(api.jobs.control, {
      jobId: f.jobId,
      action: "cancel",
      workerToken: WORKER,
    })).toBe(true);
    expect((await rows(f.t)).attention).toEqual([
      expect.objectContaining({ status: "resolved" }),
    ]);
  });

  it("retries an accepted-response-lost launch byte-equivalently and accepts one delayed run", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-23T01:00:00Z"));
    const f = await unclaimedDispatchFixture("dispatch-response-lost");
    expect(await f.t.mutation(api.jobs.markDispatchLaunchUnknown, {
      jobId: f.jobId,
      dispatchId: f.reservation.dispatchId,
      dispatchGeneration: f.reservation.dispatchGeneration,
      dispatchPhase: f.reservation.dispatchPhase,
      dispatchReceiptDigest: f.reservation.dispatchReceiptDigest,
      dispatchPayloadDigest: f.reservation.dispatchPayloadDigest,
      reason: "Trigger accepted the request but its response was lost",
      workerToken: WORKER,
    })).toBe(true);
    vi.advanceTimersByTime(31_000);
    const retry = await f.t.mutation(api.jobs.reserveDispatchBatch, {
      limit: 1,
      reason: "different-supervisor-reason-must-not-change-payload",
      workerToken: WORKER,
    });
    expect(retry.reservations).toEqual([f.reservation]);
    const claim = await f.t.mutation(api.jobs.claimDispatched, {
      jobId: f.jobId,
      dispatchId: retry.reservations[0].dispatchId,
      ...triggerClaimAuthority(retry.reservations[0]),
      workerRunId: "delayed-accepted-run",
      workerToken: WORKER,
    });
    expect(claim).toMatchObject({
      workerRunId: "delayed-accepted-run",
      dispatchGeneration: 1,
      dispatchPhase: "specialist",
      dispatchReceiptDigest: f.reservation.dispatchReceiptDigest,
    });
    expect(await f.t.mutation(api.jobs.claimDispatched, {
      jobId: f.jobId,
      dispatchId: retry.reservations[0].dispatchId,
      ...triggerClaimAuthority(retry.reservations[0]),
      workerRunId: "delayed-accepted-run",
      workerToken: WORKER,
    })).toEqual(claim);
    expect((await rows(f.t)).dispatches).toHaveLength(1);
  });

  it("keeps an expired launch claimable and concurrent supervisors cannot allocate a competitor", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-23T02:00:00Z"));
    const f = await unclaimedDispatchFixture("dispatch-past-lease");
    vi.advanceTimersByTime(10 * 60_000);
    const claim = await f.t.mutation(api.jobs.claimDispatched, {
      jobId: f.jobId,
      dispatchId: f.reservation.dispatchId,
      ...triggerClaimAuthority(f.reservation),
      workerRunId: "late-trigger-run",
      workerToken: WORKER,
    });
    expect(claim).toMatchObject({ workerRunId: "late-trigger-run", dispatchGeneration: 1 });
    const batches = await Promise.all([
      f.t.mutation(api.jobs.reserveDispatchBatch, { limit: 1, reason: "supervisor-a", workerToken: WORKER }),
      f.t.mutation(api.jobs.reserveDispatchBatch, { limit: 1, reason: "supervisor-b", workerToken: WORKER }),
    ]);
    expect(batches.flatMap((batch) => batch.reservations)).toHaveLength(0);
    expect((await rows(f.t)).dispatches).toHaveLength(1);
  });

  it("reissues expired reserved and reconciling ticks byte-identically before one raced continuation generation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-23T02:30:00Z"));
    const f = await unclaimedDispatchFixture("dispatch-expiry-and-failure-race");

    vi.advanceTimersByTime(3 * 60_000);
    const reservedRetries = await Promise.all([
      f.t.mutation(api.jobs.reserveDispatchBatch, { limit: 1, reason: "reserved-retry-a", workerToken: WORKER }),
      f.t.mutation(api.jobs.reserveDispatchBatch, { limit: 1, reason: "reserved-retry-b", workerToken: WORKER }),
    ]);
    expect(reservedRetries.flatMap((batch) => batch.reservations)).toEqual([f.reservation]);
    expect(await f.t.mutation(api.jobs.markDispatchLaunchUnknown, {
      jobId: f.jobId,
      dispatchId: f.reservation.dispatchId,
      dispatchGeneration: f.reservation.dispatchGeneration,
      dispatchPhase: f.reservation.dispatchPhase,
      dispatchReceiptDigest: f.reservation.dispatchReceiptDigest,
      dispatchPayloadDigest: f.reservation.dispatchPayloadDigest,
      reason: "accepted response was lost after the reserved retry",
      workerToken: WORKER,
    })).toBe(true);

    vi.advanceTimersByTime(31_000);
    const reconcilingRetries = await Promise.all([
      f.t.mutation(api.jobs.reserveDispatchBatch, { limit: 1, reason: "reconcile-a", workerToken: WORKER }),
      f.t.mutation(api.jobs.reserveDispatchBatch, { limit: 1, reason: "reconcile-b", workerToken: WORKER }),
    ]);
    expect(reconcilingRetries.flatMap((batch) => batch.reservations)).toEqual([f.reservation]);
    const claim = await f.t.mutation(api.jobs.claimDispatched, {
      jobId: f.jobId,
      dispatchId: f.reservation.dispatchId,
      ...triggerClaimAuthority(f.reservation),
      workerRunId: "expiry-race-run",
      workerToken: WORKER,
    });
    expect(await f.t.mutation(api.jobs.updateProgress, {
      jobId: f.jobId,
      expectedAttempt: 1,
      progress: "Prior attempt reached its final validation step",
      stage: "validating",
      percent: 99,
      workerToken: WORKER,
    })).toBe(true);
    const failures = await Promise.all([
      f.t.mutation(api.jobs.checkpointAndRequeue, {
        jobId: f.jobId, expectedAttempt: 1, authorityDigest: claim.authorityDigest,
        workerRunId: "expiry-race-run", checkpoint: "failure report a", result: "retry", workerToken: WORKER,
      }),
      f.t.mutation(api.jobs.checkpointAndRequeue, {
        jobId: f.jobId, expectedAttempt: 1, authorityDigest: claim.authorityDigest,
        workerRunId: "expiry-race-run", checkpoint: "failure report b", result: "retry", workerToken: WORKER,
      }),
    ]);
    expect(failures.filter((failure) => failure.requeued)).toHaveLength(1);
    expect(failures.filter((failure) => failure.stale)).toHaveLength(1);
    expect(await f.t.run(async (ctx) => ctx.db
      .query("jobRuntime")
      .withIndex("by_job", (q) => q.eq("jobId", f.jobId))
      .unique())).toMatchObject({ attempt: 2, status: "pending", percent: 0 });

    const continuation = (await f.t.mutation(api.jobs.reserveDispatchBatch, {
      limit: 1, reason: "next-closed-generation", workerToken: WORKER,
    })).reservations[0];
    expect(continuation).toMatchObject({
      expectedAttempt: 2,
      dispatchGeneration: 2,
      dispatchPhase: "specialist",
    });
    expect(await f.t.run(async (ctx) => ctx.db
      .query("jobRuntime")
      .withIndex("by_job", (q) => q.eq("jobId", f.jobId))
      .unique())).toMatchObject({ attempt: 2, status: "dispatching", percent: 1 });
    expect(await f.t.mutation(api.jobs.claimDispatched, {
      jobId: f.jobId,
      dispatchId: continuation.dispatchId,
      ...triggerClaimAuthority(continuation),
      workerRunId: "fresh-attempt-run",
      workerToken: WORKER,
    })).toMatchObject({ attempt: 2, workerRunId: "fresh-attempt-run" });
    expect(await f.t.run(async (ctx) => ctx.db
      .query("jobRuntime")
      .withIndex("by_job", (q) => q.eq("jobId", f.jobId))
      .unique())).toMatchObject({ attempt: 2, status: "running", percent: 2 });
    expect((await rows(f.t)).dispatches.map((receipt) => [receipt.generation, receipt.status])).toEqual([
      [1, "closed"],
      [2, "claimed"],
    ]);
  });

  it("supersedes an unclaimed tick only after durable pause/resume control", async () => {
    const f = await unclaimedDispatchFixture("dispatch-control-supersede");
    expect(await f.t.mutation(api.jobs.control, {
      jobId: f.jobId,
      action: "pause",
      workerToken: WORKER,
    })).toBe(true);
    expect(await f.t.mutation(api.jobs.control, {
      jobId: f.jobId,
      action: "resume",
      workerToken: WORKER,
    })).toBe(true);
    const next = (await f.t.mutation(api.jobs.reserveDispatchBatch, {
      limit: 1,
      reason: "post-control",
      workerToken: WORKER,
    })).reservations[0];
    expect(next).toMatchObject({ dispatchGeneration: 2, dispatchPhase: "specialist" });
    const dispatches = (await rows(f.t)).dispatches;
    expect(dispatches.map((receipt) => [receipt.generation, receipt.status])).toEqual([
      [1, "superseded"],
      [2, "reserved"],
    ]);
  });

  it("rejects forged generations, phases, payloads, receipts, and machines before execution", async () => {
    const f = await unclaimedDispatchFixture("dispatch-forgery");
    const forgeries = [
      { dispatchGeneration: f.reservation.dispatchGeneration + 1 },
      { dispatchPhase: "delivery" },
      { dispatchPayloadDigest: "0".repeat(64) },
      { dispatchReceiptDigest: "1".repeat(64) },
      { triggerMachinePreset: f.reservation.triggerMachinePreset === "medium-2x" ? "medium-1x" : "medium-2x" },
    ];
    for (const [index, forged] of forgeries.entries()) {
      expect(await f.t.mutation(api.jobs.claimDispatched, {
        jobId: f.jobId,
        dispatchId: f.reservation.dispatchId,
        ...triggerClaimAuthority(f.reservation),
        ...forged,
        workerRunId: `forged-run-${index}`,
        workerToken: WORKER,
      })).toMatchObject({
        executable: false,
        held: true,
        code: "trigger_launch_authority_held",
      });
    }
    expect((await rows(f.t)).jobs[0].status).toBe("dispatching");
  });

  it("allocates distinct immutable ticks for specialist, delivery, and integration FIFO work", async () => {
    const specialist = await specialistFixture();
    expect(specialist.reservation).toMatchObject({ dispatchGeneration: 1, dispatchPhase: "specialist" });
    expect(await specialist.t.mutation(api.jobs.markVerifiedForDelivery, specialist.commitArgs)).toBe(true);
    const delivery = (await specialist.t.mutation(api.jobs.reserveDispatchBatch, {
      limit: 1, reason: "delivery-one", workerToken: WORKER,
    })).reservations[0];
    expect(delivery).toMatchObject({ dispatchGeneration: 2, dispatchPhase: "delivery" });
    expect(delivery.dispatchReceiptDigest).not.toBe(specialist.reservation.dispatchReceiptDigest);

    const integration = await specialistFixture("auto_merge", "validating");
    expect(await integration.t.mutation(api.jobs.markVerifiedForDelivery, integration.commitArgs)).toBe(true);
    const fifo = (await integration.t.mutation(api.jobs.reserveDispatchBatch, {
      limit: 1, reason: "integration-fifo", workerToken: WORKER,
    })).reservations[0];
    expect(fifo).toMatchObject({ dispatchGeneration: 2, dispatchPhase: "integration" });
    expect(fifo.dispatchReceiptDigest).not.toBe(integration.reservation.dispatchReceiptDigest);
  });

  it("closes one delivery tick before allocating a distinct multi-pass continuation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-23T03:00:00Z"));
    const f = await committedAndClaimed();
    expect(f.reservation).toMatchObject({ dispatchGeneration: 2, dispatchPhase: "delivery" });
    expect(await f.t.mutation(api.jobs.checkpointAndRequeue, {
      ...f.fence,
      checkpoint: "provider truth remains unknown; reconcile the same prepared effect",
      result: f.result,
      delayMs: 1,
    })).toMatchObject({ requeued: true, stale: false });
    vi.advanceTimersByTime(31_000);
    const continuation = (await f.t.mutation(api.jobs.reserveDispatchBatch, {
      limit: 1,
      reason: "delivery-continuation",
      workerToken: WORKER,
    })).reservations[0];
    expect(continuation).toMatchObject({ dispatchGeneration: 3, dispatchPhase: "delivery" });
    expect(continuation.dispatchReceiptDigest).not.toBe(f.reservation.dispatchReceiptDigest);
    const dispatches = (await rows(f.t)).dispatches;
    expect(dispatches.map((receipt) => [receipt.generation, receipt.status])).toEqual([
      [1, "closed"],
      [2, "closed"],
      [3, "reserved"],
    ]);
  });

  it("fences a steered specialist and allocates a fresh workspace attempt without accepting its late review", async () => {
    const f = await specialistFixture();
    expect(await f.t.mutation(api.jobs.control, {
      jobId: f.jobId, action: "steer", input: "Keep the durable schema but change only the attribution boundary.", workerToken: WORKER,
    })).toBe(true);
    expect(await f.t.mutation(api.jobs.markVerifiedForDelivery, f.commitArgs)).toBe(false);
    const state = await rows(f.t);
    expect(state.jobs[0]).toMatchObject({ status: "awaiting_approval", attempt: 2, steerRevision: 1 });
    expect(state.attempts).toHaveLength(2);
    expect(state.attempts.map((attempt) => attempt.status)).toEqual(["steered", "awaiting_approval"]);
    expect(state.attempts[1].authorityDigest).not.toBe(state.attempts[0].authorityDigest);
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

  it("rejects a stale Trigger heartbeat without extending the claimed specialist lease", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-21T12:00:00Z"));
    const f = await specialistFixture();
    const before = await f.t.run(async (ctx) => {
      const runtime = await ctx.db.query("jobRuntime").withIndex("by_job", (q) => q.eq("jobId", f.jobId)).first();
      return runtime?.heartbeatAt;
    });

    vi.advanceTimersByTime(1_000);
    expect(await f.t.mutation(api.jobs.touchHeartbeat, {
      jobId: f.jobId,
      expectedAttempt: 1,
      workerToken: WORKER,
    })).toBe(false);
    expect(await f.t.mutation(api.jobs.touchHeartbeat, {
      jobId: f.jobId,
      expectedAttempt: 1,
      workerRunId: "stale-trigger-run",
      workerToken: WORKER,
    })).toBe(false);
    expect(await f.t.run(async (ctx) => {
      const runtime = await ctx.db.query("jobRuntime").withIndex("by_job", (q) => q.eq("jobId", f.jobId)).first();
      return runtime?.heartbeatAt;
    })).toBe(before);

    expect(await f.t.mutation(api.jobs.touchHeartbeat, {
      jobId: f.jobId,
      expectedAttempt: 1,
      workerRunId: "specialist-run",
      workerToken: WORKER,
    })).toBe(true);
    expect(await f.t.run(async (ctx) => {
      const runtime = await ctx.db.query("jobRuntime").withIndex("by_job", (q) => q.eq("jobId", f.jobId)).first();
      return runtime?.heartbeatAt;
    })).toBe(Date.now());
  });

  it("keeps an exact specialist alive during a server-bounded provider effect and reaps it after release", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T18:00:00Z"));
    const f = await specialistFixture();

    expect(await f.t.mutation(api.jobs.beginProviderEffectLease, {
      jobId: f.jobId,
      expectedAttempt: 1,
      workerRunId: "wrong-trigger-run",
      workerToken: WORKER,
    })).toBeNull();
    expect(await f.t.mutation(api.jobs.beginProviderEffectLease, {
      jobId: f.jobId,
      expectedAttempt: 2,
      workerRunId: "specialist-run",
      workerToken: WORKER,
    })).toBeNull();

    const lease = await f.t.mutation(api.jobs.beginProviderEffectLease, {
      jobId: f.jobId,
      expectedAttempt: 1,
      workerRunId: "specialist-run",
      workerToken: WORKER,
    });
    expect(lease).toEqual({ leaseUntil: Date.now() + 28 * 60_000 });
    expect(await f.t.run(async (ctx) => {
      const job = await ctx.db.query("jobs")
        .filter((q) => q.eq(q.field("_id"), f.jobId))
        .first();
      const runtime = await ctx.db.query("jobRuntime")
        .withIndex("by_job", (q) => q.eq("jobId", f.jobId))
        .first();
      return [job?.providerEffectLeaseUntil, runtime?.providerEffectLeaseUntil];
    })).toEqual([lease!.leaseUntil, lease!.leaseUntil]);

    vi.advanceTimersByTime(6 * 60_000);
    expect(await f.t.mutation(api.jobs.reapStale, { workerToken: WORKER }))
      .toMatchObject({ requeued: [] });
    expect((await rows(f.t)).jobs[0]).toMatchObject({ status: "running", attempt: 1 });

    expect(await f.t.mutation(api.jobs.endProviderEffectLease, {
      jobId: f.jobId,
      expectedAttempt: 1,
      workerRunId: "wrong-trigger-run",
      workerToken: WORKER,
    })).toBe(false);
    expect(await f.t.mutation(api.jobs.endProviderEffectLease, {
      jobId: f.jobId,
      expectedAttempt: 1,
      workerRunId: "specialist-run",
      workerToken: WORKER,
    })).toBe(true);

    vi.advanceTimersByTime(6 * 60_000);
    expect(await f.t.mutation(api.jobs.reapStale, { workerToken: WORKER }))
      .toMatchObject({ requeued: [expect.any(String)] });
    expect((await rows(f.t)).jobs[0]).toMatchObject({ status: "pending", attempt: 2 });
  });

  it("keeps legacy no-ID heartbeats compatible without weakening a V2 claim", async () => {
    const t = convexTest(schema, modules);
    const admitted = await testMissionAdmission(t, {
      key: "legacy-heartbeat-compat", workerToken: WORKER,
      repository: "daniels-project-space/jarvis", sourceHeadSha: BASE,
    });
    const jobId = await t.mutation(api.jobs.enqueueV2, {
      repo: "daniels-project-space/jarvis", task: "Publish verified repository work to the reviewed Git ref",
      readonly: false, maxAttempts: 1, goalStage: "validating", missionId: String(admitted.missionId), workerToken: WORKER,
    });
    expect(await t.mutation(api.approvals.decide, {
      jobId: String(jobId), decision: "approved", workerToken: WORKER,
    })).toBe(true);
    const [{ reservations }] = await Promise.all([
      t.mutation(api.jobs.reserveDispatchBatch, { limit: 1, reason: "legacy-heartbeat", workerToken: WORKER }),
    ]);
    const reservation = reservations[0]!;
    const claim = await t.mutation(api.jobs.claimDispatched, {
      jobId, dispatchId: reservation.dispatchId, ...triggerClaimAuthority(reservation),
      workerRunId: "legacy-trigger-run", workerToken: WORKER,
    });
    expect(claim).toMatchObject({ jobId });
    expect((await rows(t)).jobs[0]).not.toHaveProperty("heartbeatProtocolVersion");
    expect(await t.mutation(api.jobs.touchHeartbeat, {
      jobId, expectedAttempt: 1, workerToken: WORKER,
    })).toBe(true);
    // Passing an ID on a legacy claim opts into the same exact fence rather
    // than allowing an arbitrary caller to extend that lease.
    expect(await t.mutation(api.jobs.touchHeartbeat, {
      jobId, expectedAttempt: 1, workerRunId: "different-trigger-run", workerToken: WORKER,
    })).toBe(false);
    expect(await t.mutation(api.jobs.touchHeartbeat, {
      jobId, expectedAttempt: 1, workerRunId: "legacy-trigger-run", workerToken: WORKER,
    })).toBe(true);
  });

  it("persists the V2 heartbeat protocol and does not downgrade it on a replay", async () => {
    const f = await specialistFixture();
    const replay = await f.t.mutation(api.jobs.claimDispatched, {
      jobId: f.jobId, dispatchId: f.reservation.dispatchId,
      ...triggerClaimAuthority(f.reservation), workerRunId: "specialist-run", workerToken: WORKER,
    });
    expect(replay).toMatchObject({ jobId: f.jobId });
    const state = await rows(f.t);
    expect(state.jobs[0]).toMatchObject({ heartbeatProtocolVersion: 2 });
    expect(state.attempts[0]).toMatchObject({ heartbeatProtocolVersion: 2 });
    expect(await f.t.mutation(api.jobs.touchHeartbeat, {
      jobId: f.jobId, expectedAttempt: 1, workerToken: WORKER,
    })).toBe(false);
  });

  it("clears the heartbeat protocol for a later legacy retry claim", async () => {
    const f = await specialistFixture();
    expect(await f.t.mutation(api.jobs.checkpointAndRequeue, {
      jobId: f.jobId, expectedAttempt: 1, authorityDigest: f.authorityDigest,
      workerRunId: "specialist-run", checkpoint: "retry with the same sealed scope", result: "retry", delayMs: 0,
      workerToken: WORKER,
    })).toMatchObject({ requeued: true, stale: false });
    const [{ reservations }] = await Promise.all([
      f.t.mutation(api.jobs.reserveDispatchBatch, { limit: 1, reason: "legacy-retry-claim", workerToken: WORKER }),
    ]);
    const reservation = reservations[0]!;
    expect(await f.t.mutation(api.jobs.claimDispatched, {
      jobId: f.jobId, dispatchId: reservation.dispatchId, ...triggerClaimAuthority(reservation),
      workerRunId: "legacy-retry-run", workerToken: WORKER,
    })).toMatchObject({ jobId: f.jobId, attempt: 2 });
    const state = await rows(f.t);
    expect(state.jobs[0]).not.toHaveProperty("heartbeatProtocolVersion");
    expect(state.attempts.find((attempt) => attempt.attempt === 2)).not.toHaveProperty("heartbeatProtocolVersion");
    expect(await f.t.mutation(api.jobs.touchHeartbeat, {
      jobId: f.jobId, expectedAttempt: 2, workerToken: WORKER,
    })).toBe(true);
  });

  it("drains an in-flight versionless claim, then reaps and relaunches it only through V2", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T20:00:00Z"));
    const f = await specialistFixture("manual", undefined, null);
    expect((await rows(f.t)).jobs[0]).not.toHaveProperty("heartbeatProtocolVersion");

    expect(await f.t.mutation(api.jobs.activateHeartbeatProtocolV2, {
      triggerDeploymentVersion: "20260827.7", workerToken: WORKER,
    })).toMatchObject({ activated: true, protocolVersion: 2 });
    // The already-claimed old worker can finish or checkpoint during its
    // normal Trigger lifetime; it is not cut off at deployment time.
    expect(await f.t.mutation(api.jobs.touchHeartbeat, {
      jobId: f.jobId, expectedAttempt: 1, workerToken: WORKER,
    })).toBe(true);

    // A versionless worker cannot hold the lease beyond the old worker's
    // maximum duration plus one normal stale sweep. The reaper owns recovery.
    vi.advanceTimersByTime(35 * 60_000 + 5 * 60_000 + 1);
    expect(await f.t.mutation(api.jobs.touchHeartbeat, {
      jobId: f.jobId, expectedAttempt: 1, workerToken: WORKER,
    })).toBe(false);
    expect(await f.t.mutation(api.jobs.reapStale, { workerToken: WORKER }))
      .toMatchObject({ requeued: [expect.any(String)] });

    vi.advanceTimersByTime(60_000);
    const batch = await f.t.mutation(api.jobs.reserveDispatchBatch, {
      limit: 1, reason: "post-cutover-retry", workerToken: WORKER,
    });
    const reservation = batch.reservations[0]!;
    expect(await f.t.mutation(api.jobs.claimDispatched, {
      jobId: f.jobId, dispatchId: reservation.dispatchId,
      ...triggerClaimAuthority(reservation), workerRunId: "old-retry-worker", workerToken: WORKER,
    })).toMatchObject({ executable: false, held: true, code: "heartbeat_protocol_v2_required" });
    expect(await f.t.mutation(api.jobs.claimDispatched, {
      jobId: f.jobId, dispatchId: reservation.dispatchId,
      ...triggerClaimAuthority(reservation), workerRunId: "v2-retry-worker",
      heartbeatProtocolVersion: 2, workerToken: WORKER,
    })).toMatchObject({ jobId: f.jobId, attempt: 2 });
    const state = await rows(f.t);
    expect(state.jobs[0]).toMatchObject({ attempt: 2, heartbeatProtocolVersion: 2 });
    expect(state.attempts.find((attempt) => attempt.attempt === 2))
      .toMatchObject({ heartbeatProtocolVersion: 2, workerRunId: "v2-retry-worker" });
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
      jobId: f.jobId, dispatchId: f.reservation.dispatchId,
      ...triggerClaimAuthority(f.reservation),
      workerRunId: "controller-run", workerToken: WORKER,
    });
    const competing = await f.t.mutation(api.jobs.claimDispatched, {
      jobId: f.jobId, dispatchId: f.reservation.dispatchId,
      ...triggerClaimAuthority(f.reservation),
      workerRunId: "controller-two", workerToken: WORKER,
    });
    expect(replay).toEqual(f.claim);
    expect(competing).toMatchObject({
      executable: false,
      held: true,
      code: "trigger_launch_authority_held",
    });
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
      resultDigest: sha256(f.result), evidenceDigest: sha256(f.note), reviewReceiptSignature: SIGNATURE,
      reviewReceiptKeyId: REVIEW_KEY_ID, reviewDiffSha256: DIFF,
    })).toBe(false);
    expect(await f.t.mutation(api.jobs.control, { jobId: f.jobId, action: "resume", workerToken: WORKER })).toBe(true);
    const state = await rows(f.t);
    expect(state.deliveries).toHaveLength(2);
    expect(state.deliveries[1]).toMatchObject({ outcome: "read_only_complete", currentStep: "receipt", reviewKeyId: "current-2026-07" });
    expect(state.attempts).toHaveLength(1);
  });

  it("requires the exact immutable signed review key before repository finalization", async () => {
    const f = await committedAndClaimed("read_only");
    expect(await f.t.mutation(api.jobs.setDelivery, {
      ...f.fence, branch: "jarvis/reviewed", deliveryStatus: "branch",
      outcome: "read_only_complete", providerCall: false,
    })).toBe(true);
    const finalArgs = {
      ...f.fence, status: "done" as const, result: f.result,
      verificationVerdict: "pass" as const, verificationNote: f.note,
      resultDigest: sha256(f.result), evidenceDigest: sha256(f.note),
      reviewReceiptSignature: SIGNATURE, reviewDiffSha256: DIFF,
    };
    expect(await f.t.mutation(api.jobs.finalize, finalArgs)).toBe(false);
    expect(await f.t.mutation(api.jobs.finalize, {
      ...finalArgs, reviewReceiptKeyId: "stale-review-key",
    })).toBe(false);
    expect((await rows(f.t)).deliveries[0]).toMatchObject({
      currentStep: "receipt", status: "running", reviewKeyId: REVIEW_KEY_ID,
    });
    expect(await f.t.mutation(api.jobs.finalize, {
      ...finalArgs, reviewReceiptKeyId: REVIEW_KEY_ID,
    })).toBe(true);
  });

  it.each([
    ["read_only", "read_only_complete"],
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
      reviewReceiptKeyId: REVIEW_KEY_ID, reviewDiffSha256: DIFF,
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

  it.each(["manual", "read_only", "auto_merge"] as const)("records an explicit blocked terminal outcome for %s", async (policy) => {
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
      resultDigest: sha256(f.result), evidenceDigest: sha256(f.note), reviewReceiptSignature: SIGNATURE,
      reviewReceiptKeyId: REVIEW_KEY_ID, reviewDiffSha256: DIFF,
    })).toBe(false);
    await f.t.mutation(api.jobs.setDelivery, {
      ...f.fence, branch: "jarvis/reviewed", deliveryStatus: "branch", outcome: "read_only_complete", providerCall: false,
    });
    expect(await f.t.mutation(api.jobs.finalize, {
      ...f.fence, status: "done", result: f.result, verificationVerdict: "pass", verificationNote: f.note,
      resultDigest: sha256(f.result), evidenceDigest: sha256(f.note), reviewReceiptSignature: SIGNATURE,
      reviewReceiptKeyId: REVIEW_KEY_ID, reviewDiffSha256: DIFF,
    })).toBe(true);
    expect((await rows(f.t)).jobs[0].status).toBe("done");
  });
});
