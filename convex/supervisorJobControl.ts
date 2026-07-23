import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import {
  ensureWorkAttempt,
  patchJobWithRuntimeForSupervisorBatch,
  readExactWorkAttempt,
  readJobSchedulingAuthority,
  readJobWorkOrderAuthority,
  refreshWorkGroupQueueProjection,
  transitionJobWorkOrderRevision,
  validateExactWorkAttemptExecutionAuthority,
} from "./controlPlane";
import {
  readExactSupervisorJobDecisionProvenance,
  type ExactSupervisorJobDecisionProvenance,
  type SupervisorDecisionProvenanceCache,
} from "./missionSupervisorWake";
import { exactTerminalWorkReceipt } from "./workReceiptAuthority";
import { sha256Hex } from "../src/lib/source-admission";
import {
  MISSION_SUPERVISOR_MAX_AUTONOMOUS_RECOVERIES,
  MISSION_SUPERVISOR_MAX_RECOVERY_GENERATION,
} from "./missionSupervisorProtocol";

export const SUPERVISOR_JOB_CONTROL_MAX_JOBS = 24;

export type SupervisorJobControlAction =
  | "pause"
  | "resume"
  | "cancel"
  | "steer";

export type SupervisorJobControlDisposition =
  | "eligible"
  | "terminal_unchanged"
  | "already_stopped"
  | "approval_wait_unchanged";

type ExactProvenance = Extract<
  ExactSupervisorJobDecisionProvenance,
  { ok: true }
>;

type ExactExecutionAuthority = NonNullable<
  Awaited<ReturnType<typeof validateExactWorkAttemptExecutionAuthority>>
>;

export type SupervisorJobControlMemberPlan = {
  job: Doc<"jobs">;
  disposition: SupervisorJobControlDisposition;
  provenance: ExactProvenance;
  attemptNumber: number;
  currentAttempt: Doc<"workAttempts"> | null;
  executionAuthority: ExactExecutionAuthority | null;
  schedulingGroupKey?: string;
};

export type SupervisorJobControlPlan = {
  action: SupervisorJobControlAction;
  missionId: Id<"missions">;
  members: SupervisorJobControlMemberPlan[];
  affectedJobIds: Id<"jobs">[];
};

export type SupervisorJobControlPreflightFailureReason =
  | "supervisor_job_limit"
  | "job_ledger_mismatch"
  | "duplicate_job"
  | "mission_mismatch"
  | "legacy_or_invalid_provenance"
  | "missing_or_ambiguous_decision"
  | "provenance_mismatch"
  | "unsupported_job_status"
  | "invalid_action_status"
  | "terminal_recovery_required"
  | "invalid_attempt_bounds"
  | "missing_attempt_authority"
  | "ambiguous_attempt_authority"
  | "invalid_attempt_authority"
  | "supervisor_integration_requires_reconciliation"
  | "invalid_control_cohort";

export type SupervisorJobControlPreflightResult =
  | { ok: true; plan: SupervisorJobControlPlan }
  | {
      ok: false;
      reason: SupervisorJobControlPreflightFailureReason;
      jobId?: Id<"jobs">;
    };

export type SupervisorJobRuntimePatch = {
  jobId: Id<"jobs">;
  patch: Record<string, unknown>;
};

export type SupervisorJobBatchPatchResult = {
  patchedJobIds: Id<"jobs">[];
  touchedSchedulingGroupKeys: string[];
};

export type SupervisorPauseResumeFailureReason =
  | SupervisorJobControlPreflightFailureReason
  | "invalid_approval_authority"
  | "ambiguous_approval_authority"
  | "invalid_dispatch_authority"
  | "ambiguous_dispatch_authority"
  | "pause_checkpoint_pending"
  | "invalid_delivery_authority"
  | "ambiguous_delivery_authority"
  | "unresolved_provider_effect"
  | "attempt_budget_exhausted"
  | "next_attempt_authority_conflict"
  | "invalid_terminal_authority";

type DispatchControlDisposition =
  | "none"
  | "supersede"
  | "preserve_claimed"
  | "close_checkpointed_delivery";

type ResumeControlDisposition =
  | "approval"
  | "delivery"
  | "reuse_attempt"
  | "fresh_attempt";

export type SupervisorPauseResumeMemberPlan = {
  member: SupervisorJobControlMemberPlan;
  approval: Doc<"approvals"> | null;
  dispatchReceipt: Doc<"dispatchReceipts"> | null;
  dispatchDisposition: DispatchControlDisposition;
  deliveryAttempt: Doc<"deliveryAttempts"> | null;
  reviewReceipt: Doc<"reviewReceipts"> | null;
  resumeDisposition?: ResumeControlDisposition;
  resumeAttemptNumber?: number;
  resumeDeliveryGeneration?: number;
};

export type SupervisorPauseResumePlan = {
  control: SupervisorJobControlPlan;
  members: SupervisorPauseResumeMemberPlan[];
};

export type SupervisorPauseResumePreflightResult =
  | { ok: true; plan: SupervisorPauseResumePlan }
  | {
      ok: false;
      reason: SupervisorPauseResumeFailureReason;
      jobId?: Id<"jobs">;
    };

const TERMINAL_JOB_STATUSES = new Set([
  "done",
  "error",
  "cancelled",
  "needs_input",
]);

const ACTIVE_JOB_STATUSES = new Set([
  "pending",
  "dispatching",
  "running",
  "awaiting_approval",
  "paused",
  "stalled",
  "steering",
]);

const HARMLESS_INTEGRATION_STATES = new Set([
  "not_applicable",
  "integrated",
  "cancelled",
  "parked",
]);

const RESOLVED_PROVIDER_EFFECT_OBSERVATIONS = new Set([
  "applied",
  "not_applied",
]);

const ATTEMPT_REQUIRED_STATUSES = new Set([
  "dispatching",
  "running",
  "paused",
  "stalled",
  "steering",
]);

const QUEUE_AUTHORITY_FIELDS = new Set([
  "status",
  "nextRunAt",
  "dispatchReady",
  "schedulingBound",
  "priority",
]);

const FORBIDDEN_GENERIC_BATCH_PATCH_FIELDS = new Set([
  "missionId",
  "supervisorEpoch",
  "supervisorDecisionKey",
  "supervisorJobOrdinal",
  "repo",
  "readonly",
  "missionGroupId",
  "projectGroupId",
  "canonicalProjectId",
  "projectRepository",
  "schedulingGroupKey",
  "schedulingProtocolVersion",
  "schedulingAdmissionId",
  "schedulingBindingDigest",
  "schedulingBound",
  "sourceProvider",
  "sourceBranch",
  "sourceRef",
  "sourceHeadSha",
  "sourceObservedAt",
  "sourceAdmissionDigest",
  "workerBranch",
  "workerLineage",
  "workspaceLineage",
  "retryLineage",
  "integrationBranch",
  "integrationLineage",
  "task",
  "policyTask",
  "steer",
  "acceptanceCriteria",
  "model",
  "reasoningEffort",
  "mcp",
  "toolScope",
  "deliveryMode",
  "risk",
  "approvalRequired",
  "approvalReason",
  "agentId",
  "agentRole",
  "machineClass",
  "triggerMachinePreset",
  "triggerMachineReason",
  "workOrderProtocolVersion",
  "workOrderRevision",
  "workOrderRevisionId",
  "workOrderRevisionDigest",
  "pendingWorkOrderRevisionId",
  "pendingWorkOrderRevisionDigest",
]);

type DispositionResult =
  | { ok: true; disposition: SupervisorJobControlDisposition }
  | {
      ok: false;
      reason:
        | "unsupported_job_status"
        | "invalid_action_status"
        | "terminal_recovery_required";
    };

function dispositionFor(
  action: SupervisorJobControlAction,
  status: string,
): DispositionResult {
  if (TERMINAL_JOB_STATUSES.has(status)) {
    return { ok: true, disposition: "terminal_unchanged" };
  }
  if (!ACTIVE_JOB_STATUSES.has(status)) {
    return { ok: false, reason: "unsupported_job_status" };
  }
  if (action === "pause") {
    return {
      ok: true,
      disposition: status === "paused" || status === "stalled"
        ? "already_stopped"
        : "eligible",
    };
  }
  if (action === "resume") {
    if (status === "stalled") {
      return { ok: false, reason: "terminal_recovery_required" };
    }
    if (status === "awaiting_approval") {
      return { ok: true, disposition: "approval_wait_unchanged" };
    }
    return status === "paused"
      ? { ok: true, disposition: "eligible" }
      : { ok: false, reason: "invalid_action_status" };
  }
  if (action === "steer" && status === "stalled") {
    return { ok: false, reason: "terminal_recovery_required" };
  }
  return { ok: true, disposition: "eligible" };
}

function scopedDispositionFor(
  action: SupervisorJobControlAction,
  status: string,
  targeted: boolean,
  hasTargetScope: boolean,
): DispositionResult {
  if (!hasTargetScope || action !== "resume" || targeted) {
    return dispositionFor(action, status);
  }
  if (TERMINAL_JOB_STATUSES.has(status)) {
    return { ok: true, disposition: "terminal_unchanged" };
  }
  if (status === "paused" || status === "stalled") {
    return { ok: true, disposition: "already_stopped" };
  }
  return { ok: false, reason: "invalid_action_status" };
}

function hasMeaningfulIntegrationControl(job: Doc<"jobs">): boolean {
  if (job.integrationAttemptId) {
    return true;
  }
  if (typeof job.integrationState !== "string") {
    return false;
  }
  const integrationState = job.integrationState.trim();
  return (
    integrationState.length > 0
    && !HARMLESS_INTEGRATION_STATES.has(integrationState)
  );
}

function failure(
  reason: SupervisorJobControlPreflightFailureReason,
  job?: Doc<"jobs">,
): SupervisorJobControlPreflightResult {
  return { ok: false, reason, jobId: job?._id };
}

/**
 * Validate a bounded mission job ledger without performing any writes.
 *
 * This deliberately stops before delivery, approval, terminal-receipt, and
 * pause-cohort semantics. Those need the outer control receipt/state wiring
 * before they can be applied truthfully. The returned documents are intended
 * to be consumed in the same Convex mutation and consistent transaction view.
 */
export async function preflightSupervisorJobControlBatch(
  ctx: Pick<MutationCtx, "db">,
  args: {
    missionId: Id<"missions">;
    action: SupervisorJobControlAction;
    jobs: readonly Doc<"jobs">[];
    expectedTotalJobs?: number;
    targetJobIds?: readonly Id<"jobs">[];
  },
): Promise<SupervisorJobControlPreflightResult> {
  if (args.jobs.length > SUPERVISOR_JOB_CONTROL_MAX_JOBS) {
    return failure("supervisor_job_limit");
  }
  if (
    args.expectedTotalJobs !== undefined
    && (
      !Number.isSafeInteger(args.expectedTotalJobs)
      || args.expectedTotalJobs < 0
      || args.expectedTotalJobs !== args.jobs.length
    )
  ) {
    return failure("job_ledger_mismatch");
  }
  if (
    args.targetJobIds
    && args.targetJobIds.length > SUPERVISOR_JOB_CONTROL_MAX_JOBS
  ) {
    return failure("supervisor_job_limit");
  }
  const targetJobIds = new Set(
    (args.targetJobIds ?? []).map((jobId) => String(jobId)),
  );
  if (
    args.targetJobIds
    && targetJobIds.size !== args.targetJobIds.length
  ) {
    return failure("invalid_control_cohort");
  }

  const seen = new Set<string>();
  const members: SupervisorJobControlMemberPlan[] = [];
  const decisionCache: SupervisorDecisionProvenanceCache = new Map();

  for (const job of args.jobs) {
    const jobKey = String(job._id);
    if (seen.has(jobKey)) return failure("duplicate_job", job);
    seen.add(jobKey);
    if (String(job.missionId ?? "") !== String(args.missionId)) {
      return failure("mission_mismatch", job);
    }

    const provenance = await readExactSupervisorJobDecisionProvenance(
      ctx,
      job,
      decisionCache,
    );
    if (!provenance.ok) return failure(provenance.reason, job);
    if (String(provenance.missionId) !== String(args.missionId)) {
      return failure("provenance_mismatch", job);
    }

    const disposition = scopedDispositionFor(
      args.action,
      String(job.status),
      targetJobIds.has(jobKey),
      args.targetJobIds !== undefined,
    );
    if (!disposition.ok) return failure(disposition.reason, job);

    const attemptNumber = Number(job.attempt ?? 1);
    const maxAttempts = Number(job.maxAttempts ?? 12);
    if (
      !Number.isSafeInteger(attemptNumber)
      || attemptNumber < 1
      || !Number.isSafeInteger(maxAttempts)
      || maxAttempts < attemptNumber
    ) {
      return failure("invalid_attempt_bounds", job);
    }

    let currentAttempt: Doc<"workAttempts"> | null = null;
    let executionAuthority: ExactExecutionAuthority | null = null;
    if (
      disposition.disposition !== "terminal_unchanged"
      && disposition.disposition !== "approval_wait_unchanged"
    ) {
      if (
        disposition.disposition === "eligible"
        && hasMeaningfulIntegrationControl(job)
      ) {
        return failure(
          "supervisor_integration_requires_reconciliation",
          job,
        );
      }
      const attempt = await readExactWorkAttempt(
        ctx,
        job._id,
        attemptNumber,
      );
      if (attempt.kind === "ambiguous") {
        return failure("ambiguous_attempt_authority", job);
      }
      if (attempt.kind === "missing") {
        if (ATTEMPT_REQUIRED_STATUSES.has(String(job.status))) {
          return failure("missing_attempt_authority", job);
        }
      } else {
        currentAttempt = attempt.attempt;
        executionAuthority = await validateExactWorkAttemptExecutionAuthority(
          ctx,
          job,
          currentAttempt,
        );
        if (!executionAuthority) {
          return failure("invalid_attempt_authority", job);
        }
      }
    }

    members.push({
      job,
      disposition: disposition.disposition,
      provenance,
      attemptNumber,
      currentAttempt,
      executionAuthority,
      schedulingGroupKey: typeof job.schedulingGroupKey === "string"
        && job.schedulingGroupKey
        ? job.schedulingGroupKey
      : undefined,
    });
  }
  if (
    args.targetJobIds
    && [...targetJobIds].some((jobId) => !seen.has(jobId))
  ) {
    return failure("invalid_control_cohort");
  }

  return {
    ok: true,
    plan: {
      action: args.action,
      missionId: args.missionId,
      members,
      affectedJobIds: members
        .filter((member) => member.disposition === "eligible")
        .map((member) => member.job._id),
    },
  };
}

function pauseResumeFailure(
  reason: SupervisorPauseResumeFailureReason,
  job?: Doc<"jobs">,
): SupervisorPauseResumePreflightResult {
  return { ok: false, reason, jobId: job?._id };
}

async function exactPendingApproval(
  ctx: Pick<MutationCtx, "db">,
  job: Doc<"jobs">,
): Promise<
  | { ok: true; approval: Doc<"approvals"> | null }
  | {
      ok: false;
      reason: "invalid_approval_authority" | "ambiguous_approval_authority";
    }
> {
  const expectsPending =
    job.approvalRequired === true && job.approvalStatus === "pending";
  if (job.status === "awaiting_approval" && !expectsPending) {
    return { ok: false, reason: "invalid_approval_authority" };
  }
  const rows = await ctx.db
    .query("approvals")
    .withIndex("by_job_status", (q) =>
      q
        .eq("jobId", String(job._id))
        .eq("status", "pending")
    )
    .take(2);
  if (rows.length > 1) {
    return { ok: false, reason: "ambiguous_approval_authority" };
  }
  if (!expectsPending) {
    return rows.length === 0
      ? { ok: true, approval: null }
      : { ok: false, reason: "invalid_approval_authority" };
  }
  if (rows.length !== 1) {
    return { ok: false, reason: "invalid_approval_authority" };
  }
  return { ok: true, approval: rows[0] };
}

function dispatchReceiptMatchesJob(
  receipt: Doc<"dispatchReceipts">,
  job: Doc<"jobs">,
  attemptNumber: number,
): boolean {
  return (
    String(receipt.jobId) === String(job._id)
    && receipt.attempt === attemptNumber
    && receipt.generation === job.dispatchGeneration
    && receipt.phase === job.dispatchPhase
    && receipt.receiptDigest === job.dispatchReceiptDigest
    && receipt.payloadDigest === job.dispatchPayloadDigest
    && (
      job.dispatchId === undefined
      || receipt.dispatchId === job.dispatchId
    )
  );
}

async function exactDispatchReceipt(
  ctx: Pick<MutationCtx, "db">,
  member: SupervisorJobControlMemberPlan,
): Promise<
  | { ok: true; receipt: Doc<"dispatchReceipts"> | null }
  | {
      ok: false;
      reason: "invalid_dispatch_authority" | "ambiguous_dispatch_authority";
    }
> {
  const { job, attemptNumber } = member;
  const hasAnyIdentity = Boolean(
    job.dispatchReceiptId
    || job.dispatchReceiptDigest
    || job.dispatchPayloadDigest
    || job.dispatchGeneration !== undefined
    || job.dispatchPhase
    || job.dispatchId,
  );
  if (!hasAnyIdentity) return { ok: true, receipt: null };
  if (
    !job.dispatchReceiptId
    || typeof job.dispatchReceiptDigest !== "string"
    || typeof job.dispatchPayloadDigest !== "string"
    || !Number.isSafeInteger(job.dispatchGeneration)
    || Number(job.dispatchGeneration) < 1
    || typeof job.dispatchPhase !== "string"
  ) {
    return { ok: false, reason: "invalid_dispatch_authority" };
  }
  const rows = await ctx.db
    .query("dispatchReceipts")
    .withIndex("by_job_generation", (q) =>
      q
        .eq("jobId", job._id)
        .eq("generation", Number(job.dispatchGeneration))
    )
    .take(2);
  if (rows.length > 1) {
    return { ok: false, reason: "ambiguous_dispatch_authority" };
  }
  if (
    rows.length !== 1
    || String(rows[0]._id) !== String(job.dispatchReceiptId)
    || !dispatchReceiptMatchesJob(rows[0], job, attemptNumber)
  ) {
    return { ok: false, reason: "invalid_dispatch_authority" };
  }
  return { ok: true, receipt: rows[0] };
}

function deliveryHasUnresolvedProviderEffect(
  delivery: Doc<"deliveryAttempts">,
): boolean {
  const effects = delivery.effects ?? [];
  const seen = new Set<string>();
  for (const effect of effects) {
    if (
      seen.has(effect.effectId)
      || !RESOLVED_PROVIDER_EFFECT_OBSERVATIONS.has(
        String(effect.observation ?? ""),
      )
      || !Number.isSafeInteger(effect.observedAt)
      || Number(effect.observedAt) < Number(effect.preparedAt)
    ) {
      return true;
    }
    seen.add(effect.effectId);
  }
  if (delivery.preparedEffectId === undefined) {
    return delivery.providerObservation !== undefined
      || delivery.providerObservedAt !== undefined;
  }
  const prepared = effects.filter((effect) =>
    effect.effectId === delivery.preparedEffectId
  );
  return (
    prepared.length !== 1
    || prepared[0].effectKind !== delivery.preparedEffectKind
    || prepared[0].observation !== delivery.providerObservation
    || prepared[0].observedAt !== delivery.providerObservedAt
    || !RESOLVED_PROVIDER_EFFECT_OBSERVATIONS.has(
      String(delivery.providerObservation ?? ""),
    )
  );
}

function deliveryAuthorityMatches(
  delivery: Doc<"deliveryAttempts">,
  review: Doc<"reviewReceipts">,
  member: SupervisorJobControlMemberPlan,
): boolean {
  const { job, attemptNumber, executionAuthority } = member;
  if (!executionAuthority) return false;
  return (
    String(delivery.jobId) === String(job._id)
    && delivery.sourceWorkAttempt === attemptNumber
    && delivery.generation === job.deliveryGeneration
    && String(delivery.reviewReceiptId) === String(job.reviewReceiptId)
    && delivery.reviewReceiptDigest === job.reviewReceiptDigest
    && delivery.integrationAttemptId === undefined
    && review.jobId === job._id
    && review.attempt === attemptNumber
    && review.receiptDigest === job.reviewReceiptDigest
    && review.authorityDigest === executionAuthority.authorityDigest
    && review.schedulingBindingDigest
      === executionAuthority.schedulingBindingDigest
    && String(review.workOrderRevisionId)
      === String(executionAuthority.workOrderRevisionId)
    && review.workOrderRevision === executionAuthority.workOrderRevision
    && review.workOrderRevisionDigest
      === executionAuthority.workOrderRevisionDigest
    && delivery.authorityDigest === review.authorityDigest
    && delivery.schedulingBindingDigest === review.schedulingBindingDigest
    && String(delivery.workOrderRevisionId)
      === String(review.workOrderRevisionId)
    && delivery.workOrderRevision === review.workOrderRevision
    && delivery.workOrderRevisionDigest === review.workOrderRevisionDigest
  );
}

async function exactDeliveryAuthority(
  ctx: Pick<MutationCtx, "db">,
  member: SupervisorJobControlMemberPlan,
): Promise<
  | {
      ok: true;
      delivery: Doc<"deliveryAttempts"> | null;
      review: Doc<"reviewReceipts"> | null;
    }
  | {
      ok: false;
      reason:
        | "invalid_delivery_authority"
        | "ambiguous_delivery_authority"
        | "unresolved_provider_effect";
    }
> {
  const { job, attemptNumber } = member;
  const hasDeliveryProjection = Boolean(
    job.activeDeliveryAttemptId
    || job.deliveryRunId
    || job.deliveryStatus
    || job.deliveryLeaseOwner
    || job.deliveryLeaseToken
    || job.deliveryLeaseUntil
    || job.dispatchPhase === "delivery"
    || job.reviewReceiptId
    || job.reviewReceiptDigest
    || job.verificationVerdict === "pass"
    || job.deliveryGeneration !== undefined,
  );
  if (!hasDeliveryProjection) {
    return { ok: true, delivery: null, review: null };
  }
  if (
    !job.activeDeliveryAttemptId
    || !job.reviewReceiptId
    || typeof job.reviewReceiptDigest !== "string"
    || job.verificationVerdict !== "pass"
    || !Number.isSafeInteger(job.deliveryGeneration)
    || Number(job.deliveryGeneration) < 1
  ) {
    return { ok: false, reason: "invalid_delivery_authority" };
  }
  const [deliveries, reviews] = await Promise.all([
    ctx.db
      .query("deliveryAttempts")
      .withIndex("by_job_source_generation", (q) =>
        q
          .eq("jobId", job._id)
          .eq("sourceWorkAttempt", attemptNumber)
          .eq("generation", Number(job.deliveryGeneration))
      )
      .take(2),
    ctx.db
      .query("reviewReceipts")
      .withIndex("by_job_attempt_digest", (q) =>
        q
          .eq("jobId", job._id)
          .eq("attempt", attemptNumber)
          .eq("receiptDigest", job.reviewReceiptDigest!)
      )
      .take(2),
  ]);
  if (deliveries.length > 1 || reviews.length > 1) {
    return { ok: false, reason: "ambiguous_delivery_authority" };
  }
  const delivery = deliveries[0];
  const review = reviews[0];
  if (
    !delivery
    || !review
    || String(delivery._id) !== String(job.activeDeliveryAttemptId)
    || String(review._id) !== String(job.reviewReceiptId)
    || !deliveryAuthorityMatches(delivery, review, member)
  ) {
    return { ok: false, reason: "invalid_delivery_authority" };
  }
  const anyJobLease = Boolean(
    job.deliveryLeaseOwner
    || job.deliveryLeaseToken
    || job.deliveryLeaseUntil,
  );
  const anyDeliveryLease = Boolean(
    delivery.leaseOwner
    || delivery.leaseToken
    || delivery.leaseUntil,
  );
  if (
    delivery.dispatchId !== job.dispatchId
    || delivery.deliveryRunId !== job.deliveryRunId
    || (
      anyJobLease !== anyDeliveryLease
    )
    || (
      anyJobLease
      && (
        delivery.leaseOwner !== job.deliveryLeaseOwner
        || delivery.leaseToken !== job.deliveryLeaseToken
        || delivery.leaseVersion !== job.deliveryLeaseVersion
        || delivery.leaseUntil !== job.deliveryLeaseUntil
      )
    )
  ) {
    return { ok: false, reason: "invalid_delivery_authority" };
  }
  if (deliveryHasUnresolvedProviderEffect(delivery)) {
    return { ok: false, reason: "unresolved_provider_effect" };
  }
  return { ok: true, delivery, review };
}

function dispatchDispositionForPause(
  member: SupervisorJobControlMemberPlan,
  receipt: Doc<"dispatchReceipts"> | null,
  delivery: Doc<"deliveryAttempts"> | null,
): DispatchControlDisposition | null {
  const status = String(member.job.status);
  if (!receipt) {
    return ["dispatching", "running", "steering"].includes(status)
      ? null
      : "none";
  }
  if (["reserved", "reconciling"].includes(receipt.status)) {
    return "supersede";
  }
  if (["running", "steering"].includes(status)) {
    if (
      receipt.status !== "claimed"
      || typeof member.job.workerRunId !== "string"
      || receipt.workerRunId !== member.job.workerRunId
      || receipt.dispatchId !== member.job.dispatchId
    ) {
      return null;
    }
    return delivery
      ? "close_checkpointed_delivery"
      : "preserve_claimed";
  }
  return ["closed", "superseded"].includes(receipt.status) ? "none" : null;
}

function dispatchIsClosedForResume(
  member: SupervisorJobControlMemberPlan,
  receipt: Doc<"dispatchReceipts"> | null,
): boolean {
  const launched = Boolean(
    member.currentAttempt?.workerRunId
    || member.currentAttempt?.sessionId
    || member.currentAttempt?.launchedAt,
  );
  if (!launched) {
    return !receipt || ["closed", "superseded"].includes(receipt.status);
  }
  return Boolean(
    receipt
    && receipt.status === "closed"
    && member.currentAttempt?.completedAt,
  );
}

function supersessionDigestPayload(
  row: Doc<"missionSupervisorSupersessions">,
) {
  return {
    protocolVersion: row.protocolVersion,
    supersessionKey: row.supersessionKey,
    missionId: String(row.missionId),
    decisionKey: row.decisionKey,
    decisionOrdinal: row.decisionOrdinal,
    mode: row.mode,
    rootJobId: String(row.rootJobId),
    generation: row.generation,
    autonomousRecoveryCount: row.autonomousRecoveryCount,
    predecessorJobId: String(row.predecessorJobId),
    predecessorAttempt: row.predecessorAttempt,
    predecessorReceiptId: String(row.predecessorReceiptId),
    predecessorReceiptDigest: row.predecessorReceiptDigest,
    successorJobId: String(row.successorJobId),
    successorSchedulingBindingDigest: row.successorSchedulingBindingDigest,
    successorWorkOrderRevisionId: String(row.successorWorkOrderRevisionId),
    successorWorkOrderRevisionDigest: row.successorWorkOrderRevisionDigest,
    successorCanonicalProjectId: row.successorCanonicalProjectId,
    successorRepository: row.successorRepository ?? null,
    successorSourceAdmissionDigest: row.successorSourceAdmissionDigest,
    observedInputRevision: row.observedInputRevision,
    inputControlReceiptId: row.inputControlReceiptId
      ? String(row.inputControlReceiptId)
      : null,
    inputControlRequestDigest: row.inputControlRequestDigest ?? null,
    inputControlDigest: row.inputControlDigest ?? null,
  };
}

function canonicalFlatJson(value: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)),
  ));
}

async function exactSupersessionEdgeIsValid(
  ctx: Pick<MutationCtx, "db">,
  edge: Doc<"missionSupervisorSupersessions">,
  missionId: Id<"missions">,
): Promise<boolean> {
  if (
    edge.protocolVersion !== 1
    || String(edge.missionId) !== String(missionId)
    || String(edge.predecessorJobId) === String(edge.successorJobId)
    || !Number.isSafeInteger(edge.decisionOrdinal)
    || edge.decisionOrdinal < 0
    || edge.decisionOrdinal >= SUPERVISOR_JOB_CONTROL_MAX_JOBS
    || !Number.isSafeInteger(edge.generation)
    || edge.generation < 1
    || edge.generation > MISSION_SUPERVISOR_MAX_RECOVERY_GENERATION
    || !Number.isSafeInteger(edge.autonomousRecoveryCount)
    || edge.autonomousRecoveryCount < 0
    || edge.autonomousRecoveryCount
      > MISSION_SUPERVISOR_MAX_AUTONOMOUS_RECOVERIES
    || edge.supersessionDigest !== await sha256Hex(
      canonicalFlatJson(supersessionDigestPayload(edge)),
    )
  ) {
    return false;
  }
  const [predecessor, successor, root] = await Promise.all([
    ctx.db.get(edge.predecessorJobId),
    ctx.db.get(edge.successorJobId),
    ctx.db.get(edge.rootJobId),
  ]);
  if (
    !predecessor
    || !successor
    || !root
    || predecessor.missionId !== String(missionId)
    || successor.missionId !== String(missionId)
    || root.missionId !== String(missionId)
  ) {
    return false;
  }
  const [
    predecessorTerminal,
    predecessorScheduling,
    successorProvenance,
    successorScheduling,
    order,
    inputControl,
  ] =
    await Promise.all([
      exactTerminalWorkReceipt(ctx, predecessor),
      readJobSchedulingAuthority(ctx, predecessor),
      readExactSupervisorJobDecisionProvenance(ctx, successor),
      readJobSchedulingAuthority(ctx, successor),
      readJobWorkOrderAuthority(ctx, successor),
      edge.inputControlReceiptId
        ? ctx.db.get(edge.inputControlReceiptId)
        : Promise.resolve(null),
    ]);
  if (
    !predecessorTerminal
    || !predecessorScheduling
    || !successorProvenance.ok
    || successorProvenance.decision.kind !== "recover"
    || successorProvenance.provenance.decisionKey !== edge.decisionKey
    || successorProvenance.provenance.ordinal !== edge.decisionOrdinal
    || successorProvenance.decision.observedInputRevision
      !== edge.observedInputRevision
    || !successorProvenance.decision.supersessionIds
    || edge.decisionOrdinal
      >= successorProvenance.decision.supersessionIds.length
    || String(
      successorProvenance.decision.supersessionIds[edge.decisionOrdinal],
    ) !== String(edge._id)
    || edge.predecessorAttempt !== predecessorTerminal.receipt.attempt
    || String(edge.predecessorReceiptId)
      !== String(predecessorTerminal.receipt._id)
    || edge.predecessorReceiptDigest
      !== predecessorTerminal.receipt.receiptDigest
    || !successorScheduling
    || !order
    || predecessorScheduling.binding.canonicalProjectId
      !== successorScheduling.binding.canonicalProjectId
    || predecessorScheduling.binding.projectRepository
      !== successorScheduling.binding.projectRepository
    || predecessorScheduling.binding.sourceAdmissionDigest
      !== successorScheduling.binding.sourceAdmissionDigest
    || successorScheduling.digest !== edge.successorSchedulingBindingDigest
    || String(order.row._id) !== String(edge.successorWorkOrderRevisionId)
    || order.digest !== edge.successorWorkOrderRevisionDigest
    || successor.canonicalProjectId !== edge.successorCanonicalProjectId
    || successor.repo !== edge.successorRepository
    || successor.sourceAdmissionDigest !== edge.successorSourceAdmissionDigest
  ) {
    return false;
  }
  const inputControlValid = edge.mode === "input_revision"
    ? Boolean(
      inputControl
      && String(inputControl.missionId) === String(missionId)
      && inputControl.action === "provide_input"
      && inputControl.applied
      && !inputControl.noop
      && inputControl.scope
        === `terminal_leaf_recovery_input:${String(predecessor._id)}`
      && inputControl.requestDigest === edge.inputControlRequestDigest
      && inputControl.inputDigest === edge.inputControlDigest
      && inputControl.resultInputRevision === edge.observedInputRevision
      && inputControl.expectedInputRevision + 1
        === edge.observedInputRevision
    )
    : !edge.inputControlReceiptId
      && !edge.inputControlRequestDigest
      && !edge.inputControlDigest;
  const disposition = predecessorTerminal.receipt.recoveryDisposition;
  const permitted =
    (edge.mode === "retry" && disposition === "retryable")
    || (
      edge.mode === "remediate"
      && (disposition === "retryable" || disposition === "remediable")
    )
    || (
      edge.mode === "input_revision"
      && ["retryable", "remediable", "needs_input", "operator_stop"].includes(
        disposition ?? "",
      )
      && inputControlValid
      && Number.isSafeInteger(
        predecessorTerminal.receipt.observedInputRevision,
      )
      && edge.observedInputRevision
        > Number(predecessorTerminal.receipt.observedInputRevision)
    );
  if (!inputControlValid || !permitted) return false;
  return true;
}

async function exactSupervisorRecoveryLineageIsValid(
  ctx: Pick<MutationCtx, "db">,
  missionId: Id<"missions">,
  members: readonly SupervisorJobControlMemberPlan[],
): Promise<boolean> {
  const edges = await ctx.db
    .query("missionSupervisorSupersessions")
    .withIndex("by_mission_created", (q) => q.eq("missionId", missionId))
    .take(SUPERVISOR_JOB_CONTROL_MAX_JOBS + 1);
  if (edges.length > Math.max(0, members.length - 1)) {
    return false;
  }
  const membersById = new Map(
    members.map((member) => [String(member.job._id), member]),
  );
  const incoming = new Map<
    string,
    Doc<"missionSupervisorSupersessions">
  >();
  const outgoing = new Map<
    string,
    Doc<"missionSupervisorSupersessions">
  >();
  const keys = new Set<string>();
  const rootGenerations = new Set<string>();
  for (const edge of edges) {
    const predecessorId = String(edge.predecessorJobId);
    const successorId = String(edge.successorJobId);
    const rootGeneration = `${String(edge.rootJobId)}:${edge.generation}`;
    if (
      !membersById.has(predecessorId)
      || !membersById.has(successorId)
      || outgoing.has(predecessorId)
      || incoming.has(successorId)
      || keys.has(edge.supersessionKey)
      || rootGenerations.has(rootGeneration)
      || !await exactSupersessionEdgeIsValid(
        ctx,
        edge,
        missionId,
      )
    ) {
      return false;
    }
    outgoing.set(predecessorId, edge);
    incoming.set(successorId, edge);
    keys.add(edge.supersessionKey);
    rootGenerations.add(rootGeneration);
  }
  for (const member of members) {
    const edge = incoming.get(String(member.job._id));
    if (
      member.provenance.decision.kind === "recover"
        ? !edge
        : Boolean(edge)
    ) {
      return false;
    }
  }

  type RecoveryNode = {
    rootJobId: Id<"jobs">;
    generation: number;
    autonomousRecoveryCount: number;
  };
  const nodes = new Map<string, RecoveryNode>();
  const visiting = new Set<string>();
  const resolve = (jobId: string): RecoveryNode | null => {
    const existing = nodes.get(jobId);
    if (existing) return existing;
    if (visiting.has(jobId)) return null;
    const member = membersById.get(jobId);
    if (!member) return null;
    visiting.add(jobId);
    const edge = incoming.get(jobId);
    let node: RecoveryNode;
    if (!edge) {
      node = {
        rootJobId: member.job._id,
        generation: 0,
        autonomousRecoveryCount: 0,
      };
    } else {
      const parent = resolve(String(edge.predecessorJobId));
      if (!parent) return null;
      node = {
        rootJobId: parent.rootJobId,
        generation: parent.generation + 1,
        autonomousRecoveryCount:
          parent.autonomousRecoveryCount
          + (edge.mode === "input_revision" ? 0 : 1),
      };
      if (
        String(edge.rootJobId) !== String(node.rootJobId)
        || edge.generation !== node.generation
        || edge.autonomousRecoveryCount !== node.autonomousRecoveryCount
      ) {
        return null;
      }
    }
    visiting.delete(jobId);
    nodes.set(jobId, node);
    return node;
  };
  return members.every((member) => Boolean(resolve(String(member.job._id))));
}

async function terminalMemberAuthorityIsValid(
  ctx: Pick<MutationCtx, "db">,
  member: SupervisorJobControlMemberPlan,
): Promise<boolean> {
  const terminal = await exactTerminalWorkReceipt(ctx, member.job);
  if (!terminal) return false;
  const dispatch = await exactDispatchReceipt(ctx, member);
  if (
    !dispatch.ok
    || (
      dispatch.receipt
      && !["closed", "superseded"].includes(dispatch.receipt.status)
    )
  ) {
    return false;
  }
  if (
    member.job.deliveryLeaseOwner
    || member.job.deliveryLeaseToken
    || member.job.deliveryLeaseUntil
    || (
      !member.job.activeDeliveryAttemptId
      && member.job.deliveryRunId
    )
  ) {
    return false;
  }
  if (member.job.activeDeliveryAttemptId) {
    if (
      !Number.isSafeInteger(member.job.deliveryGeneration)
      || Number(member.job.deliveryGeneration) < 1
    ) {
      return false;
    }
    const deliveries = await ctx.db
      .query("deliveryAttempts")
      .withIndex("by_job_source_generation", (q) =>
        q
          .eq("jobId", member.job._id)
          .eq("sourceWorkAttempt", member.attemptNumber)
          .eq("generation", Number(member.job.deliveryGeneration))
      )
      .take(2);
    const delivery = deliveries[0];
    if (
      deliveries.length !== 1
      || !delivery
      || String(delivery._id)
        !== String(member.job.activeDeliveryAttemptId)
      || String(delivery.jobId) !== String(member.job._id)
      || delivery.sourceWorkAttempt !== member.attemptNumber
      || delivery.generation !== member.job.deliveryGeneration
      || !["done", "blocked", "abandoned"].includes(delivery.status)
      || !delivery.completedAt
      || delivery.leaseOwner
      || delivery.leaseToken
      || delivery.leaseUntil
      || deliveryHasUnresolvedProviderEffect(delivery)
    ) {
      return false;
    }
  }
  if (member.job.integrationAttemptId) {
    const integration = await ctx.db.get(member.job.integrationAttemptId);
    if (
      !integration
      || String(integration.jobId) !== String(member.job._id)
      || !["integrated", "conflict", "stale", "cancelled"].includes(
        integration.status,
      )
      || !integration.completedAt
      || integration.leaseOwner
      || integration.leaseToken
      || integration.leaseUntil
      || (
        integration.preparedEffectId
        && !RESOLVED_PROVIDER_EFFECT_OBSERVATIONS.has(
          String(integration.providerObservation ?? ""),
        )
      )
    ) {
      return false;
    }
  }
  return true;
}

export async function preflightSupervisorPauseResumeBatch(
  ctx: Pick<MutationCtx, "db">,
  args: {
    missionId: Id<"missions">;
    action: "pause" | "resume";
    jobs: readonly Doc<"jobs">[];
    expectedTotalJobs: number;
    targetJobIds?: readonly Id<"jobs">[];
  },
): Promise<SupervisorPauseResumePreflightResult> {
  const preflight = await preflightSupervisorJobControlBatch(ctx, {
    missionId: args.missionId,
    action: args.action,
    jobs: args.jobs,
    expectedTotalJobs: args.expectedTotalJobs,
    ...(args.action === "resume"
      ? { targetJobIds: args.targetJobIds ?? [] }
      : {}),
  });
  if (!preflight.ok) {
    return pauseResumeFailure(preflight.reason, args.jobs.find((job) =>
      String(job._id) === String(preflight.jobId ?? "")
    ));
  }
  if (
    preflight.plan.members.some((member) =>
      member.disposition === "terminal_unchanged"
    )
    && !await exactSupervisorRecoveryLineageIsValid(
      ctx,
      args.missionId,
      preflight.plan.members,
    )
  ) {
    return pauseResumeFailure("invalid_terminal_authority");
  }

  const members: SupervisorPauseResumeMemberPlan[] = [];
  for (const member of preflight.plan.members) {
    if (
      member.disposition === "terminal_unchanged"
      && !await terminalMemberAuthorityIsValid(ctx, member)
    ) {
      return pauseResumeFailure("invalid_terminal_authority", member.job);
    }
    if (member.disposition !== "eligible") {
      members.push({
        member,
        approval: null,
        dispatchReceipt: null,
        dispatchDisposition: "none",
        deliveryAttempt: null,
        reviewReceipt: null,
      });
      continue;
    }
    const approval = await exactPendingApproval(ctx, member.job);
    if (!approval.ok) {
      return pauseResumeFailure(approval.reason, member.job);
    }
    const delivery = await exactDeliveryAuthority(ctx, member);
    if (!delivery.ok) {
      return pauseResumeFailure(delivery.reason, member.job);
    }
    const dispatch = await exactDispatchReceipt(ctx, member);
    if (!dispatch.ok) {
      return pauseResumeFailure(dispatch.reason, member.job);
    }
    if (
      !Number.isSafeInteger(Number(member.job.deliveryLeaseVersion ?? 0))
      || Number(member.job.deliveryLeaseVersion ?? 0) < 0
      || Number(member.job.deliveryLeaseVersion ?? 0)
        >= Number.MAX_SAFE_INTEGER
      || (
        delivery.delivery?.leaseVersion !== undefined
        && (
          !Number.isSafeInteger(delivery.delivery.leaseVersion)
          || delivery.delivery.leaseVersion < 0
          || delivery.delivery.leaseVersion >= Number.MAX_SAFE_INTEGER
        )
      )
    ) {
      return pauseResumeFailure("invalid_delivery_authority", member.job);
    }

    if (args.action === "pause") {
      if (
        delivery.delivery
        && (
          (member.job.status === "running"
            && delivery.delivery.status !== "running")
          || (
            member.job.status !== "running"
            && delivery.delivery.status !== "checkpointed"
          )
        )
      ) {
        return pauseResumeFailure("invalid_delivery_authority", member.job);
      }
      const dispatchDisposition = dispatchDispositionForPause(
        member,
        dispatch.receipt,
        delivery.delivery,
      );
      if (!dispatchDisposition) {
        return pauseResumeFailure("invalid_dispatch_authority", member.job);
      }
      members.push({
        member,
        approval: approval.approval,
        dispatchReceipt: dispatch.receipt,
        dispatchDisposition,
        deliveryAttempt: delivery.delivery,
        reviewReceipt: delivery.review,
      });
      continue;
    }

    if (!member.currentAttempt) {
      return pauseResumeFailure("missing_attempt_authority", member.job);
    }
    if (
      delivery.delivery
      && delivery.delivery.status !== "checkpointed"
    ) {
      return pauseResumeFailure("invalid_delivery_authority", member.job);
    }
    if (!dispatchIsClosedForResume(member, dispatch.receipt)) {
      return pauseResumeFailure("pause_checkpoint_pending", member.job);
    }
    let resumeDisposition: ResumeControlDisposition;
    let resumeAttemptNumber = member.attemptNumber;
    let resumeDeliveryGeneration: number | undefined;
    if (delivery.delivery) {
      resumeDisposition = "delivery";
      resumeDeliveryGeneration = delivery.delivery.generation + 1;
      if (!Number.isSafeInteger(resumeDeliveryGeneration)) {
        return pauseResumeFailure("invalid_delivery_authority", member.job);
      }
      const nextDeliveries = await ctx.db
        .query("deliveryAttempts")
        .withIndex("by_job_source_generation", (q) =>
          q
            .eq("jobId", member.job._id)
            .eq("sourceWorkAttempt", member.attemptNumber)
            .eq("generation", resumeDeliveryGeneration!)
        )
        .take(2);
      if (nextDeliveries.length !== 0) {
        return pauseResumeFailure(
          nextDeliveries.length > 1
            ? "ambiguous_delivery_authority"
            : "invalid_delivery_authority",
          member.job,
        );
      }
    } else if (approval.approval) {
      if (
        member.currentAttempt.workerRunId
        || member.currentAttempt.sessionId
        || member.currentAttempt.launchedAt
      ) {
        return pauseResumeFailure("invalid_approval_authority", member.job);
      }
      resumeDisposition = "approval";
    } else {
      const launched = Boolean(
        member.currentAttempt.workerRunId
        || member.currentAttempt.sessionId
        || member.currentAttempt.launchedAt,
      );
      if (launched) {
        if (
          member.currentAttempt.status !== "paused"
          || !member.currentAttempt.completedAt
        ) {
          return pauseResumeFailure("pause_checkpoint_pending", member.job);
        }
        resumeAttemptNumber = member.attemptNumber + 1;
        if (resumeAttemptNumber > Number(member.job.maxAttempts ?? 12)) {
          return pauseResumeFailure("attempt_budget_exhausted", member.job);
        }
        const nextAttempt = await readExactWorkAttempt(
          ctx,
          member.job._id,
          resumeAttemptNumber,
        );
        if (nextAttempt.kind !== "missing") {
          return pauseResumeFailure(
            nextAttempt.kind === "ambiguous"
              ? "ambiguous_attempt_authority"
              : "next_attempt_authority_conflict",
            member.job,
          );
        }
        resumeDisposition = "fresh_attempt";
      } else {
        if (
          member.currentAttempt.status !== "paused"
          || member.currentAttempt.completedAt
        ) {
          return pauseResumeFailure("invalid_attempt_authority", member.job);
        }
        resumeDisposition = "reuse_attempt";
      }
    }
    members.push({
      member,
      approval: approval.approval,
      dispatchReceipt: dispatch.receipt,
      dispatchDisposition: "none",
      deliveryAttempt: delivery.delivery,
      reviewReceipt: delivery.review,
      resumeDisposition,
      resumeAttemptNumber,
      resumeDeliveryGeneration,
    });
  }
  return {
    ok: true,
    plan: {
      control: preflight.plan,
      members,
    },
  };
}

function assertGenericPatchIsSafe(patch: Record<string, unknown>): void {
  const fields = Object.keys(patch);
  if (fields.length === 0) {
    throw new Error("Supervisor batch job patch cannot be empty");
  }
  if (fields.some((field) => FORBIDDEN_GENERIC_BATCH_PATCH_FIELDS.has(field))) {
    throw new Error(
      "Supervisor batch authority fields require their dedicated transition",
    );
  }
}

/**
 * Patch every eligible preflight member exactly once, suppressing per-job
 * supervisor wakes and queue rebuilds. The outer mutation must first commit
 * attempt/delivery/approval/receipt changes required by its action, then call
 * `refreshSupervisorJobControlGroups` once with the returned group keys.
 */
export async function applySupervisorJobRuntimePatchBatch(
  ctx: Pick<MutationCtx, "db">,
  plan: SupervisorJobControlPlan,
  patches: readonly SupervisorJobRuntimePatch[],
): Promise<SupervisorJobBatchPatchResult> {
  if (
    plan.members.length > SUPERVISOR_JOB_CONTROL_MAX_JOBS
    || patches.length > SUPERVISOR_JOB_CONTROL_MAX_JOBS
  ) {
    throw new Error("Supervisor job control batch exceeds its bounded limit");
  }
  const eligible = new Map(
    plan.members
      .filter((member) => member.disposition === "eligible")
      .map((member) => [String(member.job._id), member]),
  );
  if (patches.length !== eligible.size) {
    throw new Error(
      "Supervisor batch must patch every eligible job exactly once",
    );
  }

  const patched = new Set<string>();
  const patchedJobIds: Id<"jobs">[] = [];
  const touchedGroups = new Set<string>();
  for (const operation of patches) {
    const key = String(operation.jobId);
    const member = eligible.get(key);
    if (!member || patched.has(key)) {
      throw new Error("Supervisor batch patch membership is invalid");
    }
    assertGenericPatchIsSafe(operation.patch);
    const result = await patchJobWithRuntimeForSupervisorBatch(
      ctx,
      member.job,
      operation.patch,
    );
    patched.add(key);
    patchedJobIds.push(member.job._id);
    if (
      result.queueRefreshRequired
      && result.schedulingGroupKey
    ) {
      touchedGroups.add(result.schedulingGroupKey);
    }
  }
  return {
    patchedJobIds,
    touchedSchedulingGroupKeys: [...touchedGroups],
  };
}

function invalidatedDeliveryLease(job: Doc<"jobs">) {
  return {
    deliveryLeaseVersion: Number(job.deliveryLeaseVersion ?? 0) + 1,
    deliveryLeaseOwner: undefined,
    deliveryLeaseToken: undefined,
    deliveryLeaseUntil: undefined,
  };
}

function carriedDeliveryAuthority(delivery: Doc<"deliveryAttempts">) {
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

export async function applySupervisorPauseBatch(
  ctx: Pick<MutationCtx, "db">,
  plan: SupervisorPauseResumePlan,
  now = Date.now(),
): Promise<SupervisorJobBatchPatchResult> {
  if (plan.control.action !== "pause") {
    throw new Error("Supervisor pause apply requires a pause preflight");
  }
  const patches: SupervisorJobRuntimePatch[] = [];
  for (const planned of plan.members) {
    const { member } = planned;
    if (member.disposition !== "eligible") continue;
    const attempt = member.currentAttempt ?? await ensureWorkAttempt(
      ctx,
      member.job,
      member.attemptNumber,
      String(member.job.status),
      now,
      {},
      true,
    );
    if (!planned.deliveryAttempt) {
      await ctx.db.patch(attempt._id, {
        status: "paused",
        ...(planned.dispatchDisposition === "preserve_claimed"
          ? {}
          : { dispatchId: undefined }),
        lastEventAt: now,
      });
    }
    if (
      planned.dispatchReceipt
      && planned.dispatchDisposition === "supersede"
    ) {
      await ctx.db.patch(planned.dispatchReceipt._id, {
        status: "superseded",
        closeReason: "supervisor pause superseded unclaimed dispatch",
        leaseUntil: undefined,
        closedAt: now,
        updatedAt: now,
      });
    }
    if (
      planned.dispatchReceipt
      && planned.dispatchDisposition === "close_checkpointed_delivery"
    ) {
      await ctx.db.patch(planned.dispatchReceipt._id, {
        status: "closed",
        closeReason: "supervisor pause checkpointed verified delivery",
        leaseUntil: undefined,
        closedAt: now,
        updatedAt: now,
      });
    }
    if (planned.deliveryAttempt) {
      await ctx.db.patch(planned.deliveryAttempt._id, {
        status: "checkpointed",
        retryReason: "paused by atomic supervisor control",
        dispatchId: undefined,
        deliveryRunId: undefined,
        leaseOwner: undefined,
        leaseToken: undefined,
        leaseUntil: undefined,
        heartbeatAt: now,
        updatedAt: now,
      });
    }
    const preserveClaimed =
      planned.dispatchDisposition === "preserve_claimed";
    patches.push({
      jobId: member.job._id,
      patch: {
        ...invalidatedDeliveryLease(member.job),
        status: "paused",
        stage: "paused",
        progress: "paused by atomic supervisor control",
        nextRunAt: undefined,
        heartbeatAt: now,
        ...(preserveClaimed
          ? {}
          : {
            dispatchId: undefined,
            dispatchLeaseUntil: undefined,
            workerRunId: undefined,
            deliveryRunId: undefined,
          }),
      },
    });
  }
  return await applySupervisorJobRuntimePatchBatch(
    ctx,
    plan.control,
    patches,
  );
}

export async function applySupervisorResumeBatch(
  ctx: Pick<MutationCtx, "db">,
  plan: SupervisorPauseResumePlan,
  now = Date.now(),
): Promise<SupervisorJobBatchPatchResult> {
  if (plan.control.action !== "resume") {
    throw new Error("Supervisor resume apply requires a resume preflight");
  }
  const patches: SupervisorJobRuntimePatch[] = [];
  for (const planned of plan.members) {
    const { member } = planned;
    if (member.disposition !== "eligible") continue;
    const currentAttempt = member.currentAttempt;
    if (!currentAttempt || !planned.resumeDisposition) {
      throw new Error("Supervisor resume plan is incomplete");
    }
    let activeDeliveryAttemptId = member.job.activeDeliveryAttemptId;
    let deliveryGeneration = member.job.deliveryGeneration;
    if (planned.resumeDisposition === "delivery") {
      if (
        !planned.deliveryAttempt
        || planned.resumeDeliveryGeneration === undefined
      ) {
        throw new Error("Supervisor delivery resume plan is incomplete");
      }
      const prior = planned.deliveryAttempt;
      deliveryGeneration = planned.resumeDeliveryGeneration;
      activeDeliveryAttemptId = await ctx.db.insert("deliveryAttempts", {
        jobId: member.job._id,
        sourceWorkAttempt: member.attemptNumber,
        generation: deliveryGeneration,
        policy: prior.policy,
        status: "checkpointed",
        parentDeliveryAttemptId: prior._id,
        ...carriedDeliveryAuthority(prior),
        heartbeatAt: now,
        retries: 0,
        cumulativeRetries: Number(prior.cumulativeRetries ?? 0),
        currentStep: prior.currentStep === "receipt" ? "receipt" : "queued",
        retryReason: "resumed by atomic supervisor control",
        createdAt: now,
        updatedAt: now,
      });
    } else if (planned.resumeDisposition === "fresh_attempt") {
      const nextAttempt = planned.resumeAttemptNumber;
      if (nextAttempt === undefined) {
        throw new Error("Supervisor fresh attempt plan is incomplete");
      }
      await ensureWorkAttempt(
        ctx,
        member.job,
        nextAttempt,
        "pending",
        now,
        {
          parentAttempt: member.attemptNumber,
          sourceHeadSha: member.job.sourceHeadSha,
          parentCheckpointHeadSha: currentAttempt.checkpointHeadSha,
        },
        true,
      );
    } else {
      await ctx.db.patch(currentAttempt._id, {
        status: planned.resumeDisposition === "approval"
          ? "awaiting_approval"
          : "queued",
        dispatchId: undefined,
        lastEventAt: now,
      });
    }

    const awaitingApproval = planned.resumeDisposition === "approval";
    const delivery = planned.resumeDisposition === "delivery";
    const attempt = planned.resumeAttemptNumber ?? member.attemptNumber;
    patches.push({
      jobId: member.job._id,
      patch: {
        ...invalidatedDeliveryLease(member.job),
        status: awaitingApproval ? "awaiting_approval" : "pending",
        stage: awaitingApproval ? "approval" : delivery ? "delivery" : "queued",
        progress: awaitingApproval
          ? "resumed — protected approval still required"
          : delivery
            ? "verified delivery resumed — fresh controller generation queued"
            : "resumed by atomic supervisor control",
        attempt,
        startedAt: undefined,
        completedAt: undefined,
        heartbeatAt: now,
        progressAt: now,
        nextRunAt: awaitingApproval ? undefined : now,
        dispatchId: undefined,
        dispatchLeaseUntil: undefined,
        workerRunId: undefined,
        deliveryRunId: undefined,
        ...(delivery
          ? {
            activeDeliveryAttemptId,
            deliveryGeneration,
          }
          : {}),
      },
    });
  }
  return await applySupervisorJobRuntimePatchBatch(
    ctx,
    plan.control,
    patches,
  );
}

/**
 * Append and activate one steered work order under batch side-effect rules.
 * Attempt and approval transitions remain the outer mutation's responsibility.
 */
export async function transitionSupervisorJobWorkOrderRevision(
  ctx: Pick<MutationCtx, "db">,
  member: SupervisorJobControlMemberPlan,
  changes: Record<string, unknown>,
  statePatch: Record<string, unknown>,
) {
  if (member.disposition !== "eligible") {
    throw new Error("Only an eligible supervisor job may be revised");
  }
  const revised = await transitionJobWorkOrderRevision(
    ctx,
    member.job,
    changes,
    statePatch,
    {
      supervisorSignal: "suppress",
      queueRefresh: "deferred",
    },
  );
  return {
    job: revised,
    queueRefreshRequired: Object.keys(statePatch).some((field) =>
      QUEUE_AUTHORITY_FIELDS.has(field)
    ),
    schedulingGroupKey: member.schedulingGroupKey,
  };
}

/**
 * Rebuild each touched queue projection once. Empty/evidence-only group keys
 * never enter the list; a missing or ambiguous admitted group fails the outer
 * transaction rather than committing stale scheduling truth.
 */
export async function refreshSupervisorJobControlGroups(
  ctx: Pick<MutationCtx, "db">,
  groupKeys: readonly string[],
  now = Date.now(),
): Promise<string[]> {
  if (groupKeys.length > SUPERVISOR_JOB_CONTROL_MAX_JOBS) {
    throw new Error("Supervisor queue refresh exceeds its bounded limit");
  }
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const raw of groupKeys) {
    const groupKey = raw.trim();
    if (!groupKey || groupKey.length > 1_200) {
      throw new Error("Supervisor queue refresh contains an invalid group");
    }
    if (seen.has(groupKey)) continue;
    seen.add(groupKey);
    unique.push(groupKey);
  }
  for (const groupKey of unique) {
    const refreshed = await refreshWorkGroupQueueProjection(
      ctx,
      groupKey,
      now,
    );
    if (!refreshed) {
      throw new Error(
        "Supervisor queue refresh requires one exact scheduling group",
      );
    }
  }
  return unique;
}
