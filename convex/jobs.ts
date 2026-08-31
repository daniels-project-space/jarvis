import { mutation, query, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { workApprovalPolicy } from "./workPolicy";
import { exactTextWorkOrder } from "../src/lib/work-order";
import { requireActor, requireDispatcher, requireViewer, requireWorker, viewerAuthArgs } from "./controlAuth";
import { buildContinuationCheckpoint } from "../src/lib/work-checkpoint";
import { normalizeWorkModelTier } from "../src/lib/work-models";
import { canonicalizeRepository } from "../src/lib/workflow-contract";
import { isCodexSessionUnavailableCode } from "../src/lib/codex-session-status";
import { goalJobMatchesMissionPhase, workResultMaxChars } from "../src/lib/goal-mode";
import { attemptWorkspaceKey } from "../src/lib/workspace-protocol";
import {
  controlIntegrationForJob,
  queueReviewedIntegration,
  recoverExpiredIntegrationController,
  resumeIntegrationReconciliation,
} from "./goalIntegration";
import { redactSensitiveText } from "../src/lib/secret-redaction";
import { hasAttemptBudget, isMeaningfulWorkProgress } from "../src/lib/work-attempt";
import { ensureGoalNodeHandoff, verifiedGoalHandoffsForJob } from "./goalHandoffs";
import { claimDisposition, completionReceiptAllowed, isSha256Digest, replayEnvelope, shouldAdvanceAttempt } from "../src/lib/durable-attempt-protocol";
import { canonicalWorkspaceCheckpoint, parseCanonicalWorkspaceCheckpoint } from "../src/lib/workspace-checkpoint";
import {
  observedTriggerMachineReason,
  TRIGGER_AGENT_MACHINE_REASONS,
  type TriggerAgentDispatchPhase,
  type TriggerAgentMachinePreset,
  type TriggerAgentMachineReason,
} from "../src/lib/trigger-machine";
import {
  ensureWorkAttempt,
  activateStagedJobWorkOrderRevision,
  insertJobWithRuntime,
  jobRuntimeFor,
  projectJobRuntime,
  patchMissionWithRuntime,
  patchJobWithRuntime,
  patchJobWithRuntimeDeferredQueue,
  promoteCompletedJobDependents,
  quarantineJobRuntime,
  readAttemptExecutionAuthority,
  readExactWorkAttempt,
  readJobSchedulingAuthority,
  stageJobWorkOrderRevision,
  transitionJobWorkOrderRevision,
  refreshWorkGroupQueueProjection,
  runtimeMatchesSchedulingAuthority,
  runtimeJob,
  upsertJobRuntime,
  upsertMissionRuntime,
} from "./controlPlane";
import {
  controllerSessionHoldIsClear,
  currentControllerSessionRepairGeneration,
} from "./controllerSession";
import {
  BACKGROUND_CONCURRENCY_LIMIT,
  DISPATCH_CANDIDATE_WINDOW_MAX,
  DISPATCH_SCHEDULER_KEY,
  immutableLineageIsValid,
  MAX_ACTIVE_PER_WORK_GROUP,
  schedulingAuthorityMatches,
  SCHEDULING_PROTOCOL_VERSION,
  selectFairWork,
  writeLineageKey,
} from "../src/lib/work-scheduler";
import { admissionForRepository } from "./sourceAdmission";
import { WORK_ORDER_MACHINE_RUNTIME, WORK_ORDER_MACHINE_TEMPLATE } from "../src/lib/work-order-revision";
import {
  resolveBackgroundExecutionProfile,
  resolveBackgroundExecutionProfileForWorkOrder,
} from "../src/lib/background-execution-profile";
import {
  canonicalNovitaPatchProposalOutcome,
  canonicalNovitaPatchProposalReservation,
} from "../src/lib/novita-patch-proposal-receipt";
import {
  exactTerminalWorkReceipt,
  insertFreshTerminalWorkReceipt,
  type RecoveryDisposition,
} from "./workReceiptAuthority";
import {
  SUPERVISOR_FLEET_MANIFEST_PROTOCOL_VERSION,
  canonicalSupervisorControlBatchDigest,
  validSupervisorFleetManifest,
  type SupervisorFleetManifestMember,
} from "../src/lib/supervisor-fleet-manifest";

const STALE_RUNNER_MS = 5 * 60 * 1000;
// Provider workspace operations have a hard 15-minute controller deadline,
// while the longest admitted background Codex segment is 25 minutes. Mint a
// little server-owned margin beyond that longest provider effect so the
// five-minute stale heartbeat reaper cannot consume an exact live attempt
// while a provider SDK call prevents the Trigger event loop from pulsing.
const PROVIDER_EFFECT_LEASE_MS = 28 * 60 * 1000;
// A configuration hold can resolve automatically after a verified provider
// deploy, but old intent must not be resurrected indefinitely.  Before this
// horizon it remains a silent, resumable system hold; afterwards it receives
// one explicit terminal record and requires a fresh user request.
const STALE_CLOUD_WORKSPACE_HOLD_MS = 60 * 60 * 1000;
// A live process that cannot produce a causal stage/percentage advance is not
// healthy work. Keep this comfortably above a normal Codex tool segment while
// still surfacing a genuinely stuck attempt before its lease disappears.
const DISPATCH_LEASE_MS = 2 * 60 * 1000;
const DELIVERY_LEASE_MS = 45_000;
const DELIVERY_RETRY_LIMIT = 6;
const ACTIVE_RUNTIME_REPAIR_LIMIT = 3;
const REVIEW_RECEIPT_MAX_CHARS = 300_000;
const CLOUD_WORKSPACE_CLEANUP_RETRY_BASE_MS = 60_000;
const CLOUD_WORKSPACE_CLEANUP_RETRY_MAX_MS = 30 * 60_000;
const CLOUD_WORKSPACE_ORPHAN_PER_STATUS_LIMIT = 12;
const CLOUD_WORKSPACE_ORPHAN_LIMIT = 24;
const CLOUD_WORKSPACE_LEGACY_PER_PROVIDER_LIMIT = 2;
const TERMINAL_CLOUD_WORKSPACE_STATUSES = ["checkpointed", "paused", "cancelled", "done", "error", "needs_input"] as const;
// bindCloudWorkspace has only ever accepted these providers. Keep a small
// migration lane for pre-marker attempts without reopening a table-wide scan.
const CLOUD_WORKSPACE_PROVIDER_NAMES = ["e2b", "sandbox0", "vercel", "cloudflare", "daytona"] as const;
const GIT_OID = /^[0-9a-f]{40,64}$/i;
const DELIVERY_OUTCOMES = new Set([
  "protected_draft", "read_only_complete", "no_change",
  "merged", "blocked", "needs_attention",
]);

function outcomeAllowed(policy: string, outcome: string) {
  if (!DELIVERY_OUTCOMES.has(outcome)) return false;
  if (outcome === "merged") return policy === "auto_merge";
  if (outcome === "protected_draft") return policy === "manual";
  if (outcome === "read_only_complete") return policy === "read_only";
  return true;
}

async function sha256Hex(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isSupervisorOwnedJob(row: {
  missionId?: unknown;
  supervisorEpoch?: unknown;
  supervisorDecisionKey?: unknown;
  supervisorJobOrdinal?: unknown;
}): boolean {
  return typeof row.missionId === "string"
    && Number.isSafeInteger(row.supervisorEpoch)
    && typeof row.supervisorDecisionKey === "string"
    && Number.isSafeInteger(row.supervisorJobOrdinal);
}

/* eslint-disable @typescript-eslint/no-explicit-any -- Convex documents are validated against the immutable receipt fields before use */
function dispatchPhaseForJob(row: any): TriggerAgentDispatchPhase {
  if (row.integrationAttemptId || row.integrationState
    || (row.goalStage === "validating" && row.deliveryMode === "auto_merge")) return "integration";
  if (row.verificationVerdict === "pass" && row.reviewReceiptId) return "delivery";
  return "specialist";
}

async function latestDispatchReceipt(ctx: any, jobId: any) {
  return await ctx.db.query("dispatchReceipts")
    .withIndex("by_job_generation", (q: any) => q.eq("jobId", jobId))
    .order("desc")
    .first();
}

async function dispatchReceiptByDigest(ctx: any, digest: string) {
  const rows = await ctx.db.query("dispatchReceipts")
    .withIndex("by_digest", (q: any) => q.eq("receiptDigest", digest))
    .take(2);
  return rows.length === 1 ? rows[0] : null;
}

async function claimedDispatchReceiptForRow(ctx: any, row: any, workerRunId: unknown) {
  if (typeof workerRunId !== "string" || !row.dispatchReceiptId) return null;
  const receipt: any = await ctx.db.get(row.dispatchReceiptId);
  return receipt
    && receipt.status === "claimed"
    && receipt.workerRunId === workerRunId
    && receipt.dispatchId === row.dispatchId
    && receipt.generation === row.dispatchGeneration
    && receipt.phase === row.dispatchPhase
    && receipt.receiptDigest === row.dispatchReceiptDigest
    && receipt.payloadDigest === row.dispatchPayloadDigest
    ? receipt
    : null;
}

async function closeClaimedDispatchReceipt(
  ctx: any,
  row: any,
  workerRunId: unknown,
  closeReason: string,
  now = Date.now(),
) {
  const receipt = await claimedDispatchReceiptForRow(ctx, row, workerRunId);
  if (!receipt) return false;
  await ctx.db.patch(receipt._id, {
    status: "closed",
    closeReason: closeReason.slice(0, 180),
    leaseUntil: undefined,
    closedAt: now,
    updatedAt: now,
  });
  return true;
}

async function closeOrConfirmDispatchReceiptForControl(
  ctx: any,
  row: any,
  workerRunId: unknown,
  closeReason: string,
  now = Date.now(),
) {
  if (await closeClaimedDispatchReceipt(
    ctx,
    row,
    workerRunId,
    closeReason,
    now,
  )) return true;
  if (typeof workerRunId !== "string" || !row.dispatchReceiptId) return false;
  const receipt: any = await ctx.db.get(row.dispatchReceiptId);
  return Boolean(
    receipt
    && receipt.status === "closed"
    && typeof receipt.closedAt === "number"
    && receipt.jobId === row._id
    && receipt.attempt === row.attempt
    && receipt.workerRunId === workerRunId
    && receipt.dispatchId === row.dispatchId
    && receipt.generation === row.dispatchGeneration
    && receipt.phase === row.dispatchPhase
    && receipt.receiptDigest === row.dispatchReceiptDigest
    && receipt.payloadDigest === row.dispatchPayloadDigest,
  );
}

async function resolveOpenJobAttention(
  ctx: any,
  jobId: Id<"jobs">,
  now = Date.now(),
) {
  const attention = await ctx.db
    .query("attentionItems")
    .withIndex("by_jobId", (q: any) => q.eq("jobId", String(jobId)))
    .take(50);
  for (const item of attention) {
    if (item.status === "open") {
      await ctx.db.patch(item._id, { status: "resolved", updatedAt: now });
    }
  }
}

function dispatchReceiptMatchesRequest(receipt: any, row: any, a: any) {
  return Boolean(receipt
    && receipt.jobId === row._id
    && receipt.attempt === a.expectedAttempt
    && receipt.generation === a.dispatchGeneration
    && receipt.phase === a.dispatchPhase
    && receipt.dispatchId === a.dispatchId
    && receipt.receiptDigest === a.dispatchReceiptDigest
    && receipt.payloadDigest === a.dispatchPayloadDigest
    && receipt.authorityDigest === a.authorityDigest
    && receipt.workOrderRevisionDigest === a.workOrderRevisionDigest
    && receipt.triggerMachinePreset === a.triggerMachinePreset
    && receipt.triggerMachineReason === a.triggerMachineReason);
}

function reservationFromDispatchReceipt(receipt: any, row: any) {
  let payload: any;
  try {
    payload = JSON.parse(receipt.payloadJson);
  } catch {
    return null;
  }
  return {
    ...payload,
    attempt: receipt.attempt,
    missionId: row.missionId ?? null,
    missionGroupId: row.missionGroupId,
    projectGroupId: row.projectGroupId,
    projectRepository: row.projectRepository ?? null,
    schedulingGroupKey: row.schedulingGroupKey,
    agentId: row.agentId ?? null,
    label: row.label ?? row.task.slice(0, 80),
  };
}

async function createDispatchReceipt(
  ctx: any,
  row: any,
  attempt: number,
  authority: any,
  machine: { preset: TriggerAgentMachinePreset; reason: TriggerAgentMachineReason },
  reason: string,
  now: number,
) {
  const latest = await latestDispatchReceipt(ctx, row._id);
  if (latest && !["closed", "superseded"].includes(latest.status)) {
    const sameAttempt = Number(latest.attempt) === attempt;
    const launchStillUnclaimed = ["reserved", "reconciling"].includes(latest.status);
    if (sameAttempt && launchStillUnclaimed
      && row.status === "dispatching"
      && row.dispatchId === latest.dispatchId
      && row.dispatchReceiptDigest === latest.receiptDigest) return null;
    const completedContinuation = sameAttempt && latest.status === "claimed";
    await ctx.db.patch(latest._id, {
      status: completedContinuation ? "closed" : "superseded",
      closeReason: completedContinuation
        ? "durable continuation queued"
        : "dispatch authority superseded before a new generation",
      leaseUntil: undefined,
      closedAt: now,
      updatedAt: now,
    });
  }
  const generation = Number(latest?.generation ?? 0) + 1;
  const envelope = await dispatchReceiptEnvelope(
    row,
    attempt,
    generation,
    authority,
    machine,
    reason,
  );
  const receiptId = await ctx.db.insert("dispatchReceipts", {
    jobId: row._id,
    attempt,
    generation,
    phase: envelope.phase,
    dispatchId: envelope.dispatchId,
    authorityDigest: authority.authorityDigest,
    workOrderRevisionDigest: authority.workOrderRevisionDigest,
    triggerMachinePreset: machine.preset,
    triggerMachineReason: machine.reason,
    payloadJson: envelope.payloadJson,
    payloadDigest: envelope.payloadDigest,
    receiptDigest: envelope.receiptDigest,
    status: "reserved",
    leaseUntil: now + DISPATCH_LEASE_MS,
    createdAt: now,
    updatedAt: now,
  });
  return {
    receiptId,
    receipt: {
      ...envelope.payload,
      attempt,
      generation,
      phase: envelope.phase,
      receiptDigest: envelope.receiptDigest,
      payloadDigest: envelope.payloadDigest,
      dispatchId: envelope.dispatchId,
    },
  };
}

type SupervisorDispatchSource = {
  controlReceiptId: Id<"missionSupervisorControls">;
  fleetDigest: string;
  memberDigest: string;
};

async function dispatchReceiptEnvelope(
  row: Doc<"jobs">,
  attempt: number,
  generation: number,
  authority: {
    authorityDigest: string;
    workOrderRevisionDigest: string;
  },
  machine: {
    preset: TriggerAgentMachinePreset;
    reason: TriggerAgentMachineReason;
  },
  reason: string,
  source?: SupervisorDispatchSource,
  phaseOverride?: TriggerAgentDispatchPhase,
) {
  const phase = phaseOverride ?? dispatchPhaseForJob(row);
  const dispatchId = `${String(row._id)}:${attempt}:${generation}:${phase}`;
  const payloadCore = {
    jobId: String(row._id),
    dispatchId,
    expectedAttempt: attempt,
    dispatchGeneration: generation,
    dispatchPhase: phase,
    authorityDigest: authority.authorityDigest,
    workOrderRevisionDigest: authority.workOrderRevisionDigest,
    triggerMachinePreset: machine.preset,
    triggerMachineReason: machine.reason,
    reason,
  };
  const payloadDigest = await sha256Hex(JSON.stringify(payloadCore));
  const receiptDigest = await sha256Hex(JSON.stringify({
    protocolVersion: 2,
    jobId: String(row._id),
    attempt,
    generation,
    phase,
    dispatchId,
    authorityDigest: authority.authorityDigest,
    workOrderRevisionDigest: authority.workOrderRevisionDigest,
    triggerMachinePreset: machine.preset,
    triggerMachineReason: machine.reason,
    payloadDigest,
    ...(source
      ? {
        sourceSupervisorControlReceiptId: String(source.controlReceiptId),
        sourceSupervisorFleetDigest: source.fleetDigest,
        sourceSupervisorMemberDigest: source.memberDigest,
      }
      : {}),
  }));
  const payload = {
    ...payloadCore,
    dispatchReceiptDigest: receiptDigest,
    dispatchPayloadDigest: payloadDigest,
  };
  return {
    phase,
    dispatchId,
    payload,
    payloadJson: JSON.stringify(payload),
    payloadDigest,
    receiptDigest,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function invalidateDeliveryLease(row: any) {
  return {
    deliveryLeaseVersion: Math.max(0, Number(row.deliveryLeaseVersion ?? 0)) + 1,
    deliveryLeaseOwner: undefined,
    deliveryLeaseToken: undefined,
    deliveryLeaseUntil: undefined,
  };
}

function hasLiveDeliveryLease(row: any, a: any, now = Date.now()) {
  return typeof a.deliveryLeaseOwner === "string"
    && typeof a.deliveryLeaseToken === "string"
    && a.deliveryLeaseOwner === row.deliveryLeaseOwner
    && a.deliveryLeaseToken === row.deliveryLeaseToken
    && Number(a.deliveryLeaseVersion) === Number(row.deliveryLeaseVersion)
    && Number(row.deliveryLeaseUntil ?? 0) >= now;
}

async function attemptFor(ctx: any, jobId: any, attempt: number) {
  const rows = await ctx.db
    .query("workAttempts")
    .withIndex("by_job_attempt", (q: any) => q.eq("jobId", jobId).eq("attempt", attempt))
    .take(2);
  return rows.length === 1 ? rows[0] : null;
}

async function attemptExecutionAuthorityFor(
  ctx: any,
  row: any,
  attemptNumber: number,
  suppliedDigest: unknown,
) {
  if (typeof suppliedDigest !== "string" || !/^[0-9a-f]{64}$/.test(suppliedDigest)) return null;
  const authority = await readAttemptExecutionAuthority(ctx, row, attemptNumber);
  return authority?.authorityDigest === suppliedDigest ? authority : null;
}

async function deliveryAttemptFor(ctx: any, jobId: any, sourceWorkAttempt: number, generation: number) {
  return await ctx.db.query("deliveryAttempts")
    .withIndex("by_job_source_generation", (q: any) => q.eq("jobId", jobId).eq("sourceWorkAttempt", sourceWorkAttempt).eq("generation", generation))
    .first();
}

async function openDeliveryAttention(ctx: any, row: any, now: number) {
  const fingerprint = `delivery-exhausted:${String(row._id)}:${row.attempt ?? 1}`;
  const existing = await ctx.db.query("attentionItems")
    .withIndex("by_fingerprint", (q: any) => q.eq("fingerprint", fingerprint)).first();
  if (existing) return existing._id;
  return await ctx.db.insert("attentionItems", {
    fingerprint, project: row.repo,
    title: "Verified repository delivery needs attention",
    detail: redactSensitiveText("The controller retry budget was exhausted. The specialist receipt remains preserved; no specialist rerun was started.").slice(0, 2_000),
    evidence: [`Job ${String(row._id)}`, `Specialist attempt ${row.attempt ?? 1}`],
    severity: "error", impact: 85, urgency: 75, confidence: 1,
    actionClass: "ask", status: "open", jobId: String(row._id), createdAt: now, updatedAt: now,
  });
}

async function openStaleReviewAttention(ctx: any, row: any, now: number) {
  const fingerprint = `delivery-stale-review:${String(row._id)}:${row.attempt ?? 1}`;
  const existing = await ctx.db.query("attentionItems")
    .withIndex("by_fingerprint", (q: any) => q.eq("fingerprint", fingerprint)).first();
  if (existing) return existing._id;
  return await ctx.db.insert("attentionItems", {
    fingerprint, project: row.repo, title: "Repository review became stale",
    detail: "The reviewed source, base, or pull request identity changed. Delivery stopped before another write.",
    evidence: [`Job ${String(row._id)}`, `Specialist attempt ${row.attempt ?? 1}`],
    severity: "warning", impact: 80, urgency: 70, confidence: 1,
    actionClass: "ask", status: "open", jobId: String(row._id), createdAt: now, updatedAt: now,
  });
}

// A dispatch is executable only while its durable projection and immutable
// receipt describe the same launch. When that proof disappears after the
// reservation lease expires, preserving `dispatching` would indefinitely
// consume a worker slot. This is intentionally a human-review state, never a
// retry: an unknown launch must not be replaced with a competing Trigger run.
async function openDispatchAuthorityAttention(
  ctx: any,
  row: any,
  dispatchId: string,
  now: number,
) {
  const attempt = row.attempt ?? 1;
  const fingerprint = `dispatch-authority-invalid:${String(row._id)}:${attempt}:${dispatchId}`;
  const existing = await ctx.db.query("attentionItems")
    .withIndex("by_fingerprint", (q: any) => q.eq("fingerprint", fingerprint)).first();
  const item = {
    fingerprint,
    project: row.repo,
    title: "Worker reservation needs review",
    detail: "The expired worker reservation no longer has one exact immutable launch receipt. JARVIS stopped it before another worker could be launched; review it and submit a fresh job if needed.",
    evidence: [
      `Job ${String(row._id)}`,
      `Specialist attempt ${attempt}`,
      `Dispatch ${dispatchId}`,
    ],
    severity: "decision",
    impact: 80,
    urgency: 75,
    confidence: 1,
    actionClass: "ask",
    status: "open",
    jobId: String(row._id),
    updatedAt: now,
  };
  if (existing) await ctx.db.patch(existing._id, item);
  else await ctx.db.insert("attentionItems", { ...item, createdAt: now });
}

async function quarantineUnprovableDispatch(
  ctx: any,
  row: any,
  dispatchId: string,
  now: number,
) {
  const attemptNumber = row.attempt ?? 1;
  const explanation = "The expired worker reservation no longer has one exact immutable launch receipt. No replacement worker was started; review this work before submitting a fresh job.";
  const attempt = await attemptFor(ctx, row._id, attemptNumber);
  // Supervisor-owned work is append-only. Record a matching terminal receipt
  // only when the execution authority is still exact; a corrupt authority is
  // itself evidence to preserve, not a reason to fabricate a receipt.
  if (isSupervisorOwnedJob(row) && await readAttemptExecutionAuthority(ctx, row, attemptNumber)) {
    const existingReceipts = await ctx.db
      .query("workReceipts")
      .withIndex("by_job_attempt", (q: any) => q.eq("jobId", row._id).eq("attempt", attemptNumber))
      .take(2);
    if (!existingReceipts.length) {
      await insertFreshTerminalWorkReceipt(ctx, row, attemptNumber, {
        status: "needs_input",
        terminalCode: "dispatch_authority_invalid",
        recoveryDisposition: "needs_input",
        acceptanceEvidence: [],
        artifacts: [
          `convex://jobs/${String(row._id)}/attempt/${attemptNumber}/dispatch`,
        ],
        verification: "needs_input",
        terminalEventKey: `dispatch-authority-invalid:${attemptNumber}:${dispatchId}`,
        result: explanation,
        evidence: row.progress ?? row.checkpoint,
      }, now);
    }
  }
  if (attempt && !attempt.completedAt) {
    await ctx.db.patch(attempt._id, {
      status: "needs_input",
      completedAt: now,
      lastEventAt: now,
    });
  }
  await patchJobWithRuntime(ctx, row, {
    ...invalidateDeliveryLease(row),
    status: "needs_input",
    stage: "needs dispatch review",
    progress: "worker reservation authority cannot be proven — review required",
    heartbeatAt: now,
    nextRunAt: undefined,
    dispatchId: undefined,
    dispatchGeneration: undefined,
    dispatchPhase: undefined,
    dispatchReceiptId: undefined,
    dispatchReceiptDigest: undefined,
    dispatchPayloadDigest: undefined,
    dispatchLeaseUntil: undefined,
    dispatchReason: undefined,
    workerRunId: undefined,
    workerRuntime: undefined,
    deliveryRunId: undefined,
    activeDeliveryAttemptId: undefined,
    providerRunState: "quarantined",
    providerObservedAt: now,
  });
  await appendAttemptEvidence(ctx, row, "dispatch_quarantined", explanation, {
    stage: "needs dispatch review",
    percent: row.percent,
    evidenceKind: "watchdog",
    eventKey: `dispatch-authority-invalid:${attemptNumber}:${dispatchId}`,
    attempt: attemptNumber,
  });
  await openDispatchAuthorityAttention(ctx, row, dispatchId, now);
}

function deliveryClaimMatches(row: any, attempt: any, a: any) {
  return Boolean(attempt
    && attempt.authorityDigest === a.authorityDigest
    && attempt.workOrderRevisionDigest === row.workOrderRevisionDigest
    && row.activeDeliveryAttemptId && String(row.activeDeliveryAttemptId) === String(attempt._id)
    && a.deliveryAttemptId && String(a.deliveryAttemptId) === String(attempt._id)
    && Number(a.sourceWorkAttempt) === Number(attempt.sourceWorkAttempt)
    && Number(a.deliveryGeneration) === Number(attempt.generation)
    && typeof a.deliveryRunId === "string" && a.deliveryRunId === attempt.deliveryRunId
    && row.deliveryRunId === attempt.deliveryRunId
    && row.dispatchId === attempt.dispatchId
    && Number(row.deliveryGeneration ?? 0) === Number(attempt.generation));
}

function hasLiveControllerFence(row: any, attempt: any, a: any, now = Date.now()) {
  return deliveryClaimMatches(row, attempt, a)
    && hasLiveDeliveryLease(row, a, now)
    && attempt.leaseOwner === a.deliveryLeaseOwner
    && attempt.leaseToken === a.deliveryLeaseToken
    && Number(attempt.leaseVersion) === Number(a.deliveryLeaseVersion)
    && Number(attempt.leaseUntil ?? 0) >= now;
}

function carriedDeliveryAuthority(delivery: any) {
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
    observedPullRequestHead: delivery.observedPullRequestHead,
    observedPullRequestBase: delivery.observedPullRequestBase,
    pullRequestNumber: delivery.pullRequestNumber,
    pullRequestUrl: delivery.pullRequestUrl,
    pullRequestNodeId: delivery.pullRequestNodeId,
    pullRequestDraft: delivery.pullRequestDraft,
    preparedEffectId: delivery.preparedEffectId,
    preparedEffectKind: delivery.preparedEffectKind,
    preparedEffectAt: delivery.preparedEffectAt,
    providerObservation: delivery.providerObservation,
    providerObservedAt: delivery.providerObservedAt,
    effects: delivery.effects,
    mergeCommitSha: delivery.mergeCommitSha,
    outcome: delivery.outcome,
  };
}

function matchingAppliedEffect(delivery: any, kinds: readonly string[], args: any) {
  const effect = [...(delivery.effects ?? [])].reverse().find((candidate: any) =>
    kinds.includes(String(candidate.effectKind))
    && candidate.observation === "applied"
    && candidate.reviewedHeadSha === delivery.reviewedHeadSha
    && candidate.reviewedBaseSha === delivery.reviewedBaseSha
    && (!args.pullRequestNumber || candidate.pullRequestNumber === args.pullRequestNumber)
  );
  if (!effect) return null;
  if (effect.observedPullRequestHead !== delivery.reviewedHeadSha
    || effect.observedPullRequestBase !== delivery.reviewedBaseSha) return null;
  if (args.pullRequestNumber && effect.pullRequestNumber !== args.pullRequestNumber) return null;
  if (args.pullRequestUrl && effect.pullRequestUrl !== args.pullRequestUrl) return null;
  if (args.pullRequestNodeId && effect.pullRequestNodeId !== args.pullRequestNodeId) return null;
  if (args.pullRequestDraft !== undefined && effect.pullRequestDraft !== args.pullRequestDraft) return null;
  if (args.mergeCommitSha && effect.mergeCommitSha !== args.mergeCommitSha) return null;
  return effect;
}

function eventIdentity(value: unknown) {
  // Event keys are replay identifiers, not evidence digests or a security
  // boundary. Completion evidence is SHA-256 computed by the controller.
  let hash = 2166136261;
  for (const char of String(value)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(36);
}

async function appendAttemptEvidence(ctx: any, row: any, type: string, message: string, options: {
  stage?: string;
  percent?: number;
  evidenceKind?: string;
  causationId?: string;
  data?: unknown;
  eventKey?: string;
  attempt?: number;
} = {}) {
  // Mutations are serialized by Convex, but callers can hold a deliberately
  // stale job object after a state transition. Read the authority row here so
  // one job-wide cursor, rather than a per-attempt counter, orders every
  // queue/launch/control/terminal event.
  const durable = await ctx.db.get(row._id) ?? row;
  const attemptNumber = options.attempt ?? row.attempt ?? 1;
  const causationId = options.causationId ?? `attempt:${String(row._id)}:${attemptNumber}`;
  const eventKey = options.eventKey ?? `${attemptNumber}:${type}:${eventIdentity(`${causationId}|${message}|${JSON.stringify(options.data ?? null)}`)}`;
  const existing = await ctx.db
    .query("workEvents")
    .withIndex("by_job_event", (q: any) => q.eq("jobId", String(row._id)).eq("eventKey", eventKey))
    .first();
  if (existing) return existing._id;
  const attempt = await attemptFor(ctx, row._id, attemptNumber);
  const sequence = Number(durable.lifecycleSequence ?? 0) + 1;
  const predecessorKey = durable.lifecycleEventKey;
  const id = await ctx.db.insert("workEvents", {
    jobId: String(row._id),
    missionId: row.missionId,
    agentId: row.agentId,
    type,
    message: message.slice(0, 1200),
    stage: options.stage,
    percent: options.percent,
    attempt: attemptNumber,
    causationId,
    evidenceKind: options.evidenceKind ?? "lifecycle",
    data: options.data,
    eventKey,
    sequence,
    predecessorKey,
    createdAt: Date.now(),
  });
  await ctx.db.patch(row._id, { lifecycleSequence: sequence, lifecycleEventKey: eventKey });
  if (attempt) await ctx.db.patch(attempt._id, { lastEventSeq: sequence, lastEventKey: eventKey, lastEventAt: Date.now() });
  return id;
}

async function ensureAttempt(ctx: any, jobId: any, attempt: number, status: string, now: number, patch: Record<string, unknown> = {}) {
  const job: any = await ctx.db.get(jobId);
  if (!job) throw new Error("Attempt job no longer exists");
  return await ensureWorkAttempt(ctx, job, attempt, status, now, patch);
}

const legacyEnqueueArgs = {
  task: v.string(),
  repo: v.optional(v.string()),
  readonly: v.optional(v.boolean()),
  model: v.optional(v.string()),
  reasoningEffort: v.optional(v.string()),
  mcp: v.optional(v.array(v.string())),
  incidentId: v.optional(v.string()),
  retried: v.optional(v.boolean()),
  missionId: v.optional(v.string()),
  label: v.optional(v.string()),
  originThreadId: v.optional(v.string()),
  originTurnId: v.optional(v.string()),
  visibility: v.optional(v.union(v.literal("conversation"), v.literal("system"))),
  agentId: v.optional(v.string()),
  risk: v.optional(v.string()),
  priority: v.optional(v.number()),
  approvalRequired: v.optional(v.boolean()),
  acceptanceCriteria: v.optional(v.array(v.string())),
  modelReason: v.optional(v.string()),
  parentJobId: v.optional(v.string()),
  dependsOn: v.optional(v.array(v.string())),
  goalStage: v.optional(v.string()),
  goalWorkstreamId: v.optional(v.string()),
  goalWave: v.optional(v.number()),
  maxAttempts: v.optional(v.number()),
  branch: v.optional(v.string()),
  checkpoint: v.optional(v.string()),
  authTokenHash: v.optional(v.string()),
  dispatchToken: v.optional(v.string()),
  workerToken: v.optional(v.string()),
};

const enqueueV2Args = {
  task: v.string(),
  repo: v.optional(v.string()),
  readonly: v.optional(v.boolean()),
  model: v.optional(v.string()),
  reasoningEffort: v.optional(v.string()),
  mcp: v.optional(v.array(v.string())),
  incidentId: v.optional(v.string()),
  retried: v.optional(v.boolean()),
  missionId: v.string(),
  label: v.optional(v.string()),
  originThreadId: v.optional(v.string()),
  originTurnId: v.optional(v.string()),
  visibility: v.optional(v.union(v.literal("conversation"), v.literal("system"))),
  agentId: v.optional(v.string()),
  risk: v.optional(v.string()),
  priority: v.optional(v.number()),
  approvalRequired: v.optional(v.boolean()),
  acceptanceCriteria: v.optional(v.array(v.string())),
  modelReason: v.optional(v.string()),
  parentJobId: v.optional(v.string()),
  dependsOn: v.optional(v.array(v.string())),
  goalStage: v.optional(v.string()),
  goalWorkstreamId: v.optional(v.string()),
  goalWave: v.optional(v.number()),
  maxAttempts: v.optional(v.number()),
  checkpoint: v.optional(v.string()),
  authTokenHash: v.optional(v.string()),
  dispatchToken: v.optional(v.string()),
  workerToken: v.optional(v.string()),
};

export const enqueue = mutation({
  args: legacyEnqueueArgs,
  handler: async (ctx, a) => {
    await requireDispatcher(ctx, a);
    const now = Date.now();
    const repo = a.repo === undefined ? undefined : canonicalizeRepository(a.repo, { allowShortName: true }) ?? undefined;
    if (a.repo !== undefined && !repo) {
      throw new Error("Repository must be an owner/repo slug or credential-free https://github.com/owner/repo(.git) URL");
    }
    const task = exactTextWorkOrder(a.task);
    const id = await ctx.db.insert("jobs", {
      task,
      repo,
      readonly: Boolean(a.readonly || !repo),
      model: a.model ? normalizeWorkModelTier(a.model) : undefined,
      reasoningEffort: a.reasoningEffort,
      mcp: a.mcp,
      incidentId: a.incidentId,
      retried: a.retried,
      missionId: a.missionId,
      label: a.label?.slice(0, 80),
      originThreadId: a.originThreadId,
      originTurnId: a.originTurnId,
      visibility: a.visibility,
      agentId: a.agentId,
      risk: a.risk,
      priority: Math.max(0, Math.min(100, a.priority ?? 50)),
      acceptanceCriteria: a.acceptanceCriteria,
      modelReason: a.modelReason,
      parentJobId: a.parentJobId,
      dependsOn: a.dependsOn,
      goalStage: a.goalStage,
      goalWorkstreamId: a.goalWorkstreamId,
      goalWave: a.goalWave,
      checkpoint: a.checkpoint,
      status: "protocol_held",
      stage: "protocol_hold",
      percent: 0,
      attempt: 1,
      maxAttempts: Math.max(1, Math.min(48, a.maxAttempts ?? 12)),
      schedulingBound: false,
      dispatchReady: false,
      admissionProtocolVersion: 1,
      protocolHoldReason: "protocol_v1_admission_held",
      createdAt: now,
    });
    const held = await ctx.db.get(id);
    if (held) await upsertJobRuntime(ctx, held);
    await ctx.db.insert("workEvents", {
      jobId: String(id), missionId: a.missionId, agentId: a.agentId,
      type: "protocol_hold", message: "Legacy job admission held before execution authority",
      stage: "protocol_hold", percent: 0,
      data: { reason: "protocol_v1_admission_held", requestedBranchIgnored: Boolean(a.branch) }, createdAt: now,
    });
    return id;
  },
});

export const enqueueV2 = mutation({
  args: enqueueV2Args,
  handler: async (ctx, a) => {
    await requireDispatcher(ctx, a);
    const { authTokenHash: _authTokenHash, dispatchToken: _dispatchToken, workerToken: _workerToken, ...input } = a;
    const task = exactTextWorkOrder(input.task);
    const now = Date.now();
    const repo = input.repo === undefined ? undefined : canonicalizeRepository(input.repo, { allowShortName: true }) ?? undefined;
    if (input.repo !== undefined && !repo) {
      throw new Error("Repository must be an owner/repo slug or credential-free https://github.com/owner/repo(.git) URL");
    }
    const normalizedInput = { ...input, repo, task };
    const missionId = ctx.db.normalizeId("missions", input.missionId);
    const mission: any = missionId ? await ctx.db.get(missionId) : null;
    const admittedProject = admissionForRepository(mission?.projectAdmissions, repo);
    if (!mission || mission.admissionProtocolVersion !== 2 || !admittedProject) {
      throw new Error("Job project admission is not inherited from its immutable mission group");
    }
    const approval = workApprovalPolicy(normalizedInput);
    const approvalRequired = approval.required;
    const status = approvalRequired ? "awaiting_approval" : "pending";
    const id = await insertJobWithRuntime(ctx, {
      ...normalizedInput,
      admissionProtocolVersion: 2,
      projectAdmission: admittedProject,
      requireFreshSourceAdmission: true,
      model: input.model ? normalizeWorkModelTier(input.model) : undefined,
      label: input.label?.slice(0, 80),
      priority: Math.max(0, Math.min(100, input.priority ?? 50)),
      status,
      risk: approvalRequired ? (input.risk ?? "consequential") : input.risk,
      approvalRequired,
      approvalReason: approval.reason,
      approvalStatus: approvalRequired ? "pending" : undefined,
      deliveryMode: approval.deliveryMode,
      stage: approvalRequired ? "approval" : "queued",
      percent: 0,
      progressAt: now,
      stallCount: 0,
      steerRevision: 0,
      attempt: 1,
      maxAttempts: Math.max(1, Math.min(48, input.maxAttempts ?? 12)),
      nextRunAt: now,
      createdAt: now,
    });
    const queued: any = await ctx.db.get(id);
    // Queue intent is durable immediately; execution authority is allocated
    // only after every dispatch admission fence passes.
    if (queued) await appendAttemptEvidence(ctx, queued, approvalRequired ? "approval_requested" : "queued",
      approvalRequired ? `Waiting for Daniel's approval${approval.reason ? ` · ${approval.reason}` : ""}` : "Work queued",
      { stage: approvalRequired ? "approval" : "queued", percent: 0, evidenceKind: "intent", eventKey: `intent:${String(id)}` });
    if (approvalRequired) {
      await ctx.db.insert("approvals", {
        jobId: String(id),
        kind: "consequential-work",
        summary: (input.label || input.task).slice(0, 240),
        risk: input.risk ?? "consequential",
        payload: { repo: input.repo, agentId: input.agentId, reason: approval.reason },
        status: "pending",
        requestedAt: now,
      });
    }
    return id;
  },
});

// v3 is the explicit, bounded owner of historical scheduler admission. Hot
// polls never infer or repair authority for legacy rows.
const CONTROL_PLANE_MIGRATION = "scheduling-admission-v5-readonly-history";
const HEARTBEAT_PROTOCOL_ROLLOUT = "fenced-heartbeats-v2";
// Trigger grants a worker thirty minutes. Add one normal stale sweep so an
// old worker that was already live at cutover can checkpoint or terminate
// before its legacy no-ID liveness path closes.
const LEGACY_HEARTBEAT_DRAIN_MS = 35 * 60 * 1000;

async function heartbeatProtocolRollout(ctx: any) {
  return await ctx.db
    .query("workerProtocolRollouts")
    .withIndex("by_key", (q: any) => q.eq("key", HEARTBEAT_PROTOCOL_ROLLOUT))
    .first();
}

async function migrationState(ctx: any) {
  const existing = await ctx.db
    .query("controlPlaneMigrations")
    .withIndex("by_key", (q: any) => q.eq("key", CONTROL_PLANE_MIGRATION))
    .first();
  if (existing) return existing;
  const value = {
    key: CONTROL_PLANE_MIGRATION,
    jobsComplete: false,
    jobsScanned: 0,
    jobsRepaired: 0,
    missionsComplete: false,
    missionsScanned: 0,
    missionsRepaired: 0,
    updatedAt: Date.now(),
  };
  const id = await ctx.db.insert("controlPlaneMigrations", value);
  return { ...value, _id: id };
}

// One bounded page builds only the compact display/scheduling projection. V1
// jobs are durable history: rollout must never reinterpret their task, source,
// approval, delivery, retry, attempt or status authority. The only supported
// way to run that work again is an explicit owner-controlled enqueue that
// creates a new v2 mission/job from a fresh provider observation.
async function migrateLegacyJobsPage(ctx: any, migration?: any) {
  const state = migration ?? await migrationState(ctx);
  if (state.jobsComplete) return { scanned: 0, repaired: 0, complete: true };
  const page = await ctx.db
    .query("jobs")
    .withIndex("by_createdAt")
    // Recent rows are most likely to be live during rollout. Older durable
    // history follows through the same resumable cursor.
    .order("desc")
    .paginate({ cursor: state.jobsCursor ?? null, numItems: 12, maximumRowsRead: 12 });
  const now = Date.now();
  let repaired = 0;
  for (const persisted of page.page) {
    // Projection writes are deliberately confined to jobRuntime. No write to
    // the historical job, approval, event, receipt or attempt tables occurs.
    await upsertJobRuntime(ctx, persisted);
    if (!await readJobSchedulingAuthority(ctx, persisted)) {
      await quarantineJobRuntime(ctx, persisted);
      repaired += 1;
    }
  }
  const complete = page.isDone;
  await ctx.db.patch(state._id, {
    jobsCursor: complete ? undefined : page.continueCursor,
    jobsComplete: complete,
    jobsScanned: Number(state.jobsScanned ?? 0) + page.page.length,
    jobsRepaired: Number(state.jobsRepaired ?? 0) + repaired,
    completedAt: complete && state.missionsComplete ? now : undefined,
    updatedAt: now,
  });
  return { scanned: page.page.length, repaired, complete };
}

// Goal history follows the same read-only rollout rule as standalone jobs.
// This phase builds display projections only; it never repairs an old job in
// place because doing so would manufacture current execution authority from a
// historical plan rather than a fresh source observation.
async function migrateLegacyMissionsPage(ctx: any, migration?: any) {
  const state = migration ?? await migrationState(ctx);
  if (state.missionsComplete) return { scanned: 0, repaired: 0, complete: true };
  const page = await ctx.db
    .query("missions")
    .withIndex("by_createdAt")
    .order("desc")
    .paginate({ cursor: state.missionsCursor ?? null, numItems: 1, maximumRowsRead: 1 });
  let repaired = 0;
  for (const mission of page.page) {
    await upsertMissionRuntime(ctx, mission);
    const jobs = await ctx.db
      .query("jobs")
      .withIndex("by_mission", (q: any) => q.eq("missionId", String(mission._id)))
      .take(100);
    for (const job of jobs) {
      await upsertJobRuntime(ctx, job);
      if (!await readJobSchedulingAuthority(ctx, job)) {
        await quarantineJobRuntime(ctx, job);
        repaired += 1;
      }
    }
  }
  const now = Date.now();
  const complete = page.isDone;
  await ctx.db.patch(state._id, {
    missionsCursor: complete ? undefined : page.continueCursor,
    missionsComplete: complete,
    missionsScanned: Number(state.missionsScanned ?? 0) + page.page.length,
    missionsRepaired: Number(state.missionsRepaired ?? 0) + repaired,
    completedAt: complete && state.jobsComplete ? now : undefined,
    updatedAt: now,
  });
  return { scanned: page.page.length, repaired, complete };
}

type MigrationPageResult = { scanned: number; repaired: number; complete: boolean };

function idleMigrationPage(complete: boolean): MigrationPageResult {
  return { scanned: 0, repaired: 0, complete };
}

// Convex permits one built-in pagination call per function execution. Select
// exactly one durable phase before paginating; the migration row is also the
// optimistic-concurrency fence, so overlapping/retried mutations either commit
// one cursor advance or rerun from the cursor that won. Completed phases are
// constant-time no-ops and never restart their historical scan.
export async function migrateControlPlaneStep(ctx: any) {
  const state = await migrationState(ctx);
  if (!state.jobsComplete) {
    const jobs = await migrateLegacyJobsPage(ctx, state);
    const missions = idleMigrationPage(Boolean(state.missionsComplete));
    return {
      phase: "jobs" as const,
      jobs,
      missions,
      complete: jobs.complete && missions.complete,
    };
  }
  if (!state.missionsComplete) {
    const jobs = idleMigrationPage(true);
    const missions = await migrateLegacyMissionsPage(ctx, state);
    return {
      phase: "missions" as const,
      jobs,
      missions,
      complete: missions.complete,
    };
  }
  return {
    phase: "complete" as const,
    jobs: idleMigrationPage(true),
    missions: idleMigrationPage(true),
    complete: true,
  };
}

export const migrateControlPlane = mutation({
  args: { workerToken: v.optional(v.string()) },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    return await migrateControlPlaneStep(ctx);
  },
});

// A new Trigger deployment announces the fenced heartbeat protocol before it
// claims or schedules work. The record is deliberately one-way: it converts
// the old permissive bridge into a bounded drain for workers already running,
// without requiring a coordinated stop-the-world deployment.
export const activateHeartbeatProtocolV2 = mutation({
  args: {
    triggerDeploymentVersion: v.optional(v.string()),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const existing = await heartbeatProtocolRollout(ctx);
    if (existing) return {
      activated: false,
      activatedAt: existing.activatedAt,
      protocolVersion: existing.protocolVersion,
    };
    const now = Date.now();
    const deploymentVersion = a.triggerDeploymentVersion?.trim().slice(0, 160);
    await ctx.db.insert("workerProtocolRollouts", {
      key: HEARTBEAT_PROTOCOL_ROLLOUT,
      protocolVersion: 2,
      activatedAt: now,
      activatedByDeploymentVersion: deploymentVersion || undefined,
      updatedAt: now,
    });
    return { activated: true, activatedAt: now, protocolVersion: 2 as const };
  },
});

// Compatibility names for Trigger workers that were already running during
// rollout. They advance the same persisted cursors and become constant-time
// no-ops after completion.
export const reconcileAutonomousSoftwareWork = mutation({
  args: { workerToken: v.optional(v.string()) },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    return (await migrateLegacyJobsPage(ctx)).repaired;
  },
});

export const reconcileGoalWorkstreamModes = mutation({
  args: { workerToken: v.optional(v.string()) },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    return (await migrateLegacyMissionsPage(ctx)).repaired;
  },
});

/* eslint-disable @typescript-eslint/no-explicit-any -- scheduler validation joins only the bounded selected authority rows */
function boundRuntimeProjection(row: any) {
  try {
    return row?.schedulingBound === true
      && Number(row.schedulingProtocolVersion) === SCHEDULING_PROTOCOL_VERSION
      && Boolean(row.schedulingAdmissionId)
      && /^[0-9a-f]{64}$/.test(String(row.schedulingBindingDigest ?? ""))
      && schedulingAuthorityMatches(row)
      && immutableLineageIsValid(row);
  } catch {
    return false;
  }
}

export function executableRuntimeProjection(row: any) {
  return boundRuntimeProjection(row)
    && row.dispatchReady === true
    && (!row.approvalRequired || row.approvalStatus === "approved");
}

async function repairIndexedActiveRuntime(ctx: any, runtime: any, job: any, now: number) {
  let repaired: any;
  if (job) {
    repaired = projectJobRuntime(job);
    // An active durable row with broken admission remains visible to capacity
    // accounting until a separate authoritative transition makes it inactive.
    // Quarantining only its executable projection cannot free a worker slot.
    if (["dispatching", "running"].includes(String(job.status))
      && !await readJobSchedulingAuthority(ctx, job)) {
      repaired.schedulingBound = false;
      repaired.dispatchReady = false;
      delete repaired.nextRunAt;
    }
  } else {
    // A missing durable job is authoritative proof that this compact row is
    // not a live worker. Move the orphan out of the active index without ever
    // treating its mutable identity fields as repair authority.
    repaired = {
      ...runtime,
      status: "projection_quarantined",
      stage: "projection_quarantined",
      active: false,
      schedulingBound: false,
      dispatchReady: false,
      updatedAt: now,
    };
    delete repaired.nextRunAt;
    delete repaired.dispatchLeaseUntil;
  }
  await ctx.db.replace(runtime._id, repaired);
  const groupKeys = new Set([runtime.schedulingGroupKey, repaired.schedulingGroupKey]
    .filter((value): value is string => typeof value === "string" && value.length > 0));
  for (const groupKey of groupKeys) await refreshWorkGroupQueueProjection(ctx, groupKey, now);
}

async function activeBackgroundRows(ctx: any, now: number) {
  // Status is the conservative capacity index. `schedulingBound` and every
  // other compact field are mutable projections: they may withhold capacity,
  // but can never make an indexed active row disappear from the global count.
  // Taking limit + 1 is sufficient to close admission; deeper history cannot
  // change the answer and is deliberately never scanned.
  const rows = (await Promise.all(["dispatching", "running"].map((status) => ctx.db
    .query("jobRuntime")
    .withIndex("by_status_priority", (q: any) => q.eq("status", status))
    .take(BACKGROUND_CONCURRENCY_LIMIT + 1)))).flat();
  const authoritativeRows = [];
  let repairs = 0;
  let uncertainActiveAuthority = false;
  for (const runtime of rows) {
    const job: any = await ctx.db.get(runtime.jobId);
    const durableActive = job && ["dispatching", "running"].includes(String(job.status));
    const authority = durableActive ? await readJobSchedulingAuthority(ctx, job) : null;
    if (durableActive && authority && immutableLineageIsValid(job)) {
      // Group and write-lineage occupancy come only from the durable admission,
      // never from the compact row. This preserves per-group bounds even when
      // a projection is forged into a locally self-consistent alternate group.
      authoritativeRows.push({ ...job, ...authority.binding });
    } else if (durableActive) {
      // A live-looking durable row whose admission cannot be proven may reduce
      // availability, but it can never grant another dispatch.
      uncertainActiveAuthority = true;
    }
    const current = Boolean(durableActive && authority
      && boundRuntimeProjection(runtime)
      && runtimeMatchesSchedulingAuthority(runtime, authority)
      && runtime.status === job.status
      && Number(runtime.attempt) === Number(job.attempt ?? 1)
      && runtime.dispatchId === job.dispatchId
      && runtime.workerRunId === job.workerRunId);
    if (!current && repairs < ACTIVE_RUNTIME_REPAIR_LIMIT) {
      await repairIndexedActiveRuntime(ctx, runtime, job, now);
      repairs += 1;
    }
  }
  return {
    // Count physical index matches, including duplicates and rows repaired in
    // this transaction. A later poll observes the bounded repair; this poll can
    // never turn corrupted projection data into fresh execution capacity.
    capacityCount: rows.length,
    authoritativeRows,
    uncertainActiveAuthority,
  };
}

async function protectedApprovalAllowsExecution(ctx: any, job: any) {
  if (!job.approvalRequired) return true;
  if (job.approvalStatus !== "approved") return false;
  const approvals = await ctx.db.query("approvals")
    .withIndex("by_job", (q: any) => q.eq("jobId", String(job._id))).take(20);
  return approvals.some((approval: any) => approval.status === "approved" && Number(approval.resolvedAt ?? 0) > 0)
    && !approvals.some((approval: any) => approval.status === "pending");
}

export async function projectedDispatchCandidates(ctx: any, now: number, requestedLimit: number) {
  const active = await activeBackgroundRows(ctx, now);
  const available = active.uncertainActiveAuthority
    ? 0
    : Math.max(0, BACKGROUND_CONCURRENCY_LIMIT - active.capacityCount);
  const limit = Math.min(requestedLimit, available);
  if (!limit) return { selected: [], scheduler: null };

  const activeByGroup = new Map<string, number>();
  const activeWriteLineages = new Set<string>();
  for (const runtime of active.authoritativeRows) {
    const groupKey = String(runtime.schedulingGroupKey ?? "");
    if (!groupKey) continue;
    activeByGroup.set(groupKey, (activeByGroup.get(groupKey) ?? 0) + 1);
    const lineage = writeLineageKey(runtime);
    if (lineage) activeWriteLineages.add(lineage);
  }

  // Future queue heads are their own durable cursor. Each bounded promotion
  // removes rows from this due page, so even more than three windows of newly
  // due groups eventually become visible without scanning the jobs table.
  const newlyDueGroups = await ctx.db.query("workGroupScheduling")
    .withIndex("by_queue_due", (q: any) => q
      .eq("queueEligible", false)
      // Missing optional values sort before numbers in Convex indexes. The
      // lower bound excludes drained projections before the bounded take.
      .gte("queueHeadNextRunAt", 0)
      .lte("queueHeadNextRunAt", now))
    .take(DISPATCH_CANDIDATE_WINDOW_MAX);
  for (const group of newlyDueGroups) await ctx.db.patch(group._id, { queueEligible: true, updatedAt: now });

  // One row per immutable project group is ordered by its durable service
  // ticket. A deep project backlog therefore occupies one window slot, not 96,
  // and continuously arriving high-priority groups begin behind already-due
  // unserved groups.
  const dueGroups = await ctx.db.query("workGroupScheduling")
    .withIndex("by_queue_service", (q: any) => q.eq("queueEligible", true))
    .order("asc")
    .take(DISPATCH_CANDIDATE_WINDOW_MAX);
  const groupRows = new Map<string, any>();
  const candidates: any[] = [];
  for (const group of dueGroups) {
    const groupKey = String(group.groupKey);
    if ((activeByGroup.get(groupKey) ?? 0) >= MAX_ACTIVE_PER_WORK_GROUP) continue;
    const rows = await ctx.db.query("jobRuntime")
      .withIndex("by_group_dispatch_ready", (q: any) => q
        .eq("schedulingGroupKey", groupKey)
        .eq("status", "pending")
        .eq("schedulingBound", true)
        .eq("dispatchReady", true)
        .lte("nextRunAt", now))
      .order("asc")
      .take(BACKGROUND_CONCURRENCY_LIMIT);
    const executable = rows.filter((candidate: any) => executableRuntimeProjection(candidate)
      && typeof candidate.nextRunAt === "number" && candidate.nextRunAt <= now);
    if (!executable.length) {
      // A malformed or stale compact row must not pin the oldest service
      // window forever. Disabling only its non-authoritative projection keeps
      // execution fail-closed; an explicit authoritative transition can
      // rebuild it later.
      for (const candidate of rows) {
        if (!executableRuntimeProjection(candidate)) {
          await ctx.db.patch(candidate._id, { dispatchReady: false, updatedAt: now });
        }
      }
      await refreshWorkGroupQueueProjection(ctx, groupKey, now);
      continue;
    }
    groupRows.set(groupKey, group);
    candidates.push(...executable);
  }
  const fairCandidates = candidates.map((candidate: any) => ({
    id: String(candidate.jobId),
    groupKey: String(candidate.schedulingGroupKey),
    priority: Number(candidate.priority ?? 50),
    createdAt: Number(candidate.createdAt ?? candidate._creationTime ?? 0),
    writeLineage: writeLineageKey(candidate),
  }));
  const groupStates = new Map([...new Set(fairCandidates.map((candidate) => candidate.groupKey))].map((groupKey) => [groupKey, {
    activeCount: activeByGroup.get(groupKey) ?? 0,
    lastServedSequence: Number(groupRows.get(groupKey)?.lastServedSequence ?? 0),
  }]));
  const scheduler = await ctx.db.query("dispatchSchedulerState")
    .withIndex("by_key", (q: any) => q.eq("key", DISPATCH_SCHEDULER_KEY)).first();
  const runtimeById = new Map(candidates.map((candidate: any) => [String(candidate.jobId), candidate]));
  const selected = selectFairWork(fairCandidates, groupStates, activeWriteLineages, limit)
    .map((candidate) => runtimeById.get(candidate.id)).filter(Boolean);
  return { selected, scheduler, groupRows };
}

async function validateSelectedDispatchCandidate(ctx: any, runtime: any, now: number) {
  const job: any = await ctx.db.get(runtime.jobId);
  if (!job) return null;
  if (job.status !== "pending" || job.dispatchReady !== true || (job.attempt ?? 1) !== runtime.attempt
    || Number(job.nextRunAt ?? 0) > now) {
    await upsertJobRuntime(ctx, job);
    return null;
  }
  const authority = await readJobSchedulingAuthority(ctx, job);
  if (!authority) {
    await quarantineJobRuntime(ctx, job, runtime);
    return null;
  }
  if (!runtimeMatchesSchedulingAuthority(runtime, authority)
    || runtime.status !== job.status || Number(runtime.nextRunAt ?? 0) !== Number(job.nextRunAt ?? 0)) {
    await upsertJobRuntime(ctx, job);
    return null;
  }
  if (!await protectedApprovalAllowsExecution(ctx, job) || !immutableLineageIsValid(job)) return null;
  if (job.goalStage && job.missionId) {
    const missionId = ctx.db.normalizeId("missions", job.missionId);
    const mission = missionId ? await ctx.db.get(missionId) : null;
    if (!mission || !goalJobMatchesMissionPhase(job, mission)) return null;
  }
  if (job.planParentMissionId) {
    const verifiedHandoffs = await verifiedGoalHandoffsForJob(ctx, job);
    if (!verifiedHandoffs) {
      await patchJobWithRuntime(ctx, job, { dispatchReady: false });
      return null;
    }
  } else if (Array.isArray(job.dependsOn) && job.dependsOn.length) {
    if (job.dependsOn.length > 16) {
      await patchJobWithRuntime(ctx, job, { dispatchReady: false });
      return null;
    }
    const dependencies = await Promise.all(job.dependsOn.map((dependency: string) => {
      const id = ctx.db.normalizeId("jobs", dependency);
      return id ? ctx.db.get(id) : null;
    }));
    if (dependencies.some((dependency: any) => dependency?.status !== "done")) {
      await patchJobWithRuntime(ctx, job, { dispatchReady: false });
      return null;
    }
  }
  if (job.integrationAttemptId && job.missionId && job.repo) {
    const integration: any = await ctx.db.get(job.integrationAttemptId);
    if (!integration || integration.jobId !== job._id || integration.status !== "queued") return null;
  }
  const attemptNumber = Math.max(1, Number(job.attempt ?? 1));
  const existingAttempt = await readExactWorkAttempt(
    ctx,
    job._id,
    attemptNumber,
  );
  if (existingAttempt.kind === "ambiguous") {
    await quarantineJobRuntime(ctx, job, runtime);
    return null;
  }
  if (existingAttempt.kind === "missing") {
    // Mint execution authority only after approval, mission phase, exact DAG
    // handoffs and integration admission have all passed. Invalid/stale work
    // therefore leaves no executable catalog lineage behind.
    await ensureWorkAttempt(ctx, job, attemptNumber, "pending", now, {}, true);
  }
  const executionAuthority = await readAttemptExecutionAuthority(ctx, job, attemptNumber);
  if (!executionAuthority) {
    await quarantineJobRuntime(ctx, job, runtime);
    return null;
  }
  return { job, authority, executionAuthority };
}

async function runnableCandidates(ctx: any, now: number, requestedLimit: number) {
  const projected = await projectedDispatchCandidates(ctx, now, requestedLimit);
  const validated = [];
  for (const runtime of projected.selected) {
    const candidate = await validateSelectedDispatchCandidate(ctx, runtime, now);
    if (candidate) validated.push(candidate);
  }
  const groupRows = projected.groupRows as Map<string, any>;
  const authorized = validated.filter((candidate) => {
    const binding = candidate.authority.binding;
    const group = groupRows.get(binding.schedulingGroupKey);
    return group && group.missionGroupId === binding.missionGroupId
      && group.projectGroupId === binding.projectGroupId
      && group.canonicalProjectId === binding.canonicalProjectId
      && group.projectRepository === binding.projectRepository;
  });
  return {
    candidates: authorized,
    groupRows,
    scheduler: projected.scheduler,
  };
}

async function recordSchedulingReservations(ctx: any, jobs: any[], now: number, groupRows: Map<string, any>, scheduler: any) {
  if (!jobs.length) return;
  let sequence = Number(scheduler?.nextSequence ?? 0);
  const groupUpdates = new Map<string, { lastServedSequence: number; count: number }>();
  for (const job of jobs) {
    sequence += 1;
    const groupKey = String(job.schedulingGroupKey);
    const current = groupUpdates.get(groupKey) ?? { lastServedSequence: sequence, count: 0 };
    current.lastServedSequence = sequence;
    current.count += 1;
    groupUpdates.set(groupKey, current);
  }
  for (const [groupKey, update] of groupUpdates) {
    const group = groupRows.get(groupKey);
    if (!group) throw new Error("Reserved work lost its immutable scheduling group");
    await ctx.db.patch(group._id, {
      lastServedSequence: update.lastServedSequence,
      reservationCount: Number(group.reservationCount ?? 0) + update.count,
      updatedAt: now,
    });
  }
  const lastGroupKey = String(jobs[jobs.length - 1].schedulingGroupKey);
  if (scheduler) await ctx.db.patch(scheduler._id, { nextSequence: sequence, lastGroupKey, updatedAt: now });
  else await ctx.db.insert("dispatchSchedulerState", { key: DISPATCH_SCHEDULER_KEY, nextSequence: sequence, lastGroupKey, updatedAt: now });
}
/* eslint-enable @typescript-eslint/no-explicit-any */

async function claimedJob(ctx: any, j: any, upstreamEvidence: readonly any[] = []) {
  const attemptAuthority = await readAttemptExecutionAuthority(ctx, j, j.attempt ?? 1);
  if (!attemptAuthority) return null;
  const order = attemptAuthority.workOrder;
  const executionProfile = order.backgroundExecutionProfile === undefined
    ? resolveBackgroundExecutionProfileForWorkOrder({
      modelTier: order.minimumModel,
      readonly: order.readonly,
      repositoryCapabilities: order.toolScope,
    })
    : resolveBackgroundExecutionProfile(order.backgroundExecutionProfile);
  if (!executionProfile.accepted) return null;
  const delivery: any = j.activeDeliveryAttemptId ? await ctx.db.get(j.activeDeliveryAttemptId) : null;
  return {
    jobId: j._id,
    task: order.executableTask,
    policyTask: order.policyTask,
    repo: order.repository ?? null,
    readonly: order.readonly,
    model: order.minimumModel,
    reasoningEffort: order.minimumReasoningEffort,
    backgroundExecutionProfile: executionProfile.profile,
    mcp: [...order.mcpScope],
    toolScope: [...order.toolScope],
    agentRole: order.agentRole,
    machineClass: order.machineClass,
    triggerMachinePreset: order.triggerMachinePreset,
    triggerMachineReason: order.triggerMachineReason,
    triggerObservedMachinePreset: j.triggerObservedMachinePreset ?? null,
    triggerObservedMachineReason: j.triggerObservedMachineReason ?? null,
    triggerPlatformAttempt: j.triggerPlatformAttempt ?? null,
    dispatchId: j.dispatchId ?? null,
    dispatchGeneration: j.dispatchGeneration ?? null,
    dispatchPhase: j.dispatchPhase ?? null,
    dispatchReceiptDigest: j.dispatchReceiptDigest ?? null,
    dispatchPayloadDigest: j.dispatchPayloadDigest ?? null,
    workOrderRevisionId: attemptAuthority.workOrderRevisionId,
    workOrderRevision: attemptAuthority.workOrderRevision,
    workOrderRevisionDigest: attemptAuthority.workOrderRevisionDigest,
    incidentId: j.incidentId ?? null,
    retried: j.retried ?? false,
    missionId: j.missionId ?? null,
    missionGroupId: j.missionGroupId ?? null,
    projectGroupId: j.projectGroupId ?? null,
    projectRepository: order.repository ?? null,
    schedulingGroupKey: j.schedulingGroupKey ?? null,
    canonicalProjectId: j.canonicalProjectId ?? null,
    sourceProvider: j.sourceProvider ?? null,
    sourceRef: j.sourceRef ?? null,
    sourceObservedAt: j.sourceObservedAt ?? null,
    sourceAdmissionDigest: j.sourceAdmissionDigest ?? null,
    schedulingBindingDigest: j.schedulingBindingDigest ?? null,
    authorityDigest: attemptAuthority.authorityDigest,
    label: j.label ?? null,
    originThreadId: j.originThreadId ?? "main",
    originTurnId: j.originTurnId ?? null,
    agentId: order.agentId,
    risk: order.risk,
    priority: j.priority ?? 50,
    attempt: j.attempt ?? 1,
    maxAttempts: j.maxAttempts ?? 12,
    checkpoint: j.checkpoint ?? null,
    result: j.result ?? null,
    branch: j.branch ?? null,
    sourceBranch: j.sourceBranch ?? null,
    sourceHeadSha: j.sourceHeadSha ?? null,
    integrationBranch: j.integrationBranch ?? null,
    workerBranch: j.workerBranch ?? null,
    workerLineage: j.workerLineage ?? null,
    workspaceLineage: j.workspaceLineage ?? null,
    retryLineage: j.retryLineage ?? null,
    integrationAttemptId: j.integrationAttemptId ?? null,
    integrationState: j.integrationState ?? null,
    deliveryMode: order.deliveryPolicy,
    deliveryStatus: j.deliveryStatus ?? null,
    pullRequestUrl: j.pullRequestUrl ?? null,
    mergeCommitSha: j.mergeCommitSha ?? null,
    sourceWorkAttempt: j.attempt ?? 1,
    deliveryGeneration: j.deliveryGeneration ?? null,
    deliveryRunId: j.deliveryRunId ?? null,
    workerRunId: j.workerRunId ?? null,
    activeDeliveryAttemptId: j.activeDeliveryAttemptId ?? null,
    deliveryOutcome: delivery?.outcome ?? null,
    deliveryPolicy: delivery?.policy ?? null,
    deliveryStep: delivery?.currentStep ?? null,
    deliveryReviewKeyId: delivery?.reviewKeyId ?? null,
    deliveryPullRequestNumber: delivery?.pullRequestNumber ?? null,
    deliveryPullRequestUrl: delivery?.pullRequestUrl ?? null,
    deliveryPullRequestNodeId: delivery?.pullRequestNodeId ?? null,
    deliveryPullRequestDraft: delivery?.pullRequestDraft ?? null,
    deliveryObservedHeadSha: delivery?.observedPullRequestHead ?? null,
    deliveryObservedBaseSha: delivery?.observedPullRequestBase ?? null,
    deliveryMergeCommitSha: delivery?.mergeCommitSha ?? null,
    deliveryPreparedEffectKind: delivery?.preparedEffectKind ?? null,
    deliveryProviderObservation: delivery?.providerObservation ?? null,
    verificationVerdict: j.verificationVerdict ?? null,
    verificationNote: j.verificationNote ?? null,
    reviewReceiptId: j.reviewReceiptId ?? null,
    reviewReceiptDigest: j.reviewReceiptDigest ?? null,
    reviewReceiptSignature: j.reviewReceiptSignature ?? null,
    acceptanceCriteria: [...order.acceptanceCriteria],
    modelReason: j.modelReason ?? null,
    parentJobId: j.parentJobId ?? null,
    planParentMissionId: j.planParentMissionId ?? null,
    planDigest: j.planDigest ?? null,
    planGeneration: j.planGeneration ?? null,
    planNodeId: j.planNodeId ?? null,
    goalStage: j.goalStage ?? null,
    goalWorkstreamId: j.goalWorkstreamId ?? null,
    goalWave: j.goalWave ?? 0,
    steer: order.steeringInstruction ?? null,
    steerRevision: j.steerRevision ?? 0,
    upstreamEvidence,
  };
}

async function upstreamEvidenceForClaim(ctx: any, j: any) {
  if (j.planParentMissionId) return await verifiedGoalHandoffsForJob(ctx, j);
  // Dependencies are an explicit contract, not an invitation to read all
  // mission siblings. Preserve declared order so the claim snapshot is stable.
  const upstreamRows = await Promise.all((j.dependsOn ?? []).slice(0, 8).map(async (dependency: string) => {
    const id = ctx.db.normalizeId("jobs", dependency);
    return id ? await ctx.db.get(id) : null;
  }));
  return upstreamRows
    .filter((row: any) => row && row._id !== j._id && row.status === "done" && String(row.result ?? "").trim())
    .map((row: any) => ({
      label: String(row.label ?? row.task ?? "Upstream workstream").slice(0, 120), status: row.status,
      result: String(row.result).slice(0, 1_400), verificationNote: String(row.verificationNote ?? "").slice(0, 300),
    }));
}

// Reserve concrete jobs before asking Trigger.dev to create cloud runs. Convex
// serializes this mutation, so overlapping supervisors receive disjoint work
// and never need a global "is any runner active?" lock.
/* eslint-disable @typescript-eslint/no-explicit-any -- bounded scheduler joins validate durable Convex documents before dispatch */
export const reserveDispatchBatch = mutation({
  args: {
    limit: v.number(),
    reason: v.optional(v.string()),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const now = Date.now();
    const limit = Math.max(1, Math.min(BACKGROUND_CONCURRENCY_LIMIT, Math.floor(a.limit)));
    const reason = a.reason?.trim().replace(/\s+/g, " ").slice(0, 160) || "work-available";
    const reservations: any[] = [];
    const retryable = [
      ...await ctx.db.query("dispatchReceipts")
        .withIndex("by_status_lease", (q: any) => q.eq("status", "reconciling").lte("leaseUntil", now))
        .take(limit),
      ...await ctx.db.query("dispatchReceipts")
        .withIndex("by_status_lease", (q: any) => q.eq("status", "reserved").lte("leaseUntil", now))
        .take(limit),
    ].sort((left: any, right: any) => left.createdAt - right.createdAt);
    const retriedJobs = new Set<string>();
    for (const receipt of retryable) {
      if (reservations.length >= limit || retriedJobs.has(String(receipt.jobId))) continue;
      const row: any = await ctx.db.get(receipt.jobId);
      const exact = row
        && row.status === "dispatching"
        && row.dispatchId === receipt.dispatchId
        && row.dispatchReceiptDigest === receipt.receiptDigest
        && row.dispatchPayloadDigest === receipt.payloadDigest
        && Number(row.dispatchGeneration) === Number(receipt.generation)
        && row.dispatchPhase === receipt.phase;
      if (!exact) {
        await ctx.db.patch(receipt._id, {
          status: "superseded",
          closeReason: "durable job authority no longer matches open dispatch",
          leaseUntil: undefined,
          closedAt: now,
          updatedAt: now,
        });
        continue;
      }
      const reservation = reservationFromDispatchReceipt(receipt, row);
      if (!reservation) {
        await ctx.db.patch(receipt._id, {
          status: "superseded",
          closeReason: "stored dispatch payload is malformed",
          leaseUntil: undefined,
          closedAt: now,
          updatedAt: now,
        });
        continue;
      }
      const leaseUntil = now + DISPATCH_LEASE_MS;
      await ctx.db.patch(receipt._id, { status: "reserved", leaseUntil, updatedAt: now });
      await patchJobWithRuntime(ctx, row, {
        dispatchLeaseUntil: leaseUntil,
        dispatchReason: receipt.status === "reconciling" ? "reconciling exact Trigger launch" : row.dispatchReason,
        providerRunState: "queued",
        providerObservedAt: now,
        heartbeatAt: now,
      });
      reservations.push(reservation);
      retriedJobs.add(String(receipt.jobId));
    }
    const candidates = await runnableCandidates(ctx, now, Math.max(0, limit - reservations.length));
    const reservedJobs = [];
    for (const candidate of candidates.candidates) {
      const j = candidate.job;
      let attemptNumber = j.attempt ?? 1;
      let attempt = candidate.executionAuthority.attempt;
      const triggerMachine = {
        preset: candidate.executionAuthority.workOrder.triggerMachinePreset as TriggerAgentMachinePreset,
        reason: candidate.executionAuthority.workOrder.triggerMachineReason as TriggerAgentMachineReason,
      };
      // A malformed/legacy pending row may still point at a launched worker.
      // Never overwrite that binding into an unclaimable reservation: close
      // it first, record its terminal lineage, then reserve a fresh attempt.
      const deliveryContinuation = j.verificationVerdict === "pass" && Boolean(j.reviewReceiptId);
      if (attempt?.workerRunId && !deliveryContinuation) {
        if (!hasAttemptBudget(attemptNumber + 1, j.maxAttempts ?? 12)) continue;
        await ctx.db.patch(attempt._id, { status: "checkpointed", completedAt: now, lastEventAt: now });
        await appendAttemptEvidence(ctx, j, "reservation_repaired", "Malformed launched reservation fenced before redispatch", {
          stage: "checkpointed", evidenceKind: "reconcile", eventKey: `reservation-repaired:${attemptNumber}`, attempt: attemptNumber,
        });
        attemptNumber += 1;
        await patchJobWithRuntime(ctx, j, { attempt: attemptNumber, ...invalidateDeliveryLease(j) });
        attempt = await ensureAttempt(ctx, j._id, attemptNumber, "pending", now);
        if (!await readAttemptExecutionAuthority(ctx, { ...j, attempt: attemptNumber }, attemptNumber)) {
          await quarantineJobRuntime(ctx, { ...j, attempt: attemptNumber });
          continue;
        }
        await appendAttemptEvidence(ctx, j, "queued", `Fresh attempt ${attemptNumber} queued after reservation repair`, {
          stage: "queued", evidenceKind: "intent", eventKey: `intent:${attemptNumber}`, attempt: attemptNumber,
        });
        j.attempt = attemptNumber;
      }
      const createdDispatch = await createDispatchReceipt(
        ctx,
        j,
        attemptNumber,
        candidate.executionAuthority,
        triggerMachine,
        reason,
        now,
      );
      if (!createdDispatch) continue;
      const dispatchId = createdDispatch.receipt.dispatchId;
      const dispatchReceipt: any = await ctx.db.get(createdDispatch.receiptId);
      if (!dispatchReceipt) continue;
      await patchJobWithRuntimeDeferredQueue(ctx, j, {
        status: "dispatching",
        stage: "dispatching",
        progress: "cloud worker reserved",
        // `percent` is the current specialist attempt, not a lifetime high
        // water mark. A correction/recovery may follow a prior 99% attempt;
        // carrying that value makes a brand-new workspace look complete.
        percent: deliveryContinuation ? Math.max(1, j.percent ?? 0) : 1,
        dispatchId,
        dispatchGeneration: dispatchReceipt.generation,
        dispatchPhase: dispatchReceipt.phase,
        dispatchReceiptId: createdDispatch.receiptId,
        dispatchReceiptDigest: dispatchReceipt.receiptDigest,
        dispatchPayloadDigest: dispatchReceipt.payloadDigest,
        dispatchLeaseUntil: now + DISPATCH_LEASE_MS,
        dispatchReason: reason,
        workerRunId: undefined,
        deliveryRunId: undefined,
        // Generation one is allocated exactly once with the cold review
        // receipt. Dispatching/recovery binds that existing generation; it
        // must never allocate a second number for the same controller pass.
        deliveryGeneration: deliveryContinuation ? Math.max(1, Number(j.deliveryGeneration ?? 1)) : j.deliveryGeneration,
        workerRuntime: "trigger",
        triggerMachinePreset: triggerMachine.preset,
        triggerMachineReason: triggerMachine.reason,
        triggerObservedMachinePreset: undefined,
        triggerObservedMachineReason: undefined,
        triggerPlatformAttempt: undefined,
        providerRunState: "queued",
        providerObservedAt: now,
        heartbeatAt: now,
      });
      // The append-only dispatch receipt plus the durable job projection are
      // the pre-claim authority. Defer the redundant attempt projection write
      // until claim to keep reservation transactions smaller, reduce hot-path
      // contention, and avoid rewriting a projection claim will immediately
      // replace.
      if (!attempt) await ensureAttempt(ctx, j._id, attemptNumber, "dispatching", now, {
        dispatchId,
        dispatchGeneration: dispatchReceipt.generation,
        dispatchPhase: dispatchReceipt.phase,
        dispatchReceiptId: createdDispatch.receiptId,
        dispatchReceiptDigest: dispatchReceipt.receiptDigest,
        dispatchPayloadDigest: dispatchReceipt.payloadDigest,
        triggerMachinePreset: triggerMachine.preset,
        triggerMachineReason: triggerMachine.reason,
      });
      await appendAttemptEvidence(ctx, j, "dispatched", `Independent Trigger worker reserved${a.reason ? ` · ${a.reason.slice(0, 120)}` : ""}`, {
        stage: "dispatching", percent: deliveryContinuation ? Math.max(1, j.percent ?? 0) : 1, evidenceKind: "dispatch", eventKey: `dispatch:${attemptNumber}:${dispatchId}`,
      });
      const reservation = reservationFromDispatchReceipt(dispatchReceipt, j);
      if (reservation) reservations.push(reservation);
      reservedJobs.push(j);
    }
    for (const groupKey of new Set(reservedJobs.map((job) => String(job.schedulingGroupKey)))) {
      await refreshWorkGroupQueueProjection(ctx, groupKey, now);
    }
    await recordSchedulingReservations(ctx, reservedJobs, now, candidates.groupRows, candidates.scheduler);
    return { reservations };
  },
});
/* eslint-enable @typescript-eslint/no-explicit-any */

type StoredSupervisorFleetMember = NonNullable<
  Doc<"missionSupervisorControls">["fleetManifest"]
>[number];
type ExactAttemptExecutionAuthority = NonNullable<
  Awaited<ReturnType<typeof readAttemptExecutionAuthority>>
>;
type ExactSchedulingAuthority = NonNullable<
  Awaited<ReturnType<typeof readJobSchedulingAuthority>>
>;
type SupervisorFleetMemberPreflight =
  | {
      kind: "candidate";
      member: StoredSupervisorFleetMember;
      job: Doc<"jobs">;
      execution: ExactAttemptExecutionAuthority;
      scheduling: ExactSchedulingAuthority;
      group: Doc<"workGroupScheduling">;
      nextDispatchGeneration: number;
    }
  | {
      kind: "reoffer";
      member: StoredSupervisorFleetMember;
      job: Doc<"jobs">;
      receipt: Doc<"dispatchReceipts">;
    }
  | {
      kind: "already_inflight";
      member: StoredSupervisorFleetMember;
      job: Doc<"jobs">;
    }
  | {
      kind: "already_advanced";
      member: StoredSupervisorFleetMember;
      job: Doc<"jobs">;
    }
  | {
      kind: "fallback_skipped";
      member: StoredSupervisorFleetMember;
      job: Doc<"jobs">;
    };

function exactCanonicalIds(
  values: readonly Id<"jobs">[] | undefined,
  expectedCount: number | undefined,
): Id<"jobs">[] | null {
  if (
    !values
    || !Number.isSafeInteger(expectedCount)
    || Number(expectedCount) < 0
    || values.length !== expectedCount
    || values.length > 24
  ) {
    return null;
  }
  const sorted = [...values].sort((left, right) =>
    String(left).localeCompare(String(right))
  );
  if (
    new Set(sorted.map(String)).size !== sorted.length
    || sorted.some((value, index) => value !== values[index])
  ) {
    return null;
  }
  return sorted;
}

async function exactSupervisorControlBatchReceipt(
  receipt: Doc<"missionSupervisorControls">,
  action: "pause" | "resume",
): Promise<Id<"jobs">[] | null> {
  const affectedJobIds = exactCanonicalIds(
    receipt.affectedJobIds,
    receipt.affectedJobCount,
  );
  if (
    receipt.protocolVersion !== 1
    || receipt.action !== action
    || !receipt.applied
    || receipt.noop
    || receipt.scope !== "supervisor_active_job_batch"
    || receipt.batchProtocolVersion !== 1
    || receipt.resultInputRevision === undefined
    || receipt.resultInputRevision !== receipt.expectedInputRevision + 1
    || !affectedJobIds
    || typeof receipt.batchDigest !== "string"
    || !/^[0-9a-f]{64}$/.test(receipt.batchDigest)
    || (
      action === "pause"
        ? receipt.sourcePauseControlReceiptId !== undefined
        : receipt.sourcePauseControlReceiptId === undefined
    )
  ) {
    return null;
  }
  const digest = await canonicalSupervisorControlBatchDigest({
    missionId: String(receipt.missionId),
    action,
    requestKey: receipt.requestKey,
    requestDigest: receipt.requestDigest,
    expectedInputRevision: receipt.expectedInputRevision,
    resultInputRevision: receipt.resultInputRevision,
    affectedJobIds: affectedJobIds.map(String),
    sourcePauseControlReceiptId: receipt.sourcePauseControlReceiptId
      ? String(receipt.sourcePauseControlReceiptId)
      : undefined,
  });
  return digest === receipt.batchDigest ? affectedJobIds : null;
}

async function supervisorFleetControlAuthority(
  ctx: Pick<MutationCtx, "db">,
  controlReceiptId: Id<"missionSupervisorControls">,
) {
  const receipt = await ctx.db.get(controlReceiptId);
  if (!receipt) return null;
  const affectedJobIds = await exactSupervisorControlBatchReceipt(
    receipt,
    "resume",
  );
  if (
    !affectedJobIds
    || !receipt.sourcePauseControlReceiptId
    || receipt.fleetManifestProtocolVersion
      !== SUPERVISOR_FLEET_MANIFEST_PROTOCOL_VERSION
    || !receipt.fleetManifest
    || !Number.isSafeInteger(receipt.fleetManifestCount)
    || Number(receipt.fleetManifestCount) < 1
    || receipt.fleetManifest.length !== receipt.fleetManifestCount
    || typeof receipt.fleetManifestDigest !== "string"
  ) {
    return null;
  }
  const pauseReceipt = await ctx.db.get(receipt.sourcePauseControlReceiptId);
  if (
    !pauseReceipt
    || pauseReceipt.missionId !== receipt.missionId
    || pauseReceipt.resultInputRevision !== receipt.expectedInputRevision
  ) {
    return null;
  }
  const pauseJobIds = await exactSupervisorControlBatchReceipt(
    pauseReceipt,
    "pause",
  );
  if (!pauseJobIds) return null;
  const paused = new Set(pauseJobIds.map(String));
  const affected = new Set(affectedJobIds.map(String));
  const manifest = receipt.fleetManifest;
  if (
    affectedJobIds.some((jobId) => !paused.has(String(jobId)))
    || manifest.some((member) =>
      !affected.has(String(member.jobId))
      || !paused.has(String(member.jobId))
    )
    || !await validSupervisorFleetManifest({
      binding: {
        missionId: String(receipt.missionId),
        requestKey: receipt.requestKey,
        requestDigest: receipt.requestDigest,
        expectedInputRevision: receipt.expectedInputRevision,
        resultInputRevision: receipt.resultInputRevision!,
        sourcePauseControlReceiptId: String(
          receipt.sourcePauseControlReceiptId,
        ),
      },
      members: manifest as unknown as SupervisorFleetManifestMember[],
      memberCount: receipt.fleetManifestCount!,
      fleetDigest: receipt.fleetManifestDigest,
    })
  ) {
    return null;
  }
  return {
    receipt,
    members: manifest,
    fleetDigest: receipt.fleetManifestDigest,
  };
}

function validSupervisorFleetMachine(
  receipt: Doc<"dispatchReceipts">,
): receipt is Doc<"dispatchReceipts"> & {
  triggerMachinePreset: TriggerAgentMachinePreset;
  triggerMachineReason: TriggerAgentMachineReason;
} {
  return ["medium-1x", "medium-2x"].includes(receipt.triggerMachinePreset)
    && (TRIGGER_AGENT_MACHINE_REASONS as readonly string[])
      .includes(receipt.triggerMachineReason);
}

async function exactProjectedDispatchReceipt(
  ctx: Pick<MutationCtx, "db">,
  args: {
    job: Doc<"jobs">;
    execution: ExactAttemptExecutionAuthority;
    receipt: Doc<"dispatchReceipts">;
    source?: SupervisorDispatchSource;
    requireJobProjection?: boolean;
    expectedPhase?: TriggerAgentDispatchPhase;
  },
): Promise<boolean> {
  const { job, execution, receipt, source } = args;
  const requireJobProjection = args.requireJobProjection ?? true;
  let payload: { reason?: unknown };
  try {
    payload = JSON.parse(receipt.payloadJson) as { reason?: unknown };
  } catch {
    return false;
  }
  if (
    typeof payload.reason !== "string"
    || !validSupervisorFleetMachine(receipt)
  ) {
    return false;
  }
  const envelope = await dispatchReceiptEnvelope(
    job,
    receipt.attempt,
    receipt.generation,
    execution,
    {
      preset: receipt.triggerMachinePreset,
      reason: receipt.triggerMachineReason,
    },
    payload.reason,
    source,
    args.expectedPhase,
  );
  return (
    receipt.jobId === job._id
    && receipt.attempt === execution.attempt.attempt
    && receipt.phase === envelope.phase
    && receipt.dispatchId === envelope.dispatchId
    && receipt.authorityDigest === execution.authorityDigest
    && receipt.workOrderRevisionDigest
      === execution.workOrderRevisionDigest
    && receipt.payloadJson === envelope.payloadJson
    && receipt.payloadDigest === envelope.payloadDigest
    && receipt.receiptDigest === envelope.receiptDigest
    && receipt.sourceSupervisorControlReceiptId
      === source?.controlReceiptId
    && receipt.sourceSupervisorFleetDigest === source?.fleetDigest
    && receipt.sourceSupervisorMemberDigest === source?.memberDigest
    && (
      !requireJobProjection
      || (
        job.dispatchReceiptId === receipt._id
        && job.dispatchId === receipt.dispatchId
        && job.dispatchGeneration === receipt.generation
        && job.dispatchPhase === receipt.phase
        && job.dispatchReceiptDigest === receipt.receiptDigest
        && job.dispatchPayloadDigest === receipt.payloadDigest
      )
    )
  );
}

async function exactManifestApproval(
  ctx: Pick<MutationCtx, "db">,
  job: Doc<"jobs">,
  member: StoredSupervisorFleetMember,
): Promise<boolean> {
  if (!job.approvalRequired) {
    return member.approvalId === undefined
      && member.approvalResolvedAt === undefined;
  }
  if (
    job.approvalStatus !== "approved"
    || !member.approvalId
    || !Number.isSafeInteger(member.approvalResolvedAt)
    || Number(member.approvalResolvedAt) <= 0
  ) {
    return false;
  }
  const [approval, approved, pending] = await Promise.all([
    ctx.db.get(member.approvalId),
    ctx.db
      .query("approvals")
      .withIndex("by_job_status", (q) =>
        q.eq("jobId", String(job._id)).eq("status", "approved")
      )
      .take(2),
    ctx.db
      .query("approvals")
      .withIndex("by_job_status", (q) =>
        q.eq("jobId", String(job._id)).eq("status", "pending")
      )
      .take(1),
  ]);
  return Boolean(
    approval
    && approved.length === 1
    && approved[0]._id === approval._id
    && pending.length === 0
    && approval.jobId === String(job._id)
    && approval.status === "approved"
    && approval.resolvedAt === member.approvalResolvedAt,
  );
}

async function exactManifestDelivery(
  ctx: Pick<MutationCtx, "db">,
  job: Doc<"jobs">,
  execution: ExactAttemptExecutionAuthority,
  member: StoredSupervisorFleetMember,
  state: "pending" | "offered" | "running",
): Promise<boolean> {
  if (member.phase === "specialist") {
    return !job.activeDeliveryAttemptId
      && !job.reviewReceiptId
      && !job.reviewReceiptDigest
      && member.deliveryAttemptId === undefined
      && member.deliverySourceWorkAttempt === undefined
      && member.deliveryGeneration === undefined
      && member.reviewReceiptId === undefined
      && member.reviewReceiptDigest === undefined
      && (
        state === "running"
          ? execution.attempt.status === "running"
            && execution.attempt.dispatchId === job.dispatchId
            && execution.attempt.workerRunId === job.workerRunId
          : !execution.attempt.dispatchId
            && !execution.attempt.workerRunId
            && !execution.attempt.sessionId
            && !execution.attempt.launchedAt
            && !execution.attempt.completedAt
            && ["pending", "queued"].includes(execution.attempt.status)
      );
  }
  if (
    job.verificationVerdict !== "pass"
    || !member.deliveryAttemptId
    || !member.reviewReceiptId
    || typeof member.reviewReceiptDigest !== "string"
    || !Number.isSafeInteger(member.deliverySourceWorkAttempt)
    || !Number.isSafeInteger(member.deliveryGeneration)
  ) {
    return false;
  }
  if (
    execution.attempt.status !== "done"
    || !Number.isSafeInteger(execution.attempt.completedAt)
    || Number(execution.attempt.completedAt) <= 0
    || typeof execution.attempt.workerRunId !== "string"
    || typeof execution.attempt.sessionId !== "string"
    || typeof execution.attempt.launchedAt !== "number"
    || typeof execution.attempt.dispatchId !== "string"
    || execution.attempt.dispatchPhase !== "specialist"
    || !execution.attempt.dispatchReceiptId
    || typeof execution.attempt.dispatchReceiptDigest !== "string"
    || typeof execution.attempt.dispatchPayloadDigest !== "string"
  ) {
    return false;
  }
  const [delivery, review] = await Promise.all([
    ctx.db.get(member.deliveryAttemptId),
    ctx.db.get(member.reviewReceiptId),
  ]);
  return Boolean(
    delivery
    && review
    && job.activeDeliveryAttemptId === delivery._id
    && job.deliveryGeneration === member.deliveryGeneration
    && job.reviewReceiptId === review._id
    && job.reviewReceiptDigest === member.reviewReceiptDigest
    && delivery.jobId === job._id
    && delivery.sourceWorkAttempt === member.deliverySourceWorkAttempt
    && delivery.sourceWorkAttempt === member.attempt
    && delivery.generation === member.deliveryGeneration
    && (
      state === "running"
        ? delivery.status === "running"
          && delivery.dispatchId === job.dispatchId
          && delivery.deliveryRunId === job.deliveryRunId
        : delivery.status === "checkpointed"
          && !delivery.dispatchId
          && !delivery.deliveryRunId
          && !delivery.leaseOwner
          && !delivery.leaseToken
          && !delivery.leaseUntil
    )
    && delivery.authorityDigest === execution.authorityDigest
    && delivery.schedulingBindingDigest
      === execution.schedulingBindingDigest
    && delivery.workOrderRevisionId === execution.workOrderRevisionId
    && delivery.workOrderRevision === execution.workOrderRevision
    && delivery.workOrderRevisionDigest
      === execution.workOrderRevisionDigest
    && delivery.reviewReceiptId === review._id
    && delivery.reviewReceiptDigest === review.receiptDigest
    && review.jobId === job._id
    && review.attempt === member.attempt
    && review.receiptDigest === member.reviewReceiptDigest
    && review.authorityDigest === execution.authorityDigest
    && review.schedulingBindingDigest
      === execution.schedulingBindingDigest
    && review.workOrderRevisionId === execution.workOrderRevisionId
    && review.workOrderRevision === execution.workOrderRevision
    && review.workOrderRevisionDigest
      === execution.workOrderRevisionDigest,
  );
}

async function exactSupervisorFleetMemberAuthority(
  ctx: Pick<MutationCtx, "db">,
  args: {
    controlReceipt: Doc<"missionSupervisorControls">;
    fleetDigest: string;
    member: StoredSupervisorFleetMember;
    now: number;
  },
): Promise<SupervisorFleetMemberPreflight | null> {
  const { controlReceipt, fleetDigest, member, now } = args;
  const job = await ctx.db.get(member.jobId);
  if (
    !job
    || String(job.missionId ?? "") !== String(controlReceipt.missionId)
    || member.protocolVersion !== SUPERVISOR_FLEET_MANIFEST_PROTOCOL_VERSION
  ) {
    return null;
  }
  const [execution, scheduling, sourceReceipts] = await Promise.all([
    readAttemptExecutionAuthority(ctx, job, member.attempt),
    readJobSchedulingAuthority(ctx, job),
    ctx.db
      .query("dispatchReceipts")
      .withIndex("by_supervisor_control_member", (q) =>
        q
          .eq("sourceSupervisorControlReceiptId", controlReceipt._id)
          .eq("jobId", member.jobId)
      )
      .take(2),
  ]);
  if (
    !execution
    || !scheduling
    || sourceReceipts.length > 1
    || execution.attempt._id !== member.workAttemptId
    || execution.authorityDigest !== member.authorityDigest
    || scheduling.admission._id !== member.schedulingAdmissionId
    || scheduling.digest !== member.schedulingBindingDigest
    || scheduling.binding.schedulingGroupKey !== member.schedulingGroupKey
    || execution.schedulingBindingDigest
      !== member.schedulingBindingDigest
    || execution.workOrderRevisionId !== member.workOrderRevisionId
    || execution.workOrderRevision !== member.workOrderRevision
    || execution.workOrderRevisionDigest
      !== member.workOrderRevisionDigest
    || Number(job.priority) !== member.priority
    || Number(job.createdAt) !== member.createdAt
    || (writeLineageKey(job) ?? undefined) !== member.writeLineage
  ) {
    return null;
  }
  const source = {
    controlReceiptId: controlReceipt._id,
    fleetDigest,
    memberDigest: member.memberDigest,
  };
  const sourceReceipt = sourceReceipts[0];
  if (["done", "error", "cancelled", "needs_input"].includes(job.status)) {
    const terminal = await exactTerminalWorkReceipt(ctx, job);
    if (
      !terminal
      || terminal.receipt.attempt < member.attempt
    ) {
      return null;
    }
    if (terminal.receipt.attempt > member.attempt) {
      if (
        !sourceReceipt
        || !["closed", "superseded"].includes(sourceReceipt.status)
        || !await exactProjectedDispatchReceipt(ctx, {
          job,
          execution,
          receipt: sourceReceipt,
          source,
          requireJobProjection: false,
          expectedPhase: member.phase,
        })
      ) {
        return null;
      }
      return { kind: "already_advanced", member, job };
    }
    if (
      sourceReceipt
      && (
        !["closed", "superseded"].includes(sourceReceipt.status)
        || !await exactProjectedDispatchReceipt(ctx, {
          job,
          execution,
          receipt: sourceReceipt,
          source,
          requireJobProjection: false,
          expectedPhase: member.phase,
        })
      )
    ) {
      return null;
    }
    if (!sourceReceipt && job.dispatchReceiptId) {
      const historical = await ctx.db.get(job.dispatchReceiptId);
      if (
        !historical
        || historical.sourceSupervisorControlReceiptId
        || !["closed", "superseded"].includes(historical.status)
        || !await exactProjectedDispatchReceipt(ctx, {
          job,
          execution,
          receipt: historical,
          requireJobProjection: false,
          expectedPhase: member.phase,
        })
      ) {
        return null;
      }
    }
    return { kind: "already_advanced", member, job };
  }
  if (member.attempt !== Number(job.attempt ?? 1)) {
    if (
      Number(job.attempt ?? 0) > member.attempt
      && sourceReceipt
      && ["closed", "superseded"].includes(sourceReceipt.status)
      && await exactProjectedDispatchReceipt(ctx, {
        job,
        execution,
        receipt: sourceReceipt,
        source,
        requireJobProjection: false,
        expectedPhase: member.phase,
      })
    ) {
      return { kind: "already_advanced", member, job };
    }
    return null;
  }
  if (
    member.phase !== dispatchPhaseForJob(job)
    || job.integrationAttemptId
    || !await exactManifestApproval(ctx, job, member)
  ) {
    return null;
  }
  if (sourceReceipt) {
    if (
      !await exactProjectedDispatchReceipt(ctx, {
        job,
        execution,
        receipt: sourceReceipt,
        source,
        expectedPhase: member.phase,
      })
    ) {
      return null;
    }
    if (
      job.status === "dispatching"
      && ["reserved", "reconciling"].includes(sourceReceipt.status)
    ) {
      if (!await exactManifestDelivery(
        ctx,
        job,
        execution,
        member,
        "offered",
      )) {
        return null;
      }
      if (
        !Number.isSafeInteger(sourceReceipt.leaseUntil)
        || Number(sourceReceipt.leaseUntil) <= now
      ) {
        return { kind: "fallback_skipped", member, job };
      }
      return { kind: "reoffer", member, job, receipt: sourceReceipt };
    }
    if (
      job.status === "running"
      && sourceReceipt.status === "claimed"
      && sourceReceipt.workerRunId === job.workerRunId
    ) {
      if (!await exactManifestDelivery(
        ctx,
        job,
        execution,
        member,
        "running",
      )) {
        return null;
      }
      return { kind: "already_inflight", member, job };
    }
    return null;
  }

  if (job.status === "dispatching" || job.status === "running") {
    const receipt = job.dispatchReceiptId
      ? await ctx.db.get(job.dispatchReceiptId)
      : null;
    if (
      !receipt
      || receipt.sourceSupervisorControlReceiptId
      || !await exactProjectedDispatchReceipt(ctx, {
        job,
        execution,
        receipt,
        expectedPhase: member.phase,
      })
      || (
        job.status === "dispatching"
          ? !["reserved", "reconciling"].includes(receipt.status)
          : receipt.status !== "claimed"
            || receipt.workerRunId !== job.workerRunId
      )
    ) {
      return null;
    }
    if (!await exactManifestDelivery(
      ctx,
      job,
      execution,
      member,
      job.status === "running" ? "running" : "offered",
    )) {
      return null;
    }
    return { kind: "already_inflight", member, job };
  }
  if (
    job.status !== "pending"
    || job.dispatchReady !== true
    || job.schedulingBound !== true
    || job.dispatchId
    || job.workerRunId
    || job.deliveryRunId
    || job.nextRunAt !== member.nextRunAt
    || member.nextRunAt > now
    || !await exactManifestDelivery(
      ctx,
      job,
      execution,
      member,
      "pending",
    )
  ) {
    return null;
  }
  const runtimeRows = await ctx.db
    .query("jobRuntime")
    .withIndex("by_job", (q) => q.eq("jobId", job._id))
    .take(2);
  if (
    runtimeRows.length !== 1
    || runtimeRows[0].status !== "pending"
    || runtimeRows[0].attempt !== member.attempt
    || runtimeRows[0].nextRunAt !== member.nextRunAt
    || !runtimeMatchesSchedulingAuthority(runtimeRows[0], scheduling)
  ) {
    return null;
  }
  const latest = await ctx.db
    .query("dispatchReceipts")
    .withIndex("by_job_generation", (q) => q.eq("jobId", job._id))
    .order("desc")
    .take(2);
  if (
    latest[0]
    && (
      !Number.isSafeInteger(latest[0].generation)
      || latest[0].generation < 1
      || !["closed", "superseded"].includes(latest[0].status)
      || (
        latest[1]
        && latest[1].generation === latest[0].generation
      )
    )
  ) {
    return null;
  }
  const groups = await ctx.db
    .query("workGroupScheduling")
    .withIndex("by_group", (q) =>
      q.eq("groupKey", scheduling.binding.schedulingGroupKey)
    )
    .take(2);
  const group = groups[0];
  const nextDispatchGeneration = Number(latest[0]?.generation ?? 0) + 1;
  if (
    groups.length !== 1
    || !group
    || group.missionGroupId !== scheduling.binding.missionGroupId
    || group.projectGroupId !== scheduling.binding.projectGroupId
    || group.canonicalProjectId
      !== scheduling.binding.canonicalProjectId
    || group.projectRepository
      !== scheduling.binding.projectRepository
    || !Number.isSafeInteger(nextDispatchGeneration)
    || nextDispatchGeneration < 1
  ) {
    return null;
  }
  return {
    kind: "candidate",
    member,
    job,
    execution,
    scheduling,
    group,
    nextDispatchGeneration,
  };
}

async function supervisorFleetActiveCapacity(
  ctx: Pick<MutationCtx, "db">,
) {
  const rows = (await Promise.all(
    ["dispatching", "running"].map((status) =>
      ctx.db
        .query("jobRuntime")
        .withIndex("by_status_priority", (q) => q.eq("status", status))
        .take(BACKGROUND_CONCURRENCY_LIMIT + 1)
    ),
  )).flat();
  if (rows.length >= BACKGROUND_CONCURRENCY_LIMIT) {
    return {
      available: 0,
      activeByGroup: new Map<string, number>(),
      activeWriteLineages: new Set<string>(),
    };
  }
  const activeByGroup = new Map<string, number>();
  const activeWriteLineages = new Set<string>();
  const seen = new Set<string>();
  for (const runtime of rows) {
    const job = await ctx.db.get(runtime.jobId);
    const scheduling = job
      && ["dispatching", "running"].includes(job.status)
      ? await readJobSchedulingAuthority(ctx, job)
      : null;
    if (
      !job
      || !scheduling
      || seen.has(String(job._id))
      || runtime.status !== job.status
      || runtime.attempt !== Number(job.attempt ?? 1)
      || runtime.dispatchId !== job.dispatchId
      || runtime.workerRunId !== job.workerRunId
      || !runtimeMatchesSchedulingAuthority(runtime, scheduling)
    ) {
      return {
        available: 0,
        activeByGroup: new Map<string, number>(),
        activeWriteLineages: new Set<string>(),
      };
    }
    seen.add(String(job._id));
    const groupKey = scheduling.binding.schedulingGroupKey;
    activeByGroup.set(groupKey, (activeByGroup.get(groupKey) ?? 0) + 1);
    const lineage = writeLineageKey(job);
    if (lineage) activeWriteLineages.add(lineage);
  }
  return {
    available: Math.max(0, BACKGROUND_CONCURRENCY_LIMIT - rows.length),
    activeByGroup,
    activeWriteLineages,
  };
}

// A resume route may offer only the exact immutable members sealed into its
// applied control receipt. It never samples the generic queue or expired
// dispatch indexes; the minute scheduler remains the eventual fallback.
export const reserveSupervisorControlDispatchBatchV1 = mutation({
  args: {
    controlReceiptId: v.id("missionSupervisorControls"),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    const now = Date.now();
    const control = await supervisorFleetControlAuthority(
      ctx,
      args.controlReceiptId,
    );
    if (!control) {
      return {
        protocolVersion: 1 as const,
        status: "invalid_manifest" as const,
        reservations: [],
      };
    }

    const preflight: SupervisorFleetMemberPreflight[] = [];
    for (const member of control.members) {
      const result = await exactSupervisorFleetMemberAuthority(ctx, {
        controlReceipt: control.receipt,
        fleetDigest: control.fleetDigest,
        member,
        now,
      });
      if (!result) {
        return {
          protocolVersion: 1 as const,
          status: "stale_manifest" as const,
          reservations: [],
        };
      }
      preflight.push(result);
    }

    const reoffers = preflight.filter((member) =>
      member.kind === "reoffer"
    );
    const inflight = preflight.filter((member) =>
      member.kind === "already_inflight"
    );
    const advanced = preflight.filter((member) =>
      member.kind === "already_advanced"
    );
    const fallbackSkipped = preflight.filter((member) =>
      member.kind === "fallback_skipped"
    );
    const candidates = preflight.filter((member) =>
      member.kind === "candidate"
    );
    const reservations = reoffers.flatMap((planned) => {
      if (planned.kind !== "reoffer") return [];
      const reservation = reservationFromDispatchReceipt(
        planned.receipt,
        planned.job,
      );
      return reservation ? [reservation] : [];
    });
    if (reservations.length !== reoffers.length) {
      return {
        protocolVersion: 1 as const,
        status: "stale_manifest" as const,
        reservations: [],
      };
    }
    if (!candidates.length) {
      return {
        protocolVersion: 1 as const,
        status: reservations.length
          ? "reserved" as const
          : inflight.length
            ? "already_inflight" as const
            : advanced.length
              ? "already_advanced" as const
              : "fallback_pending" as const,
        reservations,
        alreadyInflightCount: inflight.length,
        alreadyAdvancedCount: advanced.length,
        fallbackSkippedCount: fallbackSkipped.length,
        capacityLimitedCount: 0,
      };
    }

    const schedulerRows = await ctx.db
      .query("dispatchSchedulerState")
      .withIndex("by_key", (q) => q.eq("key", DISPATCH_SCHEDULER_KEY))
      .take(2);
    if (schedulerRows.length > 1) {
      return {
        protocolVersion: 1 as const,
        status: "invalid_scheduler_authority" as const,
        reservations: [],
      };
    }
    const capacity = await supervisorFleetActiveCapacity(ctx);
    const groupRows = new Map(
      candidates.flatMap((planned) =>
        planned.kind === "candidate"
          ? [[planned.member.schedulingGroupKey, planned.group] as const]
          : []
      ),
    );
    const groupStates = new Map([...groupRows.entries()].map(
      ([groupKey, group]) => [
        groupKey,
        {
          activeCount: capacity.activeByGroup.get(groupKey) ?? 0,
          lastServedSequence: Number(group.lastServedSequence ?? 0),
        },
      ],
    ));
    const candidateById = new Map(candidates.flatMap((planned) =>
      planned.kind === "candidate"
        ? [[String(planned.job._id), planned] as const]
        : []
    ));
    const selected = selectFairWork(
      candidates.flatMap((planned) =>
        planned.kind === "candidate"
          ? [{
            id: String(planned.job._id),
            groupKey: planned.member.schedulingGroupKey,
            priority: planned.member.priority,
            createdAt: planned.member.createdAt,
            writeLineage: planned.member.writeLineage ?? null,
          }]
          : []
      ),
      groupStates,
      capacity.activeWriteLineages,
      capacity.available,
      schedulerRows[0]?.lastGroupKey,
    ).flatMap((candidate) => {
      const planned = candidateById.get(candidate.id);
      return planned ? [planned] : [];
    });

    const reservedJobs: Doc<"jobs">[] = [];
    for (const planned of selected) {
      const source = {
        controlReceiptId: control.receipt._id,
        fleetDigest: control.fleetDigest,
        memberDigest: planned.member.memberDigest,
      };
      const machine = {
        preset: planned.execution.workOrder
          .triggerMachinePreset as TriggerAgentMachinePreset,
        reason: planned.execution.workOrder
          .triggerMachineReason as TriggerAgentMachineReason,
      };
      const reason = "supervisor resume immediate wake";
      const envelope = await dispatchReceiptEnvelope(
        planned.job,
        planned.member.attempt,
        planned.nextDispatchGeneration,
        planned.execution,
        machine,
        reason,
        source,
      );
      const receiptId = await ctx.db.insert("dispatchReceipts", {
        jobId: planned.job._id,
        attempt: planned.member.attempt,
        generation: planned.nextDispatchGeneration,
        phase: envelope.phase,
        dispatchId: envelope.dispatchId,
        authorityDigest: planned.execution.authorityDigest,
        workOrderRevisionDigest:
          planned.execution.workOrderRevisionDigest,
        triggerMachinePreset: machine.preset,
        triggerMachineReason: machine.reason,
        payloadJson: envelope.payloadJson,
        payloadDigest: envelope.payloadDigest,
        receiptDigest: envelope.receiptDigest,
        sourceSupervisorControlReceiptId: control.receipt._id,
        sourceSupervisorFleetDigest: control.fleetDigest,
        sourceSupervisorMemberDigest: planned.member.memberDigest,
        status: "reserved",
        leaseUntil: now + DISPATCH_LEASE_MS,
        createdAt: now,
        updatedAt: now,
      });
      await patchJobWithRuntimeDeferredQueue(ctx, planned.job, {
        status: "dispatching",
        stage: "dispatching",
        progress: "cloud worker reserved",
        percent: envelope.phase === "delivery"
          ? Math.max(1, planned.job.percent ?? 0)
          : 1,
        dispatchId: envelope.dispatchId,
        dispatchGeneration: planned.nextDispatchGeneration,
        dispatchPhase: envelope.phase,
        dispatchReceiptId: receiptId,
        dispatchReceiptDigest: envelope.receiptDigest,
        dispatchPayloadDigest: envelope.payloadDigest,
        dispatchLeaseUntil: now + DISPATCH_LEASE_MS,
        dispatchReason: reason,
        workerRunId: undefined,
        deliveryRunId: undefined,
        deliveryGeneration: envelope.phase === "delivery"
          ? Math.max(1, Number(planned.job.deliveryGeneration ?? 1))
          : planned.job.deliveryGeneration,
        workerRuntime: "trigger",
        triggerMachinePreset: machine.preset,
        triggerMachineReason: machine.reason,
        triggerObservedMachinePreset: undefined,
        triggerObservedMachineReason: undefined,
        triggerPlatformAttempt: undefined,
        providerRunState: "queued",
        providerObservedAt: now,
        heartbeatAt: now,
      });
      await appendAttemptEvidence(
        ctx,
        planned.job,
        "dispatched",
        "Independent Trigger worker reserved by exact supervisor resume",
        {
          stage: "dispatching",
          percent: envelope.phase === "delivery"
            ? Math.max(1, planned.job.percent ?? 0)
            : 1,
          evidenceKind: "dispatch",
          eventKey:
            `dispatch:${planned.member.attempt}:${envelope.dispatchId}`,
        },
      );
      const committedReceipt = await ctx.db.get(receiptId);
      const reservation = committedReceipt
        ? reservationFromDispatchReceipt(committedReceipt, planned.job)
        : null;
      if (!reservation) {
        throw new Error("Supervisor dispatch receipt payload was not reusable");
      }
      reservations.push(reservation);
      reservedJobs.push(planned.job);
    }
    for (const groupKey of new Set(
      reservedJobs.map((job) => String(job.schedulingGroupKey)),
    )) {
      await refreshWorkGroupQueueProjection(ctx, groupKey, now);
    }
    await recordSchedulingReservations(
      ctx,
      reservedJobs,
      now,
      groupRows,
      schedulerRows[0] ?? null,
    );
    return {
      protocolVersion: 1 as const,
      status: selected.length
        ? "reserved" as const
        : "capacity_limited" as const,
      reservations,
      alreadyInflightCount: inflight.length,
      alreadyAdvancedCount: advanced.length,
      fallbackSkippedCount: fallbackSkipped.length,
      capacityLimitedCount: candidates.length - selected.length,
    };
  },
});

// Bind one reserved job to one Trigger run. Late/retried platform deliveries
// are harmless: only the exact live dispatch id can cross this fence.
export const claimDispatched = mutation({
  args: {
    jobId: v.id("jobs"),
    dispatchId: v.string(),
    workerRunId: v.string(),
    // Version 2 means this claim requires the exact Trigger-run heartbeat
    // fence. Optional only during the rolling-deploy bridge for older runs.
    heartbeatProtocolVersion: v.optional(v.literal(2)),
    expectedAttempt: v.optional(v.number()),
    dispatchGeneration: v.optional(v.number()),
    dispatchPhase: v.optional(v.string()),
    dispatchReceiptDigest: v.optional(v.string()),
    dispatchPayloadDigest: v.optional(v.string()),
    authorityDigest: v.optional(v.string()),
    workOrderRevisionDigest: v.optional(v.string()),
    triggerMachinePreset: v.optional(v.string()),
    triggerMachineReason: v.optional(v.string()),
    triggerObservedMachinePreset: v.optional(v.string()),
    triggerPlatformAttempt: v.optional(v.number()),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const now = Date.now();
    const j: any = await ctx.db.get(a.jobId);
    if (j && j.admissionProtocolVersion !== 2) return {
      executable: false,
      held: true,
      code: "protocol_v1_admission_held",
      jobId: j._id,
    } as any;
    if (j && !await readJobSchedulingAuthority(ctx, j)) {
      await quarantineJobRuntime(ctx, j);
      return null;
    }
    const attemptNumber = j?.attempt ?? 1;
    const priorAttempt = j ? await attemptFor(ctx, a.jobId, attemptNumber) : null;
    const executionAuthority = j ? await readAttemptExecutionAuthority(ctx, j, attemptNumber) : null;
    const dispatchReceipt = typeof a.dispatchReceiptDigest === "string"
      ? await dispatchReceiptByDigest(ctx, a.dispatchReceiptDigest)
      : null;
    let triggerObservedReason = a.triggerMachineReason;
    if (j && !executionAuthority) {
      await quarantineJobRuntime(ctx, j);
      return null;
    }
    if (j?.triggerMachinePreset) {
      const observedReason = observedTriggerMachineReason({
        admittedPreset: j.triggerMachinePreset as TriggerAgentMachinePreset,
        admittedReason: j.triggerMachineReason as TriggerAgentMachineReason,
        actualPreset: String(a.triggerObservedMachinePreset ?? ""),
        triggerAttempt: Number(a.triggerPlatformAttempt),
      });
      if (a.expectedAttempt !== attemptNumber
        || a.authorityDigest !== executionAuthority?.authorityDigest
        || a.workOrderRevisionDigest !== executionAuthority?.workOrderRevisionDigest
        || a.triggerMachinePreset !== j.triggerMachinePreset
        || a.triggerMachineReason !== j.triggerMachineReason
        || !dispatchReceiptMatchesRequest(dispatchReceipt, j, a)
        || j.dispatchReceiptDigest !== dispatchReceipt?.receiptDigest
        || j.dispatchPayloadDigest !== dispatchReceipt?.payloadDigest
        || Number(j.dispatchGeneration) !== Number(dispatchReceipt?.generation)
        || j.dispatchPhase !== dispatchReceipt?.phase
        || !["reserved", "reconciling", "claimed"].includes(String(dispatchReceipt?.status))
        || (dispatchReceipt?.status === "claimed"
          && dispatchReceipt.workerRunId !== a.workerRunId.slice(0, 120))
        || !Number.isSafeInteger(a.triggerPlatformAttempt) || Number(a.triggerPlatformAttempt) < 1
        || !observedReason) return {
          executable: false,
          held: true,
          code: "trigger_launch_authority_held",
          jobId: j._id,
        };
      triggerObservedReason = observedReason;
    }
    // Trigger can redeliver after Convex committed the claim but before the
    // worker received the response. Recover exactly the already-bound launch;
    // a competing Trigger session is fenced rather than stranding `running`.
    const disposition = claimDisposition({
      jobStatus: j?.status ?? "missing", jobDispatchId: j?.dispatchId,
      requestDispatchId: a.dispatchId, requestWorkerRunId: a.workerRunId, attempt: priorAttempt,
    });
    // `heartbeatProtocolVersion` used to be absent, so keep an exact
    // response-lost replay alive during rollout. Once a V2 worker has
    // announced itself, though, a new versionless claim must not establish an
    // unfenced heartbeat lease for a later retry.
    if (a.heartbeatProtocolVersion !== 2) {
      const rollout = await heartbeatProtocolRollout(ctx);
      const runId = a.workerRunId.slice(0, 120);
      const replayOfExistingLegacyClaim = priorAttempt?.heartbeatProtocolVersion !== 2
        && (priorAttempt?.workerRunId === runId || j?.deliveryRunId === runId);
      if (rollout && !replayOfExistingLegacyClaim) return {
        executable: false,
        held: true,
        code: "heartbeat_protocol_v2_required",
        jobId: j?._id,
      } as any;
    }
    const observedMachinePatch = j?.triggerMachinePreset ? {
      triggerObservedMachinePreset: a.triggerObservedMachinePreset,
      triggerObservedMachineReason: triggerObservedReason,
      triggerPlatformAttempt: a.triggerPlatformAttempt,
    } : {};
    // Do not execute a dependency query on a redelivery. The original response
    // may have been lost after commit; this is an immutable replay envelope.
    if (disposition === "replay") {
      if (dispatchReceipt?.status !== "claimed"
        || dispatchReceipt.workerRunId !== a.workerRunId.slice(0, 120)) return null;
      if (Object.keys(observedMachinePatch).length) {
        await patchJobWithRuntime(ctx, j, observedMachinePatch);
        if (priorAttempt) await ctx.db.patch(priorAttempt._id, observedMachinePatch);
      }
      return await claimedJob(ctx, { ...j, ...observedMachinePatch }, priorAttempt?.upstreamEvidence ?? []);
    }
    if (j?.status === "running" && j.dispatchId === a.dispatchId && j.deliveryRunId === a.workerRunId.slice(0, 120)
      && j.verificationVerdict === "pass" && j.reviewReceiptId) {
      if (Object.keys(observedMachinePatch).length) {
        await patchJobWithRuntime(ctx, j, observedMachinePatch);
        if (priorAttempt) await ctx.db.patch(priorAttempt._id, observedMachinePatch);
      }
      return await claimedJob(ctx, { ...j, ...observedMachinePatch }, priorAttempt?.upstreamEvidence ?? []);
    }
    if (
      !j ||
      j.status !== "dispatching" ||
      j.dispatchId !== a.dispatchId ||
      !dispatchReceipt
    ) return null;
    const deliveryContinuation = j.verificationVerdict === "pass" && Boolean(j.reviewReceiptId);
    if (priorAttempt?.workerRunId && deliveryContinuation) {
      if (priorAttempt.workerRunId === a.workerRunId.slice(0, 120)) return null;
      const generation = Math.max(1, Number(j.deliveryGeneration ?? 1));
      const existingDelivery = await deliveryAttemptFor(ctx, a.jobId, attemptNumber, generation);
      // A lost response may only replay the immutable generation/run binding.
      if (existingDelivery && ((existingDelivery.dispatchId && existingDelivery.dispatchId !== a.dispatchId) || (existingDelivery.deliveryRunId && existingDelivery.deliveryRunId !== a.workerRunId.slice(0, 120)))) return null;
      const review: any = j.reviewReceiptId ? await ctx.db.get(j.reviewReceiptId) : null;
      if (!review || review.authorityDigest !== executionAuthority?.authorityDigest
        || review.workOrderRevisionDigest !== executionAuthority?.workOrderRevisionDigest) return null;
      const deliveryId = existingDelivery?._id ?? await ctx.db.insert("deliveryAttempts", {
        jobId: a.jobId, sourceWorkAttempt: attemptNumber, generation,
        authorityDigest: review?.authorityDigest,
        schedulingBindingDigest: review?.schedulingBindingDigest,
        workOrderRevisionId: review?.workOrderRevisionId,
        workOrderRevision: review?.workOrderRevision,
        workOrderRevisionDigest: review?.workOrderRevisionDigest,
        canonicalProjectId: review?.canonicalProjectId,
        repository: review?.repository,
        missionGroupId: j.missionGroupId,
        dispatchId: a.dispatchId, deliveryRunId: a.workerRunId.slice(0, 120),
        policy: String(j.deliveryMode ?? "manual"), status: "running",
        sourceDispatchId: a.dispatchId,
        reviewReceiptId: j.reviewReceiptId, reviewReceiptDigest: j.reviewReceiptDigest,
        reviewKeyId: review?.keyId,
        reviewLineage: j.reviewReceiptId && j.reviewReceiptDigest ? [{
          sourceWorkAttempt: attemptNumber, reviewReceiptId: j.reviewReceiptId,
          reviewReceiptDigest: j.reviewReceiptDigest, keyId: review?.keyId,
        }] : undefined,
        reviewedHeadSha: review?.headSha, reviewedBaseSha: review?.baseSha,
        reviewedHeadTreeSha: review?.headTreeSha, reviewedDiffSha256: review?.diffSha256,
        heartbeatAt: now, retries: 0, cumulativeRetries: 0, currentStep: "preflight", createdAt: now, updatedAt: now,
      });
      if (existingDelivery) await ctx.db.patch(deliveryId, {
        dispatchId: a.dispatchId, sourceDispatchId: existingDelivery.sourceDispatchId ?? a.dispatchId,
        deliveryRunId: a.workerRunId.slice(0, 120), status: "running",
        currentStep: existingDelivery.currentStep === "queued" ? "preflight" : existingDelivery.currentStep,
        heartbeatAt: now, updatedAt: now,
      });
      await patchJobWithRuntime(ctx, j, {
        status: "running", stage: "delivery", progress: "resuming verified controller delivery", startedAt: now,
        heartbeatAt: now, nextRunAt: undefined, dispatchLeaseUntil: undefined, dispatchId: a.dispatchId,
        providerEffectLeaseUntil: undefined,
        workerRunId: a.workerRunId.slice(0, 120), deliveryRunId: a.workerRunId.slice(0, 120), deliveryGeneration: generation, activeDeliveryAttemptId: deliveryId, workerRuntime: "trigger",
        triggerObservedMachinePreset: a.triggerObservedMachinePreset,
        triggerObservedMachineReason: triggerObservedReason,
        triggerPlatformAttempt: a.triggerPlatformAttempt,
        providerRunState: "executing", providerObservedAt: now,
      });
      await ctx.db.patch(dispatchReceipt._id, {
        status: "claimed",
        workerRunId: a.workerRunId.slice(0, 120),
        leaseUntil: undefined,
        updatedAt: now,
      });
      await appendAttemptEvidence(ctx, j, "delivery_resumed", "Trusted controller resumed verified delivery without rerunning the specialist", {
        stage: "delivery", evidenceKind: "delivery", eventKey: `delivery-resume:${j.attempt ?? 1}:${a.dispatchId}`,
      });
      // `ctx.db.patch` does not mutate a document returned by `get`. Build
      // the claim from the committed authority rows so the first controller
      // response has exactly the same fence as a lost-response replay.
      const committedJob = await ctx.db.get(a.jobId);
      const committedAttempt = committedJob ? await attemptFor(ctx, a.jobId, attemptNumber) : null;
      return committedJob ? await claimedJob(ctx, committedJob, committedAttempt?.upstreamEvidence ?? []) : null;
    }
    if (priorAttempt?.workerRunId || (priorAttempt?.dispatchId && priorAttempt.dispatchId !== a.dispatchId)) {
      // A stale platform redelivery must not replace the original workspace
      // or session receipt. It cannot cross the launch fence a second time.
      return null;
    }
    // Legacy rows may have been reserved before attempt rows existed. Create
    // that missing causal record before changing jobs to running; otherwise a
    // lost response could strand a running job with no replay binding.
    const attempt = priorAttempt ?? await ensureAttempt(ctx, a.jobId, attemptNumber, "dispatching", now, { dispatchId: a.dispatchId });
    if (attempt.dispatchId && attempt.dispatchId !== a.dispatchId) return null;
    const upstreamEvidence = await upstreamEvidenceForClaim(ctx, j);
    if (!upstreamEvidence) return null;
    await patchJobWithRuntime(ctx, j, {
      status: "running",
      stage: "starting",
      progress: "starting secure workspace",
      percent: 2,
      startedAt: now,
      heartbeatAt: now,
      progressAt: now,
      stalledAt: undefined,
      stallReason: undefined,
      nextRunAt: undefined,
      dispatchLeaseUntil: undefined,
      workerRunId: a.workerRunId.slice(0, 120),
      // This belongs to the current claim, not the job forever. An older
      // worker may legitimately claim a later retry during the rollout.
      heartbeatProtocolVersion: a.heartbeatProtocolVersion,
      dispatchId: a.dispatchId,
      workerRuntime: "trigger",
      triggerObservedMachinePreset: a.triggerObservedMachinePreset,
      triggerObservedMachineReason: triggerObservedReason,
      triggerPlatformAttempt: a.triggerPlatformAttempt,
      providerRunState: "executing",
      providerObservedAt: now,
      providerEffectLeaseUntil: undefined,
    });
    await ctx.db.patch(dispatchReceipt._id, {
      status: "claimed",
      workerRunId: a.workerRunId.slice(0, 120),
      leaseUntil: undefined,
      updatedAt: now,
    });
    // Bind dispatch, worker identities and the exact upstream snapshot in the
    // same transaction as running. This makes exact lost-response replay
    // reachable while fencing every competing delivery.
    const workspaceLineage = String(j.workspaceLineage ?? `sandbox:${String(a.jobId)}:lineage:1`);
    const workspaceKey = attemptWorkspaceKey(workspaceLineage, j.attempt ?? 1);
    await ctx.db.patch(attempt._id, {
      status: "running",
      workspaceKey,
      workspaceLineage,
      workerBranch: j.workerBranch,
      sessionId: a.workerRunId.slice(0, 120),
      workerRunId: a.workerRunId.slice(0, 120),
      heartbeatProtocolVersion: a.heartbeatProtocolVersion,
      dispatchId: a.dispatchId,
      dispatchGeneration: dispatchReceipt.generation,
      dispatchPhase: dispatchReceipt.phase,
      dispatchReceiptId: dispatchReceipt._id,
      dispatchReceiptDigest: dispatchReceipt.receiptDigest,
      dispatchPayloadDigest: dispatchReceipt.payloadDigest,
      triggerMachinePreset: dispatchReceipt.triggerMachinePreset,
      triggerMachineReason: dispatchReceipt.triggerMachineReason,
      triggerObservedMachinePreset: a.triggerObservedMachinePreset,
      triggerObservedMachineReason: triggerObservedReason,
      triggerPlatformAttempt: a.triggerPlatformAttempt,
      upstreamEvidence,
      launchedAt: now,
      livenessAt: now,
      progressAt: now,
      lastEventAt: now,
    });
    await appendAttemptEvidence(ctx, j, "started", `Attempt ${j.attempt ?? 1} started`, {
      stage: "starting",
      percent: 2,
      evidenceKind: "attempt_launch",
      data: { workspace: workspaceKey, workspaceLineage, workerBranch: j.workerBranch, session: a.workerRunId.slice(0, 120) },
    });
    // Never use the pre-patch object here. Convex documents are immutable
    // snapshots, unlike the old unit-test fake; returning it lost the newly
    // committed worker and delivery fence on an initial response.
    const committedJob = await ctx.db.get(a.jobId);
    const committedAttempt = committedJob ? await attemptFor(ctx, a.jobId, attemptNumber) : null;
    return committedJob ? await claimedJob(ctx, committedJob, committedAttempt?.upstreamEvidence ?? []) : null;
  },
});

export const rejectDispatch = mutation({
  args: {
    jobId: v.id("jobs"),
    dispatchId: v.string(),
    reason: v.string(),
    delayMs: v.optional(v.number()),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const row = await ctx.db.get(a.jobId);
    if (!row || row.status !== "dispatching" || row.dispatchId !== a.dispatchId) return false;
    const now = Date.now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema-validated dispatch receipt
    const receipt: any = row.dispatchReceiptId ? await ctx.db.get(row.dispatchReceiptId) : null;
    if (!receipt || receipt.dispatchId !== a.dispatchId
      || receipt.receiptDigest !== row.dispatchReceiptDigest) return false;
    const delayMs = Math.max(0, Math.min(10 * 60_000, a.delayMs ?? 30_000));
    await patchJobWithRuntime(ctx, row, {
      ...invalidateDeliveryLease(row),
      status: "pending",
      stage: "queued",
      progress: `worker launch deferred · ${a.reason.slice(0, 240)}`,
      nextRunAt: now + delayMs,
      dispatchId: undefined,
      dispatchLeaseUntil: undefined,
      workerRunId: undefined,
      heartbeatAt: now,
    });
    await ctx.db.patch(receipt._id, {
      status: "superseded",
      closeReason: `launch explicitly rejected: ${a.reason.slice(0, 180)}`,
      leaseUntil: undefined,
      closedAt: now,
      updatedAt: now,
    });
    await appendAttemptEvidence(ctx, row, "dispatch_released", a.reason.slice(0, 500), {
      stage: "queued", percent: row.percent, evidenceKind: "dispatch", eventKey: `dispatch-release:${row.attempt ?? 1}:${a.dispatchId}`,
    });
    return true;
  },
});

// A failed Trigger transport can mean "accepted, response lost". Preserve the
// exact dispatch/attempt identity until the bounded lease reaper observes it;
// the global Trigger idempotency key makes the later retry a reconciliation,
// not a second launch.
export const markDispatchLaunchUnknown = mutation({
  args: {
    jobId: v.id("jobs"),
    dispatchId: v.string(),
    dispatchGeneration: v.optional(v.number()),
    dispatchPhase: v.optional(v.string()),
    dispatchReceiptDigest: v.optional(v.string()),
    dispatchPayloadDigest: v.optional(v.string()),
    reason: v.string(),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const row = await ctx.db.get(a.jobId);
    if (!row || row.status !== "dispatching" || row.dispatchId !== a.dispatchId) return false;
    const now = Date.now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema-validated dispatch receipt
    const receipt: any = row.dispatchReceiptId ? await ctx.db.get(row.dispatchReceiptId) : null;
    if (!receipt || receipt.dispatchId !== a.dispatchId
      || receipt.receiptDigest !== row.dispatchReceiptDigest
      || receipt.payloadDigest !== row.dispatchPayloadDigest
      || (a.dispatchGeneration !== undefined && a.dispatchGeneration !== receipt.generation)
      || (a.dispatchPhase !== undefined && a.dispatchPhase !== receipt.phase)
      || (a.dispatchReceiptDigest !== undefined && a.dispatchReceiptDigest !== receipt.receiptDigest)
      || (a.dispatchPayloadDigest !== undefined && a.dispatchPayloadDigest !== receipt.payloadDigest)
      || !["reserved", "reconciling"].includes(receipt.status)) return false;
    const retryAt = now + 30_000;
    await patchJobWithRuntime(ctx, row, {
      progress: `worker launch outcome unknown · ${a.reason.slice(0, 220)}`,
      dispatchLeaseUntil: retryAt,
      providerRunState: "reconciling",
      providerObservedAt: now,
      heartbeatAt: now,
    });
    await ctx.db.patch(receipt._id, {
      status: "reconciling",
      leaseUntil: retryAt,
      updatedAt: now,
    });
    await appendAttemptEvidence(ctx, row, "dispatch_launch_unknown", a.reason.slice(0, 500), {
      stage: "dispatching",
      percent: row.percent,
      evidenceKind: "reconcile",
      eventKey: `dispatch-unknown:${row.attempt ?? 1}:${a.dispatchId}`,
    });
    return true;
  },
});

export const finalize = mutation({
  args: {
    jobId: v.id("jobs"),
    expectedAttempt: v.number(),
    authorityDigest: v.optional(v.string()),
    status: v.union(v.literal("done"), v.literal("error")),
    terminalCode: v.optional(v.union(
      v.literal("transient_provider_error"),
      v.literal("transient_network_error"),
      v.literal("verification_exhausted"),
      v.literal("worker_terminal_error"),
      v.literal("delivery_blocked"),
    )),
    result: v.optional(v.string()),
    pullRequestUrl: v.optional(v.string()),
    verificationVerdict: v.optional(v.union(v.literal("pass"), v.literal("unavailable"))),
    verificationNote: v.optional(v.string()),
    resultDigest: v.optional(v.string()),
    evidenceDigest: v.optional(v.string()),
    reviewReceiptSignature: v.optional(v.string()),
    reviewReceiptKeyId: v.optional(v.string()),
    reviewDiffSha256: v.optional(v.string()),
    reviewReceiptJson: v.optional(v.string()),
    deliveryLeaseOwner: v.optional(v.string()),
    deliveryLeaseToken: v.optional(v.string()),
    deliveryLeaseVersion: v.optional(v.number()),
    sourceWorkAttempt: v.optional(v.number()),
    deliveryGeneration: v.optional(v.number()),
    deliveryRunId: v.optional(v.string()),
    deliveryAttemptId: v.optional(v.id("deliveryAttempts")),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const row = await ctx.db.get(a.jobId);
    if (!row || row.status !== "running" || (row.attempt ?? 1) !== a.expectedAttempt) return false;
    const executionAuthority = await attemptExecutionAuthorityFor(ctx, row, a.expectedAttempt, a.authorityDigest);
    if (!executionAuthority) return false;
    if (!await claimedDispatchReceiptForRow(ctx, row, a.deliveryRunId ?? row.workerRunId)) return false;
    if (row.repo && !hasLiveDeliveryLease(row, a)) return false;
    const delivery = a.deliveryGeneration === undefined ? null : await deliveryAttemptFor(ctx, a.jobId, Number(a.sourceWorkAttempt), Number(a.deliveryGeneration));
    if (row.repo && (!delivery || !hasLiveControllerFence(row, delivery, a))) return false;
    if (row.repo) {
      const successfulOutcomes = new Set(["protected_draft", "read_only_complete", "no_change", "merged"]);
      const terminalOutcome = String(delivery?.outcome ?? "");
      if (delivery?.currentStep !== "receipt" || !outcomeAllowed(String(delivery.policy), terminalOutcome)) return false;
      if (a.status === "done" ? !successfulOutcomes.has(terminalOutcome) : !["blocked", "needs_attention"].includes(terminalOutcome)) return false;
    }
    // A completed job is called "verified" only when the supervisor actually
    // returned pass. This invariant lives in Convex, not only in the runner.
    if (a.status === "done" && (a.verificationVerdict !== "pass" || !completionReceiptAllowed(a))) return false;
    // Repository completion is impossible unless the controller persisted its
    // signed checkout review before any delivery continuation. Convex checks
    // immutable binding fields; the Trigger controller validates the HMAC with
    // its private stable authority before it ever sends this mutation.
    if (a.status === "done" && row.repo && (!row.reviewReceiptId || !row.reviewReceiptDigest || !row.reviewReceiptSignature)) return false;
    if (a.status === "done" && row.repo) {
      const review: any = await ctx.db.get(row.reviewReceiptId as any);
      if (!review || review.jobId !== a.jobId || review.attempt !== a.expectedAttempt
        || review.receiptDigest !== row.reviewReceiptDigest || review.signature !== row.reviewReceiptSignature
        || review.authorityDigest !== executionAuthority.authorityDigest
        || review.workOrderRevisionDigest !== executionAuthority.workOrderRevisionDigest
        || review.diffSha256 !== a.reviewDiffSha256 || review.signature !== a.reviewReceiptSignature
        || a.reviewReceiptKeyId !== review.keyId || delivery?.reviewKeyId !== review.keyId) return false;
    }
    const normalizedResult = String(a.result ?? "").slice(0, workResultMaxChars(row.goalStage));
    const normalizedNote = String(a.verificationNote ?? "").slice(0, 1_000);
    if (a.status === "done" && (
      a.resultDigest !== await sha256Hex(normalizedResult)
      || a.evidenceDigest !== await sha256Hex(normalizedNote)
    )) return false;
    const now = Date.now();
    const success = a.status === "done";
    const delivered = success && row.deliveryStatus === "merged";
    const activity = success ? null : await jobRuntimeFor(ctx, a.jobId);
    const finalPercent = success ? 100 : activity?.percent ?? row.percent;
    const finalProgress = success
      ? delivered ? "verified, merged and handed to deployment" : "verified and complete"
      : activity?.progress ?? row.progress;
    const finalPatch = {
      status: a.status,
      result: normalizedResult || undefined,
      pullRequestUrl: a.pullRequestUrl,
      completedAt: now,
      heartbeatAt: now,
      stage: success ? (delivered ? "delivered" : "verified") : a.status,
      percent: finalPercent,
      progress: finalProgress,
      verificationVerdict: a.verificationVerdict,
      verificationNote: normalizedNote || undefined,
      verifiedAt: success ? now : undefined,
    };
    const terminalEventKey = `terminal:${a.expectedAttempt}:${a.status}:${a.status === "done" ? a.resultDigest : eventIdentity(`${a.result ?? ""}|${a.verificationNote ?? ""}`)}`;
    const priorReceipts = await ctx.db.query("workReceipts")
      .withIndex("by_job_attempt", (q) =>
        q.eq("jobId", a.jobId).eq("attempt", a.expectedAttempt)
      )
      .take(2);
    const artifacts = [row.branch, a.pullRequestUrl ?? row.pullRequestUrl, row.mergeCommitSha]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .slice(0, 8);
    // Read-only and failure outcomes still retain one concrete reference to
    // the exact durable attempt rather than treating result prose as evidence.
    if (!artifacts.length) {
      artifacts.push(
        `convex://jobs/${String(a.jobId)}/attempt/${a.expectedAttempt}/result`,
      );
    }
    const terminalCode = success
      ? "verified_success"
      : a.terminalCode ?? (row.repo ? "delivery_blocked" : "worker_terminal_error");
    const recoveryDisposition: RecoveryDisposition = success
      ? "none"
      : ["transient_provider_error", "transient_network_error"].includes(
          terminalCode,
        )
        ? "retryable"
        : terminalCode === "verification_exhausted"
          ? "remediable"
          : "operator_stop";
    if (priorReceipts.length > 0 && !isSupervisorOwnedJob(row)) return false;
    await insertFreshTerminalWorkReceipt(
      ctx,
      row,
      a.expectedAttempt,
      {
        status: success ? "succeeded" : "failed",
        terminalCode,
        recoveryDisposition,
        acceptanceEvidence: success && normalizedNote
          ? [normalizedNote]
          : [],
        artifacts,
        verification: success ? "pass" : a.verificationVerdict ?? "unavailable",
        deliveryOutcome: delivery?.outcome,
        terminalEventKey,
        result: normalizedResult,
        evidence: normalizedNote,
        reviewReceiptSignature: a.reviewReceiptSignature,
        reviewDiffSha256: a.reviewDiffSha256,
        reviewReceiptId: row.reviewReceiptId,
        reviewReceiptDigest: row.reviewReceiptDigest,
      },
      now,
    );
    await patchJobWithRuntime(ctx, row, finalPatch);
    if (delivery) await ctx.db.patch(delivery._id, {
      status: success ? "done" : "blocked",
      currentStep: "terminal",
      terminalReceiptDigest: success ? a.resultDigest : await sha256Hex(`${String(delivery.outcome)}:${normalizedResult}`),
      completedAt: now,
      leaseUntil: undefined,
      heartbeatAt: now,
      updatedAt: now,
    });
    await closeClaimedDispatchReceipt(
      ctx,
      row,
      a.deliveryRunId ?? row.workerRunId,
      success ? "terminal completion receipt persisted" : "terminal failure receipt persisted",
      now,
    );
    const attempt = await attemptFor(ctx, a.jobId, a.expectedAttempt);
    if (attempt) await ctx.db.patch(attempt._id, {
      status: success ? "done" : "error",
      completedAt: now,
      lastEventAt: now,
    });
    await appendAttemptEvidence(ctx, row, a.status,
      success ? delivered ? "Work verified and merged automatically" : "Work verified and complete" : (a.result ?? a.status),
      { stage: success ? (delivered ? "delivered" : "verified") : a.status, percent: finalPercent, evidenceKind: success ? "completion_receipt" : "terminal", eventKey: terminalEventKey },
    );
    if (success) {
      const completed = { ...row, ...finalPatch };
      await ensureGoalNodeHandoff(ctx, completed);
      await promoteCompletedJobDependents(ctx, completed, now);
    }
    if (row.missionId) {
      const missionId = ctx.db.normalizeId("missions", row.missionId);
      if (missionId) {
        const mission = await ctx.db.get(missionId);
        const jobs = await ctx.db
          .query("jobs")
          .withIndex("by_mission", (q: any) => q.eq("missionId", row.missionId))
          .take(100);
        if (mission && mission.mode === "goal") {
          const stage = mission.phase === "refining" ? "refining" : mission.phase === "building" ? "building" : null;
          if (stage) {
            const wave = mission.revisionWave ?? 0;
            const phaseJobs = jobs.filter((job: any) => job.goalStage === stage && (job.goalWave ?? 0) === wave);
            const finished = phaseJobs.filter((job: any) => ["done", "error", "cancelled"].includes(job.status)).length;
            const start = stage === "building" ? 12 : Math.min(90, 84 + wave * 3);
            const end = stage === "building" ? 78 : Math.min(96, start + 6);
            await patchMissionWithRuntime(ctx, mission, {
              percent: Math.max(mission.percent ?? 0, Math.round(start + ((end - start) * finished) / Math.max(1, phaseJobs.length))),
              updatedAt: now,
            });
          }
        } else if (mission) {
          const finished = jobs.filter((j: any) => ["done", "error", "cancelled"].includes(j.status)).length;
          await patchMissionWithRuntime(ctx, mission, {
            phase: finished >= mission.agentCount ? "reviewing" : "executing",
            percent: Math.min(88, Math.round((finished / Math.max(1, mission.agentCount)) * 88)),
            updatedAt: now,
          });
        }
      }
    }
    if (row.agentId) {
      const agent = await ctx.db
        .query("agentProfiles")
        .withIndex("by_slug", (q: any) => q.eq("slug", row.agentId))
        .first();
      if (agent) {
        const previousRuns = agent.completedJobs + agent.failedJobs;
        const durationMs = Math.max(0, now - (row.startedAt ?? row.createdAt));
        const averageDurationMs = Math.round(
          ((agent.averageDurationMs ?? durationMs) * previousRuns + durationMs) / Math.max(1, previousRuns + 1),
        );
        await ctx.db.patch(agent._id, {
          completedJobs: agent.completedJobs + (success ? 1 : 0),
          failedJobs: agent.failedJobs + (success ? 0 : 1),
          averageDurationMs,
          updatedAt: now,
        });
      }
    }
    // Evidence-backed maintenance launched by Sentry owns an attention item.
    // Resolve it with the job lifecycle so a later insight sweep cannot
    // redispatch the same repair after the worker has already finished.
    const ownedAttention = await ctx.db
      .query("attentionItems")
      .withIndex("by_jobId", (q: any) => q.eq("jobId", String(a.jobId)))
      .first();
    if (ownedAttention) {
      await ctx.db.patch(ownedAttention._id, {
        status: success ? "resolved" : "open",
        updatedAt: now,
      });
    }
    return true;
  },
});

export const JOB_LIST_COMPATIBILITY_MAX = 12;
export const JOB_LIST_COMPATIBILITY_DEFAULT = 8;

export function boundedJobListLimit(value: number | undefined): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || Number(value) <= 0) {
    return JOB_LIST_COMPATIBILITY_DEFAULT;
  }
  return Math.min(JOB_LIST_COMPATIBILITY_MAX, Number(value));
}

function compactMonitorRow(row: any) {
  if (!row) return null;
  return {
    jobId: row.jobId,
    status: String(row.status),
    attempt: Math.max(1, Number(row.attempt ?? 1)),
    stage: String(row.stage ?? row.status).slice(0, 80),
    percent: Math.max(0, Math.min(100, Number(row.percent ?? 0))),
    progress: redactSensitiveText(String(row.progress ?? "")).slice(0, 160),
    sourceBranch: row.sourceBranch ?? null,
    sourceHeadSha: row.sourceHeadSha ?? null,
    integrationBranch: row.integrationBranch ?? null,
    workerBranch: row.workerBranch ?? null,
    branch: row.branch ?? null,
    mergeCommitSha: row.mergeCommitSha ?? null,
  };
}

// First-class supervision for one known job. The by_job index is unique by
// projection invariant and the result cannot carry durable task/log/checkpoint
// payloads or provider credentials.
export const monitor = query({
  args: { jobId: v.id("jobs"), ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    return compactMonitorRow(await jobRuntimeFor(ctx, a.jobId));
  },
});

// Lazy drill-down remains an exact compact projection read. Realtime log bytes
// are separately authorized and scoped to the exact Trigger run.
export const detail = query({
  args: { jobId: v.id("jobs"), ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    const row = await jobRuntimeFor(ctx, a.jobId);
    if (!row) return null;
    return {
      ...compactMonitorRow(row),
      label: String(row.label ?? "Agent work").slice(0, 80),
      agentId: row.agentId ?? null,
      repo: row.repo ?? null,
      progressAt: row.progressAt ?? null,
      model: row.model ? normalizeWorkModelTier(row.model) : null,
      reasoningEffort: row.reasoningEffort ?? null,
      modelReason: row.modelReason ?? null,
      workerRuntime: row.workerRuntime ?? null,
      workerRunId: row.workerRunId ?? null,
      generation: Number(row.deliveryGeneration ?? row.goalWave ?? 0),
      maxAttempts: Math.max(1, Number(row.maxAttempts ?? 1)),
      integrationState: row.integrationState ?? null,
      deliveryStatus: row.deliveryStatus ?? null,
      startedAt: row.startedAt ?? null,
      stallReason: redactSensitiveText(String(row.stallReason ?? "")).slice(0, 180) || null,
    };
  },
});

// Compatibility/briefing summary only. The sole repository caller counts
// statuses, so no task, progress, branch, checkpoint, or credential-adjacent
// fields are read back to the caller.
export const list = query({
  args: { limit: v.optional(v.number()), ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    const rows = await ctx.db
      .query("jobRuntime")
      .withIndex("by_createdAt")
      .order("desc")
      .take(boundedJobListLimit(a.limit));
    return rows.map((row: any) => ({ _id: row.jobId, status: row.status }));
  },
});

// A provider startup error can echo its command line before the worker has a
// chance to classify it. This maintenance action only removes credential-like
// material; it cannot alter status, ownership, attempts, or mission progress.
export const scrubSensitiveOutput = mutation({
  args: { jobId: v.id("jobs"), ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    const row = await ctx.db.get(a.jobId);
    if (!row) return { scrubbed: false, fields: [] as string[] };
    const patch: Record<string, string> = {};
    for (const field of ["result", "checkpoint", "log", "progress", "verificationNote"] as const) {
      if (typeof row[field] !== "string") continue;
      const redacted = redactSensitiveText(row[field]);
      if (redacted !== row[field]) patch[field] = redacted;
    }
    if (!Object.keys(patch).length) return { scrubbed: false, fields: [] as string[] };
    await patchJobWithRuntime(ctx, row, patch);
    return { scrubbed: true, fields: Object.keys(patch) };
  },
});

// A process can die without finalizing. Heartbeats distinguish a genuinely
// long segment from a dead runner; recover for up to 14 days/maximum attempts.
export const reapStale = mutation({
  args: { workerToken: v.optional(v.string()) },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const now = Date.now();
    const expiredControllers: string[] = [];
    for (const status of ["claimed", "prepared", "provider_waiting"] as const) {
      const attempts = await ctx.db.query("integrationAttempts")
        .withIndex("by_status_created", (q: any) => q.eq("status", status)).take(100);
      for (const attempt of attempts) {
        const recovered = await recoverExpiredIntegrationController(ctx, attempt, now);
        if (recovered) expiredControllers.push(String(recovered.integrationAttemptId));
      }
    }
    const dispatching = await ctx.db
      .query("jobRuntime")
      .withIndex("by_status_dispatch_lease", (q: any) => q.eq("status", "dispatching").lte("dispatchLeaseUntil", now))
      .take(100);
    const releasedDispatches: string[] = [];
    const quarantinedDispatches: string[] = [];
    for (const activity of dispatching) {
      const j = await ctx.db.get(activity.jobId);
      if (!j || j.status !== "dispatching" || j.dispatchId !== activity.dispatchId) {
        if (j) await upsertJobRuntime(ctx, j);
        continue;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema-validated dispatch receipt
      const receipt: any = j.dispatchReceiptId ? await ctx.db.get(j.dispatchReceiptId) : null;
      if (!receipt || receipt.dispatchId !== activity.dispatchId
        || receipt.receiptDigest !== j.dispatchReceiptDigest
        || receipt.payloadDigest !== j.dispatchPayloadDigest
        || !["reserved", "reconciling"].includes(receipt.status)) {
        // An active projection without its exact immutable launch receipt
        // cannot be re-offered safely. Quarantine it outside the active index
        // rather than silently refreshing a zombie reservation forever.
        await quarantineUnprovableDispatch(
          ctx,
          j,
          String(activity.dispatchId ?? j.dispatchId ?? "missing-dispatch-id"),
          now,
        );
        quarantinedDispatches.push(j.task.slice(0, 80));
        continue;
      }
      await patchJobWithRuntime(ctx, j, {
        progress: "worker reservation expired — exact launch reconciliation due",
        dispatchLeaseUntil: now,
        providerRunState: "reconciling",
        providerObservedAt: now,
        heartbeatAt: now,
      });
      await ctx.db.patch(receipt._id, {
        status: "reconciling",
        leaseUntil: now,
        updatedAt: now,
      });
      await appendAttemptEvidence(ctx, j, "dispatch_recovered", "Expired Trigger reservation retained for byte-equivalent reconciliation", {
        stage: "dispatching", percent: j.percent, evidenceKind: "reconcile", eventKey: `dispatch-recovered:${j.attempt ?? 1}:${activity.dispatchId}`,
      });
      releasedDispatches.push(j.task.slice(0, 80));
    }
    const running = await ctx.db
      .query("jobRuntime")
      .withIndex("by_status_heartbeat", (q: any) => q.eq("status", "running").lte("heartbeatAt", now - STALE_RUNNER_MS))
      .take(100);
    // A steered worker has a short opportunity to save its local checkpoint.
    // If it never observes the reactive control update, the same liveness
    // reaper preserves the last durable branch/checkpoint and releases a
    // fresh scoped attempt instead of leaving `steering` forever.
    const steering = await ctx.db
      .query("jobRuntime")
      .withIndex("by_status_heartbeat", (q: any) => q.eq("status", "steering").lte("heartbeatAt", now - STALE_RUNNER_MS))
      .take(100);
    // Atomic mission pause deliberately preserves one claimed specialist
    // binding so a live worker can save its final checkpoint. If that worker
    // disappears, paused rows no longer participate in the running reaper.
    // Reconcile only the exact stale receipt/attempt fence, without queueing
    // or otherwise resurrecting work; resume can then allocate its fresh
    // bounded attempt.
    const paused = await ctx.db
      .query("jobRuntime")
      .withIndex("by_pause_checkpoint_heartbeat", (q) =>
        q
          .eq("status", "paused")
          .eq("pauseCheckpointPending", true)
          .lte("heartbeatAt", now - STALE_RUNNER_MS)
      )
      .take(100);
    // A blocked cloud setup with its dispatch receipt already closed has no
    // running process. It should be eligible for automatic recovery if the
    // provider becomes verified shortly afterwards, but stale intent cannot
    // occupy active work forever. Limit this terminalization to the exact
    // missing-configuration code and prove that no provider workspace was
    // ever persisted before changing durable state.
    const staleCloudWorkspaceHolds = await ctx.db
      .query("jobs")
      .withIndex("by_status_provider_observed", (q: any) =>
        q
          .eq("status", "paused")
          .eq("providerRunState", "blocked")
          .lte("providerObservedAt", now - STALE_CLOUD_WORKSPACE_HOLD_MS)
      )
      .take(100);
    const expiredCloudWorkspaceHolds: string[] = [];
    for (const candidate of staleCloudWorkspaceHolds) {
      const job = await ctx.db.get(candidate._id);
      if (
        !job
        || job.status !== "paused"
        || job.providerRunState !== "blocked"
        || job.nextRunAt !== undefined
        || typeof job.dispatchId === "string"
        || typeof job.dispatchLeaseUntil === "number"
        || Number(job.providerObservedAt ?? 0) !== Number(candidate.providerObservedAt ?? 0)
        || Number(job.providerObservedAt ?? 0) > now - STALE_CLOUD_WORKSPACE_HOLD_MS
      ) continue;
      // `cloudWorkspaceBlockCode` is the forward-safe selector. The strict
      // checkpoint fallback exists solely to drain holds created before that
      // field was introduced.
      const code = String(job.cloudWorkspaceBlockCode ?? "");
      const legacyMissingConfiguration = code.length === 0
        && /^Cloud workspace blocked \[[a-z0-9_-]+\/missing_configuration\]:/im.test(
          String(job.checkpoint ?? ""),
        );
      if (code !== "missing_configuration" && !legacyMissingConfiguration) continue;
      const attempt = await attemptFor(ctx, job._id, job.attempt ?? 1);
      // A persisted provider identity is an external resource; leave it to
      // the orphan cleaner rather than assuming this no-process cleanup path.
      if (
        !attempt
        || attempt.status !== "paused"
        || !attempt.completedAt
        || attempt.providerWorkspaceId
        || attempt.providerSessionId
      ) continue;
      const receipt = job.dispatchReceiptId ? await ctx.db.get(job.dispatchReceiptId) : null;
      if (job.dispatchReceiptId && (!receipt || receipt.status !== "closed")) continue;
      if (isSupervisorOwnedJob(job)) {
        await insertFreshTerminalWorkReceipt(ctx, job, job.attempt ?? 1, {
          status: "failed",
          terminalCode: "cloud_workspace_hold_expired",
          recoveryDisposition: "remediable",
          acceptanceEvidence: [],
          artifacts: [
            `convex://jobs/${String(job._id)}/attempt/${job.attempt ?? 1}/cloud-workspace`,
          ],
          verification: "unavailable",
          terminalEventKey: `cloud-workspace-hold-expired:${job.attempt ?? 1}:${job.providerObservedAt}`,
          result: "No cloud workspace or repository process was created before the configuration hold expired.",
          evidence: job.checkpoint ?? job.progress,
        }, now);
      }
      await ctx.db.patch(attempt._id, {
        status: "error",
        completedAt: now,
        lastEventAt: now,
      });
      await patchJobWithRuntime(ctx, job, {
        ...invalidateDeliveryLease(job),
        status: "error",
        stage: "configuration error",
        progress: "cloud workspace configuration stayed unavailable for 60m — attempt stopped safely",
        result: "No cloud workspace or repository process was created. Complete secure worker setup, then submit a fresh job.",
        completedAt: now,
        heartbeatAt: now,
        nextRunAt: undefined,
        dispatchId: undefined,
        dispatchLeaseUntil: undefined,
        workerRunId: undefined,
        workerRuntime: undefined,
        providerRunState: "expired",
        providerObservedAt: now,
      });
      await appendAttemptEvidence(
        ctx,
        job,
        "cloud_workspace_hold_expired",
        "Cloud workspace configuration remained unavailable for 60 minutes; no provider workspace was created and the attempt was stopped.",
        {
          stage: "configuration error",
          percent: job.percent,
          evidenceKind: "watchdog",
          eventKey: `cloud-workspace-hold-expired:${job.attempt ?? 1}:${job.providerObservedAt}`,
          attempt: job.attempt ?? 1,
        },
      );
      expiredCloudWorkspaceHolds.push(job.task.slice(0, 80));
    }
    const reconciledPausedClaims: string[] = [];
    for (const activity of paused) {
      const job = await ctx.db.get(activity.jobId);
      const attemptNumber = Number(job?.attempt ?? 0);
      if (
        !job
        || job.status !== "paused"
        || job.dispatchPhase !== "specialist"
        || typeof job.workerRunId !== "string"
        || typeof job.dispatchId !== "string"
        || Number(job.heartbeatAt ?? 0) > now - STALE_RUNNER_MS
        || activity.attempt !== attemptNumber
        || activity.dispatchId !== job.dispatchId
        || activity.workerRunId !== job.workerRunId
      ) {
        continue;
      }
      const [attemptLookup, authority, receipt] = await Promise.all([
        readExactWorkAttempt(ctx, job._id, attemptNumber),
        readAttemptExecutionAuthority(ctx, job, attemptNumber),
        claimedDispatchReceiptForRow(ctx, job, job.workerRunId),
      ]);
      if (
        attemptLookup.kind !== "exact"
        || !authority
        || !receipt
        || receipt.attempt !== attemptNumber
        || receipt.phase !== "specialist"
        || receipt.authorityDigest !== authority.authorityDigest
        || receipt.workOrderRevisionDigest
          !== authority.workOrderRevisionDigest
        || attemptLookup.attempt.status !== "paused"
        || attemptLookup.attempt.completedAt
        || attemptLookup.attempt.workerRunId !== job.workerRunId
        || attemptLookup.attempt.dispatchId !== job.dispatchId
        || attemptLookup.attempt.dispatchReceiptId !== job.dispatchReceiptId
        || attemptLookup.attempt.dispatchReceiptDigest
          !== job.dispatchReceiptDigest
        || attemptLookup.attempt.dispatchPayloadDigest
          !== job.dispatchPayloadDigest
      ) {
        continue;
      }
      await ctx.db.patch(attemptLookup.attempt._id, {
        status: "paused",
        dispatchId: undefined,
        completedAt: now,
        livenessAt: now,
        lastEventAt: now,
      });
      if (!await closeClaimedDispatchReceipt(
        ctx,
        job,
        job.workerRunId,
        "paused worker liveness expired before final checkpoint",
        now,
      )) {
        throw new Error("Paused claim changed after exact reconciliation");
      }
      await patchJobWithRuntime(ctx, job, {
        dispatchId: undefined,
        dispatchLeaseUntil: undefined,
        workerRunId: undefined,
        deliveryRunId: undefined,
        heartbeatAt: now,
        progress:
          "paused worker stopped before final checkpoint — claim safely closed",
      });
      await appendAttemptEvidence(
        ctx,
        job,
        "paused_claim_reconciled",
        "Paused worker liveness expired; exact claim closed without resuming",
        {
          stage: "paused",
          percent: job.percent,
          evidenceKind: "watchdog",
          eventKey: `paused-claim-reconciled:${attemptNumber}:${receipt.dispatchId}`,
          attempt: attemptNumber,
        },
      );
      reconciledPausedClaims.push(job.task.slice(0, 80));
    }
    const requeued: string[] = [];
    const abandoned: string[] = [];
    const stalled: string[] = [];
    // A fresh heartbeat is positive mechanical evidence. Long model/tool or
    // provider waits are never declared stalled by elapsed time alone; only a
    // lost lease enters deterministic recovery below.
    for (const activity of [...running, ...steering]) {
      const j = await ctx.db.get(activity.jobId);
      if (!j || !["running", "steering"].includes(j.status) || (j.attempt ?? 1) !== activity.attempt) {
        if (j) await upsertJobRuntime(ctx, j);
        continue;
      }
      // The exact claimed specialist records this lease immediately before a
      // bounded provider-side operation. Unlike a JavaScript interval it is
      // durable even when the provider SDK monopolizes the Trigger event
      // loop. The server fixes the horizon; a dead worker becomes eligible
      // again automatically when the deadline expires.
      if (Number(j.providerEffectLeaseUntil ?? 0) > now) continue;
      // A delivery controller is not a specialist workspace.  Its source
      // attempt is already closed with an immutable receipt, so reaping this
      // run must queue only another bounded controller generation.
      if (j.stage === "delivery" && j.deliveryRunId && Number(j.deliveryGeneration ?? 0) > 0) {
        const delivery = await deliveryAttemptFor(ctx, j._id, j.attempt ?? 1, Number(j.deliveryGeneration));
        if (delivery?.status === "running") {
          const retries = Number(delivery.cumulativeRetries ?? delivery.retries ?? 0) + 1;
          const exhaustedDelivery = retries > DELIVERY_RETRY_LIMIT;
          if (exhaustedDelivery && isSupervisorOwnedJob(j)) {
            await insertFreshTerminalWorkReceipt(ctx, j, j.attempt ?? 1, {
              status: "needs_input",
              terminalCode: "delivery_retry_budget_exhausted",
              recoveryDisposition: "needs_input",
              acceptanceEvidence: [],
              artifacts: [
                `convex://deliveryAttempts/${String(delivery._id)}`,
              ],
              verification: "needs_input",
              terminalEventKey:
                `delivery-exhausted:${j.attempt ?? 1}:${j.deliveryGeneration}`,
              result: "Verified delivery retry budget exhausted.",
              evidence: delivery.retryReason,
            }, now);
          }
          await ctx.db.patch(delivery._id, {
            status: exhaustedDelivery ? "blocked" : "checkpointed", retries: Number(delivery.retries ?? 0) + 1, cumulativeRetries: retries, completedAt: now,
            outcome: exhaustedDelivery ? "needs_attention" : delivery.outcome,
            terminalReceiptDigest: exhaustedDelivery ? await sha256Hex(`needs_attention:${String(j._id)}:${j.attempt ?? 1}`) : delivery.terminalReceiptDigest,
            currentStep: exhaustedDelivery ? "terminal" : "retry", retryReason: "controller liveness expired",
            leaseUntil: undefined, heartbeatAt: now, updatedAt: now,
          });
          const nextGeneration = Number(j.deliveryGeneration) + 1;
          const nextDeliveryId = exhaustedDelivery ? undefined : await ctx.db.insert("deliveryAttempts", {
            jobId: j._id, sourceWorkAttempt: j.attempt ?? 1, generation: nextGeneration,
            policy: String(delivery.policy), status: "checkpointed", parentDeliveryAttemptId: delivery._id,
            ...carriedDeliveryAuthority(delivery), heartbeatAt: now, retries: 0,
            cumulativeRetries: retries, currentStep: delivery.currentStep === "receipt" ? "receipt" : "queued",
            retryReason: "controller liveness expired", createdAt: now, updatedAt: now,
          });
          await patchJobWithRuntime(ctx, j, {
            ...invalidateDeliveryLease(j),
            status: exhaustedDelivery ? "needs_input" : "pending",
            stage: exhaustedDelivery ? "delivery attention" : "checkpointed",
            progress: exhaustedDelivery
              ? "verified delivery retry budget exhausted — Daniel's attention required"
              : "delivery controller stopped — retrying the same reviewed receipt",
            nextRunAt: exhaustedDelivery ? undefined : now + Math.min(30 * 60_000, 30_000 * 2 ** Math.max(0, retries - 1)),
            dispatchId: undefined, dispatchLeaseUntil: undefined, workerRunId: undefined, deliveryRunId: undefined,
            deliveryGeneration: exhaustedDelivery ? j.deliveryGeneration : nextGeneration,
            activeDeliveryAttemptId: exhaustedDelivery ? j.activeDeliveryAttemptId : nextDeliveryId,
          });
          await appendAttemptEvidence(ctx, j, exhaustedDelivery ? "delivery_attention" : "delivery_recovered",
            exhaustedDelivery ? "Delivery retry budget exhausted" : `Delivery generation ${j.deliveryGeneration} requeued without rerunning specialist`, {
              stage: exhaustedDelivery ? "delivery attention" : "checkpointed", evidenceKind: "delivery",
              eventKey: `delivery-recovery:${j.attempt ?? 1}:${j.deliveryGeneration}:${retries}`,
            });
          if (exhaustedDelivery) abandoned.push(j.task.slice(0, 80)); else requeued.push(j.task.slice(0, 80));
          if (exhaustedDelivery) await openDeliveryAttention(ctx, j, now);
          continue;
        }
      }
      // The serialized Trigger task heartbeats every 30 seconds. If its run
      // disappears (for example an OOM kill), the next scheduled invocation is
      // the only possible reaper, so five quiet minutes is ample fencing while
      // avoiding a long ghost-running window.
      const nextAttempt = (j.attempt ?? 1) + 1;
      let recoveryEventEmitted = false;
      if (now - j.createdAt > 14 * 86_400_000 || nextAttempt > (j.maxAttempts ?? 12)) {
        if (isSupervisorOwnedJob(j)) {
          await insertFreshTerminalWorkReceipt(ctx, j, j.attempt ?? 1, {
            status: "failed",
            terminalCode: "stale_runner_budget_exhausted",
            recoveryDisposition: "remediable",
            acceptanceEvidence: [],
            artifacts: [
              `convex://jobs/${String(j._id)}/attempt/${j.attempt ?? 1}/watchdog`,
            ],
            verification: "unavailable",
            terminalEventKey: `stale-runner-exhausted:${j.attempt ?? 1}`,
            result: "Runner repeatedly stopped without a checkpoint.",
            evidence: activity.progress ?? j.progress,
          }, now);
        }
        await patchJobWithRuntime(ctx, j, {
          status: "error",
          stage: "error",
          completedAt: now,
          result: "abandoned: runner repeatedly stopped without a checkpoint",
        });
        abandoned.push(j.task.slice(0, 80));
        const attempt = await attemptFor(ctx, j._id, j.attempt ?? 1);
        if (attempt) await ctx.db.patch(attempt._id, { status: "error", completedAt: now, lastEventAt: now });
      } else {
        const checkpoint = buildContinuationCheckpoint({
          attempt: j.attempt ?? 1,
          timedOut: false,
          interruption: "lost its worker process or container before checkpoint finalization",
          priorCheckpoint: j.checkpoint,
          narrative: j.result ?? activity.progress ?? j.progress,
          trace: j.log,
          deliveryNote: j.branch ? `checkpoint branch ${j.branch} retained` : undefined,
        });
        // The old attempt's terminal event must precede allocation of the
        // replacement attempt, otherwise causal readers see a child before
        // its failed parent.
        await appendAttemptEvidence(ctx, j, "recovered", `Recovered as attempt ${nextAttempt}`, {
          stage: "checkpointed", evidenceKind: "watchdog", eventKey: `recovery:${j.attempt ?? 1}:${nextAttempt}`,
          attempt: j.attempt ?? 1,
        });
        recoveryEventEmitted = true;
        const attempt = await attemptFor(ctx, j._id, j.attempt ?? 1);
        if (attempt && !attempt.completedAt) await ctx.db.patch(attempt._id, { status: "checkpointed", completedAt: now, lastEventAt: now });
        await patchJobWithRuntime(ctx, j, {
          ...invalidateDeliveryLease(j),
          status: "pending",
          stage: "queued",
          percent: 0,
          startedAt: undefined,
          heartbeatAt: now,
          nextRunAt: now + Math.min(6 * 60 * 60 * 1000, 60_000 * 2 ** Math.max(0, nextAttempt - 2)),
          attempt: nextAttempt,
          progress: `recovered after a stalled runner · attempt ${nextAttempt}`,
          checkpoint,
          result: checkpoint.slice(0, 4000),
        });
        requeued.push(j.task.slice(0, 80));
        await ensureAttempt(ctx, j._id, nextAttempt, "pending", now);
        await appendAttemptEvidence(ctx, j, "queued", `Recovered attempt ${nextAttempt} queued`, {
          stage: "queued", evidenceKind: "intent", eventKey: `intent:${nextAttempt}`, attempt: nextAttempt,
        });
      }
      if (!recoveryEventEmitted) await appendAttemptEvidence(ctx, j, nextAttempt > (j.maxAttempts ?? 12) ? "abandoned" : "recovered",
        nextAttempt > (j.maxAttempts ?? 12) ? "Retry budget exhausted" : `Recovered as attempt ${nextAttempt}`,
        { stage: nextAttempt > (j.maxAttempts ?? 12) ? "error" : "queued", evidenceKind: "watchdog", eventKey: `recovery:${j.attempt ?? 1}:${nextAttempt}` });
    }
    return {
      requeued,
      abandoned,
      stalled,
      releasedDispatches,
      quarantinedDispatches,
      expiredControllers,
      reconciledPausedClaims,
      expiredCloudWorkspaceHolds,
    };
  },
});

export const updateProgress = mutation({
  args: {
    jobId: v.id("jobs"),
    expectedAttempt: v.number(),
    progress: v.string(),
    // Accepted only for rolling compatibility with already-running workers.
    // Transcript tails live exclusively in Trigger Realtime metadata.
    log: v.optional(v.string()),
    stage: v.optional(v.string()),
    percent: v.optional(v.number()),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    let row = await jobRuntimeFor(ctx, a.jobId);
    if (!row) {
      // One exact legacy bootstrap is permitted only while the bounded cursor
      // migration is incomplete. There is never a full-table hot fallback.
      const state = await ctx.db
        .query("controlPlaneMigrations")
        .withIndex("by_key", (q: any) => q.eq("key", CONTROL_PLANE_MIGRATION))
        .first();
      if (state?.jobsComplete) return false;
      const legacy = await ctx.db.get(a.jobId);
      if (!legacy) return false;
      await upsertJobRuntime(ctx, legacy);
      row = await jobRuntimeFor(ctx, a.jobId);
    }
    if (!row || row.status !== "running" || row.attempt !== a.expectedAttempt) return false;
    const now = Date.now();
    const percent = a.percent === undefined ? row.percent : Math.max(row.percent ?? 0, Math.min(99, a.percent));
    // Heartbeats are deliberately excluded from causal progress. A changed
    // stage, percentage advance, or new evidence line updates the cold audit
    // cursor; fresh liveness independently proves a long-running task healthy.
    const meaningful = isMeaningfulWorkProgress({
      currentStage: row.stage,
      currentPercent: row.percent,
      currentProgress: row.progress,
      nextStage: a.stage,
      nextPercent: a.percent,
      nextProgress: a.progress,
    });
    const patch: Record<string, unknown> = {
      progress: a.progress.slice(0, 400),
      percent,
    };
    if (a.stage !== undefined) patch.stage = a.stage.slice(0, 80);
    if (meaningful) patch.progressAt = now;
    patch.updatedAt = now;
    await ctx.db.patch(row._id, patch);
    if (meaningful) {
      const durable = await ctx.db.get(a.jobId);
      const attempt = await attemptFor(ctx, a.jobId, a.expectedAttempt);
      if (!durable || !attempt) return false;
      await ctx.db.patch(attempt._id, { progressAt: now, lastEventAt: now });
      await appendAttemptEvidence(ctx, durable, "progress", a.progress, {
        stage: a.stage ?? row.stage,
        percent,
        evidenceKind: "progress",
      });
    }
    return true;
  },
});

// Liveness is intentionally a different fenced operation from progress. It
// is cheap enough to send every thirty seconds and proves only that the exact
// Trigger run is alive; it never invents causal progress evidence.
export const touchHeartbeat = mutation({
  args: {
    jobId: v.id("jobs"),
    expectedAttempt: v.number(),
    workerRunId: v.optional(v.string()),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const job = await ctx.db.get(a.jobId);
    if (!job || job.status !== "running" || (job.attempt ?? 1) !== a.expectedAttempt) return false;
    const runtime = await jobRuntimeFor(ctx, a.jobId);
    const attempt = await attemptFor(ctx, a.jobId, a.expectedAttempt);
    if (!runtime || !attempt || attempt.status !== "running") return false;
    const now = Date.now();
    // The marker is bound to the current attempt. A legacy no-ID heartbeat is
    // allowed only for the finite drain after a V2 worker becomes available;
    // every later claim has to prove its exact Trigger run.
    const requiresExactFence = attempt.heartbeatProtocolVersion === 2 || typeof a.workerRunId === "string";
    if (requiresExactFence && (typeof a.workerRunId !== "string"
      || job.workerRunId !== a.workerRunId
      || !await claimedDispatchReceiptForRow(ctx, job, a.workerRunId))) return false;
    if (!requiresExactFence) {
      const rollout = await heartbeatProtocolRollout(ctx);
      if (rollout && now > Number(rollout.activatedAt) + LEGACY_HEARTBEAT_DRAIN_MS) return false;
    }
    await ctx.db.patch(runtime._id, { heartbeatAt: now, updatedAt: now });
    // Attempt rows are immutable evidence except for causal/terminal updates;
    // runtime owns the compact liveness clock used by the five-minute reaper.
    return true;
  },
});

async function exactProviderEffectClaim(
  ctx: MutationCtx,
  a: { jobId: Id<"jobs">; expectedAttempt: number; workerRunId: string },
) {
  const job = await ctx.db.get(a.jobId);
  if (
    !job
    || job.status !== "running"
    || !["specialist", "integration"].includes(String(job.dispatchPhase))
    || (job.attempt ?? 1) !== a.expectedAttempt
    || job.workerRunId !== a.workerRunId.slice(0, 120)
  ) return null;
  const runtime = await jobRuntimeFor(ctx, a.jobId);
  const attempt = await attemptFor(ctx, a.jobId, a.expectedAttempt);
  const receipt = await claimedDispatchReceiptForRow(ctx, job, a.workerRunId.slice(0, 120));
  if (
    !runtime
    || runtime.status !== "running"
    || runtime.attempt !== a.expectedAttempt
    || runtime.workerRunId !== job.workerRunId
    || !attempt
    || attempt.status !== "running"
    || attempt.workerRunId !== job.workerRunId
    || attempt.dispatchId !== job.dispatchId
    || attempt.dispatchPhase !== job.dispatchPhase
    || attempt.dispatchReceiptId !== job.dispatchReceiptId
    || attempt.dispatchReceiptDigest !== job.dispatchReceiptDigest
    || attempt.dispatchPayloadDigest !== job.dispatchPayloadDigest
    || !receipt
    || receipt.attempt !== a.expectedAttempt
    || receipt.phase !== job.dispatchPhase
  ) return null;
  return { job, runtime, attempt };
}

// A worker cannot choose or extend the lease horizon. It may only renew the
// server-fixed bound while it still owns the exact specialist attempt and
// immutable claimed dispatch receipt.
export const beginProviderEffectLease = mutation({
  args: {
    jobId: v.id("jobs"),
    expectedAttempt: v.number(),
    workerRunId: v.string(),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const claim = await exactProviderEffectClaim(ctx, a);
    if (!claim) return null;
    const now = Date.now();
    const leaseUntil = now + PROVIDER_EFFECT_LEASE_MS;
    await patchJobWithRuntime(ctx, claim.job, {
      providerEffectLeaseUntil: leaseUntil,
      providerObservedAt: now,
      heartbeatAt: now,
    });
    return { leaseUntil };
  },
});

export const endProviderEffectLease = mutation({
  args: {
    jobId: v.id("jobs"),
    expectedAttempt: v.number(),
    workerRunId: v.string(),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const claim = await exactProviderEffectClaim(ctx, a);
    if (!claim) return false;
    const now = Date.now();
    await patchJobWithRuntime(ctx, claim.job, {
      providerEffectLeaseUntil: undefined,
      providerObservedAt: now,
      heartbeatAt: now,
    });
    return true;
  },
});

// Delivery liveness is separate from the closed specialist attempt that
// produced the receipt.  GitHub check waits can therefore remain durable
// without reopening or consuming specialist work.
export const touchDeliveryHeartbeat = mutation({
  args: {
    jobId: v.id("jobs"), expectedAttempt: v.number(), authorityDigest: v.optional(v.string()), sourceWorkAttempt: v.number(),
    deliveryGeneration: v.number(), deliveryRunId: v.string(), deliveryAttemptId: v.optional(v.id("deliveryAttempts")),
    deliveryLeaseOwner: v.optional(v.string()), deliveryLeaseToken: v.optional(v.string()), deliveryLeaseVersion: v.optional(v.number()), workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const row = await ctx.db.get(a.jobId);
    const delivery = await deliveryAttemptFor(ctx, a.jobId, a.sourceWorkAttempt, a.deliveryGeneration);
    if (!row || !delivery || row.status !== "running" || (row.attempt ?? 1) !== a.expectedAttempt
      || !await attemptExecutionAuthorityFor(ctx, row, a.expectedAttempt, a.authorityDigest)
      || !hasLiveControllerFence(row, delivery, a)
      || delivery.status !== "running") return false;
    const now = Date.now();
    if (delivery.integrationAttemptId) {
      const integration: any = await ctx.db.get(delivery.integrationAttemptId);
      const mission: any = integration ? await ctx.db.get(integration.missionId) : null;
      if (!integration || !mission || integration.controllerRunId !== delivery.deliveryRunId
        || Number(integration.leaseUntil ?? 0) < now || Number(integration.controllerDeadlineAt ?? 0) <= now
        || integration.controlRequested || mission.activeIntegrationAttemptId !== integration._id
        || mission.integrationLeaseOwner !== integration.leaseOwner
        || mission.integrationLeaseToken !== integration.leaseToken
        || Number(mission.integrationLeaseVersion) !== Number(integration.leaseVersion)) return false;
    }
    await ctx.db.patch(delivery._id, { heartbeatAt: now, updatedAt: now });
    const runtime = await jobRuntimeFor(ctx, a.jobId);
    if (runtime) await ctx.db.patch(runtime._id, { heartbeatAt: now, updatedAt: now });
    return true;
  },
});

// A controller that loses a mechanical FIFO claim returns the same immutable
// delivery generation to pending. This is not a retry and consumes no work
// attempt, delivery generation, provider budget or attention item.
export const releaseIntegrationQueueWait = mutation({
  args: {
    jobId: v.id("jobs"), expectedAttempt: v.number(), authorityDigest: v.optional(v.string()), sourceWorkAttempt: v.number(),
    deliveryGeneration: v.number(), deliveryRunId: v.string(), deliveryAttemptId: v.optional(v.id("deliveryAttempts")),
    deliveryLeaseOwner: v.optional(v.string()), deliveryLeaseToken: v.optional(v.string()), deliveryLeaseVersion: v.optional(v.number()),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const row: any = await ctx.db.get(a.jobId);
    const delivery: any = await deliveryAttemptFor(ctx, a.jobId, a.sourceWorkAttempt, a.deliveryGeneration);
    if (!row || row.status !== "running" || (row.attempt ?? 1) !== a.expectedAttempt
      || !await attemptExecutionAuthorityFor(ctx, row, a.expectedAttempt, a.authorityDigest)
      || !delivery || delivery.policy !== "mission_integration"
      || !deliveryClaimMatches(row, delivery, a)
      || !await claimedDispatchReceiptForRow(ctx, row, a.deliveryRunId)) return false;
    const now = Date.now();
    await ctx.db.patch(delivery._id, {
      status: "checkpointed", dispatchId: undefined, deliveryRunId: undefined,
      currentStep: "queued", leaseOwner: undefined, leaseToken: undefined, leaseUntil: undefined,
      heartbeatAt: now, updatedAt: now,
    });
    await patchJobWithRuntime(ctx, row, {
      ...invalidateDeliveryLease(row), status: "pending", stage: "delivery",
      progress: "integration receipt waiting in repository FIFO", integrationState: "provider_waiting",
      dispatchId: undefined, dispatchLeaseUntil: undefined, workerRunId: undefined, deliveryRunId: undefined,
      nextRunAt: now, heartbeatAt: now,
    });
    await closeClaimedDispatchReceipt(ctx, row, a.deliveryRunId, "integration FIFO claim was not available", now);
    return true;
  },
});

export const checkpointAndRequeue = mutation({
  args: {
    jobId: v.id("jobs"),
    expectedAttempt: v.number(),
    authorityDigest: v.optional(v.string()),
    checkpoint: v.string(),
    checkpointHeadSha: v.optional(v.string()),
    result: v.optional(v.string()),
    branch: v.optional(v.string()),
    delayMs: v.optional(v.number()),
    systemHoldCode: v.optional(v.literal("provider_capacity")),
    nextStatus: v.optional(v.union(v.literal("pending"), v.literal("paused"), v.literal("cancelled"))),
    deliveryAttemptId: v.optional(v.id("deliveryAttempts")),
    sourceWorkAttempt: v.optional(v.number()),
    deliveryGeneration: v.optional(v.number()),
    deliveryRunId: v.optional(v.string()),
    workerRunId: v.optional(v.string()),
    deliveryLeaseOwner: v.optional(v.string()),
    deliveryLeaseToken: v.optional(v.string()),
    deliveryLeaseVersion: v.optional(v.number()),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const row = await ctx.db.get(a.jobId);
    if (!row || (row.attempt ?? 1) !== a.expectedAttempt) {
      return { requeued: false, exhausted: false, stale: true };
    }
    if (!await attemptExecutionAuthorityFor(ctx, row, a.expectedAttempt, a.authorityDigest)) {
      return { requeued: false, exhausted: false, stale: true };
    }
    if (!await claimedDispatchReceiptForRow(ctx, row, a.deliveryRunId ?? a.workerRunId)) {
      return { requeued: false, exhausted: false, stale: true };
    }
    const delivery = a.deliveryGeneration === undefined ? null : await deliveryAttemptFor(ctx, a.jobId, Number(a.sourceWorkAttempt), Number(a.deliveryGeneration));
    if (a.deliveryGeneration !== undefined && (!delivery || !hasLiveControllerFence(row, delivery, a))) {
      return { requeued: false, exhausted: false, stale: true };
    }
    const requestedStatus = a.nextStatus ?? "pending";
    const stoppedState = requestedStatus === "paused" || requestedStatus === "cancelled";
    if (row.status !== "running") {
      // Steering closes the current attempt before a replacement workspace is
      // allowed. The old worker may contribute one safe checkpoint only.
      if (row.status === "steering" && requestedStatus === "pending") {
        const now = Date.now();
        const nextAttempt = (row.attempt ?? 1) + 1;
        if (!hasAttemptBudget(nextAttempt, row.maxAttempts ?? 12)) return { requeued: false, exhausted: true, stale: false };
        await patchJobWithRuntime(ctx, row, {
          ...invalidateDeliveryLease(row),
          status: "pending", stage: "checkpointed", attempt: nextAttempt,
          percent: 0,
          checkpoint: a.checkpoint.slice(0, 6000), result: a.result, branch: a.branch ?? row.branch,
          startedAt: undefined, heartbeatAt: now, nextRunAt: now, dispatchId: undefined,
          dispatchLeaseUntil: undefined, workerRunId: undefined,
          progress: `steering checkpoint saved · fresh attempt ${nextAttempt} queued`,
        });
        await appendAttemptEvidence(ctx, row, "steering_checkpoint", "Steering checkpoint saved before fresh scoped attempt", {
          stage: "checkpointed", percent: row.percent, evidenceKind: "checkpoint", eventKey: `steering-checkpoint:${a.expectedAttempt}`, attempt: a.expectedAttempt,
        });
        const priorAttempt = await attemptFor(ctx, a.jobId, a.expectedAttempt);
        if (priorAttempt && a.checkpointHeadSha && GIT_OID.test(a.checkpointHeadSha)) {
          await ctx.db.patch(priorAttempt._id, { checkpointHeadSha: a.checkpointHeadSha });
        }
        await ensureAttempt(ctx, a.jobId, nextAttempt, "pending", now, {
          parentAttempt: a.expectedAttempt, sourceHeadSha: row.sourceHeadSha,
          parentCheckpointHeadSha: a.checkpointHeadSha && GIT_OID.test(a.checkpointHeadSha) ? a.checkpointHeadSha : undefined,
        });
        await appendAttemptEvidence(ctx, row, "queued", `Fresh attempt ${nextAttempt} queued after steering`, {
          stage: "queued", evidenceKind: "intent", eventKey: `intent:${nextAttempt}`, attempt: nextAttempt,
        });
        await closeClaimedDispatchReceipt(ctx, row, a.workerRunId, "steering checkpoint persisted", now);
        return { requeued: true, exhausted: false, stale: false };
      }
      // The control mutation owns pause/cancel state. A stopping worker may
      // append its final checkpoint, but it must never resurrect or overwrite
      // that state. A resumed/retried attempt has a new lease and was rejected
      // above before reaching this branch.
      if (stoppedState && row.status === requestedStatus) {
        const now = Date.now();
        await patchJobWithRuntime(ctx, row, {
          checkpoint: a.checkpoint.slice(0, 6000),
          result: a.result,
          branch: a.branch ?? row.branch,
          heartbeatAt: now,
        });
        await appendAttemptEvidence(ctx, row, "checkpoint_saved", `Final checkpoint saved after ${requestedStatus}`, {
          stage: requestedStatus, percent: row.percent, evidenceKind: "checkpoint", eventKey: `stopped-checkpoint:${a.expectedAttempt}:${requestedStatus}`,
        });
        const attempt = await attemptFor(ctx, a.jobId, a.expectedAttempt);
        if (attempt) await ctx.db.patch(attempt._id, { status: requestedStatus, completedAt: now, lastEventAt: now });
        await closeClaimedDispatchReceipt(ctx, row, a.workerRunId, `final ${requestedStatus} checkpoint persisted`, now);
        return { requeued: false, exhausted: false, stale: false };
      }
      return { requeued: false, exhausted: false, stale: true };
    }
    // A controller-only delivery retry carries a signed, immutable review of
    // this exact work attempt. Keep that work attempt stable and increment a
    // separate delivery generation so a resume cannot pretend old evidence
    // was observed by a new specialist attempt.
    const deliveryContinuation = requestedStatus === "pending"
      && row.verificationVerdict === "pass"
      && Boolean(row.reviewReceiptId);
    const activeAttempt = await attemptFor(ctx, a.jobId, a.expectedAttempt);
    // Capacity is an infrastructure admission hold, not a model correction.
    // Derive eligibility from durable state: no provider identity and no
    // prepared Codex turn may exist. The caller's enum only selects this
    // stricter branch; it is never trusted as proof by itself.
    const providerCapacityHold = requestedStatus === "pending"
      && a.systemHoldCode === "provider_capacity"
      && !deliveryContinuation
      && activeAttempt?.status === "running"
      && !activeAttempt.providerWorkspaceId
      && !activeAttempt.providerSessionId
      && !activeAttempt.codexTurnReceiptId;
    const nextAttempt =
      (row.attempt ?? 1)
      + (requestedStatus === "pending" && !deliveryContinuation ? 1 : 0);
    const requestedDelayMs = providerCapacityHold
      ? 60_000
      : Math.max(0, Math.min(6 * 60 * 60 * 1000, a.delayMs ?? 0));
    const retryOrdinal = deliveryContinuation && delivery
      ? Number(delivery.cumulativeRetries ?? delivery.retries ?? 0) + 1
      : 0;
    const delayMs = deliveryContinuation
      ? Math.max(requestedDelayMs, Math.min(30 * 60_000, 30_000 * 2 ** Math.max(0, retryOrdinal - 1)))
      : requestedDelayMs;
    const capacityMaxAttempts = providerCapacityHold
      ? Math.min(48, Math.max(Number(row.maxAttempts ?? 12) + 1, nextAttempt))
      : Number(row.maxAttempts ?? 12);
    const exhausted =
      requestedStatus === "pending" &&
      (nextAttempt > capacityMaxAttempts
        || Date.now() - row.createdAt > 14 * 86_400_000);
    const status = exhausted ? "error" : requestedStatus;
    // There is no next attempt when the continuation budget is exhausted.
    // Keeping the terminal job on the completed attempt lets recovery bind one
    // exact authority envelope instead of pointing at an unallocated attempt.
    const attempt = exhausted && isSupervisorOwnedJob(row)
      ? a.expectedAttempt
      : nextAttempt;
    if (exhausted && isSupervisorOwnedJob(row)) {
      await insertFreshTerminalWorkReceipt(ctx, row, a.expectedAttempt, {
        status: "failed",
        terminalCode: "continuation_budget_exhausted",
        recoveryDisposition: "remediable",
        acceptanceEvidence: [],
        artifacts: [
          `convex://jobs/${String(a.jobId)}/attempt/${a.expectedAttempt}/checkpoint`,
        ],
        verification: "unavailable",
        terminalEventKey: `continuation-exhausted:${a.expectedAttempt}`,
        result: a.result,
        evidence: a.checkpoint,
      });
    }
    if (requestedStatus === "cancelled" && isSupervisorOwnedJob(row)) {
      await insertFreshTerminalWorkReceipt(ctx, row, a.expectedAttempt, {
        status: "cancelled",
        terminalCode: "worker_observed_operator_cancel",
        recoveryDisposition: "operator_stop",
        acceptanceEvidence: [],
        artifacts: [
          `convex://jobs/${String(a.jobId)}/attempt/${a.expectedAttempt}/checkpoint`,
        ],
        verification: "cancelled",
        terminalEventKey: `checkpoint-cancelled:${a.expectedAttempt}`,
        result: a.result,
        evidence: a.checkpoint,
      });
    }
    await patchJobWithRuntime(ctx, row, {
      ...invalidateDeliveryLease(row),
      status,
      stage: exhausted ? "error" : requestedStatus === "pending" ? "checkpointed" : requestedStatus,
      percent: status === "pending" && !deliveryContinuation ? 0 : row.percent,
      checkpoint: a.checkpoint.slice(0, 6000),
      result: a.result,
      branch: a.branch ?? row.branch,
      attempt,
      maxAttempts: capacityMaxAttempts,
      // Allocate the next controller generation once here. reserveDispatch
      // only dispatches it, so retries cannot double-increment.
      deliveryGeneration: deliveryContinuation ? Number(row.deliveryGeneration ?? 1) + 1 : row.deliveryGeneration,
      startedAt: undefined,
      heartbeatAt: Date.now(),
      nextRunAt: status === "pending" ? Date.now() + delayMs : undefined,
      dispatchId: undefined,
      dispatchLeaseUntil: undefined,
      // A fresh specialist attempt has no dispatch authority yet. Keeping the
      // prior attempt's closed receipt projected on the job makes mission-wide
      // pause reject the new pending attempt as invalid authority. The
      // append-only receipt remains in dispatchReceipts and allocates the next
      // generation when this attempt is actually reserved.
      ...(status === "pending" && !deliveryContinuation
        ? {
          dispatchReceiptId: undefined,
          dispatchReceiptDigest: undefined,
          dispatchPayloadDigest: undefined,
          dispatchGeneration: undefined,
          dispatchPhase: undefined,
        }
        : {}),
      workerRunId: status === "pending" ? undefined : row.workerRunId,
      completedAt: requestedStatus === "cancelled" || exhausted ? Date.now() : undefined,
      progress: exhausted
        ? "continuation budget exhausted"
        : providerCapacityHold
          ? `provider capacity busy · continuation ${attempt} eligible in 1m`
        : requestedStatus === "pending"
          ? `checkpoint saved · continuation ${attempt}${delayMs ? ` eligible in ${Math.max(1, Math.ceil(delayMs / 60_000))}m` : " queued"}`
          : `checkpoint saved · ${requestedStatus}`,
    });
    const attemptRecord = activeAttempt;
    if (attemptRecord) await ctx.db.patch(attemptRecord._id, {
      status: exhausted ? "error" : requestedStatus === "pending" ? "checkpointed" : requestedStatus,
      checkpointHeadSha: a.checkpointHeadSha && GIT_OID.test(a.checkpointHeadSha) ? a.checkpointHeadSha : attemptRecord.checkpointHeadSha,
      completedAt: Date.now(),
      lastEventAt: Date.now(),
    });
    await closeClaimedDispatchReceipt(
      ctx,
      row,
      a.deliveryRunId ?? a.workerRunId,
      requestedStatus === "pending" ? "durable continuation queued" : `job ${requestedStatus}`,
    );
    await appendAttemptEvidence(ctx, row, exhausted ? "continuation_exhausted" : providerCapacityHold ? "provider_capacity_wait" : requestedStatus === "pending" ? "checkpoint" : requestedStatus,
      exhausted
        ? "Continuation budget exhausted"
        : providerCapacityHold
          ? `Provider capacity was busy before workspace creation; attempt ${attempt} queued without consuming model correction budget`
        : requestedStatus === "pending"
          ? `Checkpoint saved; attempt ${attempt}${delayMs ? ` eligible in ${Math.max(1, Math.ceil(delayMs / 60_000))}m` : " queued"}`
          : `Checkpoint saved; job ${requestedStatus}`,
      { stage: exhausted ? "error" : requestedStatus === "pending" ? "checkpointed" : requestedStatus,
        percent: row.percent, evidenceKind: "checkpoint", eventKey: `checkpoint:${a.expectedAttempt}:${requestedStatus}`, attempt: a.expectedAttempt });
    if (status === "pending" && !deliveryContinuation) {
      await ensureAttempt(ctx, a.jobId, attempt, "pending", Date.now(), {
        parentAttempt: a.expectedAttempt, sourceHeadSha: row.sourceHeadSha,
        parentCheckpointHeadSha: a.checkpointHeadSha && GIT_OID.test(a.checkpointHeadSha) ? a.checkpointHeadSha : undefined,
      });
      await appendAttemptEvidence(ctx, row, "queued", `Continuation attempt ${attempt} queued`, {
        stage: "queued", evidenceKind: "intent", eventKey: `intent:${attempt}`, attempt,
      });
    }
    if (providerCapacityHold && status === "pending") {
      await patchJobWithRuntime(ctx, row, {
        providerRunState: "capacity_wait",
        providerObservedAt: Date.now(),
        cloudWorkspaceBlockCode: "provider_capacity",
      });
    }
    if (deliveryContinuation && delivery) {
      const cumulativeRetries = Number(delivery.cumulativeRetries ?? delivery.retries ?? 0) + 1;
      const deliveryExhausted = cumulativeRetries > DELIVERY_RETRY_LIMIT;
      const retryNow = Date.now();
      await ctx.db.patch(delivery._id, {
        status: deliveryExhausted ? "blocked" : "checkpointed", completedAt: retryNow,
        currentStep: deliveryExhausted ? "terminal" : "retry",
        outcome: deliveryExhausted ? "needs_attention" : delivery.outcome,
        terminalReceiptDigest: deliveryExhausted ? await sha256Hex(`needs_attention:${String(row._id)}:${a.expectedAttempt}`) : delivery.terminalReceiptDigest,
        retryReason: redactSensitiveText(a.checkpoint).slice(0, 500),
        retries: Number(delivery.retries ?? 0) + 1, cumulativeRetries, leaseUntil: undefined, updatedAt: retryNow,
      });
      if (status === "pending" && !deliveryExhausted) {
        const nextGeneration = Number(row.deliveryGeneration ?? 1) + 1;
        const existing = await deliveryAttemptFor(ctx, a.jobId, a.expectedAttempt, nextGeneration);
        const nextDeliveryId = existing?._id ?? await ctx.db.insert("deliveryAttempts", {
          jobId: a.jobId, sourceWorkAttempt: a.expectedAttempt, generation: nextGeneration,
          policy: String(row.deliveryMode ?? (row.readonly ? "read_only" : "manual")), status: "checkpointed",
          parentDeliveryAttemptId: delivery._id,
          ...carriedDeliveryAuthority(delivery),
          heartbeatAt: retryNow, retries: 0, cumulativeRetries,
          currentStep: delivery.currentStep === "receipt" ? "receipt" : "queued",
          retryReason: redactSensitiveText(a.checkpoint).slice(0, 500), createdAt: retryNow, updatedAt: retryNow,
        });
        await patchJobWithRuntime(ctx, row, { activeDeliveryAttemptId: nextDeliveryId });
      } else if (deliveryExhausted) {
        if (isSupervisorOwnedJob(row)) {
          await insertFreshTerminalWorkReceipt(ctx, row, a.expectedAttempt, {
            status: "needs_input",
            terminalCode: "delivery_retry_budget_exhausted",
            recoveryDisposition: "needs_input",
            acceptanceEvidence: [],
            artifacts: [`convex://deliveryAttempts/${String(delivery._id)}`],
            verification: "needs_input",
            terminalEventKey:
              `delivery-exhausted:${a.expectedAttempt}:${delivery.generation}`,
            result: "Verified delivery retry budget exhausted.",
            evidence: a.checkpoint,
          }, retryNow);
        }
        await patchJobWithRuntime(ctx, row, {
          ...invalidateDeliveryLease(row), status: "needs_input", stage: "delivery attention",
          progress: "verified delivery retry budget exhausted — attention required",
          activeDeliveryAttemptId: delivery._id, deliveryGeneration: delivery.generation,
          dispatchId: undefined, dispatchLeaseUntil: undefined, workerRunId: undefined, deliveryRunId: undefined,
          nextRunAt: undefined,
        });
        await openDeliveryAttention(ctx, row, retryNow);
        return { requeued: false, exhausted: true, stale: false };
      }
    }
    return { requeued: status === "pending", exhausted, stale: false };
  },
});

/** Pull forward a capacity continuation produced by the pre-classification
 * runner. This accepts only the exact historical controller message and
 * proves that neither the failed nor current attempt reached a provider or
 * Codex boundary. It is safe to retain as an operator/maintenance repair. */
export const expediteCloudWorkspaceCapacityWait = mutation({
  args: { jobId: v.id("jobs"), workerToken: v.optional(v.string()) },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const row: any = await ctx.db.get(a.jobId);
    if (!row || row.status !== "pending" || !Number.isSafeInteger(row.attempt)
      || row.attempt < 2 || row.dispatchId || row.workerRunId) return false;
    const current = await attemptFor(ctx, row._id, row.attempt);
    const previous = await attemptFor(ctx, row._id, row.attempt - 1);
    if (!current || current.status !== "pending" || !previous || previous.status !== "checkpointed"
      || current.providerWorkspaceId || current.providerSessionId || current.codexTurnReceiptId
      || previous.providerWorkspaceId || previous.providerSessionId || previous.codexTurnReceiptId) return false;
    const classified = row.cloudWorkspaceBlockCode === "provider_capacity";
    const legacy = !row.cloudWorkspaceBlockCode
      && /^Runner exception on attempt [1-9][0-9]*: Vercel Sandbox controller active-attempt cap is reached\./.test(
        String(row.checkpoint ?? ""),
      );
    if (!classified && !legacy) return false;
    const now = Date.now();
    const maxAttempts = legacy
      ? Math.min(48, Math.max(Number(row.maxAttempts ?? 12) + 1, Number(row.attempt)))
      : Number(row.maxAttempts ?? 12);
    await patchJobWithRuntime(ctx, row, {
      status: "pending",
      stage: "checkpointed",
      progress: "provider capacity retry ready",
      percent: 0,
      nextRunAt: now,
      heartbeatAt: now,
      progressAt: now,
      maxAttempts,
      providerRunState: "capacity_wait",
      providerObservedAt: now,
      cloudWorkspaceBlockCode: "provider_capacity",
    });
    await appendAttemptEvidence(ctx, row, "provider_capacity_recovered", "Provider capacity continuation made eligible without consuming model correction budget", {
      stage: "queued", evidenceKind: "recovery", eventKey: `provider-capacity-recovered:${row.attempt}`, attempt: row.attempt,
    });
    return true;
  },
});

export const executionState = query({
  args: { jobId: v.id("jobs"), ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    return (await jobRuntimeFor(ctx, a.jobId))?.status ?? "missing";
  },
});

export const executionLease = query({
  args: { jobId: v.id("jobs"), ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    const row = await jobRuntimeFor(ctx, a.jobId);
    if (row) return { status: row.status, attempt: row.attempt, steerRevision: row.steerRevision ?? 0 };
    const state = await ctx.db
      .query("controlPlaneMigrations")
      .withIndex("by_key", (q: any) => q.eq("key", CONTROL_PLANE_MIGRATION))
      .first();
    if (state?.jobsComplete) return { status: "missing", attempt: 0, steerRevision: 0 };
    // Rollout-only point compatibility: an old live worker may predate its
    // projection row. This disappears permanently when the cursor completes.
    const legacy = await ctx.db.get(a.jobId);
    return legacy
      ? { status: legacy.status, attempt: legacy.attempt ?? 1, steerRevision: legacy.steerRevision ?? 0 }
      : { status: "missing", attempt: 0, steerRevision: 0 };
  },
});

// One point-read fence is reused immediately before every external or
// append-only effect. It returns only immutable authority already present in
// the claimed envelope; it never repairs, infers, or advances a mutable ref.
export const authorizeExecutionBoundary = mutation({
  args: {
    jobId: v.id("jobs"),
    expectedAttempt: v.number(),
    workerRunId: v.string(),
    authorityDigest: v.string(),
    dispatchGeneration: v.optional(v.number()),
    dispatchPhase: v.optional(v.string()),
    dispatchReceiptDigest: v.optional(v.string()),
    dispatchPayloadDigest: v.optional(v.string()),
    phase: v.union(
      v.literal("source_checkout"),
      v.literal("provider_create"),
      v.literal("codex_start"),
      v.literal("codex_resume"),
      v.literal("novita_delegate"),
      v.literal("checkpoint"),
      v.literal("review_receipt"),
      v.literal("integration"),
      v.literal("delivery"),
    ),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const row: any = await ctx.db.get(a.jobId);
    if (!row || row.status !== "running" || (row.attempt ?? 1) !== a.expectedAttempt
      || row.workerRunId !== a.workerRunId
      || row.dispatchGeneration !== a.dispatchGeneration
      || row.dispatchPhase !== a.dispatchPhase
      || row.dispatchReceiptDigest !== a.dispatchReceiptDigest
      || row.dispatchPayloadDigest !== a.dispatchPayloadDigest) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema-validated dispatch receipt
    const receipt: any = row.dispatchReceiptId ? await ctx.db.get(row.dispatchReceiptId) : null;
    if (!receipt || receipt.status !== "claimed"
      || receipt.workerRunId !== a.workerRunId
      || !dispatchReceiptMatchesRequest(receipt, row, {
        ...a,
        dispatchId: row.dispatchId,
        expectedAttempt: a.expectedAttempt,
        authorityDigest: a.authorityDigest,
        workOrderRevisionDigest: row.workOrderRevisionDigest,
        triggerMachinePreset: row.triggerMachinePreset,
        triggerMachineReason: row.triggerMachineReason,
      })) return null;
    const authority = await attemptExecutionAuthorityFor(ctx, row, a.expectedAttempt, a.authorityDigest);
    if (!authority) return null;
    const executionProfile = authority.workOrder.backgroundExecutionProfile === undefined
      ? resolveBackgroundExecutionProfileForWorkOrder({
        modelTier: authority.workOrder.minimumModel,
        readonly: authority.workOrder.readonly,
        repositoryCapabilities: authority.workOrder.toolScope,
      })
      : resolveBackgroundExecutionProfile(authority.workOrder.backgroundExecutionProfile);
    if (!executionProfile.accepted) return null;
    return {
      phase: a.phase,
      authorityDigest: authority.authorityDigest,
      schedulingBindingDigest: authority.schedulingBindingDigest,
      workOrderRevisionId: authority.workOrderRevisionId,
      workOrderRevision: authority.workOrderRevision,
      workOrderRevisionDigest: authority.workOrderRevisionDigest,
      canonicalProjectId: authority.canonicalProjectId,
      repository: authority.repository ?? null,
      sourceBranch: authority.sourceBranch ?? null,
      sourceHeadSha: authority.sourceHeadSha ?? null,
      workerBranch: row.workerBranch ?? null,
      workerLineage: authority.workerLineage,
      workspaceLineage: authority.workspaceLineage,
      retryLineage: authority.retryLineage,
      integrationLineage: authority.integrationLineage,
      machineClass: authority.workOrder.machineClass,
      triggerMachinePreset: authority.workOrder.triggerMachinePreset,
      triggerMachineReason: authority.workOrder.triggerMachineReason,
      dispatchGeneration: receipt.generation,
      dispatchPhase: receipt.phase,
      dispatchReceiptDigest: receipt.receiptDigest,
      dispatchPayloadDigest: receipt.payloadDigest,
      minimumModel: authority.workOrder.minimumModel,
      minimumReasoningEffort: authority.workOrder.minimumReasoningEffort,
      ...(a.phase === "novita_delegate" ? { policyTask: authority.workOrder.policyTask } : {}),
      backgroundExecutionProfile: executionProfile.profile,
      toolScope: authority.workOrder.toolScope,
      mcpScope: authority.workOrder.mcpScope,
    };
  },
});

// The Qwen draft is optional, but its paid egress is not retryable. This
// creates one irrevocable reservation per immutable work-order revision before
// a worker may read the vault or make a network request. A stranded reservation
// intentionally remains held: a missed draft is safer than double billing.
export const reserveNovitaPatchProposal = mutation({
  args: {
    jobId: v.id("jobs"),
    expectedAttempt: v.number(),
    workerRunId: v.string(),
    authorityDigest: v.string(),
    workOrderRevisionDigest: v.string(),
    dispatchGeneration: v.number(),
    dispatchPhase: v.string(),
    dispatchReceiptDigest: v.string(),
    dispatchPayloadDigest: v.string(),
    receiptId: v.string(),
    policyTaskDigest: v.string(),
    requestDigest: v.string(),
    sourceFileCount: v.number(),
    inputBytes: v.number(),
    reservationDigest: v.string(),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const row: any = await ctx.db.get(a.jobId);
    const attempt = row ? await attemptFor(ctx, a.jobId, a.expectedAttempt) : null;
    if (!row || !attempt || row.status !== "running" || (row.attempt ?? 1) !== a.expectedAttempt
      || row.workerRunId !== a.workerRunId
      || row.dispatchGeneration !== a.dispatchGeneration
      || row.dispatchPhase !== a.dispatchPhase
      || row.dispatchReceiptDigest !== a.dispatchReceiptDigest
      || row.dispatchPayloadDigest !== a.dispatchPayloadDigest
      || !/^[a-f0-9]{64}$/.test(a.receiptId)
      || !/^[a-f0-9]{64}$/.test(a.policyTaskDigest)
      || !/^[a-f0-9]{64}$/.test(a.requestDigest)
      || !/^[a-f0-9]{64}$/.test(a.reservationDigest)
      || !Number.isSafeInteger(a.sourceFileCount) || a.sourceFileCount < 1 || a.sourceFileCount > 3
      || !Number.isSafeInteger(a.inputBytes) || a.inputBytes < 1) return null;
    const dispatch = await claimedDispatchReceiptForRow(ctx, row, a.workerRunId);
    if (!dispatch || dispatch.receiptDigest !== a.dispatchReceiptDigest || dispatch.payloadDigest !== a.dispatchPayloadDigest
      || dispatch.authorityDigest !== a.authorityDigest || dispatch.workOrderRevisionDigest !== a.workOrderRevisionDigest) return null;
    const authority = await attemptExecutionAuthorityFor(ctx, row, a.expectedAttempt, a.authorityDigest);
    if (!authority || authority.workOrderRevisionDigest !== a.workOrderRevisionDigest) return null;
    const executionProfile = authority.workOrder.backgroundExecutionProfile === undefined
      ? resolveBackgroundExecutionProfileForWorkOrder({
        modelTier: authority.workOrder.minimumModel,
        readonly: authority.workOrder.readonly,
        repositoryCapabilities: authority.workOrder.toolScope,
      })
      : resolveBackgroundExecutionProfile(authority.workOrder.backgroundExecutionProfile);
    if (!executionProfile.accepted || executionProfile.profile.version !== 2) return null;
    const attestation = executionProfile.profile.novitaPatchProposer;
    if (a.inputBytes > attestation.requestLimits.maxInputBytes) return null;
    // A valid worker claim alone is not enough: paid egress stays bound to
    // the policy task sealed into this exact immutable work-order revision.
    const expectedPolicyTaskDigest = await sha256Hex(authority.workOrder.policyTask);
    if (a.policyTaskDigest !== expectedPolicyTaskDigest) return null;
    const expectedReservationDigest = await sha256Hex(canonicalNovitaPatchProposalReservation({
      workOrderRevisionDigest: authority.workOrderRevisionDigest,
      attestation,
      policyTaskDigest: expectedPolicyTaskDigest,
      requestDigest: a.requestDigest,
      sourceFileCount: a.sourceFileCount,
      inputBytes: a.inputBytes,
    }));
    const expectedReceiptId = await sha256Hex([
      "jarvis-novita-patch-proposal-receipt-v1",
      String(authority.workOrderRevisionId),
      expectedReservationDigest,
    ].join(":"));
    if (a.reservationDigest !== expectedReservationDigest || a.receiptId !== expectedReceiptId) return null;
    const existing = await ctx.db
      .query("novitaPatchProposalReceipts")
      .withIndex("by_work_order_revision", (q) => q.eq("workOrderRevisionId", authority.workOrderRevisionId))
      .take(2);
    if (existing.length > 0) return { disposition: "held" as const };
    const now = Date.now();
    await ctx.db.insert("novitaPatchProposalReceipts", {
      protocolVersion: 1,
      workOrderRevisionId: authority.workOrderRevisionId,
      workOrderRevision: authority.workOrderRevision,
      workOrderRevisionDigest: authority.workOrderRevisionDigest,
      jobId: row._id,
      canonicalProjectId: authority.canonicalProjectId,
      repository: authority.repository ?? undefined,
      schedulingBindingDigest: authority.schedulingBindingDigest,
      authorityDigest: authority.authorityDigest,
      workAttemptId: attempt._id,
      ownerAttempt: a.expectedAttempt,
      ownerWorkerRunId: a.workerRunId,
      ownerDispatchReceiptDigest: a.dispatchReceiptDigest,
      ownerDispatchPayloadDigest: a.dispatchPayloadDigest,
      adapterId: attestation.adapterId,
      configDigest: attestation.configDigest,
      endpointId: attestation.endpointId,
      policyTaskDigest: expectedPolicyTaskDigest,
      requestDigest: a.requestDigest,
      sourceFileCount: a.sourceFileCount,
      inputBytes: a.inputBytes,
      reservationDigest: expectedReservationDigest,
      status: "reserved",
      reservedAt: now,
    });
    return { disposition: "execute" as const, receiptId: expectedReceiptId, reservationDigest: expectedReservationDigest };
  },
});

// The original owner can settle its reservation even if the mutable job has
// since checkpointed. Replays are accepted only when byte-for-byte identical;
// no reservation is ever reclaimed or re-opened.
export const settleNovitaPatchProposal = mutation({
  args: {
    workOrderRevisionId: v.id("workOrderRevisions"),
    jobId: v.id("jobs"),
    ownerAttempt: v.number(),
    ownerWorkerRunId: v.string(),
    authorityDigest: v.string(),
    ownerDispatchReceiptDigest: v.string(),
    ownerDispatchPayloadDigest: v.string(),
    receiptId: v.string(),
    reservationDigest: v.string(),
    outcome: v.union(
      v.literal("proposed"), v.literal("no_change"), v.literal("skipped"),
      v.literal("unavailable"), v.literal("rejected"),
    ),
    outcomeDigest: v.string(),
    outputBytes: v.number(),
    failureClass: v.optional(v.union(
      v.literal("configuration"), v.literal("input"), v.literal("transport"),
      v.literal("timeout"), v.literal("http"), v.literal("response"),
    )),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    if (!/^[a-f0-9]{64}$/.test(a.receiptId) || !/^[a-f0-9]{64}$/.test(a.authorityDigest)
      || !/^[a-f0-9]{64}$/.test(a.reservationDigest)
      || !/^[a-f0-9]{64}$/.test(a.outcomeDigest)
      || !Number.isSafeInteger(a.outputBytes) || a.outputBytes < 0 || a.outputBytes > 64_000) return false;
    const rows = await ctx.db
      .query("novitaPatchProposalReceipts")
      .withIndex("by_work_order_revision", (q) => q.eq("workOrderRevisionId", a.workOrderRevisionId))
      .take(2);
    if (rows.length !== 1) return false;
    const receipt = rows[0];
    if (receipt.jobId !== a.jobId || receipt.ownerAttempt !== a.ownerAttempt
      || receipt.ownerWorkerRunId !== a.ownerWorkerRunId
      || receipt.authorityDigest !== a.authorityDigest
      || receipt.ownerDispatchReceiptDigest !== a.ownerDispatchReceiptDigest
      || receipt.ownerDispatchPayloadDigest !== a.ownerDispatchPayloadDigest
      || receipt.reservationDigest !== a.reservationDigest) return false;
    const expectedReceiptId = await sha256Hex([
      "jarvis-novita-patch-proposal-receipt-v1",
      String(receipt.workOrderRevisionId),
      receipt.reservationDigest,
    ].join(":"));
    if (a.receiptId !== expectedReceiptId) return false;
    const expectedOutcomeDigest = await sha256Hex(canonicalNovitaPatchProposalOutcome({
      reservationDigest: receipt.reservationDigest,
      outcome: a.outcome,
      failureClass: a.failureClass,
      outputBytes: a.outputBytes,
    }));
    if (a.outcomeDigest !== expectedOutcomeDigest) return false;
    if (receipt.status === "settled") {
      return receipt.outcome === a.outcome
        && receipt.outcomeDigest === a.outcomeDigest
        && receipt.outputBytes === a.outputBytes
        && receipt.failureClass === a.failureClass;
    }
    await ctx.db.patch(receipt._id, {
      status: "settled",
      outcome: a.outcome,
      outcomeDigest: a.outcomeDigest,
      outputBytes: a.outputBytes,
      failureClass: a.failureClass,
      settledAt: Date.now(),
    });
    return true;
  },
});

// The sandbox adapter confirms (never assigns) the exact source authority
// observed before enqueue and checked out before Codex starts.
export const bindWorkspaceSource = mutation({
  args: {
    jobId: v.id("jobs"), expectedAttempt: v.number(), workerRunId: v.string(),
    authorityDigest: v.optional(v.string()), sourceBranch: v.string(), sourceHeadSha: v.string(),
    checkoutHeadSha: v.optional(v.string()), workerToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    const row = await ctx.db.get(args.jobId);
    if (!row || row.status !== "running" || (row.attempt ?? 1) !== args.expectedAttempt
      || row.workerRunId !== args.workerRunId || !/^[a-zA-Z0-9._/-]{1,240}$/.test(args.sourceBranch)
      || !/^[0-9a-f]{40,64}$/i.test(args.sourceHeadSha)) return false;
    if (!await attemptExecutionAuthorityFor(ctx, row, args.expectedAttempt, args.authorityDigest)) return false;
    const attempt = await attemptFor(ctx, args.jobId, args.expectedAttempt);
    const checkoutHeadSha = args.checkoutHeadSha ?? args.sourceHeadSha;
    if (!GIT_OID.test(checkoutHeadSha)) return false;
    if (attempt?.parentAttempt !== undefined) {
      const checkpointContinuation = GIT_OID.test(String(attempt.parentCheckpointHeadSha ?? ""))
        && attempt.parentCheckpointHeadSha === checkoutHeadSha;
      // The server-minted child attempt carries the only permitted workspace
      // lineage across the attempt boundary. A checkpoint-bearing child must
      // resume that exact immutable head. A child deliberately created with
      // no parent checkpoint (for example, a rejected Goal contract or a
      // provider hold before execution) starts a fresh generation from the
      // still-sealed admitted source. Requiring the immediate parent itself
      // to have bound a workspace deadlocks chains of pre-execution holds and
      // stale controller corrections, even though no mutable checkout exists
      // to preserve. The current attempt authority and row source equality
      // below still prevent a caller from selecting another ref or commit.
      const freshAdmittedGeneration = attempt.parentCheckpointHeadSha === undefined
        && checkoutHeadSha === args.sourceHeadSha;
      if (!checkpointContinuation && !freshAdmittedGeneration) return false;
    }
    if (row.sourceHeadSha !== args.sourceHeadSha || row.sourceBranch !== args.sourceBranch) return false;
    if (attempt) await ctx.db.patch(attempt._id, { sourceHeadSha: args.sourceHeadSha, workspaceBaseSha: checkoutHeadSha, lastEventAt: Date.now() });
    await appendAttemptEvidence(ctx, row, "workspace_source_bound", `Sandbox source bound to ${args.sourceBranch}@${args.sourceHeadSha}`, {
      stage: "starting", evidenceKind: "workspace", eventKey: `workspace-source:${args.expectedAttempt}:${args.sourceHeadSha}`,
      data: { sourceBranch: args.sourceBranch, sourceHeadSha: args.sourceHeadSha, workerBranch: row.workerBranch },
    });
    return true;
  },
});

export const bindCloudWorkspace = mutation({
  args: {
    jobId: v.id("jobs"), expectedAttempt: v.number(), workerRunId: v.string(),
    authorityDigest: v.optional(v.string()),
    providerName: v.union(v.literal("e2b"), v.literal("sandbox0"), v.literal("vercel"), v.literal("cloudflare")),
    providerWorkspaceId: v.string(), providerSessionId: v.string(), workerToken: v.optional(v.string()),
    baseSha: v.string(), runtime: v.string(), lockfileDigest: v.string(), template: v.string(),
    sourceArchiveDigest: v.string(), sourceArchiveBytes: v.number(),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const row = await ctx.db.get(a.jobId);
    const attempt = await attemptFor(ctx, a.jobId, a.expectedAttempt);
    if (!row || row.status !== "running" || (row.attempt ?? 1) !== a.expectedAttempt
      || row.workerRunId !== a.workerRunId || !attempt || attempt.status !== "running"
      || !await attemptExecutionAuthorityFor(ctx, row, a.expectedAttempt, a.authorityDigest)
      || !a.providerWorkspaceId || !a.providerSessionId || a.providerWorkspaceId === a.providerSessionId
      || !GIT_OID.test(a.baseSha) || (attempt.workspaceBaseSha && attempt.workspaceBaseSha !== a.baseSha)
      || a.runtime !== WORK_ORDER_MACHINE_RUNTIME || a.template !== WORK_ORDER_MACHINE_TEMPLATE
      || !/^[0-9a-f]{64}$/.test(a.lockfileDigest) || !/^[0-9a-f]{64}$/.test(a.sourceArchiveDigest)
      || !a.runtime || a.runtime.length > 120 || !a.template || a.template.length > 240
      || !Number.isSafeInteger(a.sourceArchiveBytes) || a.sourceArchiveBytes < 0 || a.sourceArchiveBytes > 25 * 1024 * 1024) return false;
    if (attempt.providerWorkspaceId || attempt.providerSessionId) {
      return attempt.providerName === a.providerName
        && attempt.providerWorkspaceId === a.providerWorkspaceId
        && attempt.providerSessionId === a.providerSessionId
        && attempt.workspaceBaseSha === a.baseSha
        && attempt.workspaceRuntime === a.runtime
        && attempt.workspaceLockfileDigest === a.lockfileDigest
        && attempt.workspaceTemplate === a.template
        && attempt.sourceArchiveDigest === a.sourceArchiveDigest
        && attempt.sourceArchiveBytes === a.sourceArchiveBytes;
    }
    const now = Date.now();
    await ctx.db.patch(attempt._id, {
      providerName: a.providerName,
      providerWorkspaceId: a.providerWorkspaceId.slice(0, 240),
      providerSessionId: a.providerSessionId.slice(0, 240),
      providerCreatedAt: now,
      cloudWorkspaceCleanupEligible: true,
      workspaceBaseSha: a.baseSha,
      workspaceRuntime: a.runtime.slice(0, 120),
      workspaceLockfileDigest: a.lockfileDigest,
      workspaceTemplate: a.template.slice(0, 240),
      sourceArchiveDigest: a.sourceArchiveDigest,
      sourceArchiveBytes: a.sourceArchiveBytes,
      lastEventAt: now,
    });
    await patchJobWithRuntime(ctx, row, { providerRunState: "workspace_bound", providerObservedAt: now });
    await appendAttemptEvidence(ctx, row, "cloud_workspace_bound", `${a.providerName} cloud workspace bound`, {
      stage: "starting", evidenceKind: "workspace", eventKey: `cloud-workspace:${a.expectedAttempt}:${a.providerName}`,
      data: { provider: a.providerName, workspaceId: a.providerWorkspaceId.slice(0, 80), sessionId: a.providerSessionId.slice(0, 80) },
    });
    return true;
  },
});

export const noteCloudWorkspaceBlock = mutation({
  args: {
    jobId: v.id("jobs"), expectedAttempt: v.number(), authorityDigest: v.optional(v.string()),
    code: v.string(), reason: v.string(), workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const row = await ctx.db.get(a.jobId);
    if (!row || row.status !== "running" || (row.attempt ?? 1) !== a.expectedAttempt
      || !await attemptExecutionAuthorityFor(ctx, row, a.expectedAttempt, a.authorityDigest)) return false;
    const now = Date.now();
    await patchJobWithRuntime(ctx, row, {
      providerRunState: "blocked", providerObservedAt: now,
      cloudWorkspaceBlockCode: a.code.slice(0, 80),
      stage: "cloud blocked", progress: `cloud workspace blocked · ${a.code.slice(0, 80)}`,
    });
    await appendAttemptEvidence(ctx, row, "cloud_workspace_blocked", a.reason.slice(0, 500), {
      stage: "cloud blocked", evidenceKind: "checkpoint", eventKey: `cloud-blocked:${a.expectedAttempt}:${a.code.slice(0, 80)}`,
      data: { code: a.code.slice(0, 80) },
    });
    return true;
  },
});

/** Resume only system-held work after the Trigger worker has verified a fresh
 * provider receipt. This is deliberately separate from operator controls: no
 * human approval or input is manufactured for an infrastructure recovery. */
export const resumeCloudWorkspaceBlocks = mutation({
  args: { limit: v.optional(v.number()), workerToken: v.optional(v.string()) },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const now = Date.now();
    const limit = Math.max(1, Math.min(16, Math.floor(a.limit ?? 8)));
    const candidates = await ctx.db.query("jobs")
      .withIndex("by_status", (q) => q.eq("status", "paused"))
      .order("desc")
      .take(limit * 2);
    const resumed: string[] = [];
    for (const row of candidates) {
      if (resumed.length >= limit || row.providerRunState !== "blocked") continue;
      const previous = await attemptFor(ctx, row._id, row.attempt ?? 1);
      if (!previous || previous.status !== "paused" || !previous.completedAt) continue;
      const nextAttempt = (row.attempt ?? 1) + (shouldAdvanceAttempt(Boolean(previous.workerRunId)) ? 1 : 0);
      // A deployment/configuration hold happens before source hydration,
      // provider workspace creation, or a Codex turn. Preserve immutable run
      // lineage by allocating a fresh attempt, but do not consume the model's
      // correction budget merely because its predecessor proved no work could
      // start. The fresh provider attestation above is the only authority that
      // may extend this one pre-work boundary.
      const preWorkspaceHold = !previous.providerWorkspaceId && !previous.providerSessionId;
      const maxAttempts = Math.max(Number(row.maxAttempts ?? 12), preWorkspaceHold ? nextAttempt : 0);
      if (nextAttempt > 48 || (!preWorkspaceHold && !hasAttemptBudget(nextAttempt, row.maxAttempts ?? 12))) continue;
      await patchJobWithRuntime(ctx, row, {
        ...invalidateDeliveryLease(row),
        status: "pending",
        stage: "queued",
        progress: "Secure worker ready · continuing automatically",
        percent: 0,
        attempt: nextAttempt,
        maxAttempts,
        startedAt: undefined,
        heartbeatAt: now,
        progressAt: now,
        stalledAt: undefined,
        stallReason: undefined,
        nextRunAt: now,
        dispatchId: undefined,
        dispatchLeaseUntil: undefined,
        workerRunId: undefined,
        workerRuntime: undefined,
        providerRunState: "queued",
        providerObservedAt: now,
        cloudWorkspaceBlockCode: undefined,
      });
      if (nextAttempt === (row.attempt ?? 1)) {
        await ctx.db.patch(previous._id, {
          status: "queued", dispatchId: undefined, completedAt: undefined, lastEventAt: now,
        });
      } else {
        await ensureAttempt(ctx, row._id, nextAttempt, "pending", now, {
          parentAttempt: row.attempt ?? 1,
          sourceHeadSha: row.sourceHeadSha,
          parentCheckpointHeadSha: previous.checkpointHeadSha,
        });
      }
      await appendAttemptEvidence(ctx, row, "system_recovered", "Secure cloud worker verified; work resumed automatically", {
        stage: "queued", evidenceKind: "recovery", eventKey: `system-recovered:${nextAttempt}`, attempt: nextAttempt,
      });
      resumed.push(String(row._id));
    }
    return { resumed };
  },
});

export const prepareCloudCodexTurn = mutation({
  args: {
    jobId: v.id("jobs"), expectedAttempt: v.number(), workerRunId: v.string(),
    authorityDigest: v.optional(v.string()), workOrderRevisionDigest: v.optional(v.string()),
    dispatchReceiptDigest: v.optional(v.string()), dispatchPayloadDigest: v.optional(v.string()),
    providerWorkspaceId: v.string(), providerSessionId: v.string(),
    receiptId: v.string(), sequence: v.number(), workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const row = await ctx.db.get(a.jobId);
    const attempt = await attemptFor(ctx, a.jobId, a.expectedAttempt);
    if (!row || row.status !== "running" || (row.attempt ?? 1) !== a.expectedAttempt
      || row.workerRunId !== a.workerRunId || !attempt || attempt.status !== "running") return false;
    const authority = await attemptExecutionAuthorityFor(ctx, row, a.expectedAttempt, a.authorityDigest);
    if (!authority || authority.workOrderRevisionDigest !== a.workOrderRevisionDigest
      || row.dispatchReceiptDigest !== a.dispatchReceiptDigest
      || row.dispatchPayloadDigest !== a.dispatchPayloadDigest
      || attempt.dispatchReceiptDigest !== a.dispatchReceiptDigest
      || attempt.dispatchPayloadDigest !== a.dispatchPayloadDigest
      || attempt.providerWorkspaceId !== a.providerWorkspaceId
      || attempt.providerSessionId !== a.providerSessionId
      || !/^[a-f0-9]{64}$/.test(a.receiptId)
      || !Number.isSafeInteger(a.sequence) || a.sequence < 1 || a.sequence > 2) return false;
    if (attempt.codexTurnReceiptId) {
      if (attempt.codexTurnReceiptId === a.receiptId
        && attempt.codexTurnReceiptSequence === a.sequence
        && attempt.codexTurnReceiptPhase === "prepared") return true;
      if (attempt.codexTurnReceiptPhase !== "rejected"
        || a.sequence !== Number(attempt.codexTurnReceiptSequence ?? 0) + 1) return false;
    } else if (a.sequence !== 1) return false;
    const now = Date.now();
    await ctx.db.patch(attempt._id, {
      codexTurnReceiptId: a.receiptId,
      codexTurnReceiptSequence: a.sequence,
      codexTurnReceiptPhase: "prepared",
      codexTurnReceiptAt: now,
      lastEventAt: now,
    });
    await appendAttemptEvidence(ctx, row, "cloud_codex_turn_prepared", "Codex turn receipt prepared before protocol execution", {
      stage: "starting", evidenceKind: "checkpoint",
      eventKey: `codex-turn:${a.expectedAttempt}:${a.sequence}:prepared`,
      data: { sequence: a.sequence, phase: "prepared" },
    });
    return true;
  },
});

export const recordCloudCodexTurnPhase = mutation({
  args: {
    jobId: v.id("jobs"), expectedAttempt: v.number(), workerRunId: v.string(),
    authorityDigest: v.optional(v.string()), workOrderRevisionDigest: v.optional(v.string()),
    dispatchReceiptDigest: v.optional(v.string()), dispatchPayloadDigest: v.optional(v.string()),
    receiptId: v.string(), sequence: v.number(),
    phase: v.union(
      v.literal("request_intent"), v.literal("request_written"),
      v.literal("accepted"), v.literal("effect"),
      v.literal("rejected"), v.literal("completed"),
    ),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const row = await ctx.db.get(a.jobId);
    const attempt = await attemptFor(ctx, a.jobId, a.expectedAttempt);
    if (!row || row.status !== "running" || (row.attempt ?? 1) !== a.expectedAttempt
      || row.workerRunId !== a.workerRunId || !attempt || attempt.status !== "running") return false;
    const authority = await attemptExecutionAuthorityFor(ctx, row, a.expectedAttempt, a.authorityDigest);
    if (!authority || authority.workOrderRevisionDigest !== a.workOrderRevisionDigest
      || row.dispatchReceiptDigest !== a.dispatchReceiptDigest
      || row.dispatchPayloadDigest !== a.dispatchPayloadDigest
      || attempt.dispatchReceiptDigest !== a.dispatchReceiptDigest
      || attempt.dispatchPayloadDigest !== a.dispatchPayloadDigest
      || attempt.codexTurnReceiptId !== a.receiptId
      || attempt.codexTurnReceiptSequence !== a.sequence) return false;
    const prior = String(attempt.codexTurnReceiptPhase ?? "");
    if (prior === a.phase) return true;
    const allowed: Record<string, readonly string[]> = {
      prepared: ["request_intent", "request_written", "accepted", "effect", "rejected"],
      request_intent: ["request_written", "accepted", "effect", "rejected"],
      request_written: ["accepted", "effect", "rejected"],
      accepted: ["effect", "completed"],
      effect: ["completed"],
    };
    if (!allowed[prior]?.includes(a.phase)) return false;
    const now = Date.now();
    await ctx.db.patch(attempt._id, {
      codexTurnReceiptPhase: a.phase,
      codexTurnReceiptAt: now,
      lastEventAt: now,
    });
    await appendAttemptEvidence(ctx, row, `cloud_codex_turn_${a.phase}`, `Codex turn receipt advanced to ${a.phase}`, {
      stage: "executing", evidenceKind: "checkpoint",
      eventKey: `codex-turn:${a.expectedAttempt}:${a.sequence}:${a.phase}`,
      data: { sequence: a.sequence, phase: a.phase },
    });
    return true;
  },
});

export const recordCloudCheckpoint = mutation({
  args: {
    jobId: v.id("jobs"), expectedAttempt: v.number(),
    authorityDigest: v.optional(v.string()),
    providerWorkspaceId: v.string(), providerSessionId: v.string(),
    checkpointRef: v.string(), checkpointDigest: v.string(), checkpointBytes: v.number(),
    checkpointManifestDigest: v.string(), checkpointManifest: v.string(), workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const row = await ctx.db.get(a.jobId);
    const attempt = await attemptFor(ctx, a.jobId, a.expectedAttempt);
    let manifest;
    try { manifest = parseCanonicalWorkspaceCheckpoint(a.checkpointManifest); }
    catch { return false; }
    const computedManifestDigest = await sha256Hex(a.checkpointManifest);
    if (!row || row.status !== "running" || (row.attempt ?? 1) !== a.expectedAttempt || !attempt
      || !await attemptExecutionAuthorityFor(ctx, row, a.expectedAttempt, a.authorityDigest)
      || attempt.providerWorkspaceId !== a.providerWorkspaceId || attempt.providerSessionId !== a.providerSessionId
      || !/^sandbox-checkpoints\/sha256\/[0-9a-f]{64}$/.test(a.checkpointRef)
      || !/^[0-9a-f]{64}$/.test(a.checkpointDigest)
      || a.checkpointRef !== `sandbox-checkpoints/sha256/${a.checkpointDigest}`
      || !/^[0-9a-f]{64}$/.test(a.checkpointManifestDigest)
      || computedManifestDigest !== a.checkpointManifestDigest
      || !Number.isSafeInteger(a.checkpointBytes) || a.checkpointBytes < 0 || a.checkpointBytes > 25 * 1024 * 1024
      || manifest.jobId !== String(a.jobId) || manifest.attempt !== a.expectedAttempt
      || manifest.provider !== attempt.providerName
      || manifest.providerWorkspaceId !== attempt.providerWorkspaceId
      || manifest.providerSessionId !== attempt.providerSessionId
      || manifest.baseSha !== attempt.workspaceBaseSha
      || manifest.sourceArchiveSha256 !== attempt.sourceArchiveDigest
      || manifest.sourceArchiveBytes !== attempt.sourceArchiveBytes
      || manifest.archiveSha256 !== a.checkpointDigest || manifest.archiveBytes !== a.checkpointBytes
      || manifest.runtime !== attempt.workspaceRuntime || manifest.lockfileDigest !== attempt.workspaceLockfileDigest
      || manifest.template !== attempt.workspaceTemplate
      || manifest.attemptKey !== `${String(a.jobId)}:${a.expectedAttempt}`
      || manifest.causationId !== `${String(row.workerRunId)}:${a.expectedAttempt}`) return false;
    if (attempt.checkpointRef || attempt.checkpointDigest || attempt.checkpointManifest || attempt.checkpointAvailable !== undefined) {
      return attempt.checkpointAvailable === true
        && attempt.checkpointRef === a.checkpointRef
        && attempt.checkpointDigest === a.checkpointDigest
        && attempt.checkpointBytes === a.checkpointBytes
        && attempt.checkpointManifestDigest === a.checkpointManifestDigest
        && attempt.checkpointManifest === a.checkpointManifest;
    }
    const now = Date.now();
    await ctx.db.patch(attempt._id, {
      checkpointRef: a.checkpointRef, checkpointDigest: a.checkpointDigest,
      checkpointBytes: a.checkpointBytes, checkpointManifestDigest: a.checkpointManifestDigest,
      checkpointManifest: a.checkpointManifest, checkpointAvailable: true,
      lastEventAt: now,
    });
    await patchJobWithRuntime(ctx, row, { providerRunState: "checkpointed", providerObservedAt: now });
    return true;
  },
});

export const cloudCheckpointForReplay = query({
  args: {
    jobId: v.id("jobs"), expectedAttempt: v.number(), workerRunId: v.string(),
    authorityDigest: v.optional(v.string()),
    providerName: v.union(v.literal("e2b"), v.literal("sandbox0"), v.literal("vercel"), v.literal("cloudflare")),
    baseSha: v.string(), runtime: v.string(), lockfileDigest: v.string(), template: v.string(),
    sourceArchiveDigest: v.string(), sourceArchiveBytes: v.number(), workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const row = await ctx.db.get(a.jobId);
    const current = await attemptFor(ctx, a.jobId, a.expectedAttempt);
    if (!row || row.status !== "running" || (row.attempt ?? 1) !== a.expectedAttempt
      || row.workerRunId !== a.workerRunId || !current || current.status !== "running") {
      return { disposition: "reject" as const, reason: "stale_attempt" };
    }
    if (!await attemptExecutionAuthorityFor(ctx, row, a.expectedAttempt, a.authorityDigest)) {
      return { disposition: "reject" as const, reason: "authority_mismatch" };
    }
    if (!GIT_OID.test(a.baseSha) || (current.workspaceBaseSha && current.workspaceBaseSha !== a.baseSha)
      || a.runtime !== WORK_ORDER_MACHINE_RUNTIME || a.template !== WORK_ORDER_MACHINE_TEMPLATE
      || !/^[0-9a-f]{64}$/.test(a.lockfileDigest) || !/^[0-9a-f]{64}$/.test(a.sourceArchiveDigest)
      || !Number.isSafeInteger(a.sourceArchiveBytes) || a.sourceArchiveBytes < 0 || a.sourceArchiveBytes > 25 * 1024 * 1024) {
      return { disposition: "reject" as const, reason: "current_binding_invalid" };
    }
    if (a.expectedAttempt <= 1) return { disposition: "hydrate" as const, reason: "first_attempt" };
    // `checkpointAvailable` is written atomically with the receipt. Legacy
    // rows without it intentionally hydrate: replay must not reintroduce an
    // unbounded scan or infer authority from partial historical fields.
    const prior: any = await ctx.db.query("workAttempts")
      .withIndex("by_job_checkpoint_available_attempt", (q: any) => q
        .eq("jobId", a.jobId)
        .eq("checkpointAvailable", true)
        .lt("attempt", a.expectedAttempt))
      .order("desc")
      .first();
    if (!prior?.checkpointRef) return { disposition: "hydrate" as const, reason: "no_prior_checkpoint" };
    if (!prior.checkpointManifest || !prior.checkpointManifestDigest || !prior.checkpointDigest
      || !Number.isSafeInteger(prior.checkpointBytes)) {
      return { disposition: "reject" as const, reason: "checkpoint_receipt_incomplete" };
    }
    let manifest;
    try { manifest = parseCanonicalWorkspaceCheckpoint(prior.checkpointManifest); }
    catch { return { disposition: "reject" as const, reason: "checkpoint_manifest_tampered" }; }
    if (await sha256Hex(prior.checkpointManifest) !== prior.checkpointManifestDigest
      || canonicalWorkspaceCheckpoint(manifest) !== prior.checkpointManifest
      || manifest.jobId !== String(a.jobId) || manifest.attempt !== prior.attempt
      || manifest.provider !== prior.providerName
      || manifest.providerWorkspaceId !== prior.providerWorkspaceId
      || manifest.providerSessionId !== prior.providerSessionId
      || manifest.baseSha !== prior.workspaceBaseSha
      || manifest.sourceArchiveSha256 !== prior.sourceArchiveDigest
      || manifest.sourceArchiveBytes !== prior.sourceArchiveBytes
      || manifest.archiveSha256 !== prior.checkpointDigest || manifest.archiveBytes !== prior.checkpointBytes
      || manifest.runtime !== prior.workspaceRuntime || manifest.lockfileDigest !== prior.workspaceLockfileDigest
      || manifest.template !== prior.workspaceTemplate
      || manifest.attemptKey !== `${String(a.jobId)}:${prior.attempt}`
      || manifest.causationId !== `${String(prior.workerRunId)}:${prior.attempt}`
      || prior.checkpointRef !== `sandbox-checkpoints/sha256/${prior.checkpointDigest}`) {
      return { disposition: "reject" as const, reason: "checkpoint_manifest_tampered" };
    }
    const mismatch = manifest.provider !== a.providerName ? "provider_changed"
      : manifest.baseSha !== a.baseSha ? "base_changed"
        : manifest.sourceArchiveSha256 !== a.sourceArchiveDigest || manifest.sourceArchiveBytes !== a.sourceArchiveBytes ? "source_archive_changed"
          : manifest.runtime !== a.runtime ? "runtime_changed"
            : manifest.lockfileDigest !== a.lockfileDigest ? "lockfile_changed"
              : manifest.template !== a.template ? "template_changed" : null;
    if (mismatch) return { disposition: "hydrate" as const, reason: mismatch };
    return {
      disposition: "replay" as const, reason: "compatible_checkpoint",
      sourceAttempt: prior.attempt,
      checkpointRef: prior.checkpointRef, checkpointDigest: prior.checkpointDigest,
      checkpointBytes: prior.checkpointBytes, checkpointManifest: prior.checkpointManifest,
      checkpointManifestDigest: prior.checkpointManifestDigest,
    };
  },
});

export const recordCloudReplayDecision = mutation({
  args: {
    jobId: v.id("jobs"), expectedAttempt: v.number(), workerRunId: v.string(),
    // Optional only for staged compatibility with Trigger workers deployed
    // before attempt authority was forwarded. Missing/unbound authority is
    // rejected below before any durable evidence mutation.
    authorityDigest: v.optional(v.string()),
    disposition: v.union(v.literal("replay"), v.literal("hydrate"), v.literal("reject")),
    reason: v.string(), workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const row = await ctx.db.get(a.jobId);
    const attempt = await attemptFor(ctx, a.jobId, a.expectedAttempt);
    if (!row || row.admissionProtocolVersion !== 2
      || row.status !== "running" || (row.attempt ?? 1) !== a.expectedAttempt
      || row.workerRunId !== a.workerRunId || !attempt || attempt.status !== "running"
      || !await attemptExecutionAuthorityFor(ctx, row, a.expectedAttempt, a.authorityDigest)
      || !/^[a-z_]{1,80}$/.test(a.reason)) return false;
    await appendAttemptEvidence(ctx, row, "cloud_checkpoint_replay", `${a.disposition}: ${a.reason}`, {
      stage: "starting", evidenceKind: "checkpoint",
      eventKey: `cloud-replay:${a.expectedAttempt}:${a.disposition}:${a.reason}`,
      data: { disposition: a.disposition, reason: a.reason },
    });
    return true;
  },
});

export const cloudWorkspaceOrphans = query({
  args: { olderThan: v.number(), workerToken: v.optional(v.string()) },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const now = Date.now();
    const markedPages = await Promise.all(TERMINAL_CLOUD_WORKSPACE_STATUSES.map(async (status) =>
      await ctx.db.query("workAttempts")
        .withIndex("by_cloud_workspace_cleanup_status", (q: any) => q
          .eq("cloudWorkspaceCleanupEligible", true)
          .eq("status", status)
          .eq("providerTerminatedAt", undefined)
          .lte("cleanupNextRetryAt", now))
        .filter((q: any) => q.and(
          q.lte(q.field("progressAt"), a.olderThan),
          q.neq(q.field("providerName"), undefined),
          q.neq(q.field("providerWorkspaceId"), undefined),
          q.neq(q.field("providerSessionId"), undefined),
        ))
        .take(CLOUD_WORKSPACE_ORPHAN_PER_STATUS_LIMIT),
    ));
    // Pre-marker attempts are limited to the historical provider names and
    // migrate into the indexed lane on their first failed cleanup. This keeps
    // old stranded workspaces recoverable without allowing ordinary terminal
    // workAttempts to consume the cleanup read budget.
    const legacyPages = await Promise.all(CLOUD_WORKSPACE_PROVIDER_NAMES.map(async (providerName) =>
      await ctx.db.query("workAttempts")
        .withIndex("by_provider_termination_cleanup_retry", (q: any) => q
          .eq("providerName", providerName)
          .eq("providerTerminatedAt", undefined)
          .lte("cleanupNextRetryAt", now))
        .filter((q: any) => q.and(
          q.eq(q.field("cloudWorkspaceCleanupEligible"), undefined),
          q.lte(q.field("progressAt"), a.olderThan),
          q.neq(q.field("providerWorkspaceId"), undefined),
          q.neq(q.field("providerSessionId"), undefined),
          q.or(...TERMINAL_CLOUD_WORKSPACE_STATUSES.map((status) => q.eq(q.field("status"), status))),
        ))
        .take(CLOUD_WORKSPACE_LEGACY_PER_PROVIDER_LIMIT),
    ));
    const rows = [...markedPages.flat(), ...legacyPages.flat()];
    return [...new Map(rows.map((row: any) => [String(row._id), row])).values()]
      .sort((left: any, right: any) =>
        Number(left.cleanupNextRetryAt ?? left.progressAt) - Number(right.cleanupNextRetryAt ?? right.progressAt))
      .slice(0, CLOUD_WORKSPACE_ORPHAN_LIMIT)
      .map((row) => ({
        jobId: row.jobId, attempt: row.attempt, providerName: row.providerName,
        providerWorkspaceId: row.providerWorkspaceId, providerSessionId: row.providerSessionId,
      }));
  },
});

export const markCloudWorkspaceTerminated = mutation({
  args: {
    jobId: v.id("jobs"), expectedAttempt: v.number(), providerWorkspaceId: v.string(),
    providerSessionId: v.string(), workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const attempt = await attemptFor(ctx, a.jobId, a.expectedAttempt);
    if (!attempt || attempt.providerWorkspaceId !== a.providerWorkspaceId || attempt.providerSessionId !== a.providerSessionId) return false;
    const now = Date.now();
    await ctx.db.patch(attempt._id, {
      providerTerminatedAt: now,
      cloudWorkspaceCleanupEligible: undefined,
      cleanupAttempts: undefined,
      cleanupNextRetryAt: undefined,
      lastEventAt: now,
    });
    const fingerprint = `cloud-cleanup-blocked:${String(a.jobId)}:${a.expectedAttempt}:${a.providerWorkspaceId.slice(0, 80)}`;
    const attention = await ctx.db.query("attentionItems")
      .withIndex("by_fingerprint", (q: any) => q.eq("fingerprint", fingerprint)).first();
    if (attention && attention.status !== "resolved" && attention.status !== "dismissed") {
      await ctx.db.patch(attention._id, { status: "resolved", updatedAt: now });
    }
    return true;
  },
});

export const noteCloudWorkspaceCleanupBlocked = mutation({
  args: {
    jobId: v.id("jobs"), expectedAttempt: v.number(), providerWorkspaceId: v.string(),
    providerSessionId: v.string(), code: v.string(), reason: v.string(), workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const attempt = await attemptFor(ctx, a.jobId, a.expectedAttempt);
    if (!attempt || attempt.providerWorkspaceId !== a.providerWorkspaceId
      || attempt.providerSessionId !== a.providerSessionId || attempt.providerTerminatedAt) return false;
    const now = Date.now();
    const cleanupAttempts = Math.max(0, Math.floor(attempt.cleanupAttempts ?? 0)) + 1;
    const cleanupRetryDelay = Math.min(
      CLOUD_WORKSPACE_CLEANUP_RETRY_MAX_MS,
      CLOUD_WORKSPACE_CLEANUP_RETRY_BASE_MS * 2 ** Math.min(cleanupAttempts - 1, 5),
    );
    const reason = redactSensitiveText(a.reason).slice(0, 500);
    await ctx.db.patch(attempt._id, {
      cloudWorkspaceCleanupEligible: true,
      cleanupAttempts,
      cleanupNextRetryAt: now + cleanupRetryDelay,
      cleanupBlockedCode: a.code.slice(0, 80),
      cleanupBlockedReason: reason,
      cleanupBlockedAt: now, lastEventAt: now,
    });
    const fingerprint = `cloud-cleanup-blocked:${String(a.jobId)}:${a.expectedAttempt}:${a.providerWorkspaceId.slice(0, 80)}`;
    const existing = await ctx.db.query("attentionItems")
      .withIndex("by_fingerprint", (q: any) => q.eq("fingerprint", fingerprint)).first();
    const item = {
      fingerprint,
      title: `Cloud workspace cleanup blocked · ${String(attempt.providerName ?? "historical provider")}`.slice(0, 140),
      detail: reason,
      evidence: [`Job ${String(a.jobId)}`, `Attempt ${a.expectedAttempt}`, `Code ${a.code.slice(0, 80)}`],
      severity: "warning", impact: 70, urgency: 55, confidence: 1,
      actionClass: "ask", authority: "provider-cleanup", status: "open",
      jobId: String(a.jobId), updatedAt: now,
    };
    if (existing) await ctx.db.patch(existing._id, item);
    else await ctx.db.insert("attentionItems", { ...item, createdAt: now });
    return true;
  },
});

// Cold receipt access is worker-only and returns exactly the immutable record
// named by the compact claim pointer. It is never part of an agent prompt or
// sandbox configuration.
export const reviewReceipt = query({
  args: { jobId: v.id("jobs"), expectedAttempt: v.number(), reviewReceiptId: v.id("reviewReceipts"), workerToken: v.optional(v.string()) },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const row: any = await ctx.db.get(a.jobId);
    if (!row || (row.attempt ?? 1) !== a.expectedAttempt || row.reviewReceiptId !== a.reviewReceiptId) return null;
    const authority = await readAttemptExecutionAuthority(ctx, row, a.expectedAttempt);
    if (!authority) return null;
    const receipt: any = await ctx.db.get(a.reviewReceiptId);
    if (!receipt || receipt.jobId !== a.jobId || receipt.attempt !== a.expectedAttempt
      || receipt.receiptDigest !== row.reviewReceiptDigest
      || receipt.authorityDigest !== authority.authorityDigest
      || receipt.workOrderRevisionDigest !== authority.workOrderRevisionDigest) return null;
    return { ...receipt, keyId: receipt.keyId ?? "legacy-v1" };
  },
});

export const requestInput = mutation({
  args: {
    jobId: v.id("jobs"),
    expectedAttempt: v.number(),
    authorityDigest: v.optional(v.string()),
    workerRunId: v.optional(v.string()),
    question: v.string(),
    checkpoint: v.optional(v.string()),
    controllerSessionHoldCode: v.optional(v.string()),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const row = await ctx.db.get(a.jobId);
    if (!row || row.status !== "running" || (row.attempt ?? 1) !== a.expectedAttempt) return false;
    // A live production attempt is bound to one claimed dispatch. Do not let
    // another shared worker capability stop it or leave its dispatch receipt
    // permanently claimed. Legacy rows without a worker identity retain the
    // old migration-compatible path.
    const liveDispatch = typeof row.workerRunId === "string";
    const suppliedFence =
      a.authorityDigest !== undefined || a.workerRunId !== undefined;
    if (
      (liveDispatch && !suppliedFence)
      || (
        suppliedFence
        && (
          typeof a.authorityDigest !== "string"
          || typeof a.workerRunId !== "string"
          || a.workerRunId !== row.workerRunId
          || !await attemptExecutionAuthorityFor(
            ctx,
            row,
            a.expectedAttempt,
            a.authorityDigest,
          )
          || !await claimedDispatchReceiptForRow(ctx, row, a.workerRunId)
        )
      )
    ) return false;
    const now = Date.now();
    if (a.controllerSessionHoldCode !== undefined && !isCodexSessionUnavailableCode(a.controllerSessionHoldCode)) {
      throw new Error("Invalid controller-session hold code");
    }
    const controllerSessionRepairGeneration = a.controllerSessionHoldCode !== undefined
      ? await currentControllerSessionRepairGeneration(ctx)
      : undefined;
    const attempt = await attemptFor(ctx, a.jobId, a.expectedAttempt);
    if (!attempt || attempt.status !== "running") return false;
    if (isSupervisorOwnedJob(row)) {
      await insertFreshTerminalWorkReceipt(ctx, row, a.expectedAttempt, {
        status: "needs_input",
        terminalCode: "agent_input_required",
        recoveryDisposition: "needs_input",
        acceptanceEvidence: [],
        artifacts: [
          `convex://jobs/${String(a.jobId)}/attempt/${a.expectedAttempt}/input`,
        ],
        verification: "needs_input",
        terminalEventKey: `needs-input:${a.expectedAttempt}`,
        result: a.question,
        evidence: a.checkpoint,
      }, now);
    }
    await ctx.db.patch(attempt._id, { status: "needs_input", completedAt: now, lastEventAt: now });
    await patchJobWithRuntime(ctx, row, {
      status: "needs_input",
      stage: "needs Daniel",
      progress: a.question.slice(0, 400),
      checkpoint: a.checkpoint?.slice(0, 6000) ?? row.checkpoint,
      controllerSessionHoldCode: a.controllerSessionHoldCode,
      controllerSessionRepairRequired: a.controllerSessionHoldCode !== undefined ? true : undefined,
      controllerSessionRepairGeneration,
      controllerSessionHoldAt: a.controllerSessionHoldCode !== undefined ? now : undefined,
      heartbeatAt: now,
    });
    if (
      liveDispatch
      && !await closeClaimedDispatchReceipt(
        ctx,
        row,
        a.workerRunId,
        "worker requested operator input",
        now,
      )
    ) {
      throw new Error("Failed to close the exact input-request dispatch receipt");
    }
    const fingerprint = `job-input:${a.jobId}`;
    const existing = await ctx.db
      .query("attentionItems")
      .withIndex("by_fingerprint", (q: any) => q.eq("fingerprint", fingerprint))
      .first();
    const item = {
      fingerprint,
      project: row.repo,
      title: `${row.agentId ?? "Agent"} needs your decision`,
      detail: a.question.slice(0, 2000),
      evidence: [`Job ${a.jobId}`, (row.label ?? row.task).slice(0, 300)],
      severity: "decision",
      impact: 75,
      urgency: 70,
      confidence: 1,
      actionClass: "ask",
      status: "open",
      jobId: String(a.jobId),
      updatedAt: now,
    };
    if (existing) await ctx.db.patch(existing._id, item);
    else await ctx.db.insert("attentionItems", { ...item, createdAt: now });
    await appendAttemptEvidence(ctx, row, "needs_input", a.question.slice(0, 1000), {
      stage: "needs Daniel", percent: row.percent, evidenceKind: "checkpoint", eventKey: `needs-input:${a.expectedAttempt}`,
    });
    return true;
  },
});

export const provideInput = mutation({
  args: { jobId: v.id("jobs"), answer: v.string(), authTokenHash: v.optional(v.string()), workerToken: v.optional(v.string()) },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const row = await ctx.db.get(a.jobId);
    if (!row || row.status !== "needs_input") return false;
    // Supervisor work is append-only once it asks for input. Daniel's answer
    // is consumed by a fenced supervisor recovery that creates a new job.
    // Fail closed even when the historical receipt is missing, duplicated, or
    // corrupt: receipt repair and successor creation are separate operations;
    // this legacy continuation must never revive the terminal row in place.
    if (isSupervisorOwnedJob(row)) return false;
    const now = Date.now();
    const previousAttempt = await attemptFor(ctx, a.jobId, row.attempt ?? 1);
    if (!previousAttempt || previousAttempt.status !== "needs_input") return false;
    // Close and journal the old lineage before allocating its continuation.
    await ctx.db.patch(previousAttempt._id, { status: "needs_input", completedAt: now, lastEventAt: now });
    await appendAttemptEvidence(ctx, row, "input_received", "Daniel supplied the required decision", {
      stage: "needs Daniel", evidenceKind: "control", eventKey: `input-received:${row.attempt ?? 1}`, attempt: row.attempt ?? 1,
    });
    const nextAttempt = (row.attempt ?? 1) + 1;
    await patchJobWithRuntime(ctx, row, {
      ...invalidateDeliveryLease(row),
      status: "pending",
      stage: "queued",
      progress: "Daniel answered — continuation queued",
      percent: 0,
      checkpoint: `${row.checkpoint ?? ""}\n\nDaniel's answer: ${a.answer.slice(0, 2000)}`.trim(),
      attempt: nextAttempt,
      heartbeatAt: now,
      nextRunAt: now,
    });
    await ensureAttempt(ctx, a.jobId, nextAttempt, "pending", now);
    await appendAttemptEvidence(ctx, row, "queued", `Continuation attempt ${nextAttempt} queued after input`, {
      stage: "queued", evidenceKind: "intent", eventKey: `intent:${nextAttempt}`, attempt: nextAttempt,
    });
    const attention = await ctx.db
      .query("attentionItems")
      .withIndex("by_fingerprint", (q: any) => q.eq("fingerprint", `job-input:${a.jobId}`))
      .first();
    if (attention) await ctx.db.patch(attention._id, { status: "resolved", updatedAt: now });
    return true;
  },
});

// A provider write is legal only after this exact effect is durably prepared
// under the live controller fence. Replays return the same preparation; they
// cannot replace it with another PR/head/effect identity.
export const prepareDeliveryEffect = mutation({
  args: {
    jobId: v.id("jobs"), expectedAttempt: v.number(), authorityDigest: v.optional(v.string()), deliveryAttemptId: v.id("deliveryAttempts"),
    sourceWorkAttempt: v.number(), deliveryGeneration: v.number(), deliveryRunId: v.string(),
    deliveryLeaseOwner: v.string(), deliveryLeaseToken: v.string(), deliveryLeaseVersion: v.number(),
    effectId: v.string(), effectKind: v.union(v.literal("create_draft_pr"), v.literal("create_pr"), v.literal("promote_pr"), v.literal("merge_pr")),
    reviewedHeadSha: v.string(), reviewedBaseSha: v.string(), pullRequestNumber: v.optional(v.number()),
    reconcileOnly: v.optional(v.boolean()),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const row: any = await ctx.db.get(a.jobId);
    const delivery: any = await ctx.db.get(a.deliveryAttemptId);
    if (!row || row.status !== "running" || (row.attempt ?? 1) !== a.expectedAttempt
      || !await attemptExecutionAuthorityFor(ctx, row, a.expectedAttempt, a.authorityDigest)
      || !hasLiveControllerFence(row, delivery, a) || delivery.status !== "running") return null;
    if (a.reviewedHeadSha !== delivery.reviewedHeadSha || a.reviewedBaseSha !== delivery.reviewedBaseSha) return null;
    if (delivery.policy === "read_only") return null;
    if (delivery.policy === "manual" && a.effectKind !== "create_draft_pr") return null;
    if (delivery.policy === "auto_merge" && !["create_pr", "promote_pr", "merge_pr"].includes(a.effectKind)) return null;
    if (a.effectKind === "merge_pr" && (!a.pullRequestNumber || delivery.pullRequestNumber !== a.pullRequestNumber)) return null;
    const prior = (delivery.effects ?? []).find((effect: any) => effect.effectId === a.effectId);
    if (prior) {
      if (prior.effectKind !== a.effectKind || prior.reviewedHeadSha !== a.reviewedHeadSha
        || prior.reviewedBaseSha !== a.reviewedBaseSha
        || Number(prior.pullRequestNumber ?? 0) !== Number(a.pullRequestNumber ?? 0)) return null;
      await ctx.db.patch(delivery._id, {
        preparedEffectId: prior.effectId, preparedEffectKind: prior.effectKind,
        preparedEffectAt: prior.preparedAt, providerObservation: prior.observation,
        providerObservedAt: prior.observedAt, currentStep: "prepared",
        heartbeatAt: Date.now(), updatedAt: Date.now(),
      });
      return { effectId: prior.effectId, replay: true, observation: prior.observation ?? null };
    }
    if (a.reconcileOnly || (delivery.preparedEffectId && !delivery.providerObservation)) return null;
    const now = Date.now();
    await ctx.db.patch(delivery._id, {
      preparedEffectId: a.effectId.slice(0, 160), preparedEffectKind: a.effectKind,
      preparedEffectAt: now, providerObservation: undefined, providerObservedAt: undefined,
      currentStep: "prepared", heartbeatAt: now, updatedAt: now,
      effects: [...(delivery.effects ?? []), {
        effectId: a.effectId.slice(0, 160), effectKind: a.effectKind, preparedAt: now,
        reviewedHeadSha: a.reviewedHeadSha, reviewedBaseSha: a.reviewedBaseSha,
        pullRequestNumber: a.pullRequestNumber,
      }],
    });
    return { effectId: a.effectId.slice(0, 160), replay: false };
  },
});

export const observeDeliveryEffect = mutation({
  args: {
    jobId: v.id("jobs"), expectedAttempt: v.number(), authorityDigest: v.optional(v.string()), deliveryAttemptId: v.id("deliveryAttempts"),
    sourceWorkAttempt: v.number(), deliveryGeneration: v.number(), deliveryRunId: v.string(),
    deliveryLeaseOwner: v.string(), deliveryLeaseToken: v.string(), deliveryLeaseVersion: v.number(),
    effectId: v.string(), observation: v.union(v.literal("applied"), v.literal("not_applied"), v.literal("unknown")),
    pullRequestNumber: v.optional(v.number()), pullRequestUrl: v.optional(v.string()),
    pullRequestNodeId: v.optional(v.string()), pullRequestDraft: v.optional(v.boolean()),
    observedPullRequestHead: v.optional(v.string()), observedPullRequestBase: v.optional(v.string()),
    mergeCommitSha: v.optional(v.string()),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const row: any = await ctx.db.get(a.jobId);
    const delivery: any = await ctx.db.get(a.deliveryAttemptId);
    if (!row || !delivery || row.status !== "running" || delivery.status !== "running"
      || !await attemptExecutionAuthorityFor(ctx, row, a.expectedAttempt, a.authorityDigest)
      || !hasLiveControllerFence(row, delivery, a) || delivery.preparedEffectId !== a.effectId) return false;
    if (a.observedPullRequestHead && a.observedPullRequestHead !== delivery.reviewedHeadSha) return false;
    if (a.observedPullRequestBase && a.observedPullRequestBase !== delivery.reviewedBaseSha) return false;
    const now = Date.now();
    const effects = [...(delivery.effects ?? [])];
    const effectIndex = effects.findIndex((effect: any) => effect.effectId === a.effectId);
    if (effectIndex < 0) return false;
    const prepared = effects[effectIndex];
    if (a.observation === "applied") {
      if (!a.pullRequestNumber || !a.pullRequestUrl || !a.pullRequestNodeId
        || typeof a.pullRequestDraft !== "boolean"
        || a.observedPullRequestHead !== delivery.reviewedHeadSha
        || a.observedPullRequestBase !== delivery.reviewedBaseSha) return false;
      if (prepared.pullRequestNumber && prepared.pullRequestNumber !== a.pullRequestNumber) return false;
      if (prepared.effectKind === "create_draft_pr" && a.pullRequestDraft !== true) return false;
      if (["create_pr", "promote_pr", "merge_pr"].includes(prepared.effectKind) && a.pullRequestDraft !== false) return false;
      if (prepared.effectKind === "merge_pr" && !a.mergeCommitSha) return false;
    }
    effects[effectIndex] = {
      ...prepared, observation: a.observation, observedAt: now,
      pullRequestNumber: a.pullRequestNumber ?? prepared.pullRequestNumber,
      pullRequestUrl: a.pullRequestUrl, pullRequestNodeId: a.pullRequestNodeId,
      pullRequestDraft: a.pullRequestDraft, observedPullRequestHead: a.observedPullRequestHead,
      observedPullRequestBase: a.observedPullRequestBase, mergeCommitSha: a.mergeCommitSha,
    };
    await ctx.db.patch(delivery._id, {
      providerObservation: a.observation, providerObservedAt: now,
      pullRequestNumber: a.pullRequestNumber ?? delivery.pullRequestNumber,
      pullRequestUrl: a.pullRequestUrl ?? delivery.pullRequestUrl,
      pullRequestNodeId: a.pullRequestNodeId ?? delivery.pullRequestNodeId,
      pullRequestDraft: a.pullRequestDraft ?? delivery.pullRequestDraft,
      observedPullRequestHead: a.observedPullRequestHead ?? delivery.observedPullRequestHead,
      observedPullRequestBase: a.observedPullRequestBase ?? delivery.observedPullRequestBase,
      mergeCommitSha: a.mergeCommitSha ?? delivery.mergeCommitSha,
      currentStep: "observing", heartbeatAt: now, updatedAt: now,
      effects,
    });
    return true;
  },
});

export const setDelivery = mutation({
  args: {
    jobId: v.id("jobs"),
    expectedAttempt: v.number(),
    authorityDigest: v.optional(v.string()),
    branch: v.optional(v.string()),
    pullRequestUrl: v.optional(v.string()),
    deliveryStatus: v.optional(v.union(
      v.literal("branch"),
      v.literal("pull_request"),
      v.literal("merged"),
      v.literal("blocked"),
    )),
    mergeCommitSha: v.optional(v.string()),
    observedPullRequestHead: v.optional(v.string()),
    observedPullRequestBase: v.optional(v.string()),
    pullRequestNumber: v.optional(v.number()),
    pullRequestNodeId: v.optional(v.string()),
    pullRequestDraft: v.optional(v.boolean()),
    outcome: v.optional(v.union(
      v.literal("protected_draft"), v.literal("read_only_complete"), v.literal("no_change"),
      v.literal("merged"), v.literal("blocked"), v.literal("needs_attention"),
    )),
    providerCall: v.optional(v.boolean()),
    deliveryAttemptId: v.optional(v.id("deliveryAttempts")),
    deliveryLeaseOwner: v.optional(v.string()),
    deliveryLeaseToken: v.optional(v.string()),
    deliveryLeaseVersion: v.optional(v.number()),
    sourceWorkAttempt: v.optional(v.number()),
    deliveryGeneration: v.optional(v.number()),
    deliveryRunId: v.optional(v.string()),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const row = await ctx.db.get(a.jobId);
    if (!row || row.status !== "running" || (row.attempt ?? 1) !== a.expectedAttempt
      || !await attemptExecutionAuthorityFor(ctx, row, a.expectedAttempt, a.authorityDigest)) return false;
    if (!hasLiveDeliveryLease(row, a)) return false;
    const delivery = a.deliveryGeneration === undefined ? null : await deliveryAttemptFor(ctx, a.jobId, Number(a.sourceWorkAttempt), Number(a.deliveryGeneration));
    if (!delivery || !hasLiveControllerFence(row, delivery, a)) return false;
    const policy = String(delivery.policy);
    if ((policy === "manual" && a.deliveryStatus === "merged")
      || (policy === "read_only" && (a.providerCall === true || a.deliveryStatus === "merged" || a.pullRequestUrl))
      || (a.deliveryStatus === "merged" && policy !== "auto_merge")) return false;
    if (a.observedPullRequestHead && a.observedPullRequestHead !== delivery.reviewedHeadSha && a.outcome !== "needs_attention") return false;
    if (a.observedPullRequestBase && a.observedPullRequestBase !== delivery.reviewedBaseSha && a.outcome !== "needs_attention") return false;
    if (a.outcome && !outcomeAllowed(policy, a.outcome)) return false;
    if (a.outcome === "protected_draft" && (!a.pullRequestNumber || !a.pullRequestUrl || a.pullRequestDraft !== true
      || !a.pullRequestNodeId || a.observedPullRequestHead !== delivery.reviewedHeadSha
      || a.observedPullRequestBase !== delivery.reviewedBaseSha)) return false;
    if (a.outcome === "read_only_complete" && (a.providerCall || a.pullRequestNumber || a.pullRequestUrl)) return false;
    if (a.outcome === "merged" && (!a.mergeCommitSha || a.deliveryStatus !== "merged" || a.pullRequestDraft !== false)) return false;
    const providerBacked = a.providerCall === true || a.outcome === "protected_draft" || a.outcome === "merged"
      || a.deliveryStatus === "pull_request" || a.deliveryStatus === "merged";
    if (providerBacked) {
      const kinds = a.deliveryStatus === "merged" || a.outcome === "merged"
        ? ["merge_pr"]
        : policy === "manual" ? ["create_draft_pr"] : ["create_pr", "promote_pr"];
      const applied = matchingAppliedEffect(delivery, kinds, a);
      if (!applied) return false;
      if (a.pullRequestNumber !== applied.pullRequestNumber || a.pullRequestUrl !== applied.pullRequestUrl
        || a.pullRequestNodeId !== applied.pullRequestNodeId || a.pullRequestDraft !== applied.pullRequestDraft
        || a.observedPullRequestHead !== applied.observedPullRequestHead
        || a.observedPullRequestBase !== applied.observedPullRequestBase) return false;
      if (a.deliveryStatus === "merged" && a.mergeCommitSha !== applied.mergeCommitSha) return false;
    }
    await patchJobWithRuntime(ctx, row, {
      branch: a.branch,
      pullRequestUrl: a.pullRequestUrl,
      deliveryStatus: a.deliveryStatus,
      mergeCommitSha: a.mergeCommitSha?.slice(0, 80),
      mergedAt: a.deliveryStatus === "merged" ? Date.now() : undefined,
      heartbeatAt: Date.now(),
    });
    await ctx.db.patch(delivery._id, {
      observedPullRequestHead: a.observedPullRequestHead ?? delivery.observedPullRequestHead,
      observedPullRequestBase: a.observedPullRequestBase ?? delivery.observedPullRequestBase,
      pullRequestNumber: a.pullRequestNumber ?? delivery.pullRequestNumber,
      pullRequestUrl: a.pullRequestUrl ?? delivery.pullRequestUrl,
      pullRequestNodeId: a.pullRequestNodeId ?? delivery.pullRequestNodeId,
      pullRequestDraft: a.pullRequestDraft ?? delivery.pullRequestDraft,
      mergeCommitSha: a.mergeCommitSha ?? delivery.mergeCommitSha,
      outcome: a.outcome ?? delivery.outcome,
      currentStep: a.outcome ? "receipt" : a.deliveryStatus === "pull_request" ? "preflight" : "preflight",
      heartbeatAt: Date.now(), updatedAt: Date.now(),
    });
    if (a.outcome === "needs_attention") await openStaleReviewAttention(ctx, row, Date.now());
    return true;
  },
});

// Convex is the delivery linearization point. The controller acquires this
// immediately before a push, PR, merge, receipt or finalization; control can
// still arrive during an in-flight external call, so the following durable
// writer rechecks status/attempt and never resurrects the old lease.
export const linearizeDelivery = mutation({
  args: {
    jobId: v.id("jobs"), expectedAttempt: v.number(), authorityDigest: v.optional(v.string()), deliveryLeaseOwner: v.string(), deliveryLeaseToken: v.string(),
    deliveryLeaseVersion: v.optional(v.number()), workerToken: v.optional(v.string()),
    sourceWorkAttempt: v.optional(v.number()), deliveryGeneration: v.optional(v.number()), deliveryRunId: v.optional(v.string()), deliveryAttemptId: v.optional(v.id("deliveryAttempts")),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const row = await ctx.db.get(a.jobId);
    if (!row || row.status !== "running" || (row.attempt ?? 1) !== a.expectedAttempt
      || !await attemptExecutionAuthorityFor(ctx, row, a.expectedAttempt, a.authorityDigest)) return null;
    const deliveryAttempt = a.deliveryGeneration === undefined ? null : await deliveryAttemptFor(
      ctx, a.jobId, Number(a.sourceWorkAttempt), Number(a.deliveryGeneration),
    );
    if (a.deliveryGeneration !== undefined && !deliveryClaimMatches(row, deliveryAttempt, a)) return null;
    const now = Date.now();
    if (deliveryAttempt?.integrationAttemptId) {
      const integration: any = await ctx.db.get(deliveryAttempt.integrationAttemptId);
      const mission: any = integration ? await ctx.db.get(integration.missionId) : null;
      if (!integration || !mission || integration.controllerRunId !== deliveryAttempt.deliveryRunId
        || Number(integration.leaseUntil ?? 0) < now || Number(integration.controllerDeadlineAt ?? 0) <= now
        || integration.controlRequested || mission.activeIntegrationAttemptId !== integration._id
        || mission.integrationLeaseOwner !== integration.leaseOwner
        || mission.integrationLeaseToken !== integration.leaseToken
        || Number(mission.integrationLeaseVersion) !== Number(integration.leaseVersion)) return null;
    }
    const sameOwner = row.deliveryLeaseOwner === a.deliveryLeaseOwner && row.deliveryLeaseToken === a.deliveryLeaseToken;
    const requestedVersion = Number(a.deliveryLeaseVersion ?? 0);
    const live = sameOwner && Number(row.deliveryLeaseUntil ?? 0) >= now && requestedVersion === Number(row.deliveryLeaseVersion);
    if (row.deliveryLeaseUntil && Number(row.deliveryLeaseUntil) >= now && !live) return null;
    const version = live ? Number(row.deliveryLeaseVersion) : Math.max(0, Number(row.deliveryLeaseVersion ?? 0)) + 1;
    const until = now + DELIVERY_LEASE_MS;
    await patchJobWithRuntime(ctx, row, {
      deliveryLeaseVersion: version, deliveryLeaseOwner: a.deliveryLeaseOwner.slice(0, 120),
      deliveryLeaseToken: a.deliveryLeaseToken.slice(0, 160), deliveryLeaseUntil: until, heartbeatAt: now,
    });
    if (deliveryAttempt) await ctx.db.patch(deliveryAttempt._id, {
      leaseOwner: a.deliveryLeaseOwner.slice(0, 120), leaseToken: a.deliveryLeaseToken.slice(0, 160),
      leaseVersion: version, leaseUntil: until, heartbeatAt: now, updatedAt: now,
    });
    return { owner: a.deliveryLeaseOwner, token: a.deliveryLeaseToken, version, until };
  },
});

// Persist supervisor evidence before any GitHub delivery call. If checks take
// longer than one harness lease, the next attempt resumes the controller step
// directly instead of paying for (and risking divergence from) another model
// run over already verified code.
export const markVerifiedForDelivery = mutation({
  args: {
    jobId: v.id("jobs"),
    expectedAttempt: v.number(),
    authorityDigest: v.optional(v.string()),
    result: v.string(),
    verificationNote: v.string(),
    reviewReceiptJson: v.optional(v.string()),
    reviewReceiptSignature: v.optional(v.string()),
    reviewReceiptKeyId: v.optional(v.string()),
    reviewDiffSha256: v.optional(v.string()),
    resultDigest: v.optional(v.string()),
    evidenceDigest: v.optional(v.string()),
    deliveryLeaseOwner: v.optional(v.string()),
    deliveryLeaseToken: v.optional(v.string()),
    deliveryLeaseVersion: v.optional(v.number()),
    sourceWorkAttempt: v.optional(v.number()),
    deliveryGeneration: v.optional(v.number()),
    deliveryRunId: v.optional(v.string()),
    specialistRunId: v.string(),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const row = await ctx.db.get(a.jobId);
    if (!row || (row.attempt ?? 1) !== a.expectedAttempt) return false;
    const executionAuthority = await attemptExecutionAuthorityFor(ctx, row, a.expectedAttempt, a.authorityDigest);
    if (!executionAuthority) return false;
    const sourceAttempt = await attemptFor(ctx, a.jobId, a.expectedAttempt);
    if (!sourceAttempt || sourceAttempt.workerRunId !== a.specialistRunId || sourceAttempt.workerRunId !== row.workerRunId) {
      // A response-loss replay occurs after the job projection is moved to
      // pending, so the job no longer carries workerRunId. The immutable work
      // attempt remains the specialist authority in that exact case.
      if (!(row.status === "pending" && sourceAttempt?.workerRunId === a.specialistRunId && row.reviewReceiptId)) return false;
    }
    if (!['running', 'pending'].includes(row.status)) return false;
    const sourceDispatchReceipt = sourceAttempt?.dispatchReceiptId
      ? await ctx.db.get(sourceAttempt.dispatchReceiptId as Id<"dispatchReceipts">)
      : null;
    if (!sourceDispatchReceipt
      || sourceDispatchReceipt.status !== "claimed"
      || sourceDispatchReceipt.workerRunId !== a.specialistRunId
      || sourceDispatchReceipt.dispatchId !== sourceAttempt.dispatchId
      || sourceDispatchReceipt.receiptDigest !== sourceAttempt.dispatchReceiptDigest
      || sourceDispatchReceipt.payloadDigest !== sourceAttempt.dispatchPayloadDigest
      || (row.status === "running" && row.dispatchReceiptId !== sourceAttempt.dispatchReceiptId)) return false;
    if (a.deliveryGeneration !== undefined) return false;
    // A controller review receipt is completion evidence for every scoped
    // repository job. Delivery policy separately decides whether a PR/merge
    // may happen; manual and read-only work must still be able to finish.
    if (!row.repo) return false;
    if (!a.reviewReceiptJson || !isSha256Digest(a.reviewReceiptSignature) || !isSha256Digest(a.reviewDiffSha256)
      || !/^[a-zA-Z0-9._-]{1,64}$/.test(String(a.reviewReceiptKeyId ?? ""))) return false;
    if (a.reviewReceiptJson.length > REVIEW_RECEIPT_MAX_CHARS) return false;
    const result = a.result.slice(0, workResultMaxChars(row.goalStage));
    const verificationNote = a.verificationNote.slice(0, 1_000);
    if (a.resultDigest !== await sha256Hex(result) || a.evidenceDigest !== await sha256Hex(verificationNote)) return false;
    let receipt: any;
    try { receipt = JSON.parse(a.reviewReceiptJson); } catch { return false; }
    const assignedReviewBranch = String(row.workerBranch ?? row.branch ?? "");
    const readonlySourceBranch = row.readonly && !assignedReviewBranch
      ? String(row.sourceBranch ?? "")
      : "";
    const receiptBranch = String(receipt?.branch ?? "");
    const reviewBranchMatches = receiptBranch === assignedReviewBranch
      || (
        row.readonly
        && !assignedReviewBranch
        && (receiptBranch === readonlySourceBranch || receiptBranch === "")
      );
    const reviewedBranch = receiptBranch;
    if (
      receipt?.jobId !== String(a.jobId)
      || Number(receipt?.attempt) !== a.expectedAttempt
      || receipt?.workOrderRevisionDigest !== executionAuthority.workOrderRevisionDigest
      || receipt?.repository !== row.repo
      || !reviewBranchMatches
      || receipt?.diffSha256 !== a.reviewDiffSha256
      || !/^[0-9a-f]{40,64}$/i.test(String(receipt?.baseSha ?? ""))
      || !/^[0-9a-f]{40,64}$/i.test(String(receipt?.baseTreeSha ?? ""))
      || !/^[0-9a-f]{40,64}$/i.test(String(receipt?.headSha ?? ""))
      || !/^[0-9a-f]{40,64}$/i.test(String(receipt?.headTreeSha ?? ""))
      || !isSha256Digest(receipt?.agentEvidenceSha256)
    ) return false;
    const missionWritable = Boolean(row.missionId && !row.readonly && ["building", "refining"].includes(String(row.goalStage)));
    if (missionWritable && (!GIT_OID.test(String(row.sourceHeadSha ?? "")) || receipt.baseSha !== row.sourceHeadSha)) return false;
    const receiptJson = a.reviewReceiptJson;
    const receiptDigest = await sha256Hex(receiptJson);
    if (row.status === "pending") {
      const prior: any = row.reviewReceiptId ? await ctx.db.get(row.reviewReceiptId) : null;
      return Boolean(prior && prior.receiptDigest === receiptDigest && prior.signature === a.reviewReceiptSignature
        && prior.keyId === a.reviewReceiptKeyId && row.reviewReceiptDigest === receiptDigest
        && prior.authorityDigest === executionAuthority.authorityDigest
        && prior.workOrderRevisionDigest === executionAuthority.workOrderRevisionDigest);
    }
    const existing = await ctx.db.query("reviewReceipts")
      .withIndex("by_job_attempt_digest", (q: any) => q.eq("jobId", a.jobId).eq("attempt", a.expectedAttempt).eq("receiptDigest", receiptDigest)).first();
    if (existing && (existing.authorityDigest !== executionAuthority.authorityDigest
      || existing.workOrderRevisionDigest !== executionAuthority.workOrderRevisionDigest)) return false;
    const reviewReceiptId = existing?._id ?? await ctx.db.insert("reviewReceipts", {
      jobId: a.jobId, attempt: a.expectedAttempt, repository: String(row.repo), receiptJson, receiptDigest,
      authorityDigest: executionAuthority.authorityDigest,
      schedulingBindingDigest: executionAuthority.schedulingBindingDigest,
      workOrderRevisionId: executionAuthority.workOrderRevisionId,
      workOrderRevision: executionAuthority.workOrderRevision,
      workOrderRevisionDigest: executionAuthority.workOrderRevisionDigest,
      canonicalProjectId: executionAuthority.canonicalProjectId,
      signature: a.reviewReceiptSignature, diffSha256: a.reviewDiffSha256,
      keyId: a.reviewReceiptKeyId,
      workerBranch: reviewedBranch,
      sourceBranch: row.sourceBranch,
      workspaceLineage: row.workspaceLineage,
      retryLineage: row.retryLineage,
      baseSha: String(receipt.baseSha), headSha: String(receipt.headSha), baseTreeSha: String(receipt.baseTreeSha), headTreeSha: String(receipt.headTreeSha),
      agentEvidenceSha256: String(receipt.agentEvidenceSha256), createdAt: Date.now(),
    });
    const now = Date.now();
    // Review is the phase boundary.  Persist the immutable cold receipt and
    // allocate exactly one queued controller generation before the specialist
    // exits.  The first GitHub effect can therefore never be untracked.
    const integration = await queueReviewedIntegration(ctx, row, receipt, reviewReceiptId, receiptDigest);
    if (row.missionId && !row.readonly && ["building", "refining"].includes(String(row.goalStage)) && !integration) return false;
    const generation = Math.max(1, Number(row.deliveryGeneration ?? 0) || 1);
    const existingDelivery = await deliveryAttemptFor(ctx, a.jobId, a.expectedAttempt, generation);
    if (existingDelivery && (existingDelivery.reviewReceiptDigest && existingDelivery.reviewReceiptDigest !== receiptDigest
      || existingDelivery.authorityDigest !== executionAuthority.authorityDigest
      || existingDelivery.workOrderRevisionDigest !== executionAuthority.workOrderRevisionDigest)) return false;
    const deliveryAttemptId = existingDelivery?._id ?? await ctx.db.insert("deliveryAttempts", {
      jobId: a.jobId,
      authorityDigest: executionAuthority.authorityDigest,
      schedulingBindingDigest: executionAuthority.schedulingBindingDigest,
      workOrderRevisionId: executionAuthority.workOrderRevisionId,
      workOrderRevision: executionAuthority.workOrderRevision,
      workOrderRevisionDigest: executionAuthority.workOrderRevisionDigest,
      canonicalProjectId: executionAuthority.canonicalProjectId,
      repository: executionAuthority.repository,
      missionGroupId: executionAuthority.missionGroupId,
      sourceWorkAttempt: a.expectedAttempt,
      generation,
      policy: integration ? "mission_integration" : String(row.deliveryMode ?? (row.readonly ? "read_only" : "manual")),
      status: "checkpointed",
      reviewReceiptId,
      reviewReceiptDigest: receiptDigest,
      integrationAttemptId: integration?._id,
      reviewKeyId: a.reviewReceiptKeyId,
      reviewLineage: [{ sourceWorkAttempt: a.expectedAttempt, reviewReceiptId, reviewReceiptDigest: receiptDigest, keyId: a.reviewReceiptKeyId }],
      reviewedHeadSha: String(receipt.headSha),
      reviewedBaseSha: String(receipt.baseSha),
      reviewedHeadTreeSha: String(receipt.headTreeSha),
      reviewedDiffSha256: a.reviewDiffSha256,
      heartbeatAt: now,
      retries: 0,
      cumulativeRetries: 0,
      currentStep: "queued",
      createdAt: now,
      updatedAt: now,
    });
    if (existingDelivery) await ctx.db.patch(existingDelivery._id, {
      status: "checkpointed", reviewReceiptId, reviewReceiptDigest: receiptDigest,
      integrationAttemptId: integration?._id,
      reviewKeyId: a.reviewReceiptKeyId,
      reviewedHeadSha: String(receipt.headSha), reviewedBaseSha: String(receipt.baseSha),
      reviewedHeadTreeSha: String(receipt.headTreeSha), reviewedDiffSha256: a.reviewDiffSha256,
      currentStep: "queued", heartbeatAt: now, updatedAt: now,
    });
    if (sourceAttempt && !sourceAttempt.completedAt) await ctx.db.patch(sourceAttempt._id, {
      status: "done", completedAt: now, lastEventAt: now,
    });
    await patchJobWithRuntime(ctx, row, {
      result,
      verificationVerdict: "pass",
      verificationNote,
      verifiedAt: now,
      // A controller-only Trigger run will claim this cold receipt.  Do not
      // keep the reviewing specialist alive through provider effects.
      status: "pending",
      stage: "delivery",
      progress: "supervisor passed — controller delivery queued",
      percent: Math.max(96, row.percent ?? 0),
      heartbeatAt: now,
      reviewReceiptJson: undefined,
      reviewReceiptSignature: a.reviewReceiptSignature,
      reviewReceiptId,
      reviewReceiptDigest: receiptDigest,
      integrationAttemptId: integration?._id,
      integrationState: integration ? String(integration.status) : row.integrationState,
      evidenceSummary: `signed review ${receiptDigest.slice(0, 12)} queued`,
      activeDeliveryAttemptId: deliveryAttemptId,
      deliveryGeneration: generation,
      deliveryRunId: undefined,
      dispatchId: undefined,
      dispatchLeaseUntil: undefined,
      workerRunId: undefined,
      deliveryLeaseUntil: undefined,
      deliveryLeaseOwner: undefined,
      deliveryLeaseToken: undefined,
      nextRunAt: integration && integration.status !== "queued" ? undefined : now,
    });
    await appendAttemptEvidence(ctx, row, "delivery_queued", "Supervisor receipt persisted; controller-only delivery queued", {
      stage: "delivery", evidenceKind: "delivery", eventKey: `delivery-queued:${a.expectedAttempt}:${generation}`, attempt: a.expectedAttempt,
    });
    return true;
  },
});

export const control = mutation({
  args: {
    jobId: v.id("jobs"),
    action: v.union(v.literal("pause"), v.literal("resume"), v.literal("cancel"), v.literal("retry"), v.literal("steer")),
    input: v.optional(v.string()),
    authTokenHash: v.optional(v.string()),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const row = await ctx.db.get(a.jobId);
    if (!row) return false;
    if (
      a.action === "cancel"
      && row.status === "cancelled"
      && !isSupervisorOwnedJob(row)
    ) {
      if (!row.dispatchId) {
        await resolveOpenJobAttention(ctx, a.jobId);
        return true;
      }
      const attempt = await attemptFor(ctx, a.jobId, row.attempt ?? 1);
      if (!attempt?.completedAt
        || (attempt.providerWorkspaceId && !attempt.providerTerminatedAt)
        || !await closeClaimedDispatchReceipt(
          ctx,
          row,
          row.deliveryRunId ?? row.workerRunId,
          "legacy goal cancellation already committed",
        )) return false;
      await patchJobWithRuntime(ctx, row, {
        dispatchId: undefined,
        dispatchLeaseUntil: undefined,
        workerRunId: undefined,
        deliveryRunId: undefined,
      });
      await resolveOpenJobAttention(ctx, a.jobId);
      return true;
    }
    if (
      a.action === "cancel"
      && row.status === "cancelled"
      && isSupervisorOwnedJob(row)
    ) {
      // Early protocol-2 operator cancellations sealed a canonical terminal
      // summary in the append-only receipt but left an older worker result on
      // the mutable job projection. Repeating the exact control is a bounded,
      // fail-closed repair: the receipt and execution authority must still be
      // unique and valid, and its digests must match values derivable from the
      // existing row. The immutable receipt is never edited.
      const exact = await exactTerminalWorkReceipt(ctx, row);
      const result = "Daniel cancelled the work.";
      const evidence = String(row.checkpoint ?? "").slice(0, 1_000);
      if (
        !exact
        || exact.receipt.terminalCode !== "operator_cancelled"
        || exact.receipt.recoveryDisposition !== "operator_stop"
        || exact.receipt.resultDigest !== await sha256Hex(result)
        || exact.receipt.evidenceDigest !== await sha256Hex(evidence)
      ) return false;
      if (row.dispatchId && !await closeOrConfirmDispatchReceiptForControl(
        ctx,
        row,
        row.deliveryRunId ?? row.workerRunId,
        "operator cancellation already committed",
      )) return false;
      if (row.result !== result || row.verificationNote !== evidence || row.dispatchId || row.workerRunId || row.deliveryRunId) {
        await patchJobWithRuntime(ctx, row, {
          result,
          verificationNote: evidence,
          dispatchId: undefined,
          dispatchLeaseUntil: undefined,
          workerRunId: undefined,
          deliveryRunId: undefined,
        });
      }
      await resolveOpenJobAttention(ctx, a.jobId);
      return true;
    }
    const wouldResurrectSupervisorTerminal =
      isSupervisorOwnedJob(row)
      && (
        (a.action === "retry" && ["error", "cancelled"].includes(row.status))
        || (a.action === "resume" && ["needs_input", "stalled"].includes(row.status))
        || (a.action === "steer" && row.status === "stalled")
        || (a.action === "cancel" && row.status === "needs_input")
      );
    if (wouldResurrectSupervisorTerminal) {
      // Recovery of a supervisor-owned terminal leaf is append-only and goes
      // through missionSupervisor:commitV1, which creates a receipt-fenced
      // successor. Missing, ambiguous, and corrupt receipts fail closed here;
      // Goal Mode and other legacy jobs retain their in-place controls.
      return false;
    }
    const now = Date.now();
    let controlEventEmitted = false;
    const closeAttempt = async (status: string) => {
      const attempt = await attemptFor(ctx, a.jobId, row.attempt ?? 1);
      if (attempt && !attempt.completedAt) await ctx.db.patch(attempt._id, { status, completedAt: now, lastEventAt: now });
      return attempt;
    };
    if (a.action === "pause" && ["pending", "dispatching", "running", "steering"].includes(row.status)) {
      const integrationControl = await controlIntegrationForJob(ctx, row, "pause");
      if (integrationControl?.reconcile) return true;
      if (["running", "steering"].includes(row.status) && !await closeAttempt("paused")) return false;
      if (["pending", "dispatching"].includes(row.status)) {
        const attempt = await ensureAttempt(ctx, a.jobId, row.attempt ?? 1, "queued", now);
        await ctx.db.patch(attempt._id, { status: "paused", dispatchId: undefined, lastEventAt: now });
      }
      await patchJobWithRuntime(ctx, row, {
        ...invalidateDeliveryLease(row),
        status: "paused",
        stage: "paused",
        progress: "paused by Daniel",
        nextRunAt: undefined,
        dispatchId: undefined,
        dispatchLeaseUntil: undefined,
        deliveryLeaseUntil: undefined,
        deliveryLeaseToken: undefined,
      });
      if (row.activeDeliveryAttemptId) {
        const delivery: any = await ctx.db.get(row.activeDeliveryAttemptId);
        if (delivery && delivery.status === "running") await ctx.db.patch(delivery._id, {
          status: "checkpointed", retryReason: "paused by control", leaseUntil: undefined,
          heartbeatAt: now, updatedAt: now,
        });
      }
    }
    else if (a.action === "resume" && row.status === "needs_input" && row.integrationState === "needs_attention") {
      return await resumeIntegrationReconciliation(ctx, row, now);
    }
    else if (
      a.action === "resume"
      && row.status === "needs_input"
      && row.controllerSessionRepairRequired === true
    ) {
      // A controller-session failure is system-owned, not a question Daniel
      // must answer. Resume it only after trusted durable evidence clears the
      // exact hold, then allocate a fresh attempt rather than reviving the
      // terminal workspace in place.
      if (!await controllerSessionHoldIsClear(ctx, row)) return false;
      const previous = await attemptFor(ctx, a.jobId, row.attempt ?? 1);
      if (!previous || previous.status !== "needs_input" || !previous.completedAt) return false;
      const nextAttempt = (row.attempt ?? 1) + 1;
      if (!hasAttemptBudget(nextAttempt, row.maxAttempts ?? 12)) return false;
      await patchJobWithRuntime(ctx, row, {
        ...invalidateDeliveryLease(row),
        status: "pending",
        stage: "queued",
        progress: "ChatGPT connection restored — fresh attempt queued",
        percent: 0,
        attempt: nextAttempt,
        startedAt: undefined,
        completedAt: undefined,
        heartbeatAt: now,
        progressAt: now,
        nextRunAt: now,
        dispatchId: undefined,
        dispatchLeaseUntil: undefined,
        workerRunId: undefined,
        deliveryRunId: undefined,
        controllerSessionHoldCode: undefined,
        controllerSessionRepairRequired: undefined,
        controllerSessionRepairGeneration: undefined,
        controllerSessionHoldAt: undefined,
      });
      await ensureAttempt(ctx, a.jobId, nextAttempt, "pending", now);
      await appendAttemptEvidence(ctx, row, "resume", "Trusted ChatGPT recovery cleared the controller-session hold", {
        stage: "queued",
        evidenceKind: "control",
        eventKey: `control:session-resume:${row.attempt ?? 1}:${nextAttempt}`,
        attempt: row.attempt ?? 1,
      });
      await appendAttemptEvidence(ctx, row, "queued", `Fresh attempt ${nextAttempt} queued after ChatGPT recovery`, {
        stage: "queued",
        evidenceKind: "intent",
        eventKey: `intent:${nextAttempt}`,
        attempt: nextAttempt,
      });
      const attention = await ctx.db
        .query("attentionItems")
        .withIndex("by_fingerprint", (q: any) => q.eq("fingerprint", `job-input:${a.jobId}`))
        .first();
      if (attention) await ctx.db.patch(attention._id, { status: "resolved", updatedAt: now });
      controlEventEmitted = true;
    }
    else if (a.action === "resume" && ["paused", "stalled"].includes(row.status)) {
      const activeDelivery: any = row.activeDeliveryAttemptId ? await ctx.db.get(row.activeDeliveryAttemptId) : null;
      if (row.verificationVerdict === "pass" && row.reviewReceiptId && activeDelivery) {
        const nextGeneration = Number(activeDelivery.generation) + 1;
        const existing = await deliveryAttemptFor(ctx, a.jobId, row.attempt ?? 1, nextGeneration);
        const nextDeliveryId = existing?._id ?? await ctx.db.insert("deliveryAttempts", {
          jobId: a.jobId, sourceWorkAttempt: row.attempt ?? 1, generation: nextGeneration,
          policy: activeDelivery.policy, status: "checkpointed", parentDeliveryAttemptId: activeDelivery._id,
          ...carriedDeliveryAuthority(activeDelivery), heartbeatAt: now, retries: 0,
          cumulativeRetries: Number(activeDelivery.cumulativeRetries ?? 0),
          currentStep: activeDelivery.currentStep === "receipt" ? "receipt" : "queued",
          retryReason: "resumed by control", createdAt: now, updatedAt: now,
        });
        await patchJobWithRuntime(ctx, row, {
          ...invalidateDeliveryLease(row), status: "pending", stage: "delivery",
          progress: "verified delivery resumed — controller queued", heartbeatAt: now, nextRunAt: now,
          dispatchId: undefined, dispatchLeaseUntil: undefined, workerRunId: undefined, deliveryRunId: undefined,
          deliveryGeneration: nextGeneration, activeDeliveryAttemptId: nextDeliveryId,
        });
        await appendAttemptEvidence(ctx, row, "delivery_resumed", "Paused delivery resumed without rerunning the specialist", {
          stage: "delivery", evidenceKind: "control", eventKey: `control:delivery-resume:${row.attempt ?? 1}:${nextGeneration}`,
        });
        return true;
      }
      const previous = await attemptFor(ctx, a.jobId, row.attempt ?? 1);
      if (previous && !previous.completedAt && previous.status !== "paused") return false;
      // A paused reservation never launched a worker and therefore must not
      // consume a retry budget. A closed launched workspace gets a fresh id.
      const nextAttempt = (row.attempt ?? 1) + (shouldAdvanceAttempt(Boolean(previous?.workerRunId)) ? 1 : 0);
      if (!hasAttemptBudget(nextAttempt, row.maxAttempts ?? 12)) return false;
      await patchJobWithRuntime(ctx, row, {
        ...invalidateDeliveryLease(row),
        status: "pending",
        stage: "queued",
        progress: row.status === "stalled" ? "stalled attempt resumed — fresh workspace queued" : "resumed — queued",
        percent: 0,
        attempt: nextAttempt,
        startedAt: undefined,
        heartbeatAt: now,
        progressAt: now,
        stalledAt: undefined,
        stallReason: undefined,
        nextRunAt: now,
        dispatchId: undefined,
        dispatchLeaseUntil: undefined,
        workerRunId: undefined,
        deliveryLeaseUntil: undefined,
        deliveryLeaseToken: undefined,
      });
      if (row.activeDeliveryAttemptId) {
        const delivery: any = await ctx.db.get(row.activeDeliveryAttemptId);
        if (delivery && !["done", "blocked", "abandoned"].includes(delivery.status)) await ctx.db.patch(delivery._id, {
          status: "blocked", outcome: "blocked", currentStep: "terminal", retryReason: "cancelled by control",
          terminalReceiptDigest: await sha256Hex(`blocked:cancelled:${String(a.jobId)}:${row.attempt ?? 1}`),
          completedAt: now, leaseUntil: undefined, heartbeatAt: now, updatedAt: now,
        });
      }
      if (nextAttempt === (row.attempt ?? 1) && previous?.status === "paused") {
        await ctx.db.patch(previous._id, { status: "queued", dispatchId: undefined, lastEventAt: now });
      } else {
        await appendAttemptEvidence(ctx, row, "resume", `${row.status} resumed by Daniel`, {
          stage: "queued", evidenceKind: "control", eventKey: `control:resume:${row.attempt ?? 1}:${now}`,
          attempt: row.attempt ?? 1,
        });
        controlEventEmitted = true;
        await ensureAttempt(ctx, a.jobId, nextAttempt, "pending", now);
        await appendAttemptEvidence(ctx, row, "queued", `Fresh attempt ${nextAttempt} queued after ${row.status}`, {
          stage: "queued", evidenceKind: "intent", eventKey: `intent:${nextAttempt}`, attempt: nextAttempt,
        });
      }
    }
    else if (a.action === "cancel" && !["done", "error", "cancelled"].includes(row.status)) {
      const integrationControl = await controlIntegrationForJob(ctx, row, "cancel");
      if (integrationControl?.reconcile) return true;
      if (["running", "steering"].includes(row.status) && !await closeAttempt("cancelled")) return false;
      if (["pending", "dispatching", "paused"].includes(row.status)) await closeAttempt("cancelled");
      const cancellationResult = "Daniel cancelled the work.";
      const cancellationEvidence = String(row.checkpoint ?? "").slice(0, 1_000);
      if (isSupervisorOwnedJob(row)) {
        await ensureAttempt(
          ctx,
          a.jobId,
          row.attempt ?? 1,
          row.status,
          now,
        );
        await insertFreshTerminalWorkReceipt(ctx, row, row.attempt ?? 1, {
          status: "cancelled",
          terminalCode: "operator_cancelled",
          recoveryDisposition: "operator_stop",
          acceptanceEvidence: [],
          artifacts: [
            `convex://jobs/${String(a.jobId)}/attempt/${row.attempt ?? 1}/control`,
          ],
          verification: "cancelled",
          terminalEventKey: `operator-cancelled:${row.attempt ?? 1}`,
          result: cancellationResult,
          evidence: cancellationEvidence,
        }, now);
      }
      if (row.dispatchId && !await closeOrConfirmDispatchReceiptForControl(
        ctx,
        row,
        row.deliveryRunId ?? row.workerRunId,
        "job cancelled by owner control",
      )) return false;
      await patchJobWithRuntime(ctx, row, {
        ...invalidateDeliveryLease(row),
        status: "cancelled",
        stage: "cancelled",
        ...(isSupervisorOwnedJob(row)
          ? {
            result: cancellationResult,
            verificationNote: cancellationEvidence,
          }
          : {}),
        completedAt: now,
        progress: "cancelled by Daniel",
        nextRunAt: undefined,
        dispatchId: undefined,
        dispatchLeaseUntil: undefined,
        workerRunId: undefined,
        deliveryRunId: undefined,
        deliveryLeaseUntil: undefined,
        deliveryLeaseToken: undefined,
      });
      const approvals = await ctx.db
        .query("approvals")
        .withIndex("by_job", (q: any) => q.eq("jobId", String(a.jobId)))
        .take(20);
      for (const approval of approvals) {
        if (approval.status === "pending") await ctx.db.patch(approval._id, { status: "cancelled", resolvedAt: now });
      }
      await resolveOpenJobAttention(ctx, a.jobId, now);
    } else if (a.action === "retry" && ["error", "cancelled"].includes(row.status)) {
      const previous = await attemptFor(ctx, a.jobId, row.attempt ?? 1);
      if (previous && !previous.completedAt) return false;
      if (!hasAttemptBudget((row.attempt ?? 1) + 1, row.maxAttempts ?? 12)) return false;
      const renewApproval = row.approvalRequired === true && row.approvalStatus !== "approved";
      await patchJobWithRuntime(ctx, row, {
        ...invalidateDeliveryLease(row),
        status: renewApproval ? "awaiting_approval" : "pending",
        stage: renewApproval ? "approval" : "queued",
        percent: 0,
        completedAt: undefined,
        startedAt: undefined,
        heartbeatAt: now,
        progressAt: now,
        attempt: (row.attempt ?? 1) + 1,
        approvalStatus: renewApproval ? "pending" : row.approvalStatus,
        progress: renewApproval ? "retry waiting for Daniel's approval" : "manual retry queued",
        nextRunAt: renewApproval ? undefined : now,
        dispatchId: undefined,
        dispatchLeaseUntil: undefined,
        workerRunId: undefined,
        deliveryLeaseUntil: undefined,
        deliveryLeaseToken: undefined,
      });
      await ensureAttempt(ctx, a.jobId, (row.attempt ?? 1) + 1, renewApproval ? "awaiting_approval" : "pending", now);
      await appendAttemptEvidence(ctx, row, "retry", "Daniel requested a fresh attempt", {
        stage: renewApproval ? "approval" : "queued", evidenceKind: "control", eventKey: `control:retry:${row.attempt ?? 1}:${now}`,
        attempt: row.attempt ?? 1,
      });
      controlEventEmitted = true;
      await appendAttemptEvidence(ctx, row, renewApproval ? "approval_requested" : "queued",
        renewApproval ? `Fresh attempt ${(row.attempt ?? 1) + 1} awaits approval` : `Fresh attempt ${(row.attempt ?? 1) + 1} queued after retry`, {
          stage: renewApproval ? "approval" : "queued", evidenceKind: "intent", eventKey: `intent:${(row.attempt ?? 1) + 1}`,
          attempt: (row.attempt ?? 1) + 1,
        });
      if (renewApproval) {
        await ctx.db.insert("approvals", {
          jobId: String(a.jobId),
          kind: "consequential-work-retry",
          summary: (row.label || row.task).slice(0, 240),
          risk: row.risk ?? "consequential",
          payload: { repo: row.repo, agentId: row.agentId, reason: row.approvalReason },
          status: "pending",
          requestedAt: now,
        });
      }
    } else if (a.action === "steer" && ["pending", "dispatching", "running", "paused", "stalled", "steering"].includes(row.status)) {
      const steer = String(a.input ?? "").trim().slice(0, 2_000);
      if (!steer) return false;
      // HTTP/Trigger retries of the same explicit user command are idempotent:
      // they must not allocate successive workspaces or consume retry budget.
      if (row.steer === steer && Number(row.steerRevision ?? 0) > 0) return true;
      if (row.pendingWorkOrderRevisionId && row.pendingWorkOrderRevisionDigest) {
        const pending: any = await ctx.db.get(row.pendingWorkOrderRevisionId);
        if (pending?.revisionDigest === row.pendingWorkOrderRevisionDigest
          && pending.steeringInstruction === steer) return true;
      }
      const policyTask = exactTextWorkOrder(`${String(row.policyTask ?? row.task)}\n\nDaniel steering instruction:\n${steer}`);
      const approval = workApprovalPolicy({
        task: policyTask, repo: row.repo, readonly: row.readonly,
        risk: row.risk, approvalRequired: row.approvalRequired,
      });
      const revisionChanges = {
        steer,
        policyTask,
        approvalRequired: approval.required,
        approvalReason: approval.reason,
        deliveryMode: approval.deliveryMode,
        risk: approval.required ? "consequential" : String(row.risk ?? "high"),
      };
      const integrationControl = await controlIntegrationForJob(ctx, row, "steer");
      if (integrationControl?.reconcile) {
        const reconciling: any = await ctx.db.get(row._id) ?? row;
        await stageJobWorkOrderRevision(ctx, reconciling, revisionChanges);
        await patchJobWithRuntime(ctx, reconciling, {
          steerRevision: (row.steerRevision ?? 0) + 1,
          checkpoint: `${row.checkpoint ?? ""}\n\nDaniel steering instruction:\n${steer}`.trim().slice(-6_000),
        });
        return true;
      }
      const nextAttempt = (row.attempt ?? 1) + 1;
      if (!hasAttemptBudget(nextAttempt, row.maxAttempts ?? 12)) return false;
      const priorAttempt = await ensureAttempt(ctx, a.jobId, row.attempt ?? 1, row.status, now);
      if (!priorAttempt.completedAt) await ctx.db.patch(priorAttempt._id, {
        status: "steered", completedAt: now, dispatchId: undefined, lastEventAt: now,
      });
      const activeDelivery: any = row.activeDeliveryAttemptId ? await ctx.db.get(row.activeDeliveryAttemptId) : null;
      if (activeDelivery && !["done", "blocked", "abandoned"].includes(activeDelivery.status)) {
        await ctx.db.patch(activeDelivery._id, {
          status: "abandoned", outcome: "stale", currentStep: "terminal",
          retryReason: "superseded by fresh user steering", completedAt: now,
          leaseOwner: undefined, leaseToken: undefined, leaseUntil: undefined,
          heartbeatAt: now, updatedAt: now,
        });
      }
      const steerRevision = (row.steerRevision ?? 0) + 1;
      await appendAttemptEvidence(ctx, row, "steer", `Daniel steering: ${steer.slice(0, 500)}`, {
        stage: "steering", evidenceKind: "steering",
        eventKey: `control:steer:${row.attempt ?? 1}:${steerRevision}`,
        attempt: row.attempt ?? 1,
      });
      const revised = await transitionJobWorkOrderRevision(ctx, row, revisionChanges, {
        ...invalidateDeliveryLease(row),
        status: approval.required ? "awaiting_approval" : "pending",
        approvalStatus: approval.required ? "pending" : undefined,
        stage: approval.required ? "approval" : "queued",
        attempt: nextAttempt,
        percent: 0,
        steerRevision,
        checkpoint: `${row.checkpoint ?? ""}\n\nDaniel steering instruction:\n${steer}`.trim().slice(-6_000),
        progress: approval.required
          ? `Daniel supplied steering — fresh attempt ${nextAttempt} awaits protected approval`
          : `Daniel supplied steering — fresh attempt ${nextAttempt} is immediately eligible`,
        startedAt: undefined,
        completedAt: undefined,
        heartbeatAt: now,
        progressAt: now,
        nextRunAt: approval.required ? undefined : now,
        dispatchId: undefined,
        dispatchLeaseUntil: undefined,
        workerRunId: undefined,
        workerRuntime: undefined,
        providerRunState: undefined,
        providerObservedAt: undefined,
        deliveryRunId: undefined,
        activeDeliveryAttemptId: undefined,
        deliveryGeneration: undefined,
        deliveryLeaseUntil: undefined,
        deliveryLeaseToken: undefined,
        integrationAttemptId: undefined,
        integrationState: undefined,
        reviewReceiptId: undefined,
        reviewReceiptDigest: undefined,
        reviewReceiptSignature: undefined,
        verificationVerdict: undefined,
        verificationNote: undefined,
        verifiedAt: undefined,
        deliveryStatus: undefined,
        pullRequestUrl: undefined,
        mergeCommitSha: undefined,
      });
      await ensureAttempt(ctx, a.jobId, nextAttempt, approval.required ? "awaiting_approval" : "pending", now, {
        parentAttempt: row.attempt ?? 1,
        sourceHeadSha: row.sourceHeadSha,
        parentCheckpointHeadSha: priorAttempt.checkpointHeadSha,
      });
      if (approval.required) {
        await ctx.db.insert("approvals", {
          jobId: String(a.jobId), kind: "steering",
          summary: (revised.label || revised.task).slice(0, 240), risk: revised.risk ?? "consequential",
          payload: { repo: revised.repo, agentId: revised.agentId, reason: revised.approvalReason, steer: steer.slice(0, 500) },
          status: "pending", requestedAt: now,
        });
      }
      await appendAttemptEvidence(ctx, row, "queued", `Fresh attempt ${nextAttempt} queued immediately after steering`, {
        stage: "queued", evidenceKind: "intent", eventKey: `intent:${nextAttempt}`, attempt: nextAttempt,
      });
      controlEventEmitted = true;
    } else return false;
    const retryNeedsApproval =
      a.action === "retry" && row.approvalRequired === true && row.approvalStatus !== "approved";
    if (!controlEventEmitted) await appendAttemptEvidence(ctx, row, a.action,
      a.action === "steer" ? `Daniel steering: ${String(a.input ?? "").trim().slice(0, 500)}` : `${a.action} requested by Daniel`,
      { stage: retryNeedsApproval ? "approval" : a.action === "resume" || a.action === "retry" ? "queued" : a.action === "steer" ? "steering" : `${a.action}d`,
        evidenceKind: a.action === "steer" ? "steering" : "control", eventKey: `control:${a.action}:${row.attempt ?? 1}:${a.action === "steer" ? row.steerRevision ?? 0 : now}` });
    return true;
  },
});

export const active = query({
  args: { ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    const state = await ctx.db
      .query("controlPlaneMigrations")
      .withIndex("by_key", (q: any) => q.eq("key", CONTROL_PLANE_MIGRATION))
      .first();
    // The indexed v2 path is the permanent read. Before its independent
    // cursor completes, add only a bounded legacy page so an already-complete
    // v1 record cannot make the panel silently empty during rollout.
    const projected = await ctx.db
      .query("jobRuntime")
      .withIndex("by_active_priority", (q: any) => q.eq("active", true))
      .order("desc")
      .take(100);
    let active = projected;
    if (!state?.jobsComplete) {
      const legacy = await ctx.db.query("jobs").withIndex("by_createdAt").order("desc").take(100);
      const projectedIds = new Set(projected.map((row: any) => String(row.jobId)));
      const legacyActive = legacy.filter((job: any) =>
        ["running", "dispatching", "pending", "awaiting_approval", "paused", "stalled", "needs_input", "steering"].includes(job.status)
        && !projectedIds.has(String(job._id)),
      ).map((job: any) => ({ ...job, jobId: job._id }));
      active = [...projected, ...legacyActive].slice(0, 100);
    }
    return active
      .sort((a: any, b: any) => (b.priority ?? 50) - (a.priority ?? 50) || a.createdAt - b.createdAt)
      .map((j: any) => ({
        _id: j.jobId,
        task: j.task,
        label: j.label ?? null,
        missionId: j.missionId ?? null,
        repo: j.repo ?? null,
        model: j.model ? normalizeWorkModelTier(j.model) : null,
        reasoningEffort: j.reasoningEffort ?? null,
        modelReason: j.modelReason ?? null,
        agentId: j.agentId ?? null,
        risk: j.risk ?? "low",
        priority: j.priority ?? 50,
        status: j.status,
        stage: j.stage ?? j.status,
        percent: j.percent ?? 0,
        progress: j.progress ?? "",
        log: j.log ?? "",
        attempt: j.attempt ?? 1,
        maxAttempts: j.maxAttempts ?? 12,
        checkpoint: j.checkpoint ?? null,
        branch: j.branch ?? null,
        pullRequestUrl: j.pullRequestUrl ?? null,
        deliveryMode: j.deliveryMode ?? (j.readonly ? "read_only" : "manual"),
        deliveryStatus: j.deliveryStatus ?? null,
        mergeCommitSha: j.mergeCommitSha ?? null,
        originThreadId: j.originThreadId ?? "main",
        parentJobId: j.parentJobId ?? null,
        goalStage: j.goalStage ?? null,
        goalWorkstreamId: j.goalWorkstreamId ?? null,
        goalWave: j.goalWave ?? 0,
        startedAt: j.startedAt ?? j.createdAt,
        heartbeatAt: j.heartbeatAt ?? j.startedAt ?? j.createdAt,
        progressAt: j.progressAt ?? j.startedAt ?? j.createdAt,
        stalledAt: j.stalledAt ?? null,
        stallReason: j.stallReason ?? null,
        nextRunAt: j.nextRunAt ?? null,
        workerRunId: j.workerRunId ?? null,
        workerRuntime: j.workerRuntime ?? null,
      }));
  },
});

export const workerRun = query({
  args: { jobId: v.id("jobs"), ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    const row = await jobRuntimeFor(ctx, a.jobId);
    return row?.workerRunId
      ? { runId: row.workerRunId, taskId: "jarvis-agent-worker", runtime: row.workerRuntime ?? "trigger" }
      : null;
  },
});
