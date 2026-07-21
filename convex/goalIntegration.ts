import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireViewer, requireWorker, viewerAuthArgs } from "./controlAuth";
import { insertJobWithRuntime, patchJobWithRuntime, patchMissionWithRuntime } from "./controlPlane";
import { attemptWorkspaceKey, workItemIdentity } from "../src/lib/workspace-protocol";

const LEASE_MS = 45_000;
const SHA = /^[0-9a-f]{40,64}$/i;
const DIGEST = /^[0-9a-f]{64}$/i;
const ZERO_OID = "0".repeat(40);
const TERMINAL = new Set(["integrated", "conflict", "stale", "cancelled", "exhausted", "parked"]);

function canonicalValue(value: any): any {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => [key, canonicalValue(value[key])]),
  );
  return value;
}

async function sha256Hex(value: string) {
  const bytes = new TextEncoder().encode(value);
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Build and insert a canonical terminal receipt only from authoritative rows. */
export async function writeIntegrationTerminalReceipt(ctx: any, attempt: any, outcome: string, detail?: { reason?: string; repairJobId?: any; cumulativeRetries?: number }) {
  const existing: any = await ctx.db.query("integrationTerminalReceipts")
    .withIndex("by_attempt", (q: any) => q.eq("integrationAttemptId", attempt._id)).first();
  if (existing) return existing.outcome === outcome ? existing : null;
  const [mission, job, review, workAttempts, deliveryAttempts, coldEffects] = await Promise.all([
    ctx.db.get(attempt.missionId),
    ctx.db.get(attempt.jobId),
    ctx.db.get(attempt.reviewReceiptId),
    ctx.db.query("workAttempts").withIndex("by_job_attempt", (q: any) => q.eq("jobId", attempt.jobId)).collect(),
    ctx.db.query("deliveryAttempts").withIndex("by_job", (q: any) => q.eq("jobId", attempt.jobId)).collect(),
    ctx.db.query("integrationProviderEffects").withIndex("by_attempt_prepared", (q: any) => q.eq("integrationAttemptId", attempt._id)).collect(),
  ]);
  if (!mission || !job || !review
    || review.jobId !== attempt.jobId || review.attempt !== attempt.workAttempt
    || review.receiptDigest !== attempt.reviewReceiptDigest
    || review.repository !== attempt.repository || review.workerBranch !== attempt.workerBranch
    || review.sourceBranch !== job.sourceBranch || review.workspaceLineage !== job.workspaceLineage
    || review.retryLineage !== job.retryLineage
    || review.baseSha !== attempt.reviewedBaseSha || review.headSha !== attempt.reviewedHeadSha
    || review.headTreeSha !== attempt.reviewedHeadTreeSha || review.diffSha256 !== attempt.reviewedDiffSha256
    || !SHA.test(String(job.sourceHeadSha ?? "")) || review.baseSha !== job.sourceHeadSha) return null;
  const delivery: any = job.activeDeliveryAttemptId ? await ctx.db.get(job.activeDeliveryAttemptId) : null;
  if (!delivery || delivery.integrationAttemptId !== attempt._id
    || delivery.sourceWorkAttempt !== attempt.workAttempt
    || delivery.reviewReceiptId !== attempt.reviewReceiptId
    || delivery.reviewReceiptDigest !== attempt.reviewReceiptDigest
    || delivery.reviewedBaseSha !== attempt.reviewedBaseSha
    || delivery.reviewedHeadSha !== attempt.reviewedHeadSha
    || delivery.reviewedHeadTreeSha !== attempt.reviewedHeadTreeSha
    || delivery.reviewedDiffSha256 !== attempt.reviewedDiffSha256) return null;
  const repair: any = detail?.repairJobId ? await ctx.db.get(detail.repairJobId) : null;
  const effects = [...(coldEffects.length ? coldEffects : (attempt.effects ?? []))]
    .sort((left: any, right: any) => left.preparedAt - right.preparedAt || left.effectId.localeCompare(right.effectId))
    .map((effect: any) => ({
      effectId: effect.effectId, kind: effect.effectKind, provider: effect.provider,
      providerIdentity: effect.providerIdentity, method: effect.providerMethod, target: effect.providerTarget,
      requestDigest: effect.requestDigest, expectedBaseSha: effect.expectedBaseSha,
      headSha: effect.headSha, treeSha: effect.treeSha, preparedAt: effect.preparedAt,
      observation: effect.observation ?? null, providerHeadSha: effect.providerHeadSha ?? null,
      providerResponse: effect.providerResponse ?? null,
      providerResponseDigest: effect.providerResponseDigest ?? null,
      observedAt: effect.observedAt ?? null,
    }));
  if (outcome === "integrated" && !effects.some((effect: any) => effect.kind === "update_ref"
    && effect.observation === "applied" && effect.providerHeadSha === attempt.preparedIntegrationHeadSha)) return null;
  const receipt = canonicalValue({
    version: 1,
    kind: "mission_integration_terminal",
    outcome,
    mission: {
      id: String(mission._id), repository: attempt.repository, primaryRepository: mission.primaryRepo ?? null,
      workstreamId: attempt.workstreamId, revisionWave: attempt.revisionWave,
    },
    job: {
      id: String(job._id), workAttempt: attempt.workAttempt, parentJobId: job.parentJobId ?? null,
      retryLineage: job.retryLineage ?? null, workspaceLineage: job.workspaceLineage ?? null,
    },
    workspaceAttempts: workAttempts.sort((a: any, b: any) => a.attempt - b.attempt).map((row: any) => ({
      attempt: row.attempt, parentAttempt: row.parentAttempt ?? null, workspaceKey: row.workspaceKey ?? null,
      workspaceLineage: row.workspaceLineage ?? null, workerBranch: row.workerBranch ?? null,
      sourceHeadSha: row.sourceHeadSha ?? null, parentCheckpointHeadSha: row.parentCheckpointHeadSha ?? null,
      checkpointHeadSha: row.checkpointHeadSha ?? null, workerRunId: row.workerRunId ?? null,
      providerWorkspaceId: row.providerWorkspaceId ?? null, providerSessionId: row.providerSessionId ?? null,
    })),
    review: {
      id: String(review._id), digest: review.receiptDigest, keyId: review.keyId ?? "legacy-v1",
      signature: review.signature, agentEvidenceSha256: review.agentEvidenceSha256,
    },
    source: { branch: job.sourceBranch ?? attempt.sourceBranch, headSha: job.sourceHeadSha ?? null },
    worker: {
      branch: attempt.workerBranch, reviewedBaseSha: attempt.reviewedBaseSha,
      reviewedHeadSha: attempt.reviewedHeadSha, reviewedHeadTreeSha: attempt.reviewedHeadTreeSha,
      reviewedDiffSha256: attempt.reviewedDiffSha256,
    },
    integration: {
      attemptId: String(attempt._id), branch: attempt.integrationBranch, generation: attempt.generation,
      deliveryGeneration: delivery?.generation ?? job.deliveryGeneration ?? null,
      cumulativeRetries: detail?.cumulativeRetries ?? attempt.cumulativeRetries,
      expectedBaseSha: attempt.expectedIntegrationBaseSha ?? null,
      expectedRefSha: attempt.expectedIntegrationRefSha ?? null,
      preparedHeadSha: attempt.preparedIntegrationHeadSha ?? null,
      preparedTreeSha: attempt.preparedIntegrationTreeSha ?? null,
    },
    controller: {
      runId: attempt.controllerRunId ?? null, leaseVersion: attempt.leaseVersion,
      deliveryRunId: delivery?.deliveryRunId ?? job.deliveryRunId ?? null,
    },
    deliveryLineage: deliveryAttempts
      .filter((row: any) => row.jobId === attempt.jobId && row.integrationAttemptId === attempt._id)
      .sort((left: any, right: any) => left.generation - right.generation)
      .map((row: any) => ({
        id: String(row._id), generation: row.generation,
        parentDeliveryAttemptId: row.parentDeliveryAttemptId ? String(row.parentDeliveryAttemptId) : null,
        sourceWorkAttempt: row.sourceWorkAttempt, deliveryRunId: row.deliveryRunId ?? null,
        reviewReceiptId: row.reviewReceiptId ? String(row.reviewReceiptId) : null,
        reviewReceiptDigest: row.reviewReceiptDigest ?? null, reviewKeyId: row.reviewKeyId ?? null,
        cumulativeRetries: row.cumulativeRetries ?? 0, currentStep: row.currentStep ?? null,
        status: row.status, outcome: row.outcome ?? null,
      })),
    providerEffects: effects,
    terminal: {
      outcome, reason: detail?.reason?.slice(0, 500) ?? attempt.retryReason ?? null,
      deliveryStatus: outcome === "integrated" ? "done" : "blocked",
      deliveryOutcome: outcome === "integrated" ? "mission_integrated" : outcome,
      focusedRepair: repair ? {
        jobId: String(repair._id), parentJobId: repair.parentJobId ?? null,
        workerBranch: repair.workerBranch ?? null, workspaceLineage: repair.workspaceLineage ?? null,
        retryLineage: repair.retryLineage ?? null,
      } : null,
    },
  });
  const receiptJson = JSON.stringify(receipt);
  const receiptDigest = await sha256Hex(receiptJson);
  const id = await ctx.db.insert("integrationTerminalReceipts", {
    missionId: attempt.missionId, jobId: attempt.jobId, integrationAttemptId: attempt._id,
    outcome, receiptJson, receiptDigest, createdAt: Date.now(),
  });
  return { _id: id, outcome, receiptJson, receiptDigest };
}

const NONTERMINAL = ["queued", "claimed", "prepared", "provider_waiting"] as const;

async function fifoHead(ctx: any, missionId: any, repository: string) {
  const candidates = await Promise.all(NONTERMINAL.map((status) => ctx.db.query("integrationAttempts")
    .withIndex("by_mission_repository_status_generation", (q: any) => q.eq("missionId", missionId).eq("repository", repository).eq("status", status))
    .order("asc").first()));
  return candidates.filter(Boolean).sort((left: any, right: any) => left.generation - right.generation)[0] ?? null;
}

async function wakeNextIntegration(ctx: any, attempt: any) {
  const next: any = await fifoHead(ctx, attempt.missionId, attempt.repository);
  if (!next) return;
  await ctx.db.patch(next._id, { status: "queued", updatedAt: Date.now() });
  const job: any = await ctx.db.get(next.jobId);
  if (job && job.status === "pending") await patchJobWithRuntime(ctx, job, {
    integrationState: "queued", nextRunAt: Date.now(), evidenceSummary: "signed review is next in the repository integration FIFO",
  });
}

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
  const waiting = Boolean(await fifoHead(ctx, missionId, job.repo));
  const id = await ctx.db.insert("integrationAttempts", {
    missionId, jobId: job._id, workAttempt: job.attempt ?? 1, generation,
    revisionWave: Number(job.goalWave ?? 0), workstreamId: String(job.goalWorkstreamId ?? job._id),
    repository: job.repo, sourceBranch: String(job.sourceBranch ?? mission.sourceBranch ?? "main"),
    workerBranch: job.workerBranch, integrationBranch: job.integrationBranch,
    reviewReceiptId, reviewReceiptDigest, reviewedBaseSha: String(review.baseSha),
    reviewedHeadSha: String(review.headSha), reviewedHeadTreeSha: String(review.headTreeSha),
    reviewedDiffSha256: String(review.diffSha256), status: waiting ? "provider_waiting" : "queued", leaseVersion: 0,
    cumulativeRetries: 0, createdAt: now, updatedAt: now,
  });
  await patchMissionWithRuntime(ctx, mission, { integrationGeneration: generation, updatedAt: now });
  return { _id: id, generation, status: waiting ? "provider_waiting" : "queued" };
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
    const head = await fifoHead(ctx, mission._id, attempt.repository);
    if (!head || head._id !== attempt._id) return null;
    const now = Date.now();
    if (mission.activeIntegrationAttemptId && mission.activeIntegrationAttemptId !== attempt._id
      && Number(mission.integrationLeaseUntil ?? 0) >= now) return null;
    if (attempt.controllerRunId && attempt.controllerRunId !== args.controllerRunId
      && Number(attempt.leaseUntil ?? 0) >= now) return null;
    const version = Math.max(Number(mission.integrationLeaseVersion ?? 0), Number(attempt.leaseVersion ?? 0)) + 1;
    const until = now + LEASE_MS;
    const expectedIntegrationBaseSha = String(mission.integrationHeadSha ?? attempt.reviewedBaseSha);
    const expectedIntegrationRefSha = String(mission.integrationHeadSha ?? ZERO_OID);
    await ctx.db.patch(attempt._id, {
      status: "claimed",
      controllerRunId: args.controllerRunId.slice(0, 160), leaseOwner: args.leaseOwner.slice(0, 160),
      leaseToken: args.leaseToken.slice(0, 160), leaseVersion: version, leaseUntil: until,
      expectedIntegrationBaseSha, expectedIntegrationRefSha, updatedAt: now,
      controllerState: "command", controllerStateSince: now,
      controllerDeadlineAt: now + 10 * 60_000, controllerHeartbeatAt: now,
    });
    await patchMissionWithRuntime(ctx, mission, {
      activeIntegrationAttemptId: attempt._id, integrationLeaseOwner: args.leaseOwner.slice(0, 160),
      integrationLeaseToken: args.leaseToken.slice(0, 160), integrationLeaseVersion: version,
      integrationLeaseUntil: until, updatedAt: now,
    });
    await patchJobWithRuntime(ctx, job, { integrationState: "integrating", evidenceSummary: "signed worker receipt claimed by controller" });
    await appendEvent(ctx, { ...job, integrationAttemptId: attempt._id }, "integration_claimed", `Controller claimed integration generation ${attempt.generation}`);
    return { ...attempt, status: "claimed", controllerRunId: args.controllerRunId, leaseOwner: args.leaseOwner,
      leaseToken: args.leaseToken, leaseVersion: version, leaseUntil: until, expectedIntegrationBaseSha, expectedIntegrationRefSha };
  },
});

export const heartbeat = mutation({
  args: {
    ...fenceArgs,
    state: v.optional(v.union(v.literal("command"), v.literal("provider"), v.literal("reconcile"))),
    deadlineAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    const attempt: any = await ctx.db.get(args.id);
    const mission: any = attempt ? await ctx.db.get(attempt.missionId) : null;
    const job: any = attempt ? await ctx.db.get(attempt.jobId) : null;
    if (!exactFence(mission, attempt, args, job)) return false;
    const now = Date.now();
    if (args.deadlineAt !== undefined && (args.deadlineAt < now || args.deadlineAt > now + 6 * 60 * 60_000)) return false;
    const until = now + LEASE_MS;
    await ctx.db.patch(attempt._id, {
      leaseUntil: until, controllerHeartbeatAt: now,
      ...(args.state && args.state !== attempt.controllerState ? { controllerState: args.state, controllerStateSince: now } : {}),
      ...(args.deadlineAt !== undefined ? { controllerDeadlineAt: args.deadlineAt } : {}),
      updatedAt: now,
    });
    await patchMissionWithRuntime(ctx, mission, { integrationLeaseUntil: until, updatedAt: now });
    return true;
  },
});

export const prepare = mutation({
  args: {
    ...fenceArgs, effectId: v.string(),
    effectKind: v.union(v.literal("stage_blob"), v.literal("stage_tree"), v.literal("stage_commit"), v.literal("update_ref")),
    provider: v.literal("github"), providerIdentity: v.string(), providerMethod: v.literal("POST"),
    providerTarget: v.string(), requestDigest: v.string(), expectedIntegrationRefSha: v.optional(v.string()),
    preparedIntegrationHeadSha: v.string(), preparedIntegrationTreeSha: v.string(),
  },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    const attempt: any = await ctx.db.get(args.id);
    const mission: any = attempt ? await ctx.db.get(attempt.missionId) : null;
    const job: any = attempt ? await ctx.db.get(attempt.jobId) : null;
    if (!exactFence(mission, attempt, args, job)
      || args.effectId.length < 1 || args.effectId.length > 300
      || !SHA.test(args.preparedIntegrationHeadSha) || !SHA.test(args.preparedIntegrationTreeSha)
      || !DIGEST.test(args.requestDigest)
      || (args.effectKind === "update_ref" && args.expectedIntegrationRefSha !== attempt.expectedIntegrationRefSha)) return null;
    const existing: any = await ctx.db.query("integrationProviderEffects")
      .withIndex("by_attempt_effect", (q: any) => q.eq("integrationAttemptId", attempt._id).eq("effectId", args.effectId)).first();
    if (existing) {
      const same = existing.effectKind === args.effectKind && existing.provider === args.provider
        && existing.providerIdentity === args.providerIdentity && existing.providerMethod === args.providerMethod
        && existing.providerTarget === args.providerTarget && existing.requestDigest === args.requestDigest
        && existing.expectedBaseSha === args.expectedIntegrationRefSha
        && existing.headSha === args.preparedIntegrationHeadSha && existing.treeSha === args.preparedIntegrationTreeSha;
      return same ? { replay: true, observation: existing.observation ?? null } : null;
    }
    const now = Date.now();
    await ctx.db.insert("integrationProviderEffects", {
      integrationAttemptId: attempt._id,
      effectId: args.effectId, effectKind: args.effectKind, provider: args.provider,
      providerIdentity: args.providerIdentity.slice(0, 500), providerMethod: args.providerMethod,
      providerTarget: args.providerTarget.slice(0, 500), requestDigest: args.requestDigest,
      expectedBaseSha: args.expectedIntegrationRefSha,
      headSha: args.preparedIntegrationHeadSha, treeSha: args.preparedIntegrationTreeSha, preparedAt: now,
    });
    await ctx.db.patch(attempt._id, {
      status: "prepared", providerEffectCount: Number(attempt.providerEffectCount ?? 0) + 1,
      ...(args.effectKind === "update_ref" ? { preparedEffectId: args.effectId } : {}),
      preparedIntegrationHeadSha: args.preparedIntegrationHeadSha,
      preparedIntegrationTreeSha: args.preparedIntegrationTreeSha, updatedAt: now,
    });
    return { replay: false, observation: null };
  },
});

export const observe = mutation({
  args: { ...fenceArgs, effectId: v.string(), observation: v.union(v.literal("applied"), v.literal("not_applied"), v.literal("unknown")), providerHeadSha: v.optional(v.string()), providerResponse: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    const attempt: any = await ctx.db.get(args.id);
    const mission: any = attempt ? await ctx.db.get(attempt.missionId) : null;
    const job: any = attempt ? await ctx.db.get(attempt.jobId) : null;
    if (!exactFence(mission, attempt, args, job) || args.effectId.length < 1 || args.effectId.length > 300) return false;
    const effect: any = await ctx.db.query("integrationProviderEffects")
      .withIndex("by_attempt_effect", (q: any) => q.eq("integrationAttemptId", attempt._id).eq("effectId", args.effectId)).first();
    if (!effect) return false;
    if (args.observation === "applied" && args.providerHeadSha !== effect.headSha) return false;
    if (effect.observation && (effect.observation !== args.observation
      || (effect.providerHeadSha ?? undefined) !== args.providerHeadSha)
      && effect.observation !== "unknown") return false;
    const now = Date.now();
    const providerResponse = args.providerResponse?.slice(0, 8_000);
    const providerResponseDigest = args.providerResponse ? await sha256Hex(args.providerResponse) : undefined;
    await ctx.db.patch(effect._id, {
      observation: args.observation, providerHeadSha: args.providerHeadSha,
      providerResponse, providerResponseDigest, observedAt: now,
    });
    const finalEffect = effect.effectKind === "update_ref";
    await ctx.db.patch(attempt._id, {
      status: finalEffect && args.observation === "applied" ? "provider_waiting" : "prepared",
      ...(finalEffect ? { providerObservation: args.observation, providerObservedHeadSha: args.providerHeadSha } : {}),
      updatedAt: now,
    });
    return true;
  },
});

export const complete = mutation({
  args: { ...fenceArgs, effectId: v.string() },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    if (args.effectId.length < 1 || args.effectId.length > 300) return false;
    const attempt: any = await ctx.db.get(args.id);
    const mission: any = attempt ? await ctx.db.get(attempt.missionId) : null;
    const job: any = attempt ? await ctx.db.get(attempt.jobId) : null;
    const effect: any = attempt ? await ctx.db.query("integrationProviderEffects")
      .withIndex("by_attempt_effect", (q: any) => q.eq("integrationAttemptId", attempt._id).eq("effectId", args.effectId)).first() : null;
    if (!job || !exactFence(mission, attempt, args, job) || attempt.preparedEffectId !== args.effectId
      || effect?.effectKind !== "update_ref" || effect.observation !== "applied"
      || effect.providerHeadSha !== attempt.preparedIntegrationHeadSha
      || String(mission.integrationHeadSha ?? ZERO_OID) !== attempt.expectedIntegrationRefSha) return false;
    const terminal = await writeIntegrationTerminalReceipt(ctx, attempt, "integrated");
    if (!terminal) return false;
    const now = Date.now();
    await ctx.db.patch(attempt._id, {
      status: "integrated", outcome: "integrated", terminalReceiptDigest: terminal.receiptDigest,
      leaseUntil: undefined, completedAt: now, updatedAt: now,
    });
    if (job.activeDeliveryAttemptId) {
      const delivery: any = await ctx.db.get(job.activeDeliveryAttemptId);
      if (delivery?.integrationAttemptId === attempt._id) await ctx.db.patch(delivery._id, {
        status: "done", outcome: "mission_integrated", currentStep: "terminal",
        terminalReceiptDigest: terminal.receiptDigest, completedAt: now,
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
      resultDigest: terminal.receiptDigest, evidenceDigest: attempt.reviewReceiptDigest,
      reviewReceiptSignature: job.reviewReceiptSignature, reviewDiffSha256: attempt.reviewedDiffSha256,
      reviewReceiptId: attempt.reviewReceiptId, reviewReceiptDigest: attempt.reviewReceiptDigest, createdAt: now,
    });
    await appendEvent(ctx, job, "integration_completed", `Mission integration advanced once to ${attempt.preparedIntegrationHeadSha}`, {
      integrationBase: attempt.expectedIntegrationBaseSha, integrationHead: attempt.preparedIntegrationHeadSha,
      workerHead: attempt.reviewedHeadSha,
    });
    await wakeNextIntegration(ctx, attempt);
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
    const terminal = exhausted
      ? await writeIntegrationTerminalReceipt(ctx, attempt, "exhausted", { reason: `${args.reasonCode}: ${args.reason}`, cumulativeRetries: retries })
      : null;
    if (exhausted && !terminal) return false;
    await ctx.db.patch(attempt._id, {
      status: exhausted ? "exhausted" : "queued",
      outcome: exhausted ? "exhausted" : attempt.outcome,
      retryReason: `${args.reasonCode.slice(0, 80)}: ${args.reason.slice(0, 400)}`,
      cumulativeRetries: retries, leaseUntil: undefined,
      terminalReceiptDigest: terminal?.receiptDigest,
      completedAt: exhausted ? now : undefined, updatedAt: now,
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
    if (exhausted) await wakeNextIntegration(ctx, attempt);
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
    const terminal = await writeIntegrationTerminalReceipt(ctx, attempt, args.kind, { reason: args.reason, repairJobId: repairId });
    if (!terminal) throw new Error("focused integration terminal receipt could not be canonicalized");
    await ctx.db.patch(attempt._id, {
      status: args.kind, outcome: args.kind, retryReason: args.reason.slice(0, 500), repairJobId: repairId,
      terminalReceiptDigest: terminal.receiptDigest, leaseUntil: undefined, completedAt: now, updatedAt: now,
    });
    if (job.activeDeliveryAttemptId) {
      const delivery: any = await ctx.db.get(job.activeDeliveryAttemptId);
      if (delivery?.integrationAttemptId === attempt._id) await ctx.db.patch(delivery._id, {
        status: "blocked", outcome: args.kind, currentStep: "terminal",
        terminalReceiptDigest: terminal.receiptDigest, completedAt: now,
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
    await wakeNextIntegration(ctx, attempt);
    return { repairJobId: repairId };
  },
});

export const park = mutation({
  args: { ...fenceArgs, reason: v.string() },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    const attempt: any = await ctx.db.get(args.id);
    const mission: any = attempt ? await ctx.db.get(attempt.missionId) : null;
    const job: any = attempt ? await ctx.db.get(attempt.jobId) : null;
    if (!job || !exactFence(mission, attempt, args, job)) return false;
    const terminal = await writeIntegrationTerminalReceipt(ctx, attempt, "parked", { reason: args.reason });
    if (!terminal) return false;
    const now = Date.now();
    await ctx.db.patch(attempt._id, {
      status: "parked", outcome: "parked", retryReason: args.reason.slice(0, 500),
      terminalReceiptDigest: terminal.receiptDigest, leaseUntil: undefined, completedAt: now, updatedAt: now,
    });
    if (job.activeDeliveryAttemptId) {
      const delivery: any = await ctx.db.get(job.activeDeliveryAttemptId);
      if (delivery?.integrationAttemptId === attempt._id) await ctx.db.patch(delivery._id, {
        status: "blocked", outcome: "parked", currentStep: "terminal",
        terminalReceiptDigest: terminal.receiptDigest, completedAt: now, leaseUntil: undefined, updatedAt: now,
      });
    }
    await patchJobWithRuntime(ctx, job, {
      status: "done", stage: "integration parked", completedAt: now, integrationState: "parked",
      evidenceSummary: `parked: ${args.reason.slice(0, 300)}`, progress: "review retained; integration item parked",
    });
    await patchMissionWithRuntime(ctx, mission, {
      activeIntegrationAttemptId: undefined, integrationLeaseOwner: undefined, integrationLeaseToken: undefined,
      integrationLeaseUntil: undefined, updatedAt: now,
    });
    await appendEvent(ctx, job, "integration_parked", args.reason);
    await wakeNextIntegration(ctx, attempt);
    return true;
  },
});

/** Job controls fence both controller leases in the same Convex transaction. */
export async function controlIntegrationForJob(ctx: any, job: any, action: "pause" | "cancel" | "steer") {
  if (!job.integrationAttemptId) return null;
  const attempt: any = await ctx.db.get(job.integrationAttemptId);
  if (!attempt || attempt.jobId !== job._id || TERMINAL.has(attempt.status)) return null;
  const mission: any = await ctx.db.get(attempt.missionId);
  const delivery: any = job.activeDeliveryAttemptId ? await ctx.db.get(job.activeDeliveryAttemptId) : null;
  const now = Date.now();
  if (mission?.activeIntegrationAttemptId === attempt._id) await patchMissionWithRuntime(ctx, mission, {
    activeIntegrationAttemptId: undefined, integrationLeaseOwner: undefined, integrationLeaseToken: undefined,
    integrationLeaseUntil: undefined, updatedAt: now,
  });
  if (action === "pause") {
    await ctx.db.patch(attempt._id, {
      status: "queued", leaseOwner: undefined, leaseToken: undefined,
      leaseUntil: undefined, retryReason: "paused by job control", updatedAt: now,
    });
    if (delivery && !["done", "blocked", "abandoned"].includes(delivery.status)) await ctx.db.patch(delivery._id, {
      status: "checkpointed", leaseOwner: undefined, leaseToken: undefined, leaseUntil: undefined,
      retryReason: "paused by job control", heartbeatAt: now, updatedAt: now,
    });
    return { terminal: false };
  }
  const outcome = action === "steer" ? "stale" : "cancelled";
  const reason = action === "steer" ? "signed review superseded by job steering" : "cancelled by job control";
  const terminal = await writeIntegrationTerminalReceipt(ctx, attempt, outcome, { reason });
  if (!terminal) throw new Error("job control integration receipt could not be canonicalized");
  await ctx.db.patch(attempt._id, {
    status: outcome, outcome, retryReason: reason, terminalReceiptDigest: terminal.receiptDigest,
    leaseOwner: undefined, leaseToken: undefined, leaseUntil: undefined, completedAt: now, updatedAt: now,
  });
  if (delivery && !["done", "blocked", "abandoned"].includes(delivery.status)) await ctx.db.patch(delivery._id, {
    status: "blocked", outcome, currentStep: "terminal", terminalReceiptDigest: terminal.receiptDigest,
    leaseOwner: undefined, leaseToken: undefined, leaseUntil: undefined, completedAt: now, heartbeatAt: now, updatedAt: now,
  });
  await wakeNextIntegration(ctx, attempt);
  return { terminal: true, outcome, receiptDigest: terminal.receiptDigest };
}

export const byMission = query({
  args: { missionId: v.id("missions"), ...viewerAuthArgs },
  handler: async (ctx, args) => {
    await requireViewer(ctx, args);
    return await ctx.db.query("integrationAttempts")
      .withIndex("by_mission_generation", (q: any) => q.eq("missionId", args.missionId)).take(100);
  },
});
