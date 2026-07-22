// Atomic compact projections for the live agent control plane. The helpers in
// this file are intentionally database-only so every durable writer can use
// them in the same Convex transaction without calling another function.

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

export async function insertJobWithRuntime(ctx: any, value: any) {
  const jobId = await ctx.db.insert("jobs", value);
  await upsertJobRuntime(ctx, { ...value, _id: jobId });
  return jobId;
}

export async function patchJobWithRuntime(ctx: any, job: any, patch: Record<string, unknown>) {
  const existing = await jobRuntimeFor(ctx, job._id);
  await ctx.db.patch(job._id, patch);
  const projected = projectJobRuntime(mergeJobRuntimeSource(job, patch, existing));
  if (existing) await ctx.db.replace(existing._id, projected);
  else await ctx.db.insert("jobRuntime", projected);
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
