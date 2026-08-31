// Atomic compact projections for the live agent control plane. The helpers in
// this file are intentionally database-only so every durable writer can use
// them in the same Convex transaction without calling another function.

import {
  canonicalAttemptAuthority,
  canonicalSchedulingBinding,
  DISPATCH_SCHEDULER_KEY,
  integrationLineageForAuthority,
  projectedSchedulingBindingMatches,
  schedulingBindingForJob,
  schedulingAuthorityMatches,
  SCHEDULING_PROTOCOL_VERSION,
  workGroupAuthority,
  type SchedulingBinding,
  type WorkGroupAuthority,
} from "../src/lib/work-scheduler";
import { attemptWorkspaceKey, workItemIdentity } from "../src/lib/workspace-protocol";
import {
  isSafeSourceBranch,
  projectSourceAdmissionIsValid,
  type ProjectSourceAdmission,
} from "../src/lib/source-admission";
import { routeWork } from "../src/mastra/routing";
import { normalizeWorkModelTier } from "../src/lib/work-models";
import { exactTextWorkOrder } from "../src/lib/work-order";
import {
  canonicalWorkOrderRevision,
  normalizeMinimumReasoningEffort,
  normalizeWorkOrderAcceptanceCriteria,
  normalizeWorkOrderMcpScope,
  normalizeWorkOrderToolScope,
  workOrderAgent,
  workOrderProjectionMatches,
  workOrderRevisionForJob,
  workOrderRevisionRowBinding,
  WORK_ORDER_MACHINE_CLASS,
  WORK_ORDER_REVISION_PROTOCOL_VERSION,
  type WorkOrderRevisionBinding,
} from "../src/lib/work-order-revision";
import { admittedTriggerMachine } from "../src/lib/trigger-machine";
import { signalMissionSupervisorForJobPatch } from "./missionSupervisorWake";
import type { Doc, Id } from "./_generated/dataModel";

function defined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

export function projectJobRuntime(job: any) {
  const createdAt = Number(job.createdAt ?? job._creationTime ?? Date.now());
  const pauseCheckpointPending = (
    job.status === "paused"
    && job.dispatchPhase === "specialist"
    && typeof job.dispatchId === "string"
    && typeof job.workerRunId === "string"
    && Boolean(job.dispatchReceiptId)
    && typeof job.dispatchReceiptDigest === "string"
    && typeof job.dispatchPayloadDigest === "string"
  ) ? true : undefined;
  // A paused cloud-workspace hold has already closed its exact dispatch
  // receipt.  It is resumable when a verified provider becomes available,
  // but it is not a live worker and must not occupy the conversation strip.
  const systemHeldCloudWorkspacePause = (
    job.status === "paused"
    && job.providerRunState === "blocked"
    && job.nextRunAt === undefined
  );
  const active = ["running", "dispatching", "pending", "awaiting_approval", "paused", "stalled", "needs_input", "steering"].includes(String(job.status))
    && !systemHeldCloudWorkspacePause;
  return defined({
    jobId: job._id,
    admissionProtocolVersion: typeof job.admissionProtocolVersion === "number" ? job.admissionProtocolVersion : undefined,
    protocolHoldReason: typeof job.protocolHoldReason === "string" ? job.protocolHoldReason.slice(0, 240) : undefined,
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
    agentRole: typeof job.agentRole === "string" ? job.agentRole.slice(0, 120) : undefined,
    machineClass: typeof job.machineClass === "string" ? job.machineClass.slice(0, 160) : undefined,
    triggerMachinePreset: typeof job.triggerMachinePreset === "string" ? job.triggerMachinePreset.slice(0, 24) : undefined,
    triggerMachineReason: typeof job.triggerMachineReason === "string" ? job.triggerMachineReason.slice(0, 80) : undefined,
    triggerObservedMachinePreset: typeof job.triggerObservedMachinePreset === "string" ? job.triggerObservedMachinePreset.slice(0, 24) : undefined,
    triggerObservedMachineReason: typeof job.triggerObservedMachineReason === "string" ? job.triggerObservedMachineReason.slice(0, 80) : undefined,
    triggerPlatformAttempt: typeof job.triggerPlatformAttempt === "number" ? job.triggerPlatformAttempt : undefined,
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
    pauseCheckpointPending,
    nextRunAt: typeof job.nextRunAt === "number" ? job.nextRunAt : undefined,
    dispatchId: typeof job.dispatchId === "string" ? job.dispatchId.slice(0, 180) : undefined,
    dispatchGeneration: typeof job.dispatchGeneration === "number" ? job.dispatchGeneration : undefined,
    dispatchPhase: typeof job.dispatchPhase === "string" ? job.dispatchPhase.slice(0, 24) : undefined,
    dispatchReceiptId: job.dispatchReceiptId,
    dispatchReceiptDigest: typeof job.dispatchReceiptDigest === "string" ? job.dispatchReceiptDigest.slice(0, 64) : undefined,
    dispatchPayloadDigest: typeof job.dispatchPayloadDigest === "string" ? job.dispatchPayloadDigest.slice(0, 64) : undefined,
    dispatchLeaseUntil: typeof job.dispatchLeaseUntil === "number" ? job.dispatchLeaseUntil : undefined,
    workerRunId: typeof job.workerRunId === "string" ? job.workerRunId.slice(0, 120) : undefined,
    workerRuntime: typeof job.workerRuntime === "string" ? job.workerRuntime.slice(0, 40) : undefined,
    providerRunState: typeof job.providerRunState === "string" ? job.providerRunState.slice(0, 40) : undefined,
    providerObservedAt: typeof job.providerObservedAt === "number" ? job.providerObservedAt : undefined,
    providerEffectLeaseUntil: typeof job.providerEffectLeaseUntil === "number"
      ? job.providerEffectLeaseUntil
      : undefined,
    cloudWorkspaceBlockCode: typeof job.cloudWorkspaceBlockCode === "string" ? job.cloudWorkspaceBlockCode.slice(0, 80) : undefined,
    controllerSessionHoldCode: typeof job.controllerSessionHoldCode === "string" ? job.controllerSessionHoldCode.slice(0, 80) : undefined,
    controllerSessionRepairRequired: job.controllerSessionRepairRequired === true ? true : undefined,
    controllerSessionRepairGeneration: typeof job.controllerSessionRepairGeneration === "number"
      ? job.controllerSessionRepairGeneration
      : undefined,
    controllerSessionHoldAt: typeof job.controllerSessionHoldAt === "number"
      ? job.controllerSessionHoldAt
      : undefined,
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
    canonicalProjectId: typeof job.canonicalProjectId === "string" ? job.canonicalProjectId.slice(0, 120) : undefined,
    projectRepository: typeof job.projectRepository === "string" ? job.projectRepository.slice(0, 120) : undefined,
    schedulingGroupKey: typeof job.schedulingGroupKey === "string" ? job.schedulingGroupKey.slice(0, 1_200) : undefined,
    schedulingProtocolVersion: typeof job.schedulingProtocolVersion === "number" ? job.schedulingProtocolVersion : undefined,
    schedulingAdmissionId: job.schedulingAdmissionId,
    schedulingBindingDigest: typeof job.schedulingBindingDigest === "string" ? job.schedulingBindingDigest.slice(0, 64) : undefined,
    schedulingBound: job.schedulingBound === true,
    workOrderRevision: typeof job.workOrderRevision === "number" ? job.workOrderRevision : undefined,
    workOrderRevisionDigest: typeof job.workOrderRevisionDigest === "string" ? job.workOrderRevisionDigest.slice(0, 64) : undefined,
    dispatchReady: job.dispatchReady === true,
    sourceProvider: typeof job.sourceProvider === "string" ? job.sourceProvider.slice(0, 24) : undefined,
    sourceBranch: typeof job.sourceBranch === "string" ? job.sourceBranch.slice(0, 240) : undefined,
    sourceRef: typeof job.sourceRef === "string" ? job.sourceRef.slice(0, 260) : undefined,
    sourceHeadSha: typeof job.sourceHeadSha === "string" ? job.sourceHeadSha.slice(0, 80) : undefined,
    sourceObservedAt: typeof job.sourceObservedAt === "number" ? job.sourceObservedAt : undefined,
    sourceAdmissionDigest: typeof job.sourceAdmissionDigest === "string" ? job.sourceAdmissionDigest.slice(0, 64) : undefined,
    integrationBranch: typeof job.integrationBranch === "string" ? job.integrationBranch.slice(0, 240) : undefined,
    workerBranch: typeof job.workerBranch === "string" ? job.workerBranch.slice(0, 240) : undefined,
    workerLineage: typeof job.workerLineage === "string" ? job.workerLineage.slice(0, 240) : undefined,
    workspaceLineage: typeof job.workspaceLineage === "string" ? job.workspaceLineage.slice(0, 240) : undefined,
    retryLineage: typeof job.retryLineage === "string" ? job.retryLineage.slice(0, 240) : undefined,
    integrationLineage: typeof job.integrationLineage === "string" ? job.integrationLineage.slice(0, 1_200) : undefined,
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
    admissionProtocolVersion: typeof mission.admissionProtocolVersion === "number" ? mission.admissionProtocolVersion : undefined,
    protocolHoldReason: typeof mission.protocolHoldReason === "string" ? mission.protocolHoldReason.slice(0, 240) : undefined,
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
    canonicalProjectId: typeof mission.canonicalProjectId === "string" ? mission.canonicalProjectId.slice(0, 120) : undefined,
    revisionWave: Math.max(0, Number(mission.revisionWave ?? 0)),
    maxRevisionWaves: Math.max(0, Number(mission.maxRevisionWaves ?? 0)),
    maxBuildSessions: Math.max(0, Number(mission.maxBuildSessions ?? 0)),
    planningJobId: typeof mission.planningJobId === "string" ? mission.planningJobId.slice(0, 120) : undefined,
    validatorJobId: typeof mission.validatorJobId === "string" ? mission.validatorJobId.slice(0, 120) : undefined,
    planDigest: typeof mission.planDigest === "string" ? mission.planDigest.slice(0, 64) : undefined,
    planGeneration: typeof mission.planGeneration === "number" ? mission.planGeneration : undefined,
    planNodeCount: typeof mission.planNodeCount === "number" ? mission.planNodeCount : undefined,
    materializationStatus: typeof mission.materializationStatus === "string" ? mission.materializationStatus.slice(0, 40) : undefined,
    materializationCursor: typeof mission.materializationCursor === "number" ? mission.materializationCursor : undefined,
    materializationWaitingApprovals: typeof mission.materializationWaitingApprovals === "number" ? mission.materializationWaitingApprovals : undefined,
    materializationCompletedAt: typeof mission.materializationCompletedAt === "number" ? mission.materializationCompletedAt : undefined,
    sourceBranch: typeof mission.sourceBranch === "string" ? mission.sourceBranch.slice(0, 240) : undefined,
    sourceHeadSha: typeof mission.sourceHeadSha === "string" ? mission.sourceHeadSha.slice(0, 80) : undefined,
    integrationBranch: typeof mission.integrationBranch === "string" ? mission.integrationBranch.slice(0, 240) : undefined,
    integrationHeadSha: typeof mission.integrationHeadSha === "string" ? mission.integrationHeadSha.slice(0, 80) : undefined,
    integrationObservedAt: typeof mission.integrationObservedAt === "number" ? mission.integrationObservedAt : undefined,
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

/**
 * Rebuild the one bounded queue head for an immutable project group. The
 * projection is never execution authority; selected jobs are still checked
 * against their admission and attempt ledgers before reservation. Keeping one
 * row per group makes every due group index-visible regardless of backlog
 * depth in another group.
 */
export async function refreshWorkGroupQueueProjection(ctx: any, groupKey: unknown, now = Date.now()) {
  if (typeof groupKey !== "string" || !groupKey) return null;
  const groups = await ctx.db.query("workGroupScheduling")
    .withIndex("by_group", (q: any) => q.eq("groupKey", groupKey)).take(2);
  if (groups.length !== 1) return null;
  const group = groups[0];
  let head = await ctx.db.query("jobRuntime")
    .withIndex("by_group_dispatch_ready", (q: any) => q
      .eq("schedulingGroupKey", groupKey)
      .eq("status", "pending")
      .eq("schedulingBound", true)
      .eq("dispatchReady", true)
      .gte("nextRunAt", 0))
    .order("asc")
    .first();
  // A compact row is not authority. If it was corrupted wholesale (including
  // its group key), the authoritative group's durable head is still the one
  // immutable pointer that can locate and repair it. Never discover work by
  // scanning another group or by trusting a mutable label/latest pointer.
  if (!head && group.queueHeadJobId) {
    const durable: any = await ctx.db.get(group.queueHeadJobId);
    const authority = durable ? await readJobSchedulingAuthority(ctx, durable) : null;
    if (durable?.status === "pending" && durable.dispatchReady === true
      && authority?.binding.schedulingGroupKey === groupKey) {
      const repaired = projectJobRuntime(durable);
      const existing = await jobRuntimeFor(ctx, durable._id);
      if (existing) await ctx.db.replace(existing._id, repaired);
      else await ctx.db.insert("jobRuntime", repaired);
      head = repaired;
    }
  }
  const queueHeadNextRunAt = typeof head?.nextRunAt === "number" ? head.nextRunAt : undefined;
  const patch = head && queueHeadNextRunAt !== undefined ? {
    queueHeadJobId: head.jobId,
    queueHeadNextRunAt,
    queueEligible: queueHeadNextRunAt <= now,
    updatedAt: now,
  } : {
    queueHeadJobId: undefined,
    queueHeadNextRunAt: undefined,
    queueEligible: false,
    updatedAt: now,
  };
  await ctx.db.patch(group._id, patch);
  return { ...group, ...patch };
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
  await refreshWorkGroupQueueProjection(ctx, projected.schedulingGroupKey);
}

const LIVE_JOB_ACTIVITY_FIELDS = [
  "stage",
  "percent",
  "progress",
  "heartbeatAt",
  "progressAt",
  "providerRunState",
  "providerObservedAt",
  "providerEffectLeaseUntil",
  "updatedAt",
] as const;

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
const IMMUTABLE_JOB_BINDING_FIELDS = [
  "repo", "readonly", "missionId", "planParentMissionId",
  "missionGroupId", "projectGroupId", "canonicalProjectId", "projectRepository", "schedulingGroupKey",
  "schedulingProtocolVersion", "schedulingAdmissionId", "schedulingBindingDigest", "schedulingBound",
  "sourceProvider", "sourceBranch", "sourceRef", "sourceHeadSha", "sourceObservedAt", "sourceAdmissionDigest",
  "workerBranch", "workerLineage", "workspaceLineage", "retryLineage", "integrationBranch", "integrationLineage",
] as const;

const ACTIVE_WORK_ORDER_FIELDS = [
  "task", "policyTask", "steer", "acceptanceCriteria", "repo", "readonly",
  "model", "reasoningEffort", "backgroundExecutionProfile", "mcp", "toolScope", "deliveryMode", "risk",
  "approvalRequired", "approvalReason", "agentId", "agentRole", "machineClass",
  "triggerMachinePreset", "triggerMachineReason",
  "workOrderProtocolVersion", "workOrderRevision", "workOrderRevisionId", "workOrderRevisionDigest",
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
    workstreamId: job.goalWorkstreamId,
    readonly: Boolean(job.readonly || !job.repo),
  });
}

function admissionMatchesBinding(admission: any, binding: SchedulingBinding, digest: string) {
  return admission
    && Number(admission.protocolVersion) === SCHEDULING_PROTOCOL_VERSION
    && String(admission.jobId) === binding.jobId
    && admission.missionGroupId === binding.missionGroupId
    && admission.projectGroupId === binding.projectGroupId
    && admission.canonicalProjectId === binding.canonicalProjectId
    && admission.projectRepository === binding.projectRepository
    && admission.schedulingGroupKey === binding.schedulingGroupKey
    && Boolean(admission.readonly) === binding.readonly
    && admission.sourceProvider === binding.sourceProvider
    && admission.sourceBranch === binding.sourceBranch
    && admission.sourceRef === binding.sourceRef
    && admission.sourceHeadSha === binding.sourceHeadSha
    && admission.sourceObservedAt === binding.sourceObservedAt
    && admission.sourceAdmissionDigest === binding.sourceAdmissionDigest
    && admission.workerBranch === binding.workerBranch
    && admission.workerLineage === binding.workerLineage
    && admission.workspaceLineage === binding.workspaceLineage
    && admission.retryLineage === binding.retryLineage
    && admission.integrationBranch === binding.integrationBranch
    && admission.integrationLineage === binding.integrationLineage
    && admission.bindingDigest === digest
    && admission.initialWorkOrderRevisionId
    && /^[0-9a-f]{64}$/.test(String(admission.initialWorkOrderRevisionDigest ?? ""));
}

async function schedulingGroupForBinding(ctx: any, binding: SchedulingBinding) {
  const rows = await ctx.db.query("workGroupScheduling")
    .withIndex("by_group", (q: any) => q.eq("groupKey", binding.schedulingGroupKey)).take(2);
  if (rows.length > 1) return null;
  const existing = rows[0];
  if (existing && (
    existing.missionGroupId !== binding.missionGroupId
    || existing.projectGroupId !== binding.projectGroupId
    || existing.canonicalProjectId !== binding.canonicalProjectId
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
    canonicalProjectId: binding.canonicalProjectId,
    projectRepository: binding.projectRepository,
    queueEligible: false,
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
  const initialRevision: any = await ctx.db.get(admission.initialWorkOrderRevisionId);
  const initialBinding = initialRevision ? workOrderRevisionRowBinding(initialRevision) : null;
  if (!initialBinding || initialBinding.jobId !== binding.jobId || initialBinding.revision !== 1
    || initialBinding.parentRevisionId || initialBinding.parentRevisionDigest
    || initialBinding.schedulingBindingDigest !== digest
    || initialRevision.revisionDigest !== admission.initialWorkOrderRevisionDigest
    || await sha256Hex(canonicalWorkOrderRevision(initialBinding)) !== admission.initialWorkOrderRevisionDigest) return null;
  return { binding, admission, digest };
}

/** Re-hash the active append-only executable revision and its direct parent. */
export async function readJobWorkOrderAuthority(ctx: any, job: any) {
  if (Number(job?.workOrderProtocolVersion) !== WORK_ORDER_REVISION_PROTOCOL_VERSION
    || !job?.workOrderRevisionId || !Number.isSafeInteger(job.workOrderRevision)
    || typeof job.workOrderRevisionDigest !== "string") return null;
  const row: any = await ctx.db.get(job.workOrderRevisionId);
  const binding = row ? workOrderRevisionRowBinding(row) : null;
  if (!binding || binding.jobId !== String(job._id) || binding.revision !== job.workOrderRevision
    || row.revisionDigest !== job.workOrderRevisionDigest
    || await sha256Hex(canonicalWorkOrderRevision(binding)) !== job.workOrderRevisionDigest
    || !workOrderProjectionMatches(job, binding)) return null;
  if (binding.revision > 1) {
    const parent: any = binding.parentRevisionId ? await ctx.db.get(binding.parentRevisionId as any) : null;
    const parentBinding = parent ? workOrderRevisionRowBinding(parent) : null;
    if (!parentBinding || parentBinding.jobId !== binding.jobId || parentBinding.revision !== binding.revision - 1
      || parent.revisionDigest !== binding.parentRevisionDigest
      || await sha256Hex(canonicalWorkOrderRevision(parentBinding)) !== binding.parentRevisionDigest) return null;
  }
  return { row, binding, digest: job.workOrderRevisionDigest };
}

async function attemptAuthorityEnvelope(ctx: any, job: any, attempt: number) {
  const authority = await readJobSchedulingAuthority(ctx, job);
  const workOrder = await readJobWorkOrderAuthority(ctx, job);
  if (!authority || !workOrder || workOrder.binding.schedulingBindingDigest !== authority.digest
    || !Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error("Attempt authority requires one admitted job and positive attempt");
  }
  const authorityDigest = await sha256Hex(canonicalAttemptAuthority({
    binding: authority.binding,
    bindingDigest: authority.digest,
    workOrderRevisionId: String(workOrder.row._id),
    workOrderRevision: workOrder.binding.revision,
    workOrderRevisionDigest: workOrder.digest,
    attempt,
  }));
  const fields = {
    authorityDigest,
    schedulingBindingDigest: authority.digest,
    workOrderRevisionId: workOrder.row._id,
    workOrderRevision: workOrder.binding.revision,
    workOrderRevisionDigest: workOrder.digest,
    canonicalProjectId: authority.binding.canonicalProjectId,
    repository: authority.binding.projectRepository,
    missionGroupId: authority.binding.missionGroupId,
    projectGroupId: authority.binding.projectGroupId,
    sourceBranch: authority.binding.sourceBranch,
    sourceHeadSha: authority.binding.sourceHeadSha,
    sourceAdmissionDigest: authority.binding.sourceAdmissionDigest,
    workerLineage: authority.binding.workerLineage,
    workspaceLineage: authority.binding.workspaceLineage,
    retryLineage: authority.binding.retryLineage,
    integrationLineage: authority.binding.integrationLineage,
  };
  return { fields, workOrder: workOrder.binding };
}

export async function attemptAuthorityFields(ctx: any, job: any, attempt: number) {
  return (await attemptAuthorityEnvelope(ctx, job, attempt)).fields;
}

export type ExactWorkAttemptLookup =
  | { kind: "missing" }
  | { kind: "ambiguous" }
  | { kind: "exact"; attempt: Doc<"workAttempts"> };

/**
 * Resolve one immutable attempt slot without allowing a duplicate row to win
 * by index order. Callers that mint or execute authority must distinguish a
 * genuinely empty slot from a corrupt/ambiguous one.
 */
export async function readExactWorkAttempt(
  ctx: any,
  jobId: Id<"jobs">,
  attempt: number,
): Promise<ExactWorkAttemptLookup> {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    return { kind: "ambiguous" };
  }
  const rows = await ctx.db
    .query("workAttempts")
    .withIndex("by_job_attempt", (q: any) =>
      q.eq("jobId", jobId).eq("attempt", attempt)
    )
    .take(2);
  if (rows.length === 0) return { kind: "missing" };
  if (rows.length !== 1) return { kind: "ambiguous" };
  return { kind: "exact", attempt: rows[0] };
}

/** Allocate one immutable attempt envelope for any admitted job producer. */
export async function ensureWorkAttempt(
  ctx: any,
  job: any,
  attempt: number,
  status: string,
  now = Date.now(),
  patch: Record<string, unknown> = {},
  knownMissing = false,
): Promise<Doc<"workAttempts">> {
  if (!knownMissing) {
    const existing = await readExactWorkAttempt(ctx, job._id, attempt);
    if (existing.kind === "ambiguous") {
      throw new Error("Work attempt authority is ambiguous");
    }
    if (existing.kind === "exact") return existing.attempt;
  }
  const workspaceLineage = job.workspaceLineage;
  const value = {
    jobId: job._id,
    attempt,
    status,
    ...await attemptAuthorityFields(ctx, job, attempt),
    workspaceLineage,
    workspaceKey: workspaceLineage ? attemptWorkspaceKey(workspaceLineage, attempt) : undefined,
    workerBranch: job.workerBranch,
    sourceHeadSha: job.sourceHeadSha,
    lastEventSeq: 0,
    livenessAt: now,
    progressAt: now,
    lastEventAt: now,
    createdAt: now,
    ...patch,
  };
  const id = await ctx.db.insert("workAttempts", value);
  // Convex supplies `_creationTime` on the committed document. Callers only
  // consume the schema fields assembled above within this same transaction.
  return { ...value, _id: id } as unknown as Doc<"workAttempts">;
}

/**
 * Point-read and re-hash the exact job/admission/attempt ledger envelope.
 * Historical rows without this v2 envelope remain visible but cannot execute.
 */
export async function validateExactWorkAttemptExecutionAuthority(
  ctx: any,
  job: any,
  attempt: Doc<"workAttempts">,
) {
  const attemptNumber = Number(attempt.attempt);
  if (
    String(attempt.jobId) !== String(job._id)
    || !Number.isSafeInteger(attemptNumber)
    || attemptNumber < 1
  ) {
    return null;
  }
  let envelope;
  try { envelope = await attemptAuthorityEnvelope(ctx, job, attemptNumber); }
  catch { return null; }
  const expected = envelope.fields;
  const fields = Object.keys(expected) as Array<keyof typeof expected>;
  if (fields.some((field) => attempt[field] !== expected[field])) return null;
  return { attempt, ...expected, workOrder: envelope.workOrder };
}

export async function readAttemptExecutionAuthority(ctx: any, job: any, attemptNumber: number) {
  const lookup = await readExactWorkAttempt(ctx, job._id, attemptNumber);
  if (lookup.kind !== "exact") return null;
  return await validateExactWorkAttemptExecutionAuthority(
    ctx,
    job,
    lookup.attempt,
  );
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

/* eslint-enable @typescript-eslint/no-explicit-any */

export async function insertJobWithRuntime(ctx: any, value: any) {
  const projectAdmission = value.projectAdmission as ProjectSourceAdmission | undefined;
  const requireFreshSourceAdmission = value.requireFreshSourceAdmission === true;
  const {
    projectAdmission: _projectAdmission,
    requireFreshSourceAdmission: _fresh,
    // Provider authority is derived only after the scheduling binding exists;
    // callers can never smuggle a profile into a job.
    backgroundExecutionProfile: _requestedBackgroundExecutionProfile,
    ...persistedValue
  } = value;
  if (!persistedValue.missionId) throw new Error("Executable work requires an immutable mission group id");
  if (!projectAdmission || !await projectSourceAdmissionIsValid(projectAdmission, {
    expectedRepository: persistedValue.repo,
    requireFresh: requireFreshSourceAdmission,
  })) throw new Error("Job requires one valid canonical project source admission");
  if (persistedValue.integrationBranch !== undefined && !isSafeSourceBranch(persistedValue.integrationBranch)) {
    throw new Error("Job integration branch is invalid");
  }
  const task = exactTextWorkOrder(String(persistedValue.task ?? ""));
  const policyTask = exactTextWorkOrder(String(persistedValue.policyTask ?? task));
  // Route from the canonical policy task, not the enriched execution text.
  // Goal Mode adds outcome/checkpoint scaffolding such as "overhaul" and
  // "Sol validator" to `task`; treating that scaffolding as user work silently
  // escalates every bounded evidence node to the most expensive tier.
  const routed = routeWork(policyTask, {
    repo: persistedValue.repo,
    requestedModel: persistedValue.model,
    readonly: persistedValue.readonly,
  });
  const agent = workOrderAgent(persistedValue.agentId) ?? workOrderAgent(routed.agentId);
  if (!agent) throw new Error("Job requires one canonical permanent-agent role");
  // `routeWork` is the durable routing authority, including hard/consequential
  // quality floors. Do not fall back to a specialist's static default here:
  // that would make every small Paul task run at Sol and would let an explicit
  // cheap model bypass the route's safety escalation.
  const model = normalizeWorkModelTier(routed.model, agent.defaultModel);
  const readonly = Boolean(persistedValue.readonly || !persistedValue.repo);
  const reasoningEffort = normalizeMinimumReasoningEffort(persistedValue.reasoningEffort, model);
  const triggerMachine = admittedTriggerMachine({ readonly, minimumModel: model, minimumReasoningEffort: reasoningEffort });
  const normalized = {
    ...persistedValue,
    task,
    policyTask,
    readonly,
    model,
    reasoningEffort,
    mcp: normalizeWorkOrderMcpScope(persistedValue.mcp),
    toolScope: normalizeWorkOrderToolScope(persistedValue.toolScope, readonly),
    acceptanceCriteria: normalizeWorkOrderAcceptanceCriteria(persistedValue.acceptanceCriteria),
    agentId: agent.agentId,
    agentRole: agent.agentRole,
    machineClass: WORK_ORDER_MACHINE_CLASS,
    triggerMachinePreset: triggerMachine.preset,
    triggerMachineReason: triggerMachine.reason,
    risk: String(persistedValue.risk ?? "low"),
    approvalRequired: persistedValue.approvalRequired === true,
    deliveryMode: String(persistedValue.deliveryMode ?? (readonly ? "read_only" : "manual")),
    canonicalProjectId: projectAdmission.canonicalProjectId,
    sourceProvider: projectAdmission.sourceProvider,
    sourceBranch: projectAdmission.sourceBranch,
    sourceRef: projectAdmission.sourceRef,
    sourceHeadSha: projectAdmission.sourceHeadSha,
    sourceObservedAt: projectAdmission.sourceObservedAt,
    sourceAdmissionDigest: projectAdmission.sourceAdmissionDigest,
    dispatchReady: persistedValue.dispatchReady ?? (!Array.isArray(persistedValue.dependsOn) || persistedValue.dependsOn.length === 0),
  };
  const jobId = await ctx.db.insert("jobs", normalized);
  const provisional = { ...normalized, _id: jobId };
  const identity = identityForJob(provisional);
  const authority = workGroupAuthority(provisional);
  const isolated = {
    ...provisional,
    ...authority,
    workerBranch: identity.workerBranch,
    workerLineage: identity.workerLineage,
    workspaceLineage: identity.workspaceLineage,
    retryLineage: identity.retryLineage,
    integrationLineage: integrationLineageForAuthority(authority),
    branch: identity.workerBranch,
  };
  const binding = schedulingBindingForJob(isolated);
  if (!binding) throw new Error("Job scheduling authority could not be derived");
  const digest = await sha256Hex(canonicalSchedulingBinding(binding));
  const initialWorkOrderBinding = workOrderRevisionForJob(
    { ...isolated, schedulingBindingDigest: digest },
    { revision: 1 },
  );
  if (!initialWorkOrderBinding) throw new Error("Job work-order authority could not be derived");
  const initialWorkOrderDigest = await sha256Hex(canonicalWorkOrderRevision(initialWorkOrderBinding));
  const initialWorkOrderRevisionId = await ctx.db.insert("workOrderRevisions", {
    ...initialWorkOrderBinding,
    jobId,
    revisionDigest: initialWorkOrderDigest,
    createdAt: Date.now(),
  });
  const admissionValue = {
    protocolVersion: SCHEDULING_PROTOCOL_VERSION,
    jobId,
    missionGroupId: binding.missionGroupId,
    projectGroupId: binding.projectGroupId,
    canonicalProjectId: binding.canonicalProjectId,
    projectRepository: binding.projectRepository,
    schedulingGroupKey: binding.schedulingGroupKey,
    readonly: binding.readonly,
    sourceProvider: binding.sourceProvider,
    sourceBranch: binding.sourceBranch,
    sourceRef: binding.sourceRef,
    sourceHeadSha: binding.sourceHeadSha,
    sourceObservedAt: binding.sourceObservedAt,
    sourceAdmissionDigest: binding.sourceAdmissionDigest,
    workerBranch: binding.workerBranch,
    workerLineage: binding.workerLineage,
    workspaceLineage: binding.workspaceLineage,
    retryLineage: binding.retryLineage,
    integrationBranch: binding.integrationBranch,
    integrationLineage: binding.integrationLineage,
    bindingDigest: digest,
    initialWorkOrderRevisionId,
    initialWorkOrderRevisionDigest: initialWorkOrderDigest,
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
    workOrderProtocolVersion: WORK_ORDER_REVISION_PROTOCOL_VERSION,
    workOrderRevision: 1,
    workOrderRevisionId: initialWorkOrderRevisionId,
    workOrderRevisionDigest: initialWorkOrderDigest,
    backgroundExecutionProfile: initialWorkOrderBinding.backgroundExecutionProfile,
  };
  const admittedPatch = { ...admitted };
  delete admittedPatch._id;
  delete admittedPatch._creationTime;
  await ctx.db.patch(jobId, admittedPatch);
  const runtime = projectJobRuntime(admitted);
  await ctx.db.insert("jobRuntime", runtime);
  await refreshWorkGroupQueueProjection(ctx, runtime.schedulingGroupKey);
  return jobId;
}

export type JobRuntimePatchOptions = {
  supervisorSignal?: "emit" | "suppress";
  queueRefresh?: "immediate" | "deferred";
};

type InternalJobRuntimePatchOptions = JobRuntimePatchOptions & {
  allowWorkOrderTransition?: boolean;
};

export type SupervisorBatchJobPatchResult = {
  job: Record<string, unknown>;
  queueRefreshRequired: boolean;
  schedulingGroupKey?: string;
};

async function patchJobWithRuntimeInternal(
  ctx: any,
  job: any,
  patch: Record<string, unknown>,
  options: InternalJobRuntimePatchOptions = {},
): Promise<SupervisorBatchJobPatchResult> {
  const allowWorkOrderTransition = options.allowWorkOrderTransition ?? false;
  const refreshQueue = (options.queueRefresh ?? "immediate") === "immediate";
  const prospective = { ...job, ...patch };
  if (job.schedulingBound && IMMUTABLE_JOB_BINDING_FIELDS.some((field) => field in patch && patch[field] !== job[field])) {
    throw new Error("Immutable job scheduling authority cannot be changed");
  }
  if (job.schedulingBound && (!schedulingAuthorityMatches(job) || !schedulingAuthorityMatches(prospective))) {
    throw new Error("Immutable job scheduling authority is invalid");
  }
  if (!allowWorkOrderTransition && job.workOrderRevisionId
    && ACTIVE_WORK_ORDER_FIELDS.some((field) => field in patch && patch[field] !== job[field])) {
    throw new Error("Active work-order authority can change only through an append-only revision");
  }
  const committedPatch = patch;
  if ((options.supervisorSignal ?? "emit") === "emit") {
    await signalMissionSupervisorForJobPatch(ctx, job, committedPatch);
  }
  const existing = await jobRuntimeFor(ctx, job._id);
  await ctx.db.patch(job._id, committedPatch);
  const projected = projectJobRuntime(mergeJobRuntimeSource(job, committedPatch, existing));
  if (existing) await ctx.db.replace(existing._id, projected);
  else await ctx.db.insert("jobRuntime", projected);
  const queueFields = new Set(["status", "nextRunAt", "dispatchReady", "schedulingBound", "priority"]);
  const queueRefreshRequired = Object.keys(patch).some((field) =>
    queueFields.has(field)
  );
  if (refreshQueue && queueRefreshRequired) {
    await refreshWorkGroupQueueProjection(ctx, projected.schedulingGroupKey);
  }
  return {
    job: prospective,
    queueRefreshRequired,
    schedulingGroupKey: typeof projected.schedulingGroupKey === "string"
      ? projected.schedulingGroupKey
      : undefined,
  };
}

export async function patchJobWithRuntime(ctx: any, job: any, patch: Record<string, unknown>) {
  await patchJobWithRuntimeInternal(ctx, job, patch);
}

/**
 * Update one member of a serialized dispatch batch without rebuilding the
 * same group head after every row. The caller must refresh each touched group
 * once before committing the batch.
 */
export async function patchJobWithRuntimeDeferredQueue(ctx: any, job: any, patch: Record<string, unknown>) {
  await patchJobWithRuntimeInternal(ctx, job, patch, {
    queueRefresh: "deferred",
  });
}

/**
 * Apply one member of a mission-level supervisor control transaction. The
 * outer mutation owns the single supervisor input revision and refreshes each
 * affected queue group once after every member has been patched.
 */
export async function patchJobWithRuntimeForSupervisorBatch(
  ctx: any,
  job: any,
  patch: Record<string, unknown>,
): Promise<SupervisorBatchJobPatchResult> {
  return await patchJobWithRuntimeInternal(ctx, job, patch, {
    supervisorSignal: "suppress",
    queueRefresh: "deferred",
  });
}

function activeWorkOrderPatch(
  binding: WorkOrderRevisionBinding,
  revisionId: any,
  revisionDigest: string,
) {
  return {
    task: binding.executableTask,
    policyTask: binding.policyTask,
    steer: binding.steeringInstruction,
    acceptanceCriteria: [...binding.acceptanceCriteria],
    readonly: binding.readonly,
    model: binding.minimumModel,
    reasoningEffort: binding.minimumReasoningEffort,
    backgroundExecutionProfile: binding.backgroundExecutionProfile,
    mcp: [...binding.mcpScope],
    toolScope: [...binding.toolScope],
    deliveryMode: binding.deliveryPolicy,
    risk: binding.risk,
    approvalRequired: binding.approvalRequired,
    approvalReason: binding.approvalReason,
    agentId: binding.agentId,
    agentRole: binding.agentRole,
    machineClass: binding.machineClass,
    triggerMachinePreset: binding.triggerMachinePreset,
    triggerMachineReason: binding.triggerMachineReason,
    workOrderProtocolVersion: WORK_ORDER_REVISION_PROTOCOL_VERSION,
    workOrderRevision: binding.revision,
    workOrderRevisionId: revisionId,
    workOrderRevisionDigest: revisionDigest,
    pendingWorkOrderRevisionId: undefined,
    pendingWorkOrderRevisionDigest: undefined,
  };
}

/**
 * Append a child revision without activating it. Integration steering uses
 * this while an earlier provider effect is reconciled under its old order.
 */
export async function stageJobWorkOrderRevision(
  ctx: any,
  job: any,
  changes: Record<string, unknown>,
  options: JobRuntimePatchOptions = {},
) {
  const current = await readJobWorkOrderAuthority(ctx, job);
  if (!current) throw new Error("Cannot append a revision to an invalid work order");
  const agent = workOrderAgent(changes.agentId ?? job.agentId);
  if (!agent) throw new Error("Work-order revision requires one canonical permanent-agent role");
  const model = normalizeWorkModelTier(changes.model ?? job.model, agent.defaultModel);
  const reasoningEffort = normalizeMinimumReasoningEffort(changes.reasoningEffort ?? job.reasoningEffort, model);
  const triggerMachine = admittedTriggerMachine({
    readonly: Boolean(job.readonly || !job.repo),
    minimumModel: model,
    minimumReasoningEffort: reasoningEffort,
  });
  const prospective = {
    ...job,
    ...changes,
    task: exactTextWorkOrder(String(changes.task ?? job.task)),
    policyTask: exactTextWorkOrder(String(changes.policyTask ?? job.policyTask ?? changes.task ?? job.task)),
    steer: typeof changes.steer === "string" && changes.steer.trim()
      ? changes.steer.trim().slice(0, 2_000)
      : changes.steer === undefined ? job.steer : undefined,
    acceptanceCriteria: normalizeWorkOrderAcceptanceCriteria(changes.acceptanceCriteria ?? job.acceptanceCriteria),
    model,
    reasoningEffort,
    mcp: normalizeWorkOrderMcpScope(changes.mcp ?? job.mcp),
    toolScope: normalizeWorkOrderToolScope(
      changes.toolScope ?? job.toolScope,
      Boolean(job.readonly || !job.repo),
    ),
    agentId: agent.agentId,
    agentRole: agent.agentRole,
    machineClass: WORK_ORDER_MACHINE_CLASS,
    triggerMachinePreset: triggerMachine.preset,
    triggerMachineReason: triggerMachine.reason,
  };
  const binding = workOrderRevisionForJob(prospective, {
    revision: current.binding.revision + 1,
    parentRevisionId: current.row._id,
    parentRevisionDigest: current.digest,
  });
  if (!binding || binding.schedulingBindingDigest !== current.binding.schedulingBindingDigest
    || binding.repository !== current.binding.repository || binding.sourceAdmissionDigest !== current.binding.sourceAdmissionDigest) {
    throw new Error("Work-order revision attempted to cross its immutable scheduling/source admission");
  }
  const digest = await sha256Hex(canonicalWorkOrderRevision(binding));
  if (job.pendingWorkOrderRevisionId && job.pendingWorkOrderRevisionDigest) {
    const pending: any = await ctx.db.get(job.pendingWorkOrderRevisionId);
    const pendingBinding = pending ? workOrderRevisionRowBinding(pending) : null;
    if (pendingBinding && pending.revisionDigest === digest
      && await sha256Hex(canonicalWorkOrderRevision(pendingBinding)) === digest) return { job, row: pending, binding: pendingBinding, digest };
  }
  const revisionId = await ctx.db.insert("workOrderRevisions", {
    ...binding,
    jobId: job._id,
    parentRevisionId: current.row._id,
    revisionDigest: digest,
    createdAt: Date.now(),
  });
  const pendingPatch = { pendingWorkOrderRevisionId: revisionId, pendingWorkOrderRevisionDigest: digest };
  await patchJobWithRuntimeInternal(ctx, job, pendingPatch, options);
  return { job: { ...job, ...pendingPatch }, row: { ...binding, _id: revisionId, revisionDigest: digest }, binding, digest };
}

/** Activate exactly the staged child revision together with a fresh state/attempt transition. */
export async function activateStagedJobWorkOrderRevision(
  ctx: any,
  job: any,
  statePatch: Record<string, unknown> = {},
  options: JobRuntimePatchOptions = {},
) {
  const current = await readJobWorkOrderAuthority(ctx, job);
  const revision: any = job.pendingWorkOrderRevisionId ? await ctx.db.get(job.pendingWorkOrderRevisionId) : null;
  const binding = revision ? workOrderRevisionRowBinding(revision) : null;
  if (!current || !binding || revision.revisionDigest !== job.pendingWorkOrderRevisionDigest
    || binding.jobId !== String(job._id) || binding.revision !== current.binding.revision + 1
    || binding.parentRevisionId !== String(current.row._id) || binding.parentRevisionDigest !== current.digest
    || await sha256Hex(canonicalWorkOrderRevision(binding)) !== revision.revisionDigest) {
    throw new Error("Staged work-order revision failed its immutable parent fence");
  }
  const patch = { ...statePatch, ...activeWorkOrderPatch(binding, revision._id, revision.revisionDigest) };
  await patchJobWithRuntimeInternal(ctx, job, patch, {
    ...options,
    allowWorkOrderTransition: true,
  });
  return { ...job, ...patch };
}

export async function transitionJobWorkOrderRevision(
  ctx: any,
  job: any,
  changes: Record<string, unknown>,
  statePatch: Record<string, unknown> = {},
  options: JobRuntimePatchOptions = {},
) {
  const staged = await stageJobWorkOrderRevision(ctx, job, changes, options);
  return await activateStagedJobWorkOrderRevision(
    ctx,
    staged.job,
    statePatch,
    options,
  );
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
  await refreshWorkGroupQueueProjection(ctx, quarantined.schedulingGroupKey);
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
    let sealed = true;
    for (const dependency of dependencies) {
      const handoff: any = await ctx.db.query("goalHandoffs")
        .withIndex("by_source_attempt", (q: any) => q.eq("sourceJobId", dependency._id)
          .eq("sourceAttempt", Number(dependency.attempt ?? 1))
          .eq("planGeneration", Number(target.planGeneration))).first();
      if (!handoff || handoff.handoffProtocolVersion !== 2
        || typeof handoff.handoffPayloadDigest !== "string"
        || typeof handoff.workReceiptId !== "string" || typeof handoff.workReceiptDigest !== "string"
        || handoff.parentMissionId !== target.planParentMissionId
        || handoff.planDigest !== target.planDigest || handoff.sourceNodeId !== dependency.planNodeId
        || handoff.sourceJobId !== dependency._id
        || handoff.workOrderRevisionId !== dependency.workOrderRevisionId
        || Number(handoff.workOrderRevision) !== Number(dependency.workOrderRevision)
        || handoff.workOrderRevisionDigest !== dependency.workOrderRevisionDigest
        || (dependency.repo && (handoff.reviewReceiptId !== dependency.reviewReceiptId
          || handoff.reviewReceiptDigest !== dependency.reviewReceiptDigest))
        || (dependency.repo && !dependency.readonly && (handoff.integrationAttemptId !== dependency.integrationAttemptId
          || typeof handoff.integrationTerminalReceiptId !== "string"
          || typeof handoff.integrationTerminalReceiptDigest !== "string"))
        || Number(handoff.sourceSteerRevision) !== Number(dependency.steerRevision ?? 0)) {
        sealed = false;
        break;
      }
    }
    if (!sealed) continue;
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
