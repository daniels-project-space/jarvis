// Atomic compact projections for the live agent control plane. The helpers in
// this file are intentionally database-only so every durable writer can use
// them in the same Convex transaction without calling another function.

import {
  canonicalSchedulingBinding,
  DISPATCH_SCHEDULER_KEY,
  projectedSchedulingBindingMatches,
  schedulingBindingForJob,
  schedulingAuthorityMatches,
  SCHEDULING_PROTOCOL_VERSION,
  workGroupAuthority,
  type SchedulingBinding,
  type WorkGroupAuthority,
} from "../src/lib/work-scheduler";
import { workItemIdentity } from "../src/lib/workspace-protocol";

function defined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

export function projectJobRuntime(job: any) {
  const createdAt = Number(job.createdAt ?? job._creationTime ?? Date.now());
  const active = ["running", "dispatching", "pending", "awaiting_approval", "paused", "stalled", "needs_input", "steering"].includes(String(job.status));
  return defined({
    jobId: job._id,
    // The overlay needs enough context to identify the task, not the full
    // multi-thousand-character specialist prompt.
    task: String(job.task ?? "Agent work").slice(0, 600),
    label: typeof job.label === "string" ? job.label.slice(0, 80) : undefined,
    repo: typeof job.repo === "string" ? job.repo.slice(0, 120) : undefined,
    status: String(job.status ?? "pending").slice(0, 40),
    visibility: typeof job.visibility === "string" ? job.visibility.slice(0, 24) : undefined,
    incidentId: typeof job.incidentId === "string" ? job.incidentId.slice(0, 120) : undefined,
    missionId: typeof job.missionId === "string" ? job.missionId.slice(0, 120) : undefined,
    originThreadId: typeof job.originThreadId === "string" ? job.originThreadId.slice(0, 120) : undefined,
    agentId: typeof job.agentId === "string" ? job.agentId.slice(0, 40) : undefined,
    model: typeof job.model === "string" ? job.model.slice(0, 24) : undefined,
    reasoningEffort: typeof job.reasoningEffort === "string" ? job.reasoningEffort.slice(0, 24) : undefined,
    modelReason: typeof job.modelReason === "string" ? job.modelReason.slice(0, 300) : undefined,
    risk: typeof job.risk === "string" ? job.risk.slice(0, 24) : undefined,
    priority: Math.max(0, Math.min(100, Number(job.priority ?? 50))),
    approvalRequired: typeof job.approvalRequired === "boolean" ? job.approvalRequired : undefined,
    approvalStatus: typeof job.approvalStatus === "string" ? job.approvalStatus.slice(0, 32) : undefined,
    stage: String(job.stage ?? job.status ?? "pending").slice(0, 80),
    percent: Math.max(0, Math.min(100, Number(job.percent ?? 0))),
    progress: typeof job.progress === "string" ? job.progress.slice(0, 400) : undefined,
    attempt: Math.max(1, Number(job.attempt ?? 1)),
    maxAttempts: Math.max(1, Number(job.maxAttempts ?? 12)),
    heartbeatAt: Number(job.heartbeatAt ?? job.startedAt ?? createdAt),
    progressAt: Number(job.progressAt ?? job.startedAt ?? createdAt),
    stallCount: Math.max(0, Number(job.stallCount ?? 0)),
    stalledAt: typeof job.stalledAt === "number" ? job.stalledAt : undefined,
    stallReason: typeof job.stallReason === "string" ? job.stallReason.slice(0, 400) : undefined,
    steerRevision: Math.max(0, Number(job.steerRevision ?? 0)),
    active,
    nextRunAt: typeof job.nextRunAt === "number" ? job.nextRunAt : undefined,
    dispatchId: typeof job.dispatchId === "string" ? job.dispatchId.slice(0, 180) : undefined,
    dispatchLeaseUntil: typeof job.dispatchLeaseUntil === "number" ? job.dispatchLeaseUntil : undefined,
    workerRunId: typeof job.workerRunId === "string" ? job.workerRunId.slice(0, 120) : undefined,
    workerRuntime: typeof job.workerRuntime === "string" ? job.workerRuntime.slice(0, 40) : undefined,
    providerRunState: typeof job.providerRunState === "string" ? job.providerRunState.slice(0, 40) : undefined,
    providerObservedAt: typeof job.providerObservedAt === "number" ? job.providerObservedAt : undefined,
    readonly: typeof job.readonly === "boolean" ? job.readonly : undefined,
    parentJobId: typeof job.parentJobId === "string" ? job.parentJobId.slice(0, 120) : undefined,
    dependsOn: Array.isArray(job.dependsOn) ? job.dependsOn.slice(0, 16).map((id: unknown) => String(id).slice(0, 120)) : undefined,
    planParentMissionId: job.planParentMissionId,
    planDigest: typeof job.planDigest === "string" ? job.planDigest.slice(0, 64) : undefined,
    planGeneration: typeof job.planGeneration === "number" ? job.planGeneration : undefined,
    planNodeId: typeof job.planNodeId === "string" ? job.planNodeId.slice(0, 80) : undefined,
    goalStage: typeof job.goalStage === "string" ? job.goalStage.slice(0, 40) : undefined,
    goalWorkstreamId: typeof job.goalWorkstreamId === "string" ? job.goalWorkstreamId.slice(0, 120) : undefined,
    goalWave: typeof job.goalWave === "number" ? job.goalWave : undefined,
    missionGroupId: typeof job.missionGroupId === "string" ? job.missionGroupId.slice(0, 240) : undefined,
    projectGroupId: typeof job.projectGroupId === "string" ? job.projectGroupId.slice(0, 240) : undefined,
    projectRepository: typeof job.projectRepository === "string" ? job.projectRepository.slice(0, 120) : undefined,
    schedulingGroupKey: typeof job.schedulingGroupKey === "string" ? job.schedulingGroupKey.slice(0, 1_200) : undefined,
    schedulingProtocolVersion: typeof job.schedulingProtocolVersion === "number" ? job.schedulingProtocolVersion : undefined,
    schedulingAdmissionId: job.schedulingAdmissionId,
    schedulingBindingDigest: typeof job.schedulingBindingDigest === "string" ? job.schedulingBindingDigest.slice(0, 64) : undefined,
    schedulingBound: job.schedulingBound === true,
    dispatchReady: job.dispatchReady === true,
    sourceBranch: typeof job.sourceBranch === "string" ? job.sourceBranch.slice(0, 240) : undefined,
    sourceHeadSha: typeof job.sourceHeadSha === "string" ? job.sourceHeadSha.slice(0, 80) : undefined,
    integrationBranch: typeof job.integrationBranch === "string" ? job.integrationBranch.slice(0, 240) : undefined,
    workerBranch: typeof job.workerBranch === "string" ? job.workerBranch.slice(0, 240) : undefined,
    workspaceLineage: typeof job.workspaceLineage === "string" ? job.workspaceLineage.slice(0, 240) : undefined,
    retryLineage: typeof job.retryLineage === "string" ? job.retryLineage.slice(0, 240) : undefined,
    integrationAttemptId: job.integrationAttemptId,
    integrationState: typeof job.integrationState === "string" ? job.integrationState.slice(0, 40) : undefined,
    evidenceSummary: typeof job.evidenceSummary === "string" ? job.evidenceSummary.slice(0, 500) : undefined,
    branch: typeof job.branch === "string" ? job.branch.slice(0, 240) : undefined,
    pullRequestUrl: typeof job.pullRequestUrl === "string" ? job.pullRequestUrl.slice(0, 500) : undefined,
    deliveryMode: typeof job.deliveryMode === "string" ? job.deliveryMode.slice(0, 32) : undefined,
    deliveryStatus: typeof job.deliveryStatus === "string" ? job.deliveryStatus.slice(0, 32) : undefined,
    mergeCommitSha: typeof job.mergeCommitSha === "string" ? job.mergeCommitSha.slice(0, 80) : undefined,
    deliveryLeaseVersion: Math.max(0, Number(job.deliveryLeaseVersion ?? 0)),
    deliveryGeneration: Math.max(0, Number(job.deliveryGeneration ?? 0)),
    deliveryRunId: job.deliveryRunId,
    startedAt: typeof job.startedAt === "number" ? job.startedAt : undefined,
    completedAt: typeof job.completedAt === "number" ? job.completedAt : undefined,
    createdAt,
    updatedAt: Math.max(
      createdAt,
      Number(job.startedAt ?? 0),
      Number(job.heartbeatAt ?? 0),
      Number(job.completedAt ?? 0),
      Number(job.updatedAt ?? 0),
    ),
  });
}

export function projectMissionRuntime(mission: any) {
  const createdAt = Number(mission.createdAt ?? mission._creationTime ?? Date.now());
  return defined({
    missionId: mission._id,
    goal: String(mission.goal ?? "Agent mission").slice(0, 500),
    mode: String(mission.mode ?? "fleet").slice(0, 24),
    status: String(mission.status ?? "running").slice(0, 40),
    agentCount: Math.max(0, Number(mission.agentCount ?? 0)),
    originThreadId: typeof mission.originThreadId === "string" ? mission.originThreadId.slice(0, 120) : undefined,
    managerAgentId: typeof mission.managerAgentId === "string" ? mission.managerAgentId.slice(0, 40) : undefined,
    priority: Math.max(0, Math.min(100, Number(mission.priority ?? 50))),
    phase: String(mission.phase ?? mission.status ?? "running").slice(0, 80),
    percent: Math.max(0, Math.min(100, Number(mission.percent ?? 0))),
    route: typeof mission.route === "string" ? mission.route.slice(0, 80) : undefined,
    primaryRepo: typeof mission.primaryRepo === "string" ? mission.primaryRepo.slice(0, 120) : undefined,
    revisionWave: Math.max(0, Number(mission.revisionWave ?? 0)),
    maxRevisionWaves: Math.max(0, Number(mission.maxRevisionWaves ?? 0)),
    maxBuildSessions: Math.max(0, Number(mission.maxBuildSessions ?? 0)),
    planningJobId: typeof mission.planningJobId === "string" ? mission.planningJobId.slice(0, 120) : undefined,
    validatorJobId: typeof mission.validatorJobId === "string" ? mission.validatorJobId.slice(0, 120) : undefined,
    planDigest: typeof mission.planDigest === "string" ? mission.planDigest.slice(0, 64) : undefined,
    planGeneration: typeof mission.planGeneration === "number" ? mission.planGeneration : undefined,
    planNodeCount: typeof mission.planNodeCount === "number" ? mission.planNodeCount : undefined,
    sourceBranch: typeof mission.sourceBranch === "string" ? mission.sourceBranch.slice(0, 240) : undefined,
    integrationBranch: typeof mission.integrationBranch === "string" ? mission.integrationBranch.slice(0, 240) : undefined,
    integrationHeadSha: typeof mission.integrationHeadSha === "string" ? mission.integrationHeadSha.slice(0, 80) : undefined,
    integrationGeneration: Math.max(0, Number(mission.integrationGeneration ?? 0)),
    activeIntegrationAttemptId: mission.activeIntegrationAttemptId,
    integrationLeaseUntil: typeof mission.integrationLeaseUntil === "number" ? mission.integrationLeaseUntil : undefined,
    advanceLeaseOwner: typeof mission.advanceLeaseOwner === "string" ? mission.advanceLeaseOwner.slice(0, 120) : undefined,
    advanceLeaseVersion: Math.max(0, Number(mission.advanceLeaseVersion ?? 0)),
    advanceLeaseHeartbeatAt: typeof mission.advanceLeaseHeartbeatAt === "number" ? mission.advanceLeaseHeartbeatAt : undefined,
    advanceLeaseUntil: typeof mission.advanceLeaseUntil === "number" ? mission.advanceLeaseUntil : undefined,
    pausedPhase: typeof mission.pausedPhase === "string" ? mission.pausedPhase.slice(0, 80) : undefined,
    failureReason: typeof mission.failureReason === "string" ? mission.failureReason.slice(0, 600) : undefined,
    externalKind: typeof mission.externalKind === "string" ? mission.externalKind.slice(0, 80) : undefined,
    externalRunId: typeof mission.externalRunId === "string" ? mission.externalRunId.slice(0, 160) : undefined,
    externalSlug: typeof mission.externalSlug === "string" ? mission.externalSlug.slice(0, 160) : undefined,
    externalStatus: typeof mission.externalStatus === "string" ? mission.externalStatus.slice(0, 80) : undefined,
    externalStage: typeof mission.externalStage === "string" ? mission.externalStage.slice(0, 120) : undefined,
    externalPollFailures: Math.max(0, Number(mission.externalPollFailures ?? 0)),
    externalControlRequested: typeof mission.externalControlRequested === "string" ? mission.externalControlRequested.slice(0, 24) : undefined,
    externalRevisionRequested: typeof mission.externalRevisionRequested === "string" ? mission.externalRevisionRequested.slice(0, 24) : undefined,
    externalRevisionWave: typeof mission.externalRevisionWave === "number" ? mission.externalRevisionWave : undefined,
    externalActionFailures: Math.max(0, Number(mission.externalActionFailures ?? 0)),
    completedAt: typeof mission.completedAt === "number" ? mission.completedAt : undefined,
    createdAt,
    updatedAt: Number(mission.updatedAt ?? createdAt),
  });
}

export async function jobRuntimeFor(ctx: any, jobId: any) {
  return await ctx.db
    .query("jobRuntime")
    .withIndex("by_job", (q: any) => q.eq("jobId", jobId))
    .first();
}

export async function missionRuntimeFor(ctx: any, missionId: any) {
  return await ctx.db
    .query("missionRuntime")
    .withIndex("by_mission", (q: any) => q.eq("missionId", missionId))
    .first();
}

export async function upsertJobRuntime(ctx: any, job: any) {
  const existing = await jobRuntimeFor(ctx, job._id);
  // A rollout backfill may meet a row that a live heartbeat already created.
  // Preserve that newer activity while the authoritative status still agrees;
  // a status mismatch is recovery evidence and is rebuilt from the job.
  const source = existing && existing.status === job.status
    ? mergeJobRuntimeSource(job, {}, existing)
    : job;
  const projected = projectJobRuntime(source);
  if (existing) await ctx.db.replace(existing._id, projected);
  else await ctx.db.insert("jobRuntime", projected);
}

const LIVE_JOB_ACTIVITY_FIELDS = ["stage", "percent", "progress", "heartbeatAt", "progressAt", "providerRunState", "providerObservedAt", "updatedAt"] as const;

// Progress heartbeats intentionally do not rewrite the durable job. When a
// later authority transition patches an unrelated field (for example a pull
// request receipt), retain the newer compact activity instead of rebuilding it
// from the deliberately stale durable progress snapshot.
export function mergeJobRuntimeSource(
  job: Record<string, unknown>,
  patch: Record<string, unknown>,
  activity?: Record<string, unknown> | null,
) {
  const merged: Record<string, unknown> = { ...job, ...patch, _id: job._id };
  if (!activity) return merged;
  for (const field of LIVE_JOB_ACTIVITY_FIELDS) {
    if (!(field in patch) && activity[field] !== undefined) merged[field] = activity[field];
  }
  return merged;
}

export async function upsertMissionRuntime(ctx: any, mission: any) {
  const projected = projectMissionRuntime(mission);
  const existing = await missionRuntimeFor(ctx, mission._id);
  if (existing) await ctx.db.replace(existing._id, projected);
  else await ctx.db.insert("missionRuntime", projected);
}

/* eslint-disable @typescript-eslint/no-explicit-any -- shared internal Convex document helpers follow this module's rollout-compatible shape */
function persistedAuthorityConflicts(job: any, expected: WorkGroupAuthority) {
  return (["missionGroupId", "projectGroupId", "projectRepository", "schedulingGroupKey"] as const)
    .some((field) => job[field] !== undefined && job[field] !== expected[field]);
}

const IMMUTABLE_JOB_BINDING_FIELDS = [
  "repo", "readonly", "missionId", "planParentMissionId",
  "missionGroupId", "projectGroupId", "projectRepository", "schedulingGroupKey",
  "schedulingProtocolVersion", "schedulingAdmissionId", "schedulingBindingDigest", "schedulingBound",
  "workerBranch", "workspaceLineage", "retryLineage",
] as const;

async function sha256Hex(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function identityForJob(job: any) {
  const jobId = String(job._id);
  return workItemIdentity({
    missionId: job.missionId ?? `standalone-${jobId}`,
    jobId,
    workstreamId: job.goalWorkstreamId ?? job.label,
    readonly: Boolean(job.readonly || !job.repo),
  });
}

function admissionMatchesBinding(admission: any, binding: SchedulingBinding, digest: string) {
  return admission
    && Number(admission.protocolVersion) === SCHEDULING_PROTOCOL_VERSION
    && String(admission.jobId) === binding.jobId
    && admission.missionGroupId === binding.missionGroupId
    && admission.projectGroupId === binding.projectGroupId
    && admission.projectRepository === binding.projectRepository
    && admission.schedulingGroupKey === binding.schedulingGroupKey
    && Boolean(admission.readonly) === binding.readonly
    && admission.workerBranch === binding.workerBranch
    && admission.workspaceLineage === binding.workspaceLineage
    && admission.retryLineage === binding.retryLineage
    && admission.bindingDigest === digest;
}

async function schedulingGroupForBinding(ctx: any, binding: SchedulingBinding) {
  const rows = await ctx.db.query("workGroupScheduling")
    .withIndex("by_group", (q: any) => q.eq("groupKey", binding.schedulingGroupKey)).take(2);
  if (rows.length > 1) return null;
  const existing = rows[0];
  if (existing && (
    existing.missionGroupId !== binding.missionGroupId
    || existing.projectGroupId !== binding.projectGroupId
    || existing.projectRepository !== binding.projectRepository
  )) return null;
  if (existing) return existing;
  const scheduler = await ctx.db.query("dispatchSchedulerState")
    .withIndex("by_key", (q: any) => q.eq("key", DISPATCH_SCHEDULER_KEY)).first();
  const now = Date.now();
  const value = {
    groupKey: binding.schedulingGroupKey,
    missionGroupId: binding.missionGroupId,
    projectGroupId: binding.projectGroupId,
    projectRepository: binding.projectRepository,
    lastServedSequence: Number(scheduler?.nextSequence ?? 0),
    reservationCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  const id = await ctx.db.insert("workGroupScheduling", value);
  return { ...value, _id: id };
}

/** Point-read the one immutable admission bound to this durable job. */
export async function readJobSchedulingAuthority(ctx: any, job: any) {
  if (!job?.schedulingBound || Number(job.schedulingProtocolVersion) !== SCHEDULING_PROTOCOL_VERSION
    || !job.schedulingAdmissionId || typeof job.schedulingBindingDigest !== "string") return null;
  const binding = schedulingBindingForJob(job);
  if (!binding || !schedulingAuthorityMatches(job, binding)) return null;
  const digest = await sha256Hex(canonicalSchedulingBinding(binding));
  if (digest !== job.schedulingBindingDigest) return null;
  const admission = await ctx.db.get(job.schedulingAdmissionId);
  if (!admissionMatchesBinding(admission, binding, digest)) return null;
  return { binding, admission, digest };
}

export function runtimeMatchesSchedulingAuthority(runtime: any, authority: {
  binding: SchedulingBinding;
  admission: any;
  digest: string;
}) {
  return runtime?.schedulingBound === true
    && runtime?.dispatchReady === true
    && projectedSchedulingBindingMatches(
      runtime,
      authority.binding,
      authority.admission._id,
      authority.digest,
    );
}

/**
 * Bind a legacy or newly inserted job to one immutable fair-scheduling group.
 * Any later repository/mission substitution conflicts with this admission and
 * fails closed before a worker reservation exists.
 */
export async function ensureJobSchedulingAuthority(ctx: any, job: any, dispatchReady?: boolean) {
  const derived = workGroupAuthority(job);
  if (persistedAuthorityConflicts(job, derived)) return null;
  const identity = identityForJob(job);
  if ((job.workspaceLineage !== undefined && job.workspaceLineage !== identity.workspaceLineage)
    || (job.retryLineage !== undefined && job.retryLineage !== identity.retryLineage)
    || (identity.workerBranch && job.workerBranch !== undefined && job.workerBranch !== identity.workerBranch)) return null;
  const normalized = {
    ...job,
    ...derived,
    readonly: Boolean(job.readonly || !job.repo),
    workerBranch: identity.workerBranch,
    workspaceLineage: identity.workspaceLineage,
    retryLineage: identity.retryLineage,
    sourceBranch: job.sourceBranch ?? job.branch,
    branch: identity.workerBranch ?? job.branch,
    dispatchReady: dispatchReady ?? job.dispatchReady ?? (!Array.isArray(job.dependsOn) || job.dependsOn.length === 0),
  };
  const binding = schedulingBindingForJob(normalized);
  if (!binding) return null;
  const digest = await sha256Hex(canonicalSchedulingBinding(binding));
  const admissions = await ctx.db.query("jobSchedulingAdmissions")
    .withIndex("by_job", (q: any) => q.eq("jobId", job._id)).take(2);
  if (admissions.length > 1) return null;
  let admission = admissions[0];
  if (admission) {
    const authorityCompatible = admission.missionGroupId === binding.missionGroupId
      && admission.projectGroupId === binding.projectGroupId
      && admission.projectRepository === binding.projectRepository
      && admission.schedulingGroupKey === binding.schedulingGroupKey;
    if (!authorityCompatible || (admission.protocolVersion !== undefined && !admissionMatchesBinding(admission, binding, digest))) return null;
    if (admission.protocolVersion === undefined) {
      await ctx.db.patch(admission._id, {
        protocolVersion: SCHEDULING_PROTOCOL_VERSION,
        readonly: binding.readonly,
        workerBranch: binding.workerBranch,
        workspaceLineage: binding.workspaceLineage,
        retryLineage: binding.retryLineage,
        bindingDigest: digest,
      });
      admission = { ...admission, protocolVersion: SCHEDULING_PROTOCOL_VERSION, readonly: binding.readonly,
        workerBranch: binding.workerBranch, workspaceLineage: binding.workspaceLineage,
        retryLineage: binding.retryLineage, bindingDigest: digest };
    }
  } else {
    const value = {
      protocolVersion: SCHEDULING_PROTOCOL_VERSION,
      jobId: job._id,
      missionGroupId: binding.missionGroupId,
      projectGroupId: binding.projectGroupId,
      projectRepository: binding.projectRepository,
      schedulingGroupKey: binding.schedulingGroupKey,
      readonly: binding.readonly,
      workerBranch: binding.workerBranch,
      workspaceLineage: binding.workspaceLineage,
      retryLineage: binding.retryLineage,
      bindingDigest: digest,
      createdAt: Date.now(),
    };
    const id = await ctx.db.insert("jobSchedulingAdmissions", value);
    admission = { ...value, _id: id };
  }
  const scheduling = await schedulingGroupForBinding(ctx, binding);
  if (!scheduling) return null;
  const boundJob = { ...normalized,
    schedulingProtocolVersion: SCHEDULING_PROTOCOL_VERSION,
    schedulingAdmissionId: admission._id,
    schedulingBindingDigest: digest,
    schedulingBound: true,
  };
  const boundPatch = { ...boundJob };
  delete boundPatch._id;
  delete boundPatch._creationTime;
  await ctx.db.patch(job._id, boundPatch);
  await upsertJobRuntime(ctx, boundJob);
  return { job: boundJob, admission, binding, scheduling };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function insertJobWithRuntime(ctx: any, value: any) {
  const normalized = {
    ...value,
    readonly: Boolean(value.readonly || !value.repo),
    dispatchReady: value.dispatchReady ?? (!Array.isArray(value.dependsOn) || value.dependsOn.length === 0),
  };
  const jobId = await ctx.db.insert("jobs", normalized);
  const provisional = { ...normalized, _id: jobId };
  const identity = identityForJob(provisional);
  const authority = workGroupAuthority(provisional);
  const isolated = {
    ...provisional,
    ...authority,
    sourceBranch: provisional.sourceBranch ?? provisional.branch,
    workerBranch: identity.workerBranch,
    workspaceLineage: identity.workspaceLineage,
    retryLineage: identity.retryLineage,
    branch: identity.workerBranch ?? provisional.branch,
  };
  const binding = schedulingBindingForJob(isolated);
  if (!binding) throw new Error("Job scheduling authority could not be derived");
  const digest = await sha256Hex(canonicalSchedulingBinding(binding));
  const admissionValue = {
    protocolVersion: SCHEDULING_PROTOCOL_VERSION,
    jobId,
    missionGroupId: binding.missionGroupId,
    projectGroupId: binding.projectGroupId,
    projectRepository: binding.projectRepository,
    schedulingGroupKey: binding.schedulingGroupKey,
    readonly: binding.readonly,
    workerBranch: binding.workerBranch,
    workspaceLineage: binding.workspaceLineage,
    retryLineage: binding.retryLineage,
    bindingDigest: digest,
    createdAt: Date.now(),
  };
  const admissionId = await ctx.db.insert("jobSchedulingAdmissions", admissionValue);
  const scheduling = await schedulingGroupForBinding(ctx, binding);
  if (!scheduling) throw new Error("Job scheduling group conflicts with immutable admission");
  const admitted = {
    ...isolated,
    schedulingProtocolVersion: SCHEDULING_PROTOCOL_VERSION,
    schedulingAdmissionId: admissionId,
    schedulingBindingDigest: digest,
    schedulingBound: true,
  };
  const admittedPatch = { ...admitted };
  delete admittedPatch._id;
  delete admittedPatch._creationTime;
  await ctx.db.patch(jobId, admittedPatch);
  await ctx.db.insert("jobRuntime", projectJobRuntime(admitted));
  return jobId;
}

export async function patchJobWithRuntime(ctx: any, job: any, patch: Record<string, unknown>) {
  const prospective = { ...job, ...patch };
  if (job.schedulingBound && IMMUTABLE_JOB_BINDING_FIELDS.some((field) => field in patch && patch[field] !== job[field])) {
    throw new Error("Immutable job scheduling authority cannot be changed");
  }
  if (job.schedulingBound && (!schedulingAuthorityMatches(job) || !schedulingAuthorityMatches(prospective))) {
    throw new Error("Immutable job scheduling authority is invalid");
  }
  const committedPatch = patch;
  const existing = await jobRuntimeFor(ctx, job._id);
  await ctx.db.patch(job._id, committedPatch);
  const projected = projectJobRuntime(mergeJobRuntimeSource(job, committedPatch, existing));
  if (existing) await ctx.db.replace(existing._id, projected);
  else await ctx.db.insert("jobRuntime", projected);
}

export async function quarantineJobRuntime(ctx: any, job: any, runtime?: any) {
  const existing = runtime ?? await jobRuntimeFor(ctx, job._id);
  if (!existing) return;
  const quarantined = defined({
    ...projectJobRuntime(job),
    schedulingBound: false,
    dispatchReady: false,
    nextRunAt: undefined,
  });
  await ctx.db.replace(existing._id, quarantined);
}

export async function promoteCompletedJobDependents(ctx: any, source: any, now = Date.now()) {
  if (!source.planParentMissionId || !source.planGeneration) return;
  const edges = await ctx.db.query("goalPlanEdges")
    .withIndex("by_source", (q: any) => q.eq("sourceJobId", source._id)
      .eq("planGeneration", Number(source.planGeneration))).take(9);
  const targetIds = [...new Set(edges.map((edge: any) => String(edge.targetJobId)))];
  for (const targetId of targetIds) {
    const id = ctx.db.normalizeId("jobs", targetId);
    const target: any = id ? await ctx.db.get(id) : null;
    if (!target || target.status !== "pending" || target.dispatchReady === true) continue;
    const dependencies = await Promise.all((target.dependsOn ?? []).map((dependency: string) => {
      const dependencyId = ctx.db.normalizeId("jobs", dependency);
      return dependencyId ? ctx.db.get(dependencyId) : null;
    }));
    if (dependencies.length !== (target.dependsOn ?? []).length
      || dependencies.some((dependency: any) => dependency?.status !== "done")) continue;
    await patchJobWithRuntime(ctx, target, {
      dispatchReady: true,
      nextRunAt: target.nextRunAt ?? now,
      progress: target.progress === "Queued · waiting for dependencies" ? "Queued · dependencies verified" : target.progress,
    });
  }
}

export async function insertMissionWithRuntime(ctx: any, value: any) {
  const missionId = await ctx.db.insert("missions", value);
  await upsertMissionRuntime(ctx, { ...value, _id: missionId });
  return missionId;
}

export async function patchMissionWithRuntime(ctx: any, mission: any, patch: Record<string, unknown>) {
  await ctx.db.patch(mission._id, patch);
  const existing = await missionRuntimeFor(ctx, mission._id);
  await upsertMissionRuntime(ctx, { ...(existing ?? mission), ...patch, _id: mission._id });
}

export function runtimeJob(row: any) {
  return {
    ...row,
    _id: row.jobId,
    log: "",
    checkpoint: null,
  };
}

export function runtimeMission(row: any) {
  return { ...row, _id: row.missionId };
}
