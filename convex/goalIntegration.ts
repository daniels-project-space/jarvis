import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireViewer, requireWorker, viewerAuthArgs } from "./controlAuth";
import { insertJobWithRuntime, patchJobWithRuntime, patchMissionWithRuntime } from "./controlPlane";
import { attemptWorkspaceKey, workItemIdentity } from "../src/lib/workspace-protocol";

const LEASE_MS = 45_000;
const CONTROLLER_STATE_MS = { command: 2 * 60_000, provider: 5 * 60_000, reconcile: 2 * 60_000 } as const;
const MAX_PROVIDER_EFFECTS = 1_024;
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

export async function integrationEffectManifest(effect: any) {
  return {
    // Effect ids and provider identities may each be hundreds of bytes. Their
    // collision-resistant digests are exact cold-row lookup evidence without
    // making the terminal document scale with caller-controlled strings.
    effectIdDigest: await sha256Hex(String(effect.effectId)),
    kind: effect.effectKind,
    providerIdentityDigest: await sha256Hex(String(effect.providerIdentity)),
    requestDigest: effect.requestDigest,
    expectedBaseSha: effect.expectedBaseSha,
    headSha: effect.headSha,
    treeSha: effect.treeSha,
    observation: effect.observation ?? null,
    providerHeadSha: effect.providerHeadSha ?? null,
    providerResponseDigest: effect.providerResponseDigest ?? null,
  };
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
  const orderedEffects = [...(coldEffects.length ? coldEffects : (attempt.effects ?? []))]
    .sort((left: any, right: any) => left.preparedAt - right.preparedAt || left.effectId.localeCompare(right.effectId));
  // Full provider ids/responses remain in one cold row. The terminal manifest
  // carries exact digests, so its size is independent of response bodies,
  // provider URLs, and caller-sized effect ids.
  const effects = await Promise.all(orderedEffects.map(integrationEffectManifest));
  if (effects.length > MAX_PROVIDER_EFFECTS) return null;
  const orderedEffectIdentityDigest = await sha256Hex(JSON.stringify(effects));
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
    providerEffects: {
      count: effects.length,
      orderedEffectIdentityDigest,
      ordered: effects,
    },
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

function carriedIntegrationDelivery(delivery: any) {
  return {
    integrationAttemptId: delivery.integrationAttemptId,
    reviewReceiptId: delivery.reviewReceiptId,
    reviewReceiptDigest: delivery.reviewReceiptDigest,
    reviewKeyId: delivery.reviewKeyId,
    reviewLineage: delivery.reviewLineage,
    reviewedHeadSha: delivery.reviewedHeadSha,
    reviewedBaseSha: delivery.reviewedBaseSha,
    reviewedHeadTreeSha: delivery.reviewedHeadTreeSha,
    reviewedDiffSha256: delivery.reviewedDiffSha256,
  };
}

/**
 * One transactionally fenced watchdog path for a dead integration controller.
 * It retains the exact review/effect identity and allocates only a delivery
 * generation; the specialist work attempt is never reopened or incremented.
 */
export async function recoverExpiredIntegrationController(ctx: any, attempt: any, now = Date.now()) {
  if (!attempt || TERMINAL.has(attempt.status) || attempt.status === "queued") return null;
  const expiry = Math.min(Number(attempt.leaseUntil ?? 0), Number(attempt.controllerDeadlineAt ?? 0));
  if (expiry >= now) return null;
  const [mission, job] = await Promise.all([ctx.db.get(attempt.missionId), ctx.db.get(attempt.jobId)]);
  const delivery: any = job?.activeDeliveryAttemptId ? await ctx.db.get(job.activeDeliveryAttemptId) : null;
  if (!mission || !job || job.integrationAttemptId !== attempt._id
    || delivery?.integrationAttemptId !== attempt._id || delivery.status !== "running"
    || mission.activeIntegrationAttemptId !== attempt._id) return null;
  const head = await fifoHead(ctx, attempt.missionId, attempt.repository);
  if (!head || head._id !== attempt._id) return null;
  const nextGeneration = Number(delivery.generation) + 1;
  const existing: any = await ctx.db.query("deliveryAttempts")
    .withIndex("by_job_source_generation", (q: any) => q.eq("jobId", job._id)
      .eq("sourceWorkAttempt", attempt.workAttempt).eq("generation", nextGeneration)).first();
  if (existing) return null;
  const retries = Number(delivery.cumulativeRetries ?? 0) + 1;
  const nextDeliveryId = await ctx.db.insert("deliveryAttempts", {
    jobId: job._id, sourceWorkAttempt: attempt.workAttempt, generation: nextGeneration,
    policy: "mission_integration", status: "checkpointed", parentDeliveryAttemptId: delivery._id,
    ...carriedIntegrationDelivery(delivery), heartbeatAt: now, retries: 0,
    cumulativeRetries: retries, currentStep: "queued", retryReason: "integration controller expired",
    createdAt: now, updatedAt: now,
  });
  await ctx.db.patch(delivery._id, {
    status: "abandoned", completedAt: now, leaseOwner: undefined, leaseToken: undefined,
    leaseUntil: undefined, retryReason: "integration controller expired", updatedAt: now,
  });
  await ctx.db.patch(attempt._id, {
    status: "queued", controllerRunId: undefined, leaseOwner: undefined, leaseToken: undefined,
    leaseUntil: undefined, controllerHeartbeatAt: now, retryReason: "integration controller expired",
    updatedAt: now,
  });
  await patchMissionWithRuntime(ctx, mission, {
    activeIntegrationAttemptId: undefined, integrationLeaseOwner: undefined, integrationLeaseToken: undefined,
    integrationLeaseUntil: undefined, updatedAt: now,
  });
  await patchJobWithRuntime(ctx, job, {
    status: "pending", stage: "delivery", nextRunAt: now,
    integrationState: attempt.controlRequested ? `${attempt.controlRequested}_requested` : "queued",
    evidenceSummary: "expired controller fenced; exact reviewed receipt queued for reconciliation",
    activeDeliveryAttemptId: nextDeliveryId, deliveryGeneration: nextGeneration,
    dispatchId: undefined, dispatchLeaseUntil: undefined, workerRunId: undefined, deliveryRunId: undefined,
    deliveryLeaseOwner: undefined, deliveryLeaseToken: undefined, deliveryLeaseUntil: undefined,
    heartbeatAt: now,
  });
  return { integrationAttemptId: attempt._id, jobId: job._id, deliveryAttemptId: nextDeliveryId };
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
    const now = Date.now();
    // Control may fence an in-flight provider request before its callback
    // returns. Even a correctly reconcile-only replacement must not classify
    // an exact object/ref as absent until the original server-owned state
    // deadline and bounded provider request have both elapsed.
    if (Number(attempt.reconcileAfter ?? 0) > now) return null;
    const mission: any = await ctx.db.get(attempt.missionId);
    const job: any = await ctx.db.get(attempt.jobId);
    const delivery: any = job?.activeDeliveryAttemptId ? await ctx.db.get(job.activeDeliveryAttemptId) : null;
    if (!mission || mission.mode !== "goal" || mission.status !== "running" || !job
      || job.integrationAttemptId !== attempt._id || job.deliveryRunId !== args.controllerRunId
      || delivery?.integrationAttemptId !== attempt._id || delivery?.deliveryRunId !== args.controllerRunId
      || delivery?.policy !== "mission_integration" || !["pending", "running"].includes(job.status)) return null;
    const head = await fifoHead(ctx, mission._id, attempt.repository);
    if (!head || head._id !== attempt._id) return null;
    if (mission.activeIntegrationAttemptId && mission.activeIntegrationAttemptId !== attempt._id
      && Number(mission.integrationLeaseUntil ?? 0) >= now) return null;
    if (attempt.controllerRunId && attempt.controllerRunId !== args.controllerRunId
      && Number(attempt.leaseUntil ?? 0) >= now) return null;
    const version = Math.max(Number(mission.integrationLeaseVersion ?? 0), Number(attempt.leaseVersion ?? 0)) + 1;
    const until = now + LEASE_MS;
    // A recovered attempt retains its original exact CAS and reviewed cold
    // receipt. A new generation binds them once from the authoritative head.
    const expectedIntegrationBaseSha = String(attempt.expectedIntegrationBaseSha ?? mission.integrationHeadSha ?? attempt.reviewedBaseSha);
    const expectedIntegrationRefSha = String(attempt.expectedIntegrationRefSha ?? mission.integrationHeadSha ?? ZERO_OID);
    await ctx.db.patch(attempt._id, {
      status: "claimed",
      controllerRunId: args.controllerRunId.slice(0, 160), leaseOwner: args.leaseOwner.slice(0, 160),
      leaseToken: args.leaseToken.slice(0, 160), leaseVersion: version, leaseUntil: until,
      expectedIntegrationBaseSha, expectedIntegrationRefSha, updatedAt: now,
      controllerState: "command", controllerStateSince: now,
      controllerDeadlineAt: now + CONTROLLER_STATE_MS.command, controllerHeartbeatAt: now,
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
    // Retained for rolling workers, but callers cannot choose or extend a
    // state deadline. The server owns the fixed budget below.
    deadlineAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    const attempt: any = await ctx.db.get(args.id);
    const mission: any = attempt ? await ctx.db.get(attempt.missionId) : null;
    // Job controls clear these two authority leases transactionally. Reading
    // the large job document on every pulse adds no fence that the mission and
    // attempt documents do not already provide.
    if (!exactFence(mission, attempt, args)) return false;
    const now = Date.now();
    if (Number(attempt.controllerDeadlineAt ?? 0) <= now) return false;
    const current = String(attempt.controllerState ?? "command") as keyof typeof CONTROLLER_STATE_MS;
    const requested = args.state ?? current;
    const allowed = current === requested
      || (current === "command" && requested === "provider")
      || (current === "provider" && requested === "reconcile");
    if (!allowed) return false;
    const transitioned = requested !== current;
    const until = now + LEASE_MS;
    await ctx.db.patch(attempt._id, {
      leaseUntil: until, controllerHeartbeatAt: now,
      ...(transitioned ? { controllerState: requested, controllerStateSince: now,
        controllerDeadlineAt: now + CONTROLLER_STATE_MS[requested] } : {}),
      updatedAt: now,
    });
    // The mission document is controller authority. Avoid rewriting its rich
    // runtime projection on every compact lease pulse.
    await ctx.db.patch(mission._id, { integrationLeaseUntil: until, updatedAt: now });
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
      || attempt.controlRequested && !await ctx.db.query("integrationProviderEffects")
        .withIndex("by_attempt_effect", (q: any) => q.eq("integrationAttemptId", attempt._id).eq("effectId", args.effectId)).first()
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
    if (Number(attempt.providerEffectCount ?? 0) >= MAX_PROVIDER_EFFECTS) return null;
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

async function queueSteeredContinuation(ctx: any, job: any, now: number) {
  const nextAttempt = Number(job.attempt ?? 1) + 1;
  const existing = await ctx.db.query("workAttempts")
    .withIndex("by_job_attempt", (q: any) => q.eq("jobId", job._id).eq("attempt", nextAttempt)).first();
  if (!existing) await ctx.db.insert("workAttempts", {
    jobId: job._id, attempt: nextAttempt, parentAttempt: job.attempt ?? 1, status: "pending",
    workspaceLineage: job.workspaceLineage,
    workspaceKey: job.workspaceLineage ? attemptWorkspaceKey(job.workspaceLineage, nextAttempt) : undefined,
    workerBranch: job.workerBranch, sourceHeadSha: job.sourceHeadSha,
    lastEventSeq: 0, livenessAt: now, progressAt: now, lastEventAt: now, createdAt: now,
  });
  await patchJobWithRuntime(ctx, job, {
    status: "pending", stage: "queued", progress: "provider truth reconciled — steering continuation queued",
    attempt: nextAttempt, startedAt: undefined, completedAt: undefined, nextRunAt: now,
    integrationAttemptId: undefined, integrationState: undefined, activeDeliveryAttemptId: undefined,
    reviewReceiptId: undefined, reviewReceiptDigest: undefined, reviewReceiptSignature: undefined,
    verificationVerdict: undefined, verificationNote: undefined, verifiedAt: undefined,
    dispatchId: undefined, dispatchLeaseUntil: undefined, workerRunId: undefined, deliveryRunId: undefined,
    deliveryLeaseOwner: undefined, deliveryLeaseToken: undefined, deliveryLeaseUntil: undefined,
    heartbeatAt: now,
  });
}

async function finalizeMissionControlIfSettled(ctx: any, mission: any) {
  const requested = mission?.controlRequested as "pause" | "cancel" | undefined;
  if (!requested) return;
  const attempts = await ctx.db.query("integrationAttempts")
    .withIndex("by_mission_generation", (q: any) => q.eq("missionId", mission._id)).take(100);
  if (attempts.some((attempt: any) => attempt.controlRequested)) return;
  const now = Date.now();
  const jobs = await ctx.db.query("jobs").withIndex("by_mission", (q: any) => q.eq("missionId", String(mission._id))).take(100);
  for (const child of jobs) {
    if (["done", "error", "cancelled"].includes(child.status)) continue;
    await patchJobWithRuntime(ctx, child, requested === "pause" ? {
      status: "paused", stage: "paused", progress: "Goal Mode paused after provider reconciliation",
      nextRunAt: undefined, deliveryLeaseOwner: undefined, deliveryLeaseToken: undefined, deliveryLeaseUntil: undefined,
    } : {
      status: "cancelled", stage: "cancelled", progress: "Goal Mode cancelled after provider reconciliation",
      completedAt: now, nextRunAt: undefined, deliveryLeaseOwner: undefined, deliveryLeaseToken: undefined, deliveryLeaseUntil: undefined,
    });
  }
  await patchMissionWithRuntime(ctx, mission, requested === "pause" ? {
    status: "paused", phase: "paused", controlRequested: undefined, controlRequestedAt: undefined,
    activeIntegrationAttemptId: undefined, integrationLeaseOwner: undefined, integrationLeaseToken: undefined,
    integrationLeaseUntil: undefined, updatedAt: now,
  } : {
    status: "cancelled", phase: "cancelled", controlRequested: undefined, controlRequestedAt: undefined,
    activeIntegrationAttemptId: undefined, integrationLeaseOwner: undefined, integrationLeaseToken: undefined,
    integrationLeaseUntil: undefined, completedAt: now, updatedAt: now,
  });
}

async function settleRequestedControlWithoutRef(ctx: any, attempt: any, mission: any, job: any) {
  const control = attempt.controlRequested as "pause" | "cancel" | "steer" | undefined;
  if (!control) return false;
  const effects = await ctx.db.query("integrationProviderEffects")
    .withIndex("by_attempt_prepared", (q: any) => q.eq("integrationAttemptId", attempt._id)).collect();
  if (effects.some((effect: any) => !effect.observation || effect.observation === "unknown")) return false;
  if (effects.some((effect: any) => effect.effectKind === "update_ref" && effect.observation === "applied")) return false;
  const now = Date.now();
  const delivery: any = job.activeDeliveryAttemptId ? await ctx.db.get(job.activeDeliveryAttemptId) : null;
  if (control === "pause") {
    await ctx.db.patch(attempt._id, {
      status: "queued", controlRequested: undefined, controlRequestedAt: undefined,
      reconcileAfter: undefined,
      controllerRunId: undefined, leaseOwner: undefined, leaseToken: undefined, leaseUntil: undefined,
      retryReason: "paused after exact provider reconciliation", updatedAt: now,
    });
    if (delivery?.integrationAttemptId === attempt._id) await ctx.db.patch(delivery._id, {
      status: "checkpointed", leaseOwner: undefined, leaseToken: undefined, leaseUntil: undefined,
      retryReason: "paused after exact provider reconciliation", heartbeatAt: now, updatedAt: now,
    });
    await patchJobWithRuntime(ctx, job, {
      status: "paused", stage: "paused", progress: "paused after exact provider reconciliation",
      integrationState: "queued", nextRunAt: undefined, deliveryRunId: undefined,
      deliveryLeaseOwner: undefined, deliveryLeaseToken: undefined, deliveryLeaseUntil: undefined,
      heartbeatAt: now,
    });
    await patchMissionWithRuntime(ctx, mission, {
      activeIntegrationAttemptId: undefined, integrationLeaseOwner: undefined, integrationLeaseToken: undefined,
      integrationLeaseUntil: undefined, updatedAt: now,
    });
    await finalizeMissionControlIfSettled(ctx, { ...mission, activeIntegrationAttemptId: undefined });
    return true;
  }
  const outcome = control === "cancel" ? "cancelled" : "stale";
  const terminal = await writeIntegrationTerminalReceipt(ctx, attempt, outcome, {
    reason: control === "cancel" ? "cancelled after exact provider reconciliation" : "superseded after exact provider reconciliation",
  });
  if (!terminal) return false;
  await ctx.db.patch(attempt._id, {
    status: outcome, outcome, terminalReceiptDigest: terminal.receiptDigest,
    controlRequested: undefined, controlRequestedAt: undefined, reconcileAfter: undefined, controllerRunId: undefined,
    leaseOwner: undefined, leaseToken: undefined, leaseUntil: undefined, completedAt: now, updatedAt: now,
  });
  if (delivery?.integrationAttemptId === attempt._id) await ctx.db.patch(delivery._id, {
    status: "blocked", outcome, currentStep: "terminal", terminalReceiptDigest: terminal.receiptDigest,
    leaseOwner: undefined, leaseToken: undefined, leaseUntil: undefined,
    completedAt: now, heartbeatAt: now, updatedAt: now,
  });
  await patchMissionWithRuntime(ctx, mission, {
    activeIntegrationAttemptId: undefined, integrationLeaseOwner: undefined, integrationLeaseToken: undefined,
    integrationLeaseUntil: undefined, updatedAt: now,
  });
  if (control === "steer") await queueSteeredContinuation(ctx, job, now);
  else await patchJobWithRuntime(ctx, job, {
    status: "cancelled", stage: "cancelled", completedAt: now, nextRunAt: undefined,
    integrationState: "cancelled", progress: "cancelled after exact provider reconciliation",
    deliveryLeaseOwner: undefined, deliveryLeaseToken: undefined, deliveryLeaseUntil: undefined,
  });
  await wakeNextIntegration(ctx, attempt);
  await finalizeMissionControlIfSettled(ctx, mission);
  return true;
}

export const settleControl = mutation({
  args: { ...fenceArgs },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    const attempt: any = await ctx.db.get(args.id);
    const mission: any = attempt ? await ctx.db.get(attempt.missionId) : null;
    const job: any = attempt ? await ctx.db.get(attempt.jobId) : null;
    if (!job || !exactFence(mission, attempt, args, job)) return false;
    return await settleRequestedControlWithoutRef(ctx, attempt, mission, job);
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
    const requestedControl = attempt.controlRequested as "pause" | "cancel" | "steer" | undefined;
    const terminalOutcome = requestedControl === "cancel" ? "cancelled" : requestedControl === "steer" ? "stale" : "integrated";
    const terminal = await writeIntegrationTerminalReceipt(ctx, attempt, terminalOutcome, requestedControl
      ? { reason: `${requestedControl} requested during the applied final CAS; provider truth reconciled first` }
      : undefined);
    if (!terminal) return false;
    const now = Date.now();
    await ctx.db.patch(attempt._id, {
      status: terminalOutcome, outcome: terminalOutcome, terminalReceiptDigest: terminal.receiptDigest,
      controlRequested: undefined, controlRequestedAt: undefined, reconcileAfter: undefined,
      leaseUntil: undefined, completedAt: now, updatedAt: now,
    });
    if (job.activeDeliveryAttemptId) {
      const delivery: any = await ctx.db.get(job.activeDeliveryAttemptId);
      if (delivery?.integrationAttemptId === attempt._id) await ctx.db.patch(delivery._id, {
        status: requestedControl && requestedControl !== "pause" ? "blocked" : "done",
        outcome: requestedControl === "cancel" ? "cancelled" : requestedControl === "steer" ? "stale" : "mission_integrated", currentStep: "terminal",
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
    if (requestedControl === "steer") await queueSteeredContinuation(ctx, job, now);
    else await patchJobWithRuntime(ctx, job, {
      status: requestedControl === "pause" ? "paused" : requestedControl === "cancel" ? "cancelled" : "done",
      stage: requestedControl === "pause" ? "paused" : requestedControl === "cancel" ? "cancelled" : "integrated",
      percent: requestedControl ? job.percent : 100, completedAt: requestedControl === "pause" ? undefined : now, heartbeatAt: now,
      nextRunAt: undefined, integrationState: requestedControl === "cancel" ? "cancelled" : "integrated",
      deliveryStatus: "merged", mergeCommitSha: attempt.preparedIntegrationHeadSha,
      evidenceSummary: `review ${attempt.reviewReceiptDigest.slice(0, 12)} reconciled at ${attempt.preparedIntegrationHeadSha.slice(0, 12)}`,
      progress: requestedControl ? `${requestedControl} preserved after the applied provider ref was reconciled` : "reviewed worker receipt integrated into the mission head",
    });
    const prior = await ctx.db.query("workReceipts")
      .withIndex("by_job_attempt", (q: any) => q.eq("jobId", job._id).eq("attempt", attempt.workAttempt)).first();
    if (!prior) await ctx.db.insert("workReceipts", {
      jobId: job._id, attempt: attempt.workAttempt, status: terminalOutcome === "integrated" ? "succeeded" : terminalOutcome,
      acceptanceEvidence: [String(job.verificationNote ?? "controller review passed")],
      artifacts: [attempt.workerBranch, attempt.integrationBranch, attempt.preparedIntegrationHeadSha],
      verification: "pass", deliveryOutcome: terminalOutcome === "integrated" ? "mission_integrated" : terminalOutcome,
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
    await finalizeMissionControlIfSettled(ctx, mission);
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
  const effects = await ctx.db.query("integrationProviderEffects")
    .withIndex("by_attempt_prepared", (q: any) => q.eq("integrationAttemptId", attempt._id)).collect();
  const requiresReconciliation = effects.some((effect: any) => !effect.observation || effect.observation === "unknown"
    || (effect.effectKind === "update_ref" && effect.observation === "applied"));
  if (mission?.activeIntegrationAttemptId === attempt._id) await patchMissionWithRuntime(ctx, mission, {
    activeIntegrationAttemptId: undefined, integrationLeaseOwner: undefined, integrationLeaseToken: undefined,
    integrationLeaseUntil: undefined, updatedAt: now,
  });
  if (requiresReconciliation) {
    const originalDeadline = Math.max(now, Math.min(
      now + CONTROLLER_STATE_MS.provider,
      Number(attempt.controllerDeadlineAt ?? now),
    ));
    const reconcileAfter = Math.max(now + 90_000, originalDeadline + 1);
    let nextDeliveryId = delivery?._id;
    let nextGeneration = Number(delivery?.generation ?? job.deliveryGeneration ?? 1);
    if (delivery && !["done", "blocked", "abandoned"].includes(delivery.status)) {
      nextGeneration += 1;
      nextDeliveryId = await ctx.db.insert("deliveryAttempts", {
        jobId: job._id, sourceWorkAttempt: attempt.workAttempt, generation: nextGeneration,
        policy: "mission_integration", status: "checkpointed", parentDeliveryAttemptId: delivery._id,
        ...carriedIntegrationDelivery(delivery), heartbeatAt: now, retries: 0,
        cumulativeRetries: Number(delivery.cumulativeRetries ?? 0), currentStep: "queued",
        retryReason: `${action} requested; provider reconciliation required`, createdAt: now, updatedAt: now,
      });
      await ctx.db.patch(delivery._id, {
        status: "abandoned", completedAt: now, leaseOwner: undefined, leaseToken: undefined,
        leaseUntil: undefined, retryReason: `${action} requested during provider effect`, updatedAt: now,
      });
    }
    await ctx.db.patch(attempt._id, {
      status: "queued", controlRequested: action, controlRequestedAt: now, reconcileAfter,
      leaseOwner: undefined, leaseToken: undefined, leaseUntil: undefined,
      retryReason: `${action} requested; exact provider reconciliation pending`, updatedAt: now,
    });
    await patchJobWithRuntime(ctx, job, {
      status: "pending", stage: `${action} requested`, progress: `${action} requested — reconciling an in-flight provider effect`,
      integrationState: `${action}_requested`, nextRunAt: reconcileAfter,
      activeDeliveryAttemptId: nextDeliveryId, deliveryGeneration: nextGeneration,
      dispatchId: undefined, dispatchLeaseUntil: undefined, workerRunId: undefined, deliveryRunId: undefined,
      deliveryLeaseOwner: undefined, deliveryLeaseToken: undefined, deliveryLeaseUntil: undefined,
      heartbeatAt: now,
    });
    return { terminal: false, reconcile: true, outcome: `${action}_requested` };
  }
  if (action === "pause") {
    await ctx.db.patch(attempt._id, {
      status: "queued", leaseOwner: undefined, leaseToken: undefined,
      leaseUntil: undefined, retryReason: "paused by job control", updatedAt: now,
    });
    if (delivery && !["done", "blocked", "abandoned"].includes(delivery.status)) await ctx.db.patch(delivery._id, {
      status: "checkpointed", leaseOwner: undefined, leaseToken: undefined, leaseUntil: undefined,
      retryReason: "paused by job control", heartbeatAt: now, updatedAt: now,
    });
    return { terminal: false, reconcile: false };
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
