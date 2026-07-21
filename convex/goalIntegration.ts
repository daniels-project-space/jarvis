import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireViewer, requireWorker, viewerAuthArgs } from "./controlAuth";
import { insertJobWithRuntime, patchJobWithRuntime, patchMissionWithRuntime } from "./controlPlane";
import { attemptWorkspaceKey, workItemIdentity } from "../src/lib/workspace-protocol";

const LEASE_MS = 45_000;
const SHA = /^[0-9a-f]{40,64}$/i;
const DIGEST = /^[0-9a-f]{64}$/i;
const TERMINAL = new Set(["integrated", "conflict", "stale", "cancelled", "exhausted"]);

function exactFence(mission: any, attempt: any, args: any, job?: any) {
  return mission?.status === "running"
    && (!job || job.status === "running")
    && mission?.activeIntegrationAttemptId === attempt?._id
    && attempt.controllerRunId === args.controllerRunId
    && attempt.leaseOwner === args.leaseOwner
    && attempt.leaseToken === args.leaseToken
    && attempt.leaseVersion === args.leaseVersion
    && Number(attempt.leaseUntil ?? 0) >= Date.now()
    && mission.integrationLeaseVersion === args.leaseVersion
    && mission.integrationLeaseOwner === args.leaseOwner
    && mission.integrationLeaseToken === args.leaseToken
    && Number(mission.integrationLeaseUntil ?? 0) >= Date.now();
}

async function appendEvent(ctx: any, job: any, type: string, message: string, data?: unknown) {
  const ordinal = data && typeof data === "object" && "retries" in data ? String((data as any).retries) : "terminal";
  const eventKey = `integration:${String(job.integrationAttemptId)}:${type}:${ordinal}`;
  const prior = await ctx.db.query("workEvents")
    .withIndex("by_job_event", (q: any) => q.eq("jobId", String(job._id)).eq("eventKey", eventKey)).first();
  if (prior) return;
  const durable: any = await ctx.db.get(job._id) ?? job;
  const sequence = Number(durable.lifecycleSequence ?? 0) + 1;
  await ctx.db.insert("workEvents", {
    jobId: String(job._id), missionId: job.missionId, agentId: "jarvis", type,
    message: message.slice(0, 1_200), stage: "integration", attempt: job.attempt ?? 1,
    causationId: `integration:${String(job.integrationAttemptId)}`, evidenceKind: "integration",
    eventKey, sequence, predecessorKey: durable.lifecycleEventKey, data, createdAt: Date.now(),
  });
  await ctx.db.patch(job._id, { lifecycleSequence: sequence, lifecycleEventKey: eventKey });
}

/** Called inside the specialist review transaction; idempotent by job/attempt. */
export async function queueReviewedIntegration(ctx: any, job: any, review: any, reviewReceiptId: any, reviewReceiptDigest: string) {
  if (!job.missionId || job.readonly || !job.repo || !job.workerBranch || !job.integrationBranch
    || !["building", "refining"].includes(String(job.goalStage))) return null;
  const missionId = ctx.db.normalizeId("missions", job.missionId);
  const mission: any = missionId ? await ctx.db.get(missionId) : null;
  if (!mission || mission.mode !== "goal") return null;
  const existing = await ctx.db.query("integrationAttempts")
    .withIndex("by_job_attempt", (q: any) => q.eq("jobId", job._id).eq("workAttempt", job.attempt ?? 1)).first();
  if (existing) return existing.reviewReceiptDigest === reviewReceiptDigest ? existing : null;
  const generation = Number(mission.integrationGeneration ?? 0) + 1;
  const now = Date.now();
  const id = await ctx.db.insert("integrationAttempts", {
    missionId, jobId: job._id, workAttempt: job.attempt ?? 1, generation,
    revisionWave: Number(job.goalWave ?? 0), workstreamId: String(job.goalWorkstreamId ?? job._id),
    repository: job.repo, sourceBranch: String(job.sourceBranch ?? mission.sourceBranch ?? "main"),
    workerBranch: job.workerBranch, integrationBranch: job.integrationBranch,
    reviewReceiptId, reviewReceiptDigest, reviewedBaseSha: String(review.baseSha),
    reviewedHeadSha: String(review.headSha), reviewedHeadTreeSha: String(review.headTreeSha),
    reviewedDiffSha256: String(review.diffSha256), status: "queued", leaseVersion: 0,
    cumulativeRetries: 0, createdAt: now, updatedAt: now,
  });
  await patchMissionWithRuntime(ctx, mission, { integrationGeneration: generation, updatedAt: now });
  return { _id: id, generation, status: "queued" };
}

const fenceArgs = {
  id: v.id("integrationAttempts"),
  controllerRunId: v.string(), leaseOwner: v.string(), leaseToken: v.string(), leaseVersion: v.number(),
  workerToken: v.optional(v.string()),
};

// Two Trigger deliveries may race, but Convex grants one mission integration
// lease. The losing run performs no provider write and checkpoints normally.
export const claim = mutation({
  args: {
    id: v.id("integrationAttempts"), controllerRunId: v.string(), leaseOwner: v.string(), leaseToken: v.string(),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    const attempt: any = await ctx.db.get(args.id);
    if (!attempt || TERMINAL.has(attempt.status)) return null;
    const mission: any = await ctx.db.get(attempt.missionId);
    const job: any = await ctx.db.get(attempt.jobId);
    const delivery: any = job?.activeDeliveryAttemptId ? await ctx.db.get(job.activeDeliveryAttemptId) : null;
    if (!mission || mission.mode !== "goal" || mission.status !== "running" || !job
      || job.integrationAttemptId !== attempt._id || job.deliveryRunId !== args.controllerRunId
      || delivery?.integrationAttemptId !== attempt._id || delivery?.deliveryRunId !== args.controllerRunId
      || delivery?.policy !== "mission_integration" || !["pending", "running"].includes(job.status)) return null;
    const lineage = await ctx.db.query("integrationAttempts")
      .withIndex("by_mission_generation", (q: any) => q.eq("missionId", mission._id)).take(100);
    if (lineage.some((candidate: any) => candidate.generation < attempt.generation && !TERMINAL.has(candidate.status))) return null;
    const now = Date.now();
    if (mission.activeIntegrationAttemptId && mission.activeIntegrationAttemptId !== attempt._id
      && Number(mission.integrationLeaseUntil ?? 0) >= now) return null;
    if (attempt.controllerRunId && attempt.controllerRunId !== args.controllerRunId
      && Number(attempt.leaseUntil ?? 0) >= now) return null;
    const version = Math.max(Number(mission.integrationLeaseVersion ?? 0), Number(attempt.leaseVersion ?? 0)) + 1;
    const until = now + LEASE_MS;
    const expectedIntegrationBaseSha = String(mission.integrationHeadSha ?? attempt.reviewedBaseSha);
    await ctx.db.patch(attempt._id, {
      status: attempt.status === "prepared" || attempt.status === "provider_waiting" ? attempt.status : "claimed",
      controllerRunId: args.controllerRunId.slice(0, 160), leaseOwner: args.leaseOwner.slice(0, 160),
      leaseToken: args.leaseToken.slice(0, 160), leaseVersion: version, leaseUntil: until,
      expectedIntegrationBaseSha, updatedAt: now,
    });
    await patchMissionWithRuntime(ctx, mission, {
      activeIntegrationAttemptId: attempt._id, integrationLeaseOwner: args.leaseOwner.slice(0, 160),
      integrationLeaseToken: args.leaseToken.slice(0, 160), integrationLeaseVersion: version,
      integrationLeaseUntil: until, updatedAt: now,
    });
    await patchJobWithRuntime(ctx, job, { integrationState: "integrating", evidenceSummary: "signed worker receipt claimed by controller" });
    await appendEvent(ctx, { ...job, integrationAttemptId: attempt._id }, "integration_claimed", `Controller claimed integration generation ${attempt.generation}`);
    return { ...attempt, status: "claimed", controllerRunId: args.controllerRunId, leaseOwner: args.leaseOwner,
      leaseToken: args.leaseToken, leaseVersion: version, leaseUntil: until, expectedIntegrationBaseSha };
  },
});

export const heartbeat = mutation({
  args: fenceArgs,
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    const attempt: any = await ctx.db.get(args.id);
    const mission: any = attempt ? await ctx.db.get(attempt.missionId) : null;
    const job: any = attempt ? await ctx.db.get(attempt.jobId) : null;
    if (!exactFence(mission, attempt, args, job)) return false;
    const until = Date.now() + LEASE_MS;
    await ctx.db.patch(attempt._id, { leaseUntil: until, updatedAt: Date.now() });
    await patchMissionWithRuntime(ctx, mission, { integrationLeaseUntil: until, updatedAt: Date.now() });
    return true;
  },
});

export const prepare = mutation({
  args: {
    ...fenceArgs, effectId: v.string(), expectedIntegrationBaseSha: v.string(),
    preparedIntegrationHeadSha: v.string(), preparedIntegrationTreeSha: v.string(),
  },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    const attempt: any = await ctx.db.get(args.id);
    const mission: any = attempt ? await ctx.db.get(attempt.missionId) : null;
    const job: any = attempt ? await ctx.db.get(attempt.jobId) : null;
    if (!exactFence(mission, attempt, args, job) || !SHA.test(args.expectedIntegrationBaseSha)
      || !SHA.test(args.preparedIntegrationHeadSha) || !SHA.test(args.preparedIntegrationTreeSha)
      || args.expectedIntegrationBaseSha !== attempt.expectedIntegrationBaseSha) return null;
    if (attempt.preparedEffectId) {
      return attempt.preparedEffectId === args.effectId
        && attempt.preparedIntegrationHeadSha === args.preparedIntegrationHeadSha
        && attempt.preparedIntegrationTreeSha === args.preparedIntegrationTreeSha
        ? { replay: true, observation: attempt.providerObservation ?? null } : null;
    }
    await ctx.db.patch(attempt._id, {
      status: "prepared", preparedEffectId: args.effectId.slice(0, 200),
      preparedIntegrationHeadSha: args.preparedIntegrationHeadSha,
      preparedIntegrationTreeSha: args.preparedIntegrationTreeSha, updatedAt: Date.now(),
    });
    return { replay: false, observation: null };
  },
});

export const observe = mutation({
  args: { ...fenceArgs, effectId: v.string(), observation: v.union(v.literal("applied"), v.literal("not_applied"), v.literal("unknown")), providerHeadSha: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    const attempt: any = await ctx.db.get(args.id);
    const mission: any = attempt ? await ctx.db.get(attempt.missionId) : null;
    const job: any = attempt ? await ctx.db.get(attempt.jobId) : null;
    if (!exactFence(mission, attempt, args, job) || attempt.preparedEffectId !== args.effectId) return false;
    if (args.observation === "applied" && args.providerHeadSha !== attempt.preparedIntegrationHeadSha) return false;
    await ctx.db.patch(attempt._id, {
      status: args.observation === "applied" ? "provider_waiting" : "prepared",
      providerObservation: args.observation, providerObservedHeadSha: args.providerHeadSha,
      updatedAt: Date.now(),
    });
    return true;
  },
});

export const complete = mutation({
  args: { ...fenceArgs, effectId: v.string(), terminalReceiptDigest: v.string() },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    const attempt: any = await ctx.db.get(args.id);
    const mission: any = attempt ? await ctx.db.get(attempt.missionId) : null;
    const job: any = attempt ? await ctx.db.get(attempt.jobId) : null;
    if (!job || !exactFence(mission, attempt, args, job) || attempt.preparedEffectId !== args.effectId
      || attempt.providerObservation !== "applied" || attempt.providerObservedHeadSha !== attempt.preparedIntegrationHeadSha
      || !DIGEST.test(args.terminalReceiptDigest)) return false;
    const now = Date.now();
    await ctx.db.patch(attempt._id, {
      status: "integrated", outcome: "integrated", terminalReceiptDigest: args.terminalReceiptDigest,
      leaseUntil: undefined, completedAt: now, updatedAt: now,
    });
    if (job.activeDeliveryAttemptId) {
      const delivery: any = await ctx.db.get(job.activeDeliveryAttemptId);
      if (delivery?.integrationAttemptId === attempt._id) await ctx.db.patch(delivery._id, {
        status: "done", outcome: "mission_integrated", currentStep: "terminal",
        terminalReceiptDigest: args.terminalReceiptDigest, completedAt: now,
        leaseUntil: undefined, updatedAt: now,
      });
    }
    await patchMissionWithRuntime(ctx, mission, {
      integrationHeadSha: attempt.preparedIntegrationHeadSha,
      integrationGeneration: Math.max(Number(mission.integrationGeneration ?? 0), Number(attempt.generation)),
      activeIntegrationAttemptId: undefined, integrationLeaseOwner: undefined, integrationLeaseToken: undefined,
      integrationLeaseUntil: undefined, updatedAt: now,
    });
    await patchJobWithRuntime(ctx, job, {
      status: "done", stage: "integrated", percent: 100, completedAt: now, heartbeatAt: now,
      integrationState: "integrated", deliveryStatus: "merged", mergeCommitSha: attempt.preparedIntegrationHeadSha,
      evidenceSummary: `review ${attempt.reviewReceiptDigest.slice(0, 12)} integrated at ${attempt.preparedIntegrationHeadSha.slice(0, 12)}`,
      progress: "reviewed worker receipt integrated into the mission head",
    });
    const prior = await ctx.db.query("workReceipts")
      .withIndex("by_job_attempt", (q: any) => q.eq("jobId", job._id).eq("attempt", attempt.workAttempt)).first();
    if (!prior) await ctx.db.insert("workReceipts", {
      jobId: job._id, attempt: attempt.workAttempt, status: "succeeded",
      acceptanceEvidence: [String(job.verificationNote ?? "controller review passed")],
      artifacts: [attempt.workerBranch, attempt.integrationBranch, attempt.preparedIntegrationHeadSha],
      verification: "pass", deliveryOutcome: "mission_integrated",
      terminalEventKey: `integration:${String(attempt._id)}:integrated`,
      resultDigest: attempt.terminalReceiptDigest, evidenceDigest: attempt.reviewReceiptDigest,
      reviewReceiptSignature: job.reviewReceiptSignature, reviewDiffSha256: attempt.reviewedDiffSha256,
      reviewReceiptId: attempt.reviewReceiptId, reviewReceiptDigest: attempt.reviewReceiptDigest, createdAt: now,
    });
    await appendEvent(ctx, job, "integration_completed", `Mission integration advanced once to ${attempt.preparedIntegrationHeadSha}`, {
      integrationBase: attempt.expectedIntegrationBaseSha, integrationHead: attempt.preparedIntegrationHeadSha,
      workerHead: attempt.reviewedHeadSha,
    });
    return true;
  },
});

export const defer = mutation({
  args: { ...fenceArgs, reasonCode: v.string(), reason: v.string() },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    const attempt: any = await ctx.db.get(args.id);
    const mission: any = attempt ? await ctx.db.get(attempt.missionId) : null;
    const job: any = attempt ? await ctx.db.get(attempt.jobId) : null;
    if (!job || !exactFence(mission, attempt, args, job)) return false;
    const retries = Number(attempt.cumulativeRetries ?? 0) + 1;
    const exhausted = retries > 6;
    const now = Date.now();
    await ctx.db.patch(attempt._id, {
      status: exhausted ? "exhausted" : (attempt.preparedEffectId ? "prepared" : "queued"),
      outcome: exhausted ? "exhausted" : attempt.outcome,
      retryReason: `${args.reasonCode.slice(0, 80)}: ${args.reason.slice(0, 400)}`,
      cumulativeRetries: retries, leaseUntil: undefined, completedAt: exhausted ? now : undefined, updatedAt: now,
    });
    await patchMissionWithRuntime(ctx, mission, {
      activeIntegrationAttemptId: undefined, integrationLeaseOwner: undefined, integrationLeaseToken: undefined,
      integrationLeaseUntil: undefined, updatedAt: now,
    });
    let nextDeliveryId = job.activeDeliveryAttemptId;
    let nextDeliveryGeneration = Number(job.deliveryGeneration ?? 1);
    if (!exhausted && job.activeDeliveryAttemptId) {
      const prior: any = await ctx.db.get(job.activeDeliveryAttemptId);
      if (prior?.integrationAttemptId === attempt._id) {
        nextDeliveryGeneration += 1;
        nextDeliveryId = await ctx.db.insert("deliveryAttempts", {
          jobId: job._id, integrationAttemptId: attempt._id, sourceWorkAttempt: attempt.workAttempt,
          generation: nextDeliveryGeneration, policy: "mission_integration", status: "checkpointed",
          parentDeliveryAttemptId: prior._id, reviewReceiptId: prior.reviewReceiptId,
          reviewReceiptDigest: prior.reviewReceiptDigest, reviewKeyId: prior.reviewKeyId,
          reviewLineage: prior.reviewLineage, reviewedHeadSha: prior.reviewedHeadSha,
          reviewedBaseSha: prior.reviewedBaseSha, reviewedHeadTreeSha: prior.reviewedHeadTreeSha,
          reviewedDiffSha256: prior.reviewedDiffSha256, heartbeatAt: now, retries: 0,
          cumulativeRetries: retries, currentStep: "queued", retryReason: args.reasonCode.slice(0, 80),
          createdAt: now, updatedAt: now,
        });
        await ctx.db.patch(prior._id, {
          status: "abandoned", completedAt: now, leaseUntil: undefined,
          retryReason: args.reasonCode.slice(0, 80), updatedAt: now,
        });
      }
    }
    await patchJobWithRuntime(ctx, job, {
      integrationState: exhausted ? "exhausted" : "retry_due",
      evidenceSummary: `${args.reasonCode.slice(0, 80)} · retry ${retries}/6`,
      activeDeliveryAttemptId: nextDeliveryId,
      deliveryGeneration: nextDeliveryGeneration,
      dispatchId: undefined, dispatchLeaseUntil: undefined, workerRunId: undefined, deliveryRunId: undefined,
      deliveryLeaseOwner: undefined, deliveryLeaseToken: undefined, deliveryLeaseUntil: undefined,
      ...(exhausted ? { status: "needs_input", stage: "integration attention", nextRunAt: undefined }
        : { status: "pending", stage: "delivery", nextRunAt: now + Math.min(30 * 60_000, 30_000 * 2 ** Math.max(0, retries - 1)) }),
    });
    await appendEvent(ctx, job, exhausted ? "integration_exhausted" : "integration_retry_due", args.reason, {
      reasonCode: args.reasonCode.slice(0, 80), retries,
      sentryRecommendationScope: exhausted ? ["resume", "focused_repair", "park", "escalate"] : undefined,
    });
    return true;
  },
});

export const failFocused = mutation({
  args: { ...fenceArgs, kind: v.union(v.literal("conflict"), v.literal("stale")), reason: v.string() },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    const attempt: any = await ctx.db.get(args.id);
    const mission: any = attempt ? await ctx.db.get(attempt.missionId) : null;
    const job: any = attempt ? await ctx.db.get(attempt.jobId) : null;
    if (!job || !exactFence(mission, attempt, args, job)) return null;
    const now = Date.now();
    const repairId = await insertJobWithRuntime(ctx, {
      repo: attempt.repository,
      task: [
        `Focused ${args.kind} repair for reviewed workstream ${attempt.workstreamId}.`,
        `Original signed receipt ${attempt.reviewReceiptDigest}; worker ${attempt.workerBranch} at ${attempt.reviewedHeadSha}.`,
        `Current mission integration branch ${attempt.integrationBranch} at ${attempt.expectedIntegrationBaseSha}.`,
        `Repair only this receipt against the current integration head. Do not rerun or modify unrelated workstreams.`,
        args.reason.slice(0, 1_000),
      ].join("\n\n"),
      status: "pending", readonly: false, model: "terra", reasoningEffort: "high", mcp: ["context7"],
      missionId: String(mission._id), label: `${args.kind} repair · ${attempt.workstreamId}`.slice(0, 80),
      visibility: "conversation", originThreadId: mission.originThreadId, agentId: job.agentId ?? "paul",
      risk: "high", priority: 99, stage: "queued", percent: 0, progressAt: now, heartbeatAt: now,
      attempt: 1, maxAttempts: 8, nextRunAt: now, parentJobId: String(job._id),
      goalStage: job.goalStage, goalWorkstreamId: `${attempt.workstreamId}-repair-${attempt.generation}`,
      goalWave: attempt.revisionWave, acceptanceCriteria: ["Produce a fresh exact signed receipt against the current integration head"],
      sourceBranch: attempt.integrationBranch, integrationBranch: attempt.integrationBranch,
      integrationState: "awaiting_review", createdAt: now,
    });
    const identity = workItemIdentity({ missionId: String(mission._id), jobId: String(repairId), workstreamId: `${attempt.workstreamId}-repair`, readonly: false });
    const repair: any = await ctx.db.get(repairId);
    if (repair) await patchJobWithRuntime(ctx, repair, { ...identity, branch: identity.workerBranch, workerBranch: identity.workerBranch });
    await ctx.db.insert("workAttempts", {
      jobId: repairId, attempt: 1, status: "pending", workspaceLineage: identity.workspaceLineage,
      workerBranch: identity.workerBranch, workspaceKey: attemptWorkspaceKey(identity.workspaceLineage, 1),
      lastEventSeq: 0, livenessAt: now, progressAt: now, lastEventAt: now, createdAt: now,
    });
    await ctx.db.patch(attempt._id, {
      status: args.kind, outcome: args.kind, retryReason: args.reason.slice(0, 500), repairJobId: repairId,
      terminalReceiptDigest: attempt.reviewReceiptDigest, leaseUntil: undefined, completedAt: now, updatedAt: now,
    });
    if (job.activeDeliveryAttemptId) {
      const delivery: any = await ctx.db.get(job.activeDeliveryAttemptId);
      if (delivery?.integrationAttemptId === attempt._id) await ctx.db.patch(delivery._id, {
        status: "blocked", outcome: args.kind, currentStep: "terminal",
        terminalReceiptDigest: attempt.reviewReceiptDigest, completedAt: now,
        leaseUntil: undefined, updatedAt: now,
      });
    }
    await patchJobWithRuntime(ctx, job, {
      status: "done", stage: "repair queued", completedAt: now, integrationState: args.kind,
      evidenceSummary: `${args.kind}: ${args.reason.slice(0, 300)}`, progress: "review retained; focused integration repair queued",
    });
    await patchMissionWithRuntime(ctx, mission, {
      activeIntegrationAttemptId: undefined, integrationLeaseOwner: undefined, integrationLeaseToken: undefined,
      integrationLeaseUntil: undefined, agentCount: Number(mission.agentCount ?? 0) + 1, updatedAt: now,
    });
    await appendEvent(ctx, job, `integration_${args.kind}`, args.reason, { repairJobId: String(repairId) });
    return { repairJobId: repairId };
  },
});

export const byMission = query({
  args: { missionId: v.id("missions"), ...viewerAuthArgs },
  handler: async (ctx, args) => {
    await requireViewer(ctx, args);
    return await ctx.db.query("integrationAttempts")
      .withIndex("by_mission_generation", (q: any) => q.eq("missionId", args.missionId)).take(100);
  },
});
