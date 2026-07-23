import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { testMissionAdmission } from "./testSourceAdmission";

declare global {
  interface ImportMeta { glob(pattern: string): Record<string, () => Promise<unknown>>; }
}

const modules = import.meta.glob("./**/*.ts");
const WORKER = "mixed-protocol-worker";
const REPO = "daniels-project-space/jarvis";
const HEAD = "a".repeat(40);
const TREE = "b".repeat(40);
const DIGEST = "c".repeat(64);
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

beforeEach(() => { process.env.JARVIS_WORKER_TOKEN = WORKER; });
afterEach(() => { delete process.env.JARVIS_WORKER_TOKEN; });

describe("mixed protocol full lifecycle", () => {
  it("keeps realistic v1 rows visible and validator-safe while every v2 execution boundary fails closed", async () => {
    const t = convexTest(schema, modules);
    const missionId = await t.mutation(api.missions.create, {
      goal: "legacy mission retained for operator history", agentCount: 1,
      originThreadId: "mixed-thread", workerToken: WORKER,
    });
    const jobId = await t.mutation(api.jobs.enqueue, {
      task: "legacy repository attempt retained through rolling protocol deployment",
      repo: REPO, missionId: String(missionId), originThreadId: "mixed-thread",
      visibility: "conversation", workerToken: WORKER,
    });
    const legacyReceiptJson = JSON.stringify({ version: 1, jobId: String(jobId), head: HEAD });
    const now = Date.now();
    // Old deployments could already have an attempt-1 row. Reuse it when
    // present so a rolling fixture never creates a duplicate job/attempt
    // identity; this checkout's held compatibility admission needs one seed.
    await t.run(async (ctx) => {
      const existing = await ctx.db.query("workAttempts")
        .withIndex("by_job_attempt", (q) => q.eq("jobId", jobId).eq("attempt", 1)).first();
      if (!existing) {
        await ctx.db.insert("workAttempts", {
          jobId, attempt: 1, status: "pending",
          livenessAt: now, progressAt: now, lastEventAt: now, createdAt: now,
        });
      }
    });
    const rows = await t.run(async (ctx) => {
      await ctx.db.patch(jobId, {
        status: "running", stage: "legacy review", progress: "historical v1 work remains visible",
        percent: 72, attempt: 1, workerRunId: "legacy-worker", dispatchId: "legacy-dispatch",
        dispatchLeaseUntil: now + 60_000, heartbeatAt: now, progressAt: now,
      });
      const runtime = await ctx.db.query("jobRuntime").withIndex("by_job", (q) => q.eq("jobId", jobId)).first();
      if (!runtime) throw new Error("legacy runtime fixture missing");
      await ctx.db.patch(runtime._id, {
        status: "running", stage: "legacy review", progress: "historical v1 work remains visible",
        percent: 72, attempt: 1, workerRunId: "legacy-worker", active: true,
        originThreadId: "mixed-thread", visibility: "conversation", heartbeatAt: now, progressAt: now,
      });
      const attempts = await ctx.db.query("workAttempts")
        .withIndex("by_job_attempt", (q) => q.eq("jobId", jobId).eq("attempt", 1)).collect();
      expect(attempts).toHaveLength(1);
      const attemptId = attempts[0]._id;
      await ctx.db.patch(attemptId, {
        status: "running", workerRunId: "legacy-worker", dispatchId: "legacy-dispatch",
        workspaceKey: "legacy-workspace", sourceHeadSha: HEAD,
        livenessAt: now, progressAt: now, lastEventAt: now, createdAt: now,
      });
      const reviewId = await ctx.db.insert("reviewReceipts", {
        jobId, attempt: 1, repository: REPO, receiptJson: legacyReceiptJson,
        receiptDigest: sha256(legacyReceiptJson), signature: DIGEST, diffSha256: DIGEST,
        baseSha: HEAD, headSha: HEAD, baseTreeSha: TREE, headTreeSha: TREE,
        agentEvidenceSha256: DIGEST, createdAt: now,
      });
      const workReceiptId = await ctx.db.insert("workReceipts", {
        jobId, attempt: 1, status: "succeeded", acceptanceEvidence: ["legacy evidence"],
        artifacts: [HEAD], verification: "pass", terminalEventKey: "legacy-terminal",
        resultDigest: DIGEST, evidenceDigest: DIGEST, reviewReceiptId: reviewId,
        reviewReceiptDigest: sha256(legacyReceiptJson), createdAt: now,
      });
      const integrationId = await ctx.db.insert("integrationAttempts", {
        missionId, jobId, workAttempt: 1, generation: 1, revisionWave: 0,
        workstreamId: "legacy-workstream", repository: REPO, sourceBranch: "main",
        workerBranch: "legacy-worker-branch", integrationBranch: "legacy-integration-branch",
        reviewReceiptId: reviewId, reviewReceiptDigest: sha256(legacyReceiptJson),
        reviewedBaseSha: HEAD, reviewedHeadSha: HEAD, reviewedHeadTreeSha: TREE,
        reviewedDiffSha256: DIGEST, status: "queued", leaseVersion: 0,
        cumulativeRetries: 0, createdAt: now, updatedAt: now,
      });
      const deliveryId = await ctx.db.insert("deliveryAttempts", {
        jobId, integrationAttemptId: integrationId, sourceWorkAttempt: 1, generation: 1,
        policy: "mission_integration", status: "running", deliveryRunId: "legacy-delivery",
        reviewReceiptId: reviewId, reviewReceiptDigest: sha256(legacyReceiptJson),
        reviewedHeadSha: HEAD, reviewedBaseSha: HEAD, reviewedHeadTreeSha: TREE,
        reviewedDiffSha256: DIGEST, heartbeatAt: now, retries: 0,
        currentStep: "prepared", createdAt: now, updatedAt: now,
      });
      await ctx.db.patch(jobId, { reviewReceiptId: reviewId, integrationAttemptId: integrationId, activeDeliveryAttemptId: deliveryId });
      return { attemptId, reviewId, workReceiptId, integrationId, deliveryId };
    });

    const projection = await t.query(api.commandCenter.snapshot, {
      threadId: "mixed-thread", workerToken: WORKER,
    });
    expect(projection.active).toMatchObject({ id: jobId, status: "reviewing", percent: 72 });
    const legacyEventCount = await t.run(async (ctx) => (await ctx.db.query("workEvents")
      .withIndex("by_job", (q) => q.eq("jobId", String(jobId))).collect()).length);
    expect(await t.mutation(api.jobs.recordCloudReplayDecision, {
      jobId, expectedAttempt: 1, workerRunId: "legacy-worker",
      disposition: "hydrate", reason: "no_prior_checkpoint", workerToken: WORKER,
    })).toBe(false);
    expect(await t.run(async (ctx) => (await ctx.db.query("workEvents")
      .withIndex("by_job", (q) => q.eq("jobId", String(jobId))).collect()).length)).toBe(legacyEventCount);
    expect(await t.mutation(api.jobs.claimDispatched, {
      jobId, dispatchId: "legacy-dispatch", workerRunId: "legacy-replay", workerToken: WORKER,
    })).toMatchObject({ executable: false, held: true, code: "protocol_v1_admission_held" });
    // Every API that existed before protocol v2 must accept the old call
    // shape during a Convex-first rollout, then fail closed in its handler.
    // Only the new v2-only authorization boundary requires the digest at the
    // validator.
    const legacyFence = { jobId, expectedAttempt: 1, workerToken: WORKER };
    const fence = { ...legacyFence, authorityDigest: DIGEST };
    expect(await t.mutation(api.jobs.authorizeExecutionBoundary, {
      ...fence, workerRunId: "legacy-worker", phase: "checkpoint",
    })).toBeNull();
    expect(await t.mutation(api.jobs.bindWorkspaceSource, {
      ...legacyFence, workerRunId: "legacy-worker", sourceBranch: "main", sourceHeadSha: HEAD,
    })).toBe(false);
    expect(await t.mutation(api.jobs.checkpointAndRequeue, {
      ...legacyFence, checkpoint: "legacy checkpoint", result: "legacy result",
    })).toMatchObject({ stale: true, requeued: false });
    expect(await t.mutation(api.jobs.markVerifiedForDelivery, {
      ...legacyFence, specialistRunId: "legacy-worker", result: "legacy result", verificationNote: "legacy evidence",
      resultDigest: sha256("legacy result"), evidenceDigest: sha256("legacy evidence"),
    })).toBe(false);
    expect(await t.mutation(api.jobs.linearizeDelivery, {
      ...legacyFence, sourceWorkAttempt: 1, deliveryGeneration: 1, deliveryRunId: "legacy-delivery",
      deliveryAttemptId: rows.deliveryId, deliveryLeaseOwner: "owner", deliveryLeaseToken: "token",
    })).toBeNull();
    expect(await t.mutation(api.jobs.prepareDeliveryEffect, {
      ...legacyFence, sourceWorkAttempt: 1, deliveryGeneration: 1, deliveryRunId: "legacy-delivery",
      deliveryAttemptId: rows.deliveryId, deliveryLeaseOwner: "owner", deliveryLeaseToken: "token",
      deliveryLeaseVersion: 1, effectId: "legacy-effect", effectKind: "create_pr",
      reviewedHeadSha: HEAD, reviewedBaseSha: HEAD,
    })).toBeNull();
    expect(await t.mutation(api.jobs.observeDeliveryEffect, {
      ...legacyFence, sourceWorkAttempt: 1, deliveryGeneration: 1, deliveryRunId: "legacy-delivery",
      deliveryAttemptId: rows.deliveryId, deliveryLeaseOwner: "owner", deliveryLeaseToken: "token",
      deliveryLeaseVersion: 1, effectId: "legacy-effect", observation: "not_applied",
    })).toBe(false);
    expect(await t.mutation(api.jobs.touchDeliveryHeartbeat, {
      ...legacyFence, sourceWorkAttempt: 1, deliveryGeneration: 1, deliveryRunId: "legacy-delivery",
      deliveryAttemptId: rows.deliveryId,
    })).toBe(false);
    expect(await t.mutation(api.jobs.releaseIntegrationQueueWait, {
      ...legacyFence, sourceWorkAttempt: 1, deliveryGeneration: 1, deliveryRunId: "legacy-delivery",
      deliveryAttemptId: rows.deliveryId,
    })).toBe(false);
    expect(await t.mutation(api.jobs.setDelivery, {
      ...legacyFence, sourceWorkAttempt: 1, deliveryGeneration: 1, deliveryRunId: "legacy-delivery",
      deliveryAttemptId: rows.deliveryId, deliveryStatus: "blocked",
    })).toBe(false);
    expect(await t.mutation(api.jobs.bindCloudWorkspace, {
      ...legacyFence, workerRunId: "legacy-worker", providerName: "e2b",
      providerWorkspaceId: "legacy-workspace", providerSessionId: "legacy-session",
      baseSha: HEAD, runtime: "legacy-runtime", lockfileDigest: DIGEST,
      template: "legacy-template", sourceArchiveDigest: DIGEST, sourceArchiveBytes: 1,
    })).toBe(false);
    expect(await t.mutation(api.jobs.noteCloudWorkspaceBlock, {
      ...legacyFence, code: "legacy_block", reason: "legacy worker has no v2 authority",
    })).toBe(false);
    expect(await t.mutation(api.jobs.prepareCloudCodexTurn, {
      ...legacyFence, workerRunId: "legacy-worker",
      providerWorkspaceId: "legacy-workspace", providerSessionId: "legacy-session",
      receiptId: DIGEST, sequence: 1,
    })).toBe(false);
    expect(await t.mutation(api.jobs.recordCloudCodexTurnPhase, {
      ...legacyFence, workerRunId: "legacy-worker", receiptId: DIGEST,
      sequence: 1, phase: "request_written",
    })).toBe(false);
    expect(await t.mutation(api.jobs.recordCloudCheckpoint, {
      ...legacyFence, providerWorkspaceId: "legacy-workspace", providerSessionId: "legacy-session",
      checkpointRef: `sandbox-checkpoints/sha256/${DIGEST}`, checkpointDigest: DIGEST,
      checkpointBytes: 1, checkpointManifestDigest: DIGEST, checkpointManifest: "{}",
    })).toBe(false);
    expect(await t.query(api.jobs.cloudCheckpointForReplay, {
      ...legacyFence, workerRunId: "legacy-worker", providerName: "e2b",
      baseSha: HEAD, runtime: "legacy-runtime", lockfileDigest: DIGEST,
      template: "legacy-template", sourceArchiveDigest: DIGEST, sourceArchiveBytes: 1,
    })).toMatchObject({ disposition: "reject", reason: "authority_mismatch" });
    expect(await t.mutation(api.jobs.finalize, {
      ...legacyFence, status: "done", result: "legacy result", verificationVerdict: "pass",
      verificationNote: "legacy evidence", resultDigest: sha256("legacy result"), evidenceDigest: sha256("legacy evidence"),
    })).toBe(false);

    const integrationFence = {
      id: rows.integrationId, controllerRunId: "legacy-delivery", leaseOwner: "owner",
      leaseToken: "token", workerToken: WORKER,
    };
    expect(await t.mutation(api.goalIntegration.claim, integrationFence)).toBeNull();
    expect(await t.mutation(api.goalIntegration.prepare, {
      ...integrationFence, leaseVersion: 1, effectId: "legacy-effect", effectKind: "update_ref",
      provider: "github", providerIdentity: "legacy-provider", providerMethod: "POST",
      providerTarget: "refs/heads/legacy", requestDigest: DIGEST,
      expectedIntegrationRefSha: HEAD, preparedIntegrationHeadSha: HEAD, preparedIntegrationTreeSha: TREE,
    })).toBeNull();
    expect(await t.mutation(api.goalIntegration.observe, {
      ...integrationFence, leaseVersion: 1, effectId: "legacy-effect", observation: "not_applied",
    })).toBe(false);
    expect(await t.mutation(api.goalIntegration.complete, {
      ...integrationFence, leaseVersion: 1, effectId: "legacy-effect",
    })).toBe(false);
    expect(await t.mutation(api.goalMode.claimAdvance, { workerToken: WORKER })).toBeNull();

    const persisted = await t.run(async (ctx) => ({
      mission: await ctx.db.get(missionId), job: await ctx.db.get(jobId),
      attempt: await ctx.db.get(rows.attemptId), review: await ctx.db.get(rows.reviewId),
      attempts: await ctx.db.query("workAttempts")
        .withIndex("by_job_attempt", (q) => q.eq("jobId", jobId).eq("attempt", 1)).collect(),
      workReceipt: await ctx.db.get(rows.workReceiptId), integration: await ctx.db.get(rows.integrationId),
      delivery: await ctx.db.get(rows.deliveryId), handoffs: await ctx.db.query("goalHandoffs").collect(),
    }));
    expect(persisted.mission).toMatchObject({ admissionProtocolVersion: 1, protocolHoldReason: "protocol_v1_admission_held" });
    expect(persisted.job).toMatchObject({ admissionProtocolVersion: 1, status: "running" });
    expect(persisted.attempt).toBeTruthy();
    expect(persisted.attempts).toHaveLength(1);
    expect(persisted.review).toBeTruthy();
    expect(persisted.workReceipt).toBeTruthy();
    expect(persisted.integration).toMatchObject({ status: "queued" });
    expect(persisted.delivery).toMatchObject({ status: "running" });
    expect(persisted.handoffs).toHaveLength(0);

    const fresh = await testMissionAdmission(t, {
      key: "fresh-v2-after-legacy", workerToken: WORKER, repository: REPO,
    });
    const freshJobId = await t.mutation(api.jobs.enqueueV2, {
      task: "fresh v2 re-admission", repo: REPO, missionId: String(fresh.missionId), workerToken: WORKER,
    }) as Id<"jobs">;
    const freshState = await t.run(async (ctx) => ({
      mission: await ctx.db.get(fresh.missionId),
      job: await ctx.db.get(freshJobId),
    }));
    expect(fresh.missionId).not.toBe(missionId);
    expect(freshJobId).not.toBe(jobId);
    if (!freshState.job) throw new Error("fresh v2 job fixture missing");
    expect(freshState.mission).toMatchObject({ admissionProtocolVersion: 2 });
    expect(freshState.job).toMatchObject({ admissionProtocolVersion: 2, schedulingBound: true, workOrderRevision: 1 });
    expect(freshState.job.schedulingBindingDigest).not.toBe(DIGEST);
    expect(freshState.job.workOrderRevisionDigest).not.toBe(DIGEST);
  });
});
