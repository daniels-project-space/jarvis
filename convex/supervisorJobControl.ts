import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import {
  patchJobWithRuntimeForSupervisorBatch,
  readExactWorkAttempt,
  refreshWorkGroupQueueProjection,
  transitionJobWorkOrderRevision,
  validateExactWorkAttemptExecutionAuthority,
} from "./controlPlane";
import {
  readExactSupervisorJobDecisionProvenance,
  type ExactSupervisorJobDecisionProvenance,
  type SupervisorDecisionProvenanceCache,
} from "./missionSupervisorWake";

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
  | "supervisor_integration_requires_reconciliation";

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

    const disposition = dispositionFor(args.action, String(job.status));
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
