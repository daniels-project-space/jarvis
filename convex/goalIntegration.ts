import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireViewer, requireWorker, viewerAuthArgs } from "./controlAuth";
import {
  activateStagedJobWorkOrderRevision,
  ensureWorkAttempt,
  insertJobWithRuntime,
  patchJobWithRuntime,
  patchMissionWithRuntime,
  promoteCompletedJobDependents,
  readAttemptExecutionAuthority,
} from "./controlPlane";
import { ensureGoalNodeHandoff } from "./goalHandoffs";
import { sealProjectSourceAdmission } from "../src/lib/source-admission";

const LEASE_MS = 45_000;
const CONTROLLER_STATE_MS = { command: 2 * 60_000, provider: 5 * 60_000, reconcile: 2 * 60_000 } as const;
const MAX_PROVIDER_EFFECTS = 1_024;
export const INTEGRATION_RECONCILIATION_LIMIT = 16;
export const INTEGRATION_TERMINAL_RECEIPT_MAX_BYTES = 600_000;
export const INTEGRATION_TERMINAL_RECEIPT_TARGET_BYTES = 180_000;
export const INTEGRATION_TERMINAL_MAX_WORK_ATTEMPTS = 32;
export const INTEGRATION_TERMINAL_MAX_DELIVERIES = 64;
export const INTEGRATION_EFFECT_COLUMNS = [
  "effectIdDigest", "kind", "providerIdentityDigest", "requestDigest", "expectedBaseSha",
  "headSha", "treeSha", "observation", "providerHeadSha", "providerResponseDigest",
] as const;
const MISSION_HORIZON_MS = 14 * 86_400_000;
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

function serializedBytes(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function compactEffectManifest(effect: Awaited<ReturnType<typeof integrationEffectManifest>>) {
  return INTEGRATION_EFFECT_COLUMNS.map((column) => (effect as Record<string, unknown>)[column] ?? null);
}

export function expandIntegrationEffectManifest(row: unknown[]) {
  return Object.fromEntries(INTEGRATION_EFFECT_COLUMNS.map((column, index) => [column, row[index] ?? null]));
}

function integratedEffectChainMatches(attempt: any, effects: any[], finalEffectId?: string) {
  if (!SHA.test(String(attempt.preparedIntegrationHeadSha ?? ""))
    || !SHA.test(String(attempt.preparedIntegrationTreeSha ?? ""))
    || effects.length !== Number(attempt.providerEffectCount ?? effects.length)) return false;
  const finalEffects = effects.filter((effect: any) => effect.effectKind === "update_ref");
  if (finalEffects.length !== 1) return false;
  const final = finalEffects[0];
  if (finalEffectId && final.effectId !== finalEffectId) return false;
  if (final.effectId !== attempt.preparedEffectId
    || final.expectedBaseSha !== attempt.expectedIntegrationRefSha
    || final.headSha !== attempt.preparedIntegrationHeadSha
    || final.treeSha !== attempt.preparedIntegrationTreeSha) return false;
  return effects.every((effect: any) => {
    if (effect.observation !== "applied" || effect.providerHeadSha !== effect.headSha
      || effect.treeSha !== attempt.preparedIntegrationTreeSha) return false;
    if (effect.effectKind === "stage_blob") return SHA.test(String(effect.headSha ?? ""));
    if (effect.effectKind === "stage_tree") return effect.headSha === attempt.preparedIntegrationTreeSha;
    if (effect.effectKind === "stage_commit") return effect.headSha === attempt.preparedIntegrationHeadSha;
    return effect.effectKind === "update_ref";
  });
}

export type IntegrationTerminalReleaseDecision = Readonly<{
  releasable: boolean;
  state: "unresolved" | "resolved_without_applied_final" | "applied_final";
  reason?: string;
  finalEffectId?: string;
  appliedHeadSha?: string;
}>;

/** The one provider-truth predicate used before any terminal receipt or FIFO release. */
export function integrationTerminalReleaseDecision(attempt: any, effects: any[]): IntegrationTerminalReleaseDecision {
  if (effects.length !== Number(attempt.providerEffectCount ?? effects.length)) {
    return { releasable: false, state: "unresolved", reason: "provider effect count does not match cold authority" };
  }
  if (effects.some((effect: any) => !["applied", "not_applied"].includes(String(effect.observation ?? "")))) {
    return { releasable: false, state: "unresolved", reason: "a prepared provider effect is unobserved or unknown" };
  }
  if (effects.some((effect: any) => effect.observation === "applied" && effect.providerHeadSha !== effect.headSha)) {
    return { releasable: false, state: "unresolved", reason: "an applied provider effect lacks its exact immutable identity" };
  }
  const appliedFinals = effects.filter((effect: any) => effect.effectKind === "update_ref" && effect.observation === "applied");
  if (!appliedFinals.length) return { releasable: true, state: "resolved_without_applied_final" };
  if (appliedFinals.length !== 1 || !integratedEffectChainMatches(attempt, effects, appliedFinals[0].effectId)) {
    return { releasable: false, state: "unresolved", reason: "the applied final effect chain is not exact and complete" };
  }
  return {
    releasable: true,
    state: "applied_final",
    finalEffectId: appliedFinals[0].effectId,
    appliedHeadSha: appliedFinals[0].headSha,
  };
}

function reconciliationDelayMs(retries: number) {
  return Math.min(6 * 60 * 60_000, 5 * 60_000 * 2 ** Math.max(0, retries - 1));
}

function reconciliationBudget(attempt: any, now: number) {
  const retries = Number(attempt.cumulativeRetries ?? 0) + 1;
  return {
    retries,
    exhausted: retries > INTEGRATION_RECONCILIATION_LIMIT || now - Number(attempt.createdAt ?? now) >= MISSION_HORIZON_MS,
    nextRunAt: now + reconciliationDelayMs(retries),
  };
}

export type ReceiptWriteBlocked = Readonly<{
  blocked: true;
  code: "provider_effects_unresolved" | "applied_final_requires_completion" | "byte_limit";
  serializedBytes?: number;
  byteLimit: number;
}>;

export function integrationTerminalReceiptByteGuard(receiptJson: string):
  | Readonly<{ blocked: false; serializedBytes: number; byteLimit: number }>
  | ReceiptWriteBlocked {
  const receiptBytes = serializedBytes(receiptJson);
  return receiptBytes > INTEGRATION_TERMINAL_RECEIPT_MAX_BYTES
    ? { blocked: true, code: "byte_limit", serializedBytes: receiptBytes, byteLimit: INTEGRATION_TERMINAL_RECEIPT_MAX_BYTES }
    : { blocked: false, serializedBytes: receiptBytes, byteLimit: INTEGRATION_TERMINAL_RECEIPT_MAX_BYTES };
}

function storedTerminalReceipt(value: any): value is { receiptDigest: string; receiptJson: string; outcome: string } {
  return Boolean(value && value.blocked !== true && typeof value.receiptDigest === "string");
}

/** Build and insert a canonical terminal receipt only from authoritative rows. */
async function writeIntegrationTerminalReceipt(ctx: any, attempt: any, outcome: string, detail?: {
  reason?: string;
  repairJobId?: any;
  cumulativeRetries?: number;
  appliedFinalEffectId?: string;
}) {
  const [existing, mission, job, review, workAttempts, deliveryAttempts, coldEffects] = await Promise.all([
    ctx.db.query("integrationTerminalReceipts")
      .withIndex("by_attempt", (q: any) => q.eq("integrationAttemptId", attempt._id)).first(),
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
  const executionAuthority = await readAttemptExecutionAuthority(ctx, job, Number(attempt.workAttempt));
  if (!executionAuthority
    || attempt.authorityDigest !== executionAuthority.authorityDigest
    || attempt.schedulingBindingDigest !== executionAuthority.schedulingBindingDigest
    || attempt.workOrderRevisionId !== executionAuthority.workOrderRevisionId
    || attempt.workOrderRevision !== executionAuthority.workOrderRevision
    || attempt.workOrderRevisionDigest !== executionAuthority.workOrderRevisionDigest
    || review.authorityDigest !== executionAuthority.authorityDigest
    || review.schedulingBindingDigest !== executionAuthority.schedulingBindingDigest
    || review.workOrderRevisionId !== executionAuthority.workOrderRevisionId
    || review.workOrderRevision !== executionAuthority.workOrderRevision
    || review.workOrderRevisionDigest !== executionAuthority.workOrderRevisionDigest) return null;
  const delivery: any = job.activeDeliveryAttemptId ? await ctx.db.get(job.activeDeliveryAttemptId) : null;
  if (!delivery || delivery.integrationAttemptId !== attempt._id
    || delivery.sourceWorkAttempt !== attempt.workAttempt
    || delivery.reviewReceiptId !== attempt.reviewReceiptId
    || delivery.reviewReceiptDigest !== attempt.reviewReceiptDigest
    || delivery.reviewedBaseSha !== attempt.reviewedBaseSha
    || delivery.reviewedHeadSha !== attempt.reviewedHeadSha
    || delivery.authorityDigest !== executionAuthority.authorityDigest
    || delivery.schedulingBindingDigest !== executionAuthority.schedulingBindingDigest
    || delivery.workOrderRevisionId !== executionAuthority.workOrderRevisionId
    || delivery.workOrderRevision !== executionAuthority.workOrderRevision
    || delivery.workOrderRevisionDigest !== executionAuthority.workOrderRevisionDigest
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
  const release = integrationTerminalReleaseDecision(attempt, orderedEffects);
  if (!release.releasable) return {
    blocked: true, code: "provider_effects_unresolved", byteLimit: INTEGRATION_TERMINAL_RECEIPT_MAX_BYTES,
  } satisfies ReceiptWriteBlocked;
  if (release.state === "applied_final" && detail?.appliedFinalEffectId !== release.finalEffectId) return {
    blocked: true, code: "applied_final_requires_completion", byteLimit: INTEGRATION_TERMINAL_RECEIPT_MAX_BYTES,
  } satisfies ReceiptWriteBlocked;
  if (outcome === "integrated" && release.state !== "applied_final") return null;
  if (existing) return existing.outcome === outcome
    && existing.workOrderRevisionDigest === executionAuthority.workOrderRevisionDigest ? existing : null;
  const sourceAttempt = workAttempts.find((row: any) => row.attempt === attempt.workAttempt);
  if (!sourceAttempt || sourceAttempt.authorityDigest !== executionAuthority.authorityDigest
    || sourceAttempt.workOrderRevisionDigest !== executionAuthority.workOrderRevisionDigest) return null;
  const orderedWorkAttempts = workAttempts.sort((a: any, b: any) => a.attempt - b.attempt || String(a._id).localeCompare(String(b._id)));
  const orderedDeliveries = deliveryAttempts
    .filter((row: any) => row.jobId === attempt.jobId && row.integrationAttemptId === attempt._id)
    .sort((left: any, right: any) => left.generation - right.generation || String(left._id).localeCompare(String(right._id)));
  const workspaceAttemptManifests = orderedWorkAttempts.map((row: any) => ({
    id: String(row._id), attempt: row.attempt, parentAttempt: row.parentAttempt ?? null, workspaceKey: row.workspaceKey ?? null,
    workOrderRevisionDigest: row.workOrderRevisionDigest ?? null,
    workspaceLineage: row.workspaceLineage ?? null, workerBranch: row.workerBranch ?? null,
    sourceHeadSha: row.sourceHeadSha ?? null, parentCheckpointHeadSha: row.parentCheckpointHeadSha ?? null,
    checkpointHeadSha: row.checkpointHeadSha ?? null, workerRunId: row.workerRunId ?? null,
    providerWorkspaceId: row.providerWorkspaceId ?? null, providerSessionId: row.providerSessionId ?? null,
  }));
  const deliveryManifests = orderedDeliveries.map((row: any) => ({
    id: String(row._id), generation: row.generation,
    workOrderRevisionDigest: row.workOrderRevisionDigest ?? null,
    parentDeliveryAttemptId: row.parentDeliveryAttemptId ? String(row.parentDeliveryAttemptId) : null,
    sourceWorkAttempt: row.sourceWorkAttempt, deliveryRunId: row.deliveryRunId ?? null,
    reviewReceiptId: row.reviewReceiptId ? String(row.reviewReceiptId) : null,
    reviewReceiptDigest: row.reviewReceiptDigest ?? null, reviewKeyId: row.reviewKeyId ?? null,
    cumulativeRetries: row.cumulativeRetries ?? 0, currentStep: row.currentStep ?? null,
    status: row.status, outcome: row.outcome ?? null,
  }));
  const receiptCore = {
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
      workOrderRevision: executionAuthority.workOrderRevision,
      workOrderRevisionDigest: executionAuthority.workOrderRevisionDigest,
    },
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
      expectedBaseObservedAt: attempt.expectedIntegrationBaseObservedAt ?? null,
      expectedRefSha: attempt.expectedIntegrationRefSha ?? null,
      preparedHeadSha: attempt.preparedIntegrationHeadSha ?? null,
      preparedTreeSha: attempt.preparedIntegrationTreeSha ?? null,
    },
    controller: {
      runId: attempt.controllerRunId ?? null, leaseVersion: attempt.leaseVersion,
      deliveryRunId: delivery?.deliveryRunId ?? job.deliveryRunId ?? null,
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
  };
  const inlineReceipt = canonicalValue({
    ...receiptCore,
    lineageMode: "inline",
    workspaceAttempts: workspaceAttemptManifests,
    deliveryLineage: deliveryManifests,
    providerEffects: {
      count: effects.length, orderedEffectIdentityDigest,
      columns: INTEGRATION_EFFECT_COLUMNS, ordered: effects.map(compactEffectManifest),
    },
  });
  const inlineJson = JSON.stringify(inlineReceipt);
  const compactMode = orderedWorkAttempts.length > INTEGRATION_TERMINAL_MAX_WORK_ATTEMPTS
    || orderedDeliveries.length > INTEGRATION_TERMINAL_MAX_DELIVERIES
    || serializedBytes(inlineJson) > INTEGRATION_TERMINAL_RECEIPT_TARGET_BYTES;
  const boundedEnds = <T>(rows: T[]) => ({ head: rows.slice(0, 2), tail: rows.slice(Math.max(2, rows.length - 2)) });
  const compactWorkSummary = workspaceAttemptManifests.map((row: any) => ({
    id: row.id, attempt: row.attempt, parentAttempt: row.parentAttempt,
    sourceHeadSha: row.sourceHeadSha, checkpointHeadSha: row.checkpointHeadSha,
  }));
  const compactDeliverySummary = deliveryManifests.map((row: any) => ({
    id: row.id, generation: row.generation, sourceWorkAttempt: row.sourceWorkAttempt,
    cumulativeRetries: row.cumulativeRetries, status: row.status, outcome: row.outcome,
  }));
  const compactEffects = effects.map(compactEffectManifest);
  const finalEffectIndex = orderedEffects.findIndex((effect: any) => effect.effectId === attempt.preparedEffectId);
  const receipt = compactMode ? canonicalValue({
    ...receiptCore,
    version: 2,
    lineageMode: "compact_manifest",
    workspaceAttempts: {
      count: workspaceAttemptManifests.length,
      orderedDigest: await sha256Hex(JSON.stringify(canonicalValue(workspaceAttemptManifests))),
      ...boundedEnds(compactWorkSummary),
    },
    deliveryLineage: {
      count: deliveryManifests.length,
      orderedDigest: await sha256Hex(JSON.stringify(canonicalValue(deliveryManifests))),
      ...boundedEnds(compactDeliverySummary),
    },
    providerEffects: {
      count: effects.length, orderedEffectIdentityDigest, columns: INTEGRATION_EFFECT_COLUMNS,
      mode: "compact_manifest", ...boundedEnds(compactEffects),
      final: finalEffectIndex >= 0 ? compactEffects[finalEffectIndex] : null,
    },
  }) : inlineReceipt;
  const receiptJson = compactMode ? JSON.stringify(receipt) : inlineJson;
  const receiptGuard = integrationTerminalReceiptByteGuard(receiptJson);
  if (receiptGuard.blocked) return receiptGuard;
  const receiptDigest = await sha256Hex(receiptJson);
  const id = await ctx.db.insert("integrationTerminalReceipts", {
    missionId: attempt.missionId, jobId: attempt.jobId, integrationAttemptId: attempt._id,
    workOrderRevisionDigest: executionAuthority.workOrderRevisionDigest,
    outcome, receiptJson, receiptDigest, createdAt: Date.now(),
  });
  return { _id: id, outcome, receiptJson, receiptDigest };
}

const NONTERMINAL = ["queued", "claimed", "prepared", "provider_waiting"] as const;

async function authoritativeProviderEffects(ctx: any, attempt: any) {
  const cold = await ctx.db.query("integrationProviderEffects")
    .withIndex("by_attempt_prepared", (q: any) => q.eq("integrationAttemptId", attempt._id)).collect();
  return [...(cold.length ? cold : (attempt.effects ?? []))]
    .sort((left: any, right: any) => left.preparedAt - right.preparedAt || left.effectId.localeCompare(right.effectId));
}

async function terminalReleaseDecisionForAttempt(ctx: any, attempt: any) {
  return integrationTerminalReleaseDecision(attempt, await authoritativeProviderEffects(ctx, attempt));
}

async function fifoHead(ctx: any, missionId: any, repository: string) {
  const candidates = await Promise.all(NONTERMINAL.map((status) => ctx.db.query("integrationAttempts")
    .withIndex("by_mission_repository_status_generation", (q: any) => q.eq("missionId", missionId).eq("repository", repository).eq("status", status))
    .order("asc").first()));
  return candidates.filter(Boolean).sort((left: any, right: any) => left.generation - right.generation)[0] ?? null;
}

async function wakeNextIntegration(ctx: any, attempt: any) {
  const current: any = await ctx.db.get(attempt._id);
  if (!current || !TERMINAL.has(current.status) || !current.terminalReceiptDigest) return false;
  const [receipt, mission, release] = await Promise.all([
    ctx.db.query("integrationTerminalReceipts")
      .withIndex("by_attempt", (q: any) => q.eq("integrationAttemptId", current._id)).first(),
    ctx.db.get(current.missionId),
    terminalReleaseDecisionForAttempt(ctx, current),
  ]);
  if (!receipt || receipt.receiptDigest !== current.terminalReceiptDigest || receipt.outcome !== current.outcome
    || !release.releasable
    || (release.state === "applied_final" && mission?.integrationHeadSha !== release.appliedHeadSha)) return false;
  await resolveIntegrationAttention(ctx, current, Date.now());
  const next: any = await fifoHead(ctx, attempt.missionId, attempt.repository);
  if (!next) return true;
  await ctx.db.patch(next._id, { status: "queued", updatedAt: Date.now() });
  const job: any = await ctx.db.get(next.jobId);
  if (job && job.status === "pending") await patchJobWithRuntime(ctx, job, {
    integrationState: "queued", nextRunAt: Date.now(), evidenceSummary: "signed review is next in the repository integration FIFO",
  });
  return true;
}

function carriedIntegrationDelivery(delivery: any) {
  return {
    authorityDigest: delivery.authorityDigest,
    schedulingBindingDigest: delivery.schedulingBindingDigest,
    workOrderRevisionId: delivery.workOrderRevisionId,
    workOrderRevision: delivery.workOrderRevision,
    workOrderRevisionDigest: delivery.workOrderRevisionDigest,
    canonicalProjectId: delivery.canonicalProjectId,
    repository: delivery.repository,
    missionGroupId: delivery.missionGroupId,
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

async function openIntegrationAttention(ctx: any, job: any, attempt: any, now: number) {
  const fingerprint = `integration-reconciliation:${String(attempt._id)}`;
  const existing: any = await ctx.db.query("attentionItems")
    .withIndex("by_fingerprint", (q: any) => q.eq("fingerprint", fingerprint)).first();
  const item = {
    fingerprint, project: attempt.repository,
    title: "Mission integration needs reconciliation attention",
    detail: "Automatic reconciliation reached its bounded budget while exact provider truth remained unresolved. The signed receipt and cold effects remain the FIFO head; resume retries this controller authority without rerunning the specialist.",
    evidence: [`Job ${String(job._id)}`, `Integration ${String(attempt._id)}`, `Specialist attempt ${attempt.workAttempt}`],
    severity: "error", impact: 95, urgency: 80, confidence: 1,
    actionClass: "ask", status: "open", jobId: String(job._id), updatedAt: now,
  };
  if (existing) {
    await ctx.db.patch(existing._id, item);
    return existing._id;
  }
  return await ctx.db.insert("attentionItems", { ...item, createdAt: now });
}

async function resolveIntegrationAttention(ctx: any, attempt: any, now: number) {
  const attention: any = await ctx.db.query("attentionItems")
    .withIndex("by_fingerprint", (q: any) => q.eq("fingerprint", `integration-reconciliation:${String(attempt._id)}`)).first();
  if (attention && attention.status !== "resolved") await ctx.db.patch(attention._id, { status: "resolved", updatedAt: now });
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
  const executionAuthority = job
    ? await readAttemptExecutionAuthority(ctx, job, Number(attempt.workAttempt))
    : null;
  const delivery: any = job?.activeDeliveryAttemptId ? await ctx.db.get(job.activeDeliveryAttemptId) : null;
  if (!mission || !job || !executionAuthority
    || attempt.authorityDigest !== executionAuthority.authorityDigest
    || attempt.schedulingBindingDigest !== executionAuthority.schedulingBindingDigest
    || attempt.workOrderRevisionId !== executionAuthority.workOrderRevisionId
    || attempt.workOrderRevision !== executionAuthority.workOrderRevision
    || attempt.workOrderRevisionDigest !== executionAuthority.workOrderRevisionDigest
    || attempt.repository !== executionAuthority.repository
    || attempt.integrationLineage !== executionAuthority.integrationLineage
    || job.integrationAttemptId !== attempt._id
    || delivery?.integrationAttemptId !== attempt._id || delivery.status !== "running"
    || delivery.authorityDigest !== executionAuthority.authorityDigest
    || delivery.workOrderRevisionDigest !== executionAuthority.workOrderRevisionDigest
    || mission.activeIntegrationAttemptId !== attempt._id) return null;
  const head = await fifoHead(ctx, attempt.missionId, attempt.repository);
  if (!head || head._id !== attempt._id) return null;
  const budget = reconciliationBudget(attempt, now);
  const nextGeneration = Number(delivery.generation) + 1;
  let nextDeliveryId = delivery._id;
  if (!budget.exhausted) {
    const existing: any = await ctx.db.query("deliveryAttempts")
      .withIndex("by_job_source_generation", (q: any) => q.eq("jobId", job._id)
        .eq("sourceWorkAttempt", attempt.workAttempt).eq("generation", nextGeneration)).first();
    if (existing) return null;
    nextDeliveryId = await ctx.db.insert("deliveryAttempts", {
      jobId: job._id, sourceWorkAttempt: attempt.workAttempt, generation: nextGeneration,
      policy: "mission_integration", status: "checkpointed", parentDeliveryAttemptId: delivery._id,
      ...carriedIntegrationDelivery(delivery), heartbeatAt: now, retries: 0,
      cumulativeRetries: budget.retries, currentStep: "queued", retryReason: "integration controller expired",
      createdAt: now, updatedAt: now,
    });
  }
  await ctx.db.patch(delivery._id, budget.exhausted ? {
    status: "checkpointed", leaseOwner: undefined, leaseToken: undefined, leaseUntil: undefined,
    retryReason: "integration reconciliation budget exhausted", heartbeatAt: now, updatedAt: now,
  } : {
    status: "abandoned", completedAt: now, leaseOwner: undefined, leaseToken: undefined,
    leaseUntil: undefined, retryReason: "integration controller expired", updatedAt: now,
  });
  await ctx.db.patch(attempt._id, {
    status: budget.exhausted ? "provider_waiting" : "queued",
    controllerRunId: undefined, leaseOwner: undefined, leaseToken: undefined,
    leaseUntil: undefined, controllerHeartbeatAt: now, retryReason: "integration controller expired",
    cumulativeRetries: budget.retries,
    reconciliationAttentionAt: budget.exhausted ? now : undefined,
    updatedAt: now,
  });
  await patchMissionWithRuntime(ctx, mission, {
    activeIntegrationAttemptId: undefined, integrationLeaseOwner: undefined, integrationLeaseToken: undefined,
    integrationLeaseUntil: undefined, updatedAt: now,
  });
  await patchJobWithRuntime(ctx, job, {
    status: budget.exhausted ? "needs_input" : "pending",
    stage: budget.exhausted ? "integration attention" : "delivery",
    nextRunAt: budget.exhausted ? undefined : budget.nextRunAt,
    integrationState: budget.exhausted ? "needs_attention"
      : attempt.controlRequested ? `${attempt.controlRequested}_requested` : "retry_due",
    evidenceSummary: budget.exhausted
      ? `integration reconciliation needs attention after ${budget.retries - 1} automatic retries`
      : `expired controller fenced; reconciliation ${budget.retries}/${INTEGRATION_RECONCILIATION_LIMIT} retained`,
    activeDeliveryAttemptId: nextDeliveryId,
    deliveryGeneration: budget.exhausted ? Number(delivery.generation) : nextGeneration,
    dispatchId: undefined, dispatchLeaseUntil: undefined, workerRunId: undefined, deliveryRunId: undefined,
    deliveryLeaseOwner: undefined, deliveryLeaseToken: undefined, deliveryLeaseUntil: undefined,
    heartbeatAt: now,
  });
  await appendEvent(ctx, job, budget.exhausted ? "integration_attention" : "integration_retry_due",
    budget.exhausted ? "Automatic reconciliation budget exhausted; provider truth retained as FIFO head" : "Expired integration controller queued for bounded reconciliation", {
      retries: budget.retries, retryLimit: INTEGRATION_RECONCILIATION_LIMIT,
    });
  if (budget.exhausted) await openIntegrationAttention(ctx, job, attempt, now);
  return { integrationAttemptId: attempt._id, jobId: job._id, deliveryAttemptId: nextDeliveryId, attention: budget.exhausted };
}

async function exactFence(ctx: any, mission: any, attempt: any, args: any, suppliedJob?: any) {
  const job = suppliedJob ?? (attempt?.jobId ? await ctx.db.get(attempt.jobId) : null);
  const executionAuthority = job
    ? await readAttemptExecutionAuthority(ctx, job, Number(attempt?.workAttempt))
    : null;
  return mission?.status === "running"
    && job?.status === "running"
    && executionAuthority
    && mission?.activeIntegrationAttemptId === attempt?._id
    && attempt.controllerRunId === args.controllerRunId
    && attempt.leaseOwner === args.leaseOwner
    && attempt.leaseToken === args.leaseToken
    && attempt.leaseVersion === args.leaseVersion
    && attempt.authorityDigest === args.authorityDigest
    && attempt.authorityDigest === executionAuthority.authorityDigest
    && attempt.schedulingBindingDigest === executionAuthority.schedulingBindingDigest
    && attempt.workOrderRevisionId === executionAuthority.workOrderRevisionId
    && attempt.workOrderRevision === executionAuthority.workOrderRevision
    && attempt.workOrderRevisionDigest === executionAuthority.workOrderRevisionDigest
    && attempt.repository === executionAuthority.repository
    && attempt.integrationLineage === executionAuthority.integrationLineage
    && Number(attempt.leaseUntil ?? 0) >= Date.now()
    && mission.integrationLeaseVersion === args.leaseVersion
    && mission.integrationLeaseOwner === args.leaseOwner
    && mission.integrationLeaseToken === args.leaseToken;
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
  const executionAuthority = await readAttemptExecutionAuthority(ctx, job, Number(job.attempt ?? 1));
  if (!executionAuthority || executionAuthority.repository !== job.repo
    || executionAuthority.integrationLineage !== job.integrationLineage) return null;
  const existing = await ctx.db.query("integrationAttempts")
    .withIndex("by_job_attempt", (q: any) => q.eq("jobId", job._id).eq("workAttempt", job.attempt ?? 1)).first();
  if (existing) return existing.reviewReceiptDigest === reviewReceiptDigest
    && existing.authorityDigest === executionAuthority.authorityDigest
    && existing.workOrderRevisionDigest === executionAuthority.workOrderRevisionDigest ? existing : null;
  const generation = Number(mission.integrationGeneration ?? 0) + 1;
  const now = Date.now();
  const waiting = Boolean(await fifoHead(ctx, missionId, job.repo));
  const id = await ctx.db.insert("integrationAttempts", {
    missionId, jobId: job._id, workAttempt: job.attempt ?? 1, generation,
    revisionWave: Number(job.goalWave ?? 0), workstreamId: String(job.goalWorkstreamId ?? job._id),
    repository: job.repo, sourceBranch: String(job.sourceBranch ?? mission.sourceBranch ?? "main"),
    workerBranch: job.workerBranch, integrationBranch: job.integrationBranch,
    authorityDigest: executionAuthority.authorityDigest,
    schedulingBindingDigest: executionAuthority.schedulingBindingDigest,
    workOrderRevisionId: executionAuthority.workOrderRevisionId,
    workOrderRevision: executionAuthority.workOrderRevision,
    workOrderRevisionDigest: executionAuthority.workOrderRevisionDigest,
    canonicalProjectId: executionAuthority.canonicalProjectId,
    missionGroupId: executionAuthority.missionGroupId,
    projectGroupId: executionAuthority.projectGroupId,
    integrationLineage: executionAuthority.integrationLineage,
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
  authorityDigest: v.string(),
  workerToken: v.optional(v.string()),
};

// Two Trigger deliveries may race, but Convex grants one mission integration
// lease. The losing run performs no provider write and checkpoints normally.
export const claim = mutation({
  args: {
    id: v.id("integrationAttempts"), controllerRunId: v.string(), leaseOwner: v.string(), leaseToken: v.string(),
    authorityDigest: v.string(),
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
    const executionAuthority = job
      ? await readAttemptExecutionAuthority(ctx, job, Number(attempt.workAttempt))
      : null;
    const delivery: any = job?.activeDeliveryAttemptId ? await ctx.db.get(job.activeDeliveryAttemptId) : null;
    if (!mission || mission.mode !== "goal" || mission.status !== "running" || !job
      || !executionAuthority || args.authorityDigest !== executionAuthority.authorityDigest
      || attempt.authorityDigest !== executionAuthority.authorityDigest
      || attempt.schedulingBindingDigest !== executionAuthority.schedulingBindingDigest
      || attempt.workOrderRevisionId !== executionAuthority.workOrderRevisionId
      || attempt.workOrderRevision !== executionAuthority.workOrderRevision
      || attempt.workOrderRevisionDigest !== executionAuthority.workOrderRevisionDigest
      || attempt.canonicalProjectId !== executionAuthority.canonicalProjectId
      || attempt.missionGroupId !== executionAuthority.missionGroupId
      || attempt.projectGroupId !== executionAuthority.projectGroupId
      || attempt.integrationLineage !== executionAuthority.integrationLineage
      || attempt.repository !== executionAuthority.repository
      || job.integrationAttemptId !== attempt._id || job.deliveryRunId !== args.controllerRunId
      || delivery?.integrationAttemptId !== attempt._id || delivery?.deliveryRunId !== args.controllerRunId
      || delivery?.authorityDigest !== executionAuthority.authorityDigest
      || delivery?.workOrderRevisionDigest !== executionAuthority.workOrderRevisionDigest
      || delivery?.policy !== "mission_integration" || !["pending", "running"].includes(job.status)) return null;
    const head = await fifoHead(ctx, mission._id, attempt.repository);
    if (!head || head._id !== attempt._id) return null;
    if (mission.activeIntegrationAttemptId && mission.activeIntegrationAttemptId !== attempt._id) {
      const active: any = await ctx.db.get(mission.activeIntegrationAttemptId);
      if (active && Number(active.leaseUntil ?? 0) >= now
        && active.leaseOwner === mission.integrationLeaseOwner
        && active.leaseToken === mission.integrationLeaseToken
        && Number(active.leaseVersion) === Number(mission.integrationLeaseVersion)) return null;
    }
    if (attempt.controllerRunId && attempt.controllerRunId !== args.controllerRunId
      && Number(attempt.leaseUntil ?? 0) >= now) return null;
    const version = Math.max(Number(mission.integrationLeaseVersion ?? 0), Number(attempt.leaseVersion ?? 0)) + 1;
    const until = now + LEASE_MS;
    // A recovered attempt retains its original exact CAS and reviewed cold
    // receipt. A new generation binds them once from the authoritative head.
    let expectedIntegrationBaseSha = String(attempt.expectedIntegrationBaseSha ?? "");
    let expectedIntegrationBaseObservedAt = Number(attempt.expectedIntegrationBaseObservedAt ?? 0);
    if (!expectedIntegrationBaseSha) {
      if (mission.integrationHeadSha) {
        expectedIntegrationBaseSha = String(mission.integrationHeadSha);
        expectedIntegrationBaseObservedAt = Number(mission.integrationObservedAt ?? 0);
      } else {
        expectedIntegrationBaseSha = String(attempt.reviewedBaseSha);
        expectedIntegrationBaseObservedAt = Number(job.sourceObservedAt ?? 0);
      }
    }
    if (!SHA.test(expectedIntegrationBaseSha) || !Number.isSafeInteger(expectedIntegrationBaseObservedAt)
      || expectedIntegrationBaseObservedAt <= 0
      || (mission.integrationHeadSha
        ? expectedIntegrationBaseSha !== mission.integrationHeadSha
        : expectedIntegrationBaseSha !== attempt.reviewedBaseSha || expectedIntegrationBaseSha !== job.sourceHeadSha)) return null;
    const expectedIntegrationRefSha = String(attempt.expectedIntegrationRefSha ?? mission.integrationHeadSha ?? ZERO_OID);
    await ctx.db.patch(attempt._id, {
      status: "claimed",
      controllerRunId: args.controllerRunId.slice(0, 160), leaseOwner: args.leaseOwner.slice(0, 160),
      leaseToken: args.leaseToken.slice(0, 160), leaseVersion: version, leaseUntil: until,
      expectedIntegrationBaseSha, expectedIntegrationBaseObservedAt, expectedIntegrationRefSha, updatedAt: now,
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
      leaseToken: args.leaseToken, leaseVersion: version, leaseUntil: until,
      expectedIntegrationBaseSha, expectedIntegrationBaseObservedAt, expectedIntegrationRefSha,
      controllerState: "command", controllerStateSince: now,
      controllerDeadlineAt: now + CONTROLLER_STATE_MS.command, controllerHeartbeatAt: now };
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
    if (!await exactFence(ctx, mission, attempt, args)) return false;
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
    // Control still fences the exact mission token/version transactionally,
    // while the compact attempt row is the sole steady-state liveness write.
    // Mission/UI projections therefore do not invalidate every 30 seconds.
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
    if (!await exactFence(ctx, mission, attempt, args, job)
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
    if (!await exactFence(ctx, mission, attempt, args, job) || args.effectId.length < 1 || args.effectId.length > 300) return false;
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
  if (!job.pendingWorkOrderRevisionId || !job.pendingWorkOrderRevisionDigest) {
    throw new Error("Steering continuation requires an append-only staged work-order revision");
  }
  const pending: any = await ctx.db.get(job.pendingWorkOrderRevisionId);
  if (!pending || pending.revisionDigest !== job.pendingWorkOrderRevisionDigest) {
    throw new Error("Steering continuation lost its staged revision authority");
  }
  const awaitingApproval = pending.approvalRequired === true;
  const revised = await activateStagedJobWorkOrderRevision(ctx, job, {
    status: awaitingApproval ? "awaiting_approval" : "pending",
    approvalStatus: awaitingApproval ? "pending" : undefined,
    stage: awaitingApproval ? "approval" : "queued",
    progress: awaitingApproval
      ? "provider truth reconciled — steering continuation awaits protected approval"
      : "provider truth reconciled — steering continuation queued",
    attempt: nextAttempt, startedAt: undefined, completedAt: undefined, nextRunAt: awaitingApproval ? undefined : now,
    integrationAttemptId: undefined, integrationState: undefined, activeDeliveryAttemptId: undefined,
    reviewReceiptId: undefined, reviewReceiptDigest: undefined, reviewReceiptSignature: undefined,
    verificationVerdict: undefined, verificationNote: undefined, verifiedAt: undefined,
    dispatchId: undefined, dispatchLeaseUntil: undefined, workerRunId: undefined, deliveryRunId: undefined,
    workerRuntime: undefined, providerRunState: undefined, providerObservedAt: undefined,
    deliveryLeaseVersion: Math.max(0, Number(job.deliveryLeaseVersion ?? 0)) + 1,
    deliveryLeaseOwner: undefined, deliveryLeaseToken: undefined, deliveryLeaseUntil: undefined,
    heartbeatAt: now,
  });
  await ensureWorkAttempt(ctx, revised, nextAttempt, awaitingApproval ? "awaiting_approval" : "pending", now, { parentAttempt: job.attempt ?? 1 });
  if (awaitingApproval) {
    const approvals = await ctx.db.query("approvals")
      .withIndex("by_job", (q: any) => q.eq("jobId", String(job._id))).take(20);
    if (!approvals.some((approval: any) => approval.status === "pending")) await ctx.db.insert("approvals", {
      jobId: String(job._id), kind: "steering",
      summary: (revised.label || revised.task).slice(0, 240), risk: revised.risk ?? "consequential",
      payload: { repo: revised.repo, agentId: revised.agentId, reason: revised.approvalReason },
      status: "pending", requestedAt: now,
    });
  }
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
  if (!storedTerminalReceipt(terminal)) return false;
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
    if (!job || !await exactFence(ctx, mission, attempt, args, job)) return false;
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
    const effects: any[] = attempt ? await ctx.db.query("integrationProviderEffects")
      .withIndex("by_attempt_prepared", (q: any) => q.eq("integrationAttemptId", attempt._id)).collect() : [];
    if (!job || !await exactFence(ctx, mission, attempt, args, job) || attempt.preparedEffectId !== args.effectId
      || effect?.effectKind !== "update_ref" || effect.observation !== "applied"
      || effect.providerHeadSha !== attempt.preparedIntegrationHeadSha
      || !integratedEffectChainMatches(attempt, effects, args.effectId)
      || String(mission.integrationHeadSha ?? ZERO_OID) !== attempt.expectedIntegrationRefSha) return false;
    const requestedControl = attempt.controlRequested as "pause" | "cancel" | "steer" | undefined;
    const terminalOutcome = requestedControl === "cancel" ? "cancelled" : requestedControl === "steer" ? "stale" : "integrated";
    const terminal = await writeIntegrationTerminalReceipt(ctx, attempt, terminalOutcome, requestedControl
      ? {
          reason: `${requestedControl} requested during the applied final CAS; provider truth reconciled first`,
          appliedFinalEffectId: args.effectId,
        }
      : { appliedFinalEffectId: args.effectId });
    if (!storedTerminalReceipt(terminal)) {
      if (terminal?.blocked) await ctx.db.patch(attempt._id, {
        retryReason: `terminal receipt ${terminal.code}: ${terminal.serializedBytes ?? "lineage"}/${terminal.byteLimit}`,
        updatedAt: Date.now(),
      });
      return false;
    }
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
      integrationObservedAt: now,
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
      authorityDigest: attempt.authorityDigest,
      schedulingBindingDigest: attempt.schedulingBindingDigest,
      workOrderRevisionId: attempt.workOrderRevisionId,
      workOrderRevision: attempt.workOrderRevision,
      workOrderRevisionDigest: attempt.workOrderRevisionDigest,
      canonicalProjectId: attempt.canonicalProjectId,
      repository: attempt.repository,
      acceptanceEvidence: [String(job.verificationNote ?? "controller review passed")],
      artifacts: [attempt.workerBranch, attempt.integrationBranch, attempt.preparedIntegrationHeadSha],
      verification: "pass", deliveryOutcome: terminalOutcome === "integrated" ? "mission_integrated" : terminalOutcome,
      terminalEventKey: `integration:${String(attempt._id)}:integrated`,
      resultDigest: terminal.receiptDigest, evidenceDigest: attempt.reviewReceiptDigest,
      reviewReceiptSignature: job.reviewReceiptSignature, reviewDiffSha256: attempt.reviewedDiffSha256,
      reviewReceiptId: attempt.reviewReceiptId, reviewReceiptDigest: attempt.reviewReceiptDigest, createdAt: now,
    });
    if (!requestedControl && terminalOutcome === "integrated") {
      const completed = {
        ...job,
        status: "done",
        stage: "integrated",
        completedAt: now,
        integrationState: "integrated",
        deliveryStatus: "merged",
        mergeCommitSha: attempt.preparedIntegrationHeadSha,
      };
      await ensureGoalNodeHandoff(ctx, completed);
      await promoteCompletedJobDependents(ctx, completed, now);
    }
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
    if (!job || !await exactFence(ctx, mission, attempt, args, job)) return false;
    const now = Date.now();
    const budget = reconciliationBudget(attempt, now);
    await ctx.db.patch(attempt._id, {
      // Automatic exhaustion is deliberately nonterminal. A prepared provider
      // effect may still have committed, so this exact authority remains FIFO
      // head until an explicit resume reconciles it.
      status: budget.exhausted ? "provider_waiting" : "queued",
      retryReason: `${args.reasonCode.slice(0, 80)}: ${args.reason.slice(0, 400)}`,
      cumulativeRetries: budget.retries, controllerRunId: undefined,
      leaseOwner: undefined, leaseToken: undefined, leaseUntil: undefined,
      reconciliationAttentionAt: budget.exhausted ? now : undefined,
      updatedAt: now,
    });
    await patchMissionWithRuntime(ctx, mission, {
      activeIntegrationAttemptId: undefined, integrationLeaseOwner: undefined, integrationLeaseToken: undefined,
      integrationLeaseUntil: undefined, updatedAt: now,
    });
    let nextDeliveryId = job.activeDeliveryAttemptId;
    let nextDeliveryGeneration = Number(job.deliveryGeneration ?? 1);
    if (!budget.exhausted && job.activeDeliveryAttemptId) {
      const prior: any = await ctx.db.get(job.activeDeliveryAttemptId);
      if (prior?.integrationAttemptId === attempt._id) {
        nextDeliveryGeneration += 1;
        nextDeliveryId = await ctx.db.insert("deliveryAttempts", {
          jobId: job._id, sourceWorkAttempt: attempt.workAttempt,
          generation: nextDeliveryGeneration, policy: "mission_integration", status: "checkpointed",
          parentDeliveryAttemptId: prior._id, ...carriedIntegrationDelivery(prior),
          heartbeatAt: now, retries: 0,
          cumulativeRetries: budget.retries, currentStep: "queued", retryReason: args.reasonCode.slice(0, 80),
          createdAt: now, updatedAt: now,
        });
        await ctx.db.patch(prior._id, {
          status: "abandoned", completedAt: now, leaseUntil: undefined,
          retryReason: args.reasonCode.slice(0, 80), updatedAt: now,
        });
      }
    } else if (budget.exhausted && job.activeDeliveryAttemptId) {
      const prior: any = await ctx.db.get(job.activeDeliveryAttemptId);
      if (prior?.integrationAttemptId === attempt._id) await ctx.db.patch(prior._id, {
        status: "checkpointed", leaseOwner: undefined, leaseToken: undefined, leaseUntil: undefined,
        retryReason: "integration reconciliation budget exhausted", heartbeatAt: now, updatedAt: now,
      });
    }
    await patchJobWithRuntime(ctx, job, {
      integrationState: budget.exhausted ? "needs_attention" : "retry_due",
      evidenceSummary: budget.exhausted
        ? `${args.reasonCode.slice(0, 80)} · automatic reconciliation budget exhausted`
        : `${args.reasonCode.slice(0, 80)} · retry ${budget.retries}/${INTEGRATION_RECONCILIATION_LIMIT}`,
      activeDeliveryAttemptId: nextDeliveryId,
      deliveryGeneration: nextDeliveryGeneration,
      dispatchId: undefined, dispatchLeaseUntil: undefined, workerRunId: undefined, deliveryRunId: undefined,
      deliveryLeaseOwner: undefined, deliveryLeaseToken: undefined, deliveryLeaseUntil: undefined,
      ...(budget.exhausted ? { status: "needs_input", stage: "integration attention", nextRunAt: undefined }
        : { status: "pending", stage: "delivery", nextRunAt: budget.nextRunAt }),
    });
    await appendEvent(ctx, job, budget.exhausted ? "integration_attention" : "integration_retry_due", args.reason, {
      reasonCode: args.reasonCode.slice(0, 80), retries: budget.retries,
      retryLimit: INTEGRATION_RECONCILIATION_LIMIT,
      sentryRecommendationScope: budget.exhausted ? ["resume", "escalate"] : undefined,
    });
    if (budget.exhausted) await openIntegrationAttention(ctx, job, attempt, now);
    return true;
  },
});

/** Explicit resume grants one more reconciliation run over the same receipt. */
export async function resumeIntegrationReconciliation(ctx: any, job: any, now = Date.now()) {
  if (job?.status !== "needs_input" || job.integrationState !== "needs_attention" || !job.integrationAttemptId) return false;
  const attempt: any = await ctx.db.get(job.integrationAttemptId);
  const mission: any = attempt ? await ctx.db.get(attempt.missionId) : null;
  const delivery: any = job.activeDeliveryAttemptId ? await ctx.db.get(job.activeDeliveryAttemptId) : null;
  const executionAuthority = await readAttemptExecutionAuthority(ctx, job, Number(attempt?.workAttempt));
  if (!attempt || TERMINAL.has(attempt.status) || !attempt.reconciliationAttentionAt
    || !mission || mission.mode !== "goal" || mission.status !== "running"
    || !executionAuthority || attempt.authorityDigest !== executionAuthority.authorityDigest
    || attempt.workOrderRevisionDigest !== executionAuthority.workOrderRevisionDigest
    || delivery?.authorityDigest !== executionAuthority.authorityDigest
    || delivery?.workOrderRevisionDigest !== executionAuthority.workOrderRevisionDigest
    || delivery?.integrationAttemptId !== attempt._id || delivery.status !== "checkpointed") return false;
  const head = await fifoHead(ctx, attempt.missionId, attempt.repository);
  if (!head || head._id !== attempt._id) return false;
  const nextGeneration = Number(delivery.generation) + 1;
  const existing: any = await ctx.db.query("deliveryAttempts")
    .withIndex("by_job_source_generation", (q: any) => q.eq("jobId", job._id)
      .eq("sourceWorkAttempt", attempt.workAttempt).eq("generation", nextGeneration)).first();
  const nextDeliveryId = existing?._id ?? await ctx.db.insert("deliveryAttempts", {
    jobId: job._id, sourceWorkAttempt: attempt.workAttempt, generation: nextGeneration,
    policy: "mission_integration", status: "checkpointed", parentDeliveryAttemptId: delivery._id,
    ...carriedIntegrationDelivery(delivery), heartbeatAt: now, retries: 0,
    cumulativeRetries: Number(attempt.cumulativeRetries ?? delivery.cumulativeRetries ?? 0),
    currentStep: "queued", retryReason: "integration reconciliation resumed by control",
    createdAt: now, updatedAt: now,
  });
  if (!existing) await ctx.db.patch(delivery._id, {
    status: "abandoned", completedAt: now, leaseOwner: undefined, leaseToken: undefined,
    leaseUntil: undefined, retryReason: "integration reconciliation resumed by control", updatedAt: now,
  });
  await ctx.db.patch(attempt._id, {
    status: "queued", reconciliationAttentionAt: undefined,
    controllerRunId: undefined, leaseOwner: undefined, leaseToken: undefined, leaseUntil: undefined,
    retryReason: "integration reconciliation resumed by control", updatedAt: now,
  });
  await patchJobWithRuntime(ctx, job, {
    status: "pending", stage: "delivery", progress: "resuming the same signed integration authority for reconciliation",
    integrationState: "retry_due", nextRunAt: now,
    activeDeliveryAttemptId: nextDeliveryId, deliveryGeneration: nextGeneration,
    dispatchId: undefined, dispatchLeaseUntil: undefined, workerRunId: undefined, deliveryRunId: undefined,
    deliveryLeaseOwner: undefined, deliveryLeaseToken: undefined, deliveryLeaseUntil: undefined,
    heartbeatAt: now,
  });
  await resolveIntegrationAttention(ctx, attempt, now);
  await appendEvent(ctx, job, "integration_resumed", "Exact provider reconciliation resumed without rerunning the specialist", {
    retries: Number(attempt.cumulativeRetries ?? 0), deliveryGeneration: nextGeneration,
  });
  return true;
}

export const failFocused = mutation({
  args: { ...fenceArgs, kind: v.union(v.literal("conflict"), v.literal("stale")), reason: v.string() },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    const attempt: any = await ctx.db.get(args.id);
    const mission: any = attempt ? await ctx.db.get(attempt.missionId) : null;
    const job: any = attempt ? await ctx.db.get(attempt.jobId) : null;
    if (!job || !await exactFence(ctx, mission, attempt, args, job)) return null;
    const release = await terminalReleaseDecisionForAttempt(ctx, attempt);
    if (!release.releasable || release.state === "applied_final") return null;
    const now = Date.now();
    if (!job.canonicalProjectId || !SHA.test(String(attempt.expectedIntegrationBaseSha ?? ""))
      || !Number.isSafeInteger(attempt.expectedIntegrationBaseObservedAt)
      || Number(attempt.expectedIntegrationBaseObservedAt) <= 0) return null;
    const projectAdmission = await sealProjectSourceAdmission({
      protocolVersion: 2,
      canonicalProjectId: job.canonicalProjectId,
      repository: attempt.repository,
      sourceProvider: "github",
      sourceBranch: attempt.integrationBranch,
      sourceRef: `refs/heads/${attempt.integrationBranch}`,
      sourceHeadSha: String(attempt.expectedIntegrationBaseSha),
      sourceObservedAt: Number(attempt.expectedIntegrationBaseObservedAt),
    });
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
      projectAdmission, integrationBranch: attempt.integrationBranch,
      integrationState: "awaiting_review", createdAt: now,
    });
    const repair: any = await ctx.db.get(repairId);
    if (!repair?.workspaceLineage) throw new Error("Focused repair lost its immutable workspace admission");
    const terminal = await writeIntegrationTerminalReceipt(ctx, attempt, args.kind, { reason: args.reason, repairJobId: repairId });
    if (!storedTerminalReceipt(terminal)) throw new Error("focused integration terminal receipt could not be canonicalized");
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
    if (!job || !await exactFence(ctx, mission, attempt, args, job)) return false;
    const terminal = await writeIntegrationTerminalReceipt(ctx, attempt, "parked", { reason: args.reason });
    if (!storedTerminalReceipt(terminal)) return false;
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
  const executionAuthority = await readAttemptExecutionAuthority(ctx, job, Number(attempt.workAttempt));
  if (!executionAuthority || attempt.authorityDigest !== executionAuthority.authorityDigest
    || attempt.schedulingBindingDigest !== executionAuthority.schedulingBindingDigest
    || attempt.workOrderRevisionId !== executionAuthority.workOrderRevisionId
    || attempt.workOrderRevision !== executionAuthority.workOrderRevision
    || attempt.workOrderRevisionDigest !== executionAuthority.workOrderRevisionDigest
    || attempt.repository !== executionAuthority.repository
    || attempt.integrationLineage !== executionAuthority.integrationLineage) return null;
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
  if (!storedTerminalReceipt(terminal)) throw new Error("job control integration receipt could not be canonicalized");
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
