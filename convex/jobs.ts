import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { isResumeOnlyUntouchedGoalJob } from "../src/lib/goal-job-lifecycle";
import { workApprovalPolicy } from "./workPolicy";
import { classifyWorkSafety, isOwnedRepository } from "../src/lib/work-safety";
import { requireActor, requireDispatcher, requireViewer, requireWorker, viewerAuthArgs } from "./controlAuth";
import { buildContinuationCheckpoint } from "../src/lib/work-checkpoint";
import { normalizeWorkModelTier } from "../src/lib/work-models";
import { goalJobMatchesMissionPhase } from "../src/lib/goal-mode";
import { redactSensitiveText } from "../src/lib/secret-redaction";
import { verifiedDeliveryCanFinalize } from "../src/lib/provider-release-finalization";
import {
  insertJobWithRuntime,
  jobRuntimeFor,
  patchMissionWithRuntime,
  patchJobWithRuntime,
  runtimeJob,
  upsertJobRuntime,
  upsertMissionRuntime,
} from "./controlPlane";

const STALE_RUNNER_MS = 5 * 60 * 1000;
const DISPATCH_LEASE_MS = 2 * 60 * 1000;
const PROVIDER_RELEASE_LEASE_MS = 10 * 60 * 1000;

const providerReleaseValidator = v.object({
  releaseId: v.string(),
  repository: v.string(),
  branch: v.string(),
  baseSha: v.string(),
  headSha: v.string(),
  mergeSha: v.optional(v.string()),
  changedPaths: v.array(v.string()),
  providers: v.array(v.string()),
  impactDigest: v.string(),
  boundaryDigest: v.string(),
  phase: v.string(),
  attempts: v.number(),
  steps: v.array(v.object({
    id: v.string(),
    status: v.string(),
    proof: v.optional(v.string()),
    version: v.optional(v.string()),
    runId: v.optional(v.string()),
    data: v.optional(v.any()),
    checkedAt: v.optional(v.number()),
  })),
  note: v.optional(v.string()),
  updatedAt: v.number(),
});

function normalizedRepo(repo: unknown): string {
  return String(repo ?? "").trim().replace(/^https:\/\/github\.com\//i, "").replace(/\.git$/i, "").toLowerCase();
}

function validProviderReleaseShape(release: any): boolean {
  const phase = String(release?.phase ?? "");
  const steps = Array.isArray(release?.steps) ? release.steps : [];
  const premerge = steps.filter((step: any) => !String(step?.id ?? "").startsWith("live:"));
  const postmerge = steps.filter((step: any) => String(step?.id ?? "").startsWith("live:"));
  const exactMerge = /^[0-9a-f]{40,64}$/i.test(String(release?.mergeSha ?? ""));
  return /^providers-v2:[0-9a-f]{64}$/.test(String(release?.releaseId ?? ""))
    && /^[0-9a-f]{40,64}$/i.test(String(release?.baseSha ?? ""))
    && /^[0-9a-f]{40,64}$/i.test(String(release?.headSha ?? ""))
    && /^jarvis\/[a-z0-9._/-]+$/i.test(String(release?.branch ?? ""))
    && /^[0-9a-f]{64}$/i.test(String(release?.impactDigest ?? ""))
    && ["deploying", "premerge_ready", "verifying_live", "live", "blocked"].includes(phase)
    && Array.isArray(release?.providers)
    && release.providers.length > 0
    && release.providers.every((provider: unknown) => ["convex", "trigger"].includes(String(provider)))
    && steps.length >= 4
    && premerge[0]?.id?.startsWith("vercel:")
    && postmerge[0]?.id?.startsWith("live:vercel:")
    && new Set(steps.map((step: any) => String(step.id))).size === steps.length
    && steps.every((step: any) => ["pending", "deploying", "verified", "failed"].includes(String(step.status)))
    && (!["premerge_ready", "verifying_live", "live"].includes(phase)
      || premerge.every((step: any) => step.status === "verified"))
    && (!["verifying_live", "live"].includes(phase) || exactMerge)
    && (phase !== "live" || postmerge.every((step: any) => step.status === "verified"));
}

const enqueueArgs = {
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

export const enqueue = mutation({
  args: enqueueArgs,
  handler: async (ctx, a) => {
    await requireDispatcher(ctx, a);
    const { authTokenHash: _authTokenHash, dispatchToken: _dispatchToken, workerToken: _workerToken, ...input } = a;
    const now = Date.now();
    const approval = workApprovalPolicy(input);
    const approvalRequired = approval.required;
    const status = approvalRequired ? "awaiting_approval" : "pending";
    const id = await insertJobWithRuntime(ctx, {
      ...input,
      task: input.task.slice(0, 6000),
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
      attempt: 1,
      maxAttempts: Math.max(1, Math.min(48, input.maxAttempts ?? 12)),
      nextRunAt: now,
      createdAt: now,
    });
    await ctx.db.insert("workEvents", {
      jobId: String(id),
      missionId: input.missionId,
      agentId: input.agentId,
      type: approvalRequired ? "approval_requested" : "queued",
      message: approvalRequired
        ? `Waiting for Daniel's approval${approval.reason ? ` · ${approval.reason}` : ""}`
        : "Work queued",
      stage: approvalRequired ? "approval" : "queued",
      percent: 0,
      createdAt: now,
    });
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

const CONTROL_PLANE_MIGRATION = "compact-runtime-v1";

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

// One bounded page both backfills the compact runtime row and repairs the old
// false-positive software approval policy. The cursor is durable, so completed
// history is never scanned again by the minute supervisor.
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
  for (const row of page.page) {
    const safety = row.status === "awaiting_approval" ? classifyWorkSafety(row.task, { repo: row.repo }) : null;
    if (safety && !safety.approvalRequired && isOwnedRepository(row.repo)) {
      const patch = {
        status: "pending",
        risk: row.risk === "consequential" ? "high" : row.risk,
        approvalRequired: false,
        approvalReason: undefined,
        approvalStatus: "superseded",
        deliveryMode: row.readonly === true ? "read_only" : "auto_merge",
        stage: "queued",
        progress: "autonomous software delivery enabled — queued",
        nextRunAt: now,
      };
      await patchJobWithRuntime(ctx, row, patch);
      const approvals = await ctx.db
        .query("approvals")
        .withIndex("by_job", (q: any) => q.eq("jobId", String(row._id)))
        .take(20);
      for (const approval of approvals) {
        if (approval.status === "pending") await ctx.db.patch(approval._id, { status: "superseded", resolvedAt: now });
      }
      await ctx.db.insert("workEvents", {
        jobId: String(row._id),
        missionId: row.missionId,
        agentId: row.agentId,
        type: "autonomy_reconciled",
        message: "Legacy software-delivery approval removed; verified delivery is automatic",
        stage: "queued",
        percent: row.percent ?? 0,
        createdAt: now,
      });
      repaired += 1;
    } else {
      await upsertJobRuntime(ctx, row);
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

// Goal workstream mode repair is similarly cursor-bound. One mission (and at
// most the architecture's bounded 100 child rows) is examined per invocation.
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
    const streams = mission.mode === "goal" && Array.isArray((mission.plan as any)?.workstreams)
      ? (mission.plan as any).workstreams as Array<{ id?: string; readonly?: boolean }>
      : [];
    if (!streams.length) continue;
    const byId = new Map(streams.map((stream) => [String(stream.id ?? ""), stream]));
    const jobs = await ctx.db
      .query("jobs")
      .withIndex("by_mission", (q: any) => q.eq("missionId", String(mission._id)))
      .take(100);
    for (const job of jobs) {
      const patch: Record<string, unknown> = {};
      if (isResumeOnlyUntouchedGoalJob(job)) {
        patch.attempt = 1;
        patch.checkpoint = undefined;
        patch.progress = "Queued · waiting for dependencies";
      }
      if (job.goalStage === "building" && job.goalWorkstreamId) {
        const stream = byId.get(String(job.goalWorkstreamId));
        if (stream) {
          const readonly = stream.readonly === true;
          const deliveryMode = readonly ? "read_only" : "auto_merge";
          if (job.readonly !== readonly || job.deliveryMode !== deliveryMode || (readonly && job.branch)) {
            patch.readonly = readonly;
            patch.deliveryMode = deliveryMode;
            if (readonly) patch.branch = undefined;
          }
        }
      }
      if (Object.keys(patch).length) {
        await patchJobWithRuntime(ctx, job, patch);
        repaired += 1;
      } else {
        await upsertJobRuntime(ctx, job);
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

async function runnableCandidates(ctx: any, now: number, limit: number): Promise<any[]> {
  const candidates = await ctx.db
    .query("jobRuntime")
    .withIndex("by_status_next_run", (q: any) => q.eq("status", "pending").lte("nextRunAt", now))
    .take(Math.max(24, Math.min(96, limit * 8)));
  candidates.sort((a: any, b: any) => (b.priority ?? 50) - (a.priority ?? 50) || a.createdAt - b.createdAt);
  const runnable: any[] = [];
  const missionCache = new Map<string, any>();
  const dependencyCache = new Map<string, any>();
  for (const candidate of candidates) {
    if (candidate.approvalRequired && candidate.approvalStatus !== "approved") continue;
    if (candidate.missionId) {
      let mission = missionCache.get(candidate.missionId);
      if (mission === undefined) {
        const missionId = ctx.db.normalizeId("missions", candidate.missionId);
        mission = missionId
          ? await ctx.db
              .query("missionRuntime")
              .withIndex("by_mission", (q: any) => q.eq("missionId", missionId))
              .first()
          : null;
        missionCache.set(candidate.missionId, mission ?? null);
      }
      // A paused/blocked/cancelled Goal Mode mission owns the lease. This
      // server-side fence prevents a manually approved or retried child job
      // from escaping while the parent goal is stopped.
      if (candidate.goalStage && (!mission || !goalJobMatchesMissionPhase(candidate, mission))) continue;
    }
    let blocked = false;
    for (const dependency of candidate.dependsOn ?? []) {
      let dep = dependencyCache.get(dependency);
      if (dep === undefined) {
        const id = ctx.db.normalizeId("jobs", dependency);
        dep = id ? await jobRuntimeFor(ctx, id) : null;
        dependencyCache.set(dependency, dep ?? null);
      }
      if (!dep || dep.status !== "done") {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;
    // The projection selects exact candidates; the one bounded authority read
    // below fences dispatch against any stale rollout row without scanning jobs.
    const job = await ctx.db.get(candidate.jobId);
    if (!job || job.status !== "pending" || (job.attempt ?? 1) !== candidate.attempt || (job.nextRunAt ?? 0) > now) {
      if (job) await upsertJobRuntime(ctx, job);
      continue;
    }
    // The projection carries the common bounded dependency prefix. If a
    // legacy/general job has more, the selected authority document must fence
    // every remaining dependency before dispatch; oversized graphs stay held
    // for explicit recovery instead of silently dropping an edge.
    const projectedDependencyCount = Array.isArray(candidate.dependsOn) ? candidate.dependsOn.length : 0;
    const authorityDependencies = Array.isArray(job.dependsOn) ? job.dependsOn : [];
    if (authorityDependencies.length > 100) continue;
    for (const dependency of authorityDependencies.slice(projectedDependencyCount)) {
      let dep = dependencyCache.get(dependency);
      if (dep === undefined) {
        const id = ctx.db.normalizeId("jobs", dependency);
        dep = id ? await jobRuntimeFor(ctx, id) : null;
        dependencyCache.set(dependency, dep ?? null);
      }
      if (!dep || dep.status !== "done") {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;
    if (job.goalStage && job.missionId) {
      const missionId = ctx.db.normalizeId("missions", job.missionId);
      const mission = missionId ? await ctx.db.get(missionId) : null;
      if (!mission || !goalJobMatchesMissionPhase(job, mission)) continue;
    }
    runnable.push(job);
    if (runnable.length >= limit) break;
  }
  return runnable;
}

function claimedJob(j: any, upstreamEvidence: any[] = []) {
  return {
    jobId: j._id,
    task: j.task,
    repo: j.repo ?? null,
    readonly: j.readonly ?? false,
    model: j.model ? normalizeWorkModelTier(j.model) : null,
    reasoningEffort: j.reasoningEffort ?? null,
    mcp: j.mcp ?? [],
    incidentId: j.incidentId ?? null,
    retried: j.retried ?? false,
    missionId: j.missionId ?? null,
    label: j.label ?? null,
    originThreadId: j.originThreadId ?? "main",
    originTurnId: j.originTurnId ?? null,
    agentId: j.agentId ?? null,
    risk: j.risk ?? "low",
    priority: j.priority ?? 50,
    attempt: j.attempt ?? 1,
    maxAttempts: j.maxAttempts ?? 12,
    checkpoint: j.checkpoint ?? null,
    result: j.result ?? null,
    branch: j.branch ?? null,
    deliveryMode: j.deliveryMode ?? (j.readonly ? "read_only" : "manual"),
    deliveryStatus: j.deliveryStatus ?? null,
    pullRequestUrl: j.pullRequestUrl ?? null,
    mergeCommitSha: j.mergeCommitSha ?? null,
    deliveredHeadSha: j.deliveredHeadSha ?? null,
    providerRelease: j.providerRelease ?? null,
    verificationVerdict: j.verificationVerdict ?? null,
    verificationNote: j.verificationNote ?? null,
    acceptanceCriteria: j.acceptanceCriteria ?? [],
    modelReason: j.modelReason ?? null,
    parentJobId: j.parentJobId ?? null,
    goalStage: j.goalStage ?? null,
    goalWorkstreamId: j.goalWorkstreamId ?? null,
    goalWave: j.goalWave ?? 0,
    upstreamEvidence,
  };
}

// Reserve concrete jobs before asking Trigger.dev to create cloud runs. Convex
// serializes this mutation, so overlapping supervisors receive disjoint work
// and never need a global "is any runner active?" lock.
export const reserveDispatchBatch = mutation({
  args: {
    limit: v.number(),
    reason: v.optional(v.string()),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const now = Date.now();
    const limit = Math.max(1, Math.min(12, Math.floor(a.limit)));
    const candidates = await runnableCandidates(ctx, now, limit);
    const reservations = [];
    for (const j of candidates) {
      const dispatchId = `${String(j._id)}:${j.attempt ?? 1}:${now}`;
      await patchJobWithRuntime(ctx, j, {
        status: "dispatching",
        stage: "dispatching",
        progress: "cloud worker reserved",
        dispatchId,
        dispatchLeaseUntil: now + DISPATCH_LEASE_MS,
        dispatchReason: a.reason?.slice(0, 160),
        workerRunId: undefined,
        workerRuntime: "trigger",
        heartbeatAt: now,
      });
      await ctx.db.insert("workEvents", {
        jobId: String(j._id),
        missionId: j.missionId,
        agentId: j.agentId,
        type: "dispatched",
        message: `Independent Trigger worker reserved${a.reason ? ` · ${a.reason.slice(0, 120)}` : ""}`,
        stage: "dispatching",
        percent: Math.max(1, j.percent ?? 0),
        createdAt: now,
      });
      reservations.push({
        jobId: String(j._id),
        dispatchId,
        attempt: j.attempt ?? 1,
        missionId: j.missionId ?? null,
        agentId: j.agentId ?? null,
        label: j.label ?? j.task.slice(0, 80),
      });
    }
    return { reservations };
  },
});

// Bind one reserved job to one Trigger run. Late/retried platform deliveries
// are harmless: only the exact live dispatch id can cross this fence.
export const claimDispatched = mutation({
  args: {
    jobId: v.id("jobs"),
    dispatchId: v.string(),
    workerRunId: v.string(),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const now = Date.now();
    const j: any = await ctx.db.get(a.jobId);
    if (
      !j ||
      j.status !== "dispatching" ||
      j.dispatchId !== a.dispatchId ||
      (j.dispatchLeaseUntil ?? 0) < now
    ) return null;
    await patchJobWithRuntime(ctx, j, {
      status: "running",
      stage: "starting",
      progress: "starting secure workspace",
      percent: Math.max(2, j.percent ?? 0),
      startedAt: now,
      heartbeatAt: now,
      nextRunAt: undefined,
      dispatchLeaseUntil: undefined,
      workerRunId: a.workerRunId.slice(0, 120),
      workerRuntime: "trigger",
    });
    const upstreamRows = j.missionId
      ? await ctx.db
          .query("jobs")
          .withIndex("by_mission", (q: any) => q.eq("missionId", j.missionId))
          .take(100)
      : await Promise.all((j.dependsOn ?? []).slice(0, 8).map(async (dependency: string) => {
          const id = ctx.db.normalizeId("jobs", dependency);
          return id ? await ctx.db.get(id) : null;
        }));
    const upstreamEvidence = upstreamRows
      .filter((row: any) => row && row._id !== j._id && row.status === "done" && String(row.result ?? "").trim())
      .sort((left: any, right: any) => Number(left.completedAt ?? left.createdAt ?? 0) - Number(right.completedAt ?? right.createdAt ?? 0))
      .slice(-8)
      .map((row: any) => ({
        label: String(row.label ?? row.task ?? "Upstream workstream").slice(0, 120),
        status: row.status,
        result: String(row.result).slice(0, 1_400),
        verificationNote: String(row.verificationNote ?? "").slice(0, 300),
      }));
    await ctx.db.insert("workEvents", {
      jobId: String(j._id),
      missionId: j.missionId,
      agentId: j.agentId,
      type: "started",
      message: `Attempt ${j.attempt ?? 1} started`,
      stage: "starting",
      percent: Math.max(2, j.percent ?? 0),
      createdAt: now,
    });
    return claimedJob(j, upstreamEvidence);
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
    const delayMs = Math.max(0, Math.min(10 * 60_000, a.delayMs ?? 30_000));
    await patchJobWithRuntime(ctx, row, {
      status: "pending",
      stage: "queued",
      progress: `worker launch deferred · ${a.reason.slice(0, 240)}`,
      nextRunAt: now + delayMs,
      dispatchId: undefined,
      dispatchLeaseUntil: undefined,
      workerRunId: undefined,
      heartbeatAt: now,
    });
    await ctx.db.insert("workEvents", {
      jobId: String(a.jobId),
      missionId: row.missionId,
      agentId: row.agentId,
      type: "dispatch_released",
      message: a.reason.slice(0, 500),
      stage: "queued",
      percent: row.percent,
      createdAt: now,
    });
    return true;
  },
});

export const finalize = mutation({
  args: {
    jobId: v.id("jobs"),
    expectedAttempt: v.number(),
    status: v.union(v.literal("done"), v.literal("error")),
    result: v.optional(v.string()),
    pullRequestUrl: v.optional(v.string()),
    verificationVerdict: v.optional(v.union(v.literal("pass"), v.literal("unavailable"))),
    verificationNote: v.optional(v.string()),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const row = await ctx.db.get(a.jobId);
    if (!row || row.status !== "running" || (row.attempt ?? 1) !== a.expectedAttempt) return false;
    // A completed job is called "verified" only when the supervisor actually
    // returned pass. This invariant lives in Convex, not only in the runner.
    if (a.status === "done" && a.verificationVerdict !== "pass") return false;
    // Once a verified branch enters controller delivery, neither a failed
    // provider phase nor an unmerged PR may be mislabeled done. The Trigger
    // process can disappear or contain a caller bug; Convex remains the final
    // durable fence.
    if (a.status === "done" && !verifiedDeliveryCanFinalize(row)) return false;
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
      result: a.result,
      pullRequestUrl: a.pullRequestUrl,
      completedAt: now,
      heartbeatAt: now,
      stage: success ? (delivered ? "delivered" : "verified") : a.status,
      percent: finalPercent,
      progress: finalProgress,
      verificationVerdict: a.verificationVerdict,
      verificationNote: a.verificationNote?.slice(0, 1000),
      verifiedAt: success ? now : undefined,
    };
    await patchJobWithRuntime(ctx, row, finalPatch);
    await ctx.db.insert("workEvents", {
      jobId: String(a.jobId),
      missionId: row.missionId,
      agentId: row.agentId,
      type: a.status,
      message: success
        ? delivered ? "Work verified and merged automatically" : "Work verified and complete"
        : (a.result ?? a.status).slice(0, 500),
      stage: success ? (delivered ? "delivered" : "verified") : a.status,
      percent: finalPercent,
      createdAt: now,
    });
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

export const list = query({
  args: { limit: v.optional(v.number()), ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    const rows = await ctx.db
      .query("jobRuntime")
      .withIndex("by_createdAt")
      .order("desc")
      .take(Math.min(a.limit ?? 20, 100));
    return rows.map((row: any) => ({
      ...runtimeJob(row),
      model: row.model ? normalizeWorkModelTier(row.model) : undefined,
    }));
  },
});

// A provider startup error can echo its command line before the worker has a
// chance to classify it. This maintenance action only removes credential-like
// material; it cannot alter status, ownership, attempts, or mission progress.
export const scrubSensitiveOutput = mutation({
  args: { jobId: v.id("jobs"), ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    const row: any = await ctx.db.get(a.jobId);
    if (!row) return { scrubbed: false, fields: [] as string[] };
    const patch: Record<string, string> = {};
    for (const field of ["result", "checkpoint", "log", "progress", "verificationNote", "question"] as const) {
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
    const dispatching = await ctx.db
      .query("jobRuntime")
      .withIndex("by_status_dispatch_lease", (q: any) => q.eq("status", "dispatching").lte("dispatchLeaseUntil", now))
      .take(100);
    const releasedDispatches: string[] = [];
    for (const activity of dispatching) {
      const j = await ctx.db.get(activity.jobId);
      if (!j || j.status !== "dispatching" || j.dispatchId !== activity.dispatchId) {
        if (j) await upsertJobRuntime(ctx, j);
        continue;
      }
      await patchJobWithRuntime(ctx, j, {
        status: "pending",
        stage: "queued",
        progress: "worker reservation expired — redispatch queued",
        nextRunAt: now,
        dispatchId: undefined,
        dispatchLeaseUntil: undefined,
        workerRunId: undefined,
        heartbeatAt: now,
      });
      await ctx.db.insert("workEvents", {
        jobId: String(j._id),
        missionId: j.missionId,
        agentId: j.agentId,
        type: "dispatch_recovered",
        message: "Expired Trigger worker reservation released",
        stage: "queued",
        percent: j.percent,
        createdAt: now,
      });
      releasedDispatches.push(j.task.slice(0, 80));
    }
    const running = await ctx.db
      .query("jobRuntime")
      .withIndex("by_status_heartbeat", (q: any) => q.eq("status", "running").lte("heartbeatAt", now - STALE_RUNNER_MS))
      .take(100);
    const requeued: string[] = [];
    const abandoned: string[] = [];
    for (const activity of running) {
      const j = await ctx.db.get(activity.jobId);
      if (!j || j.status !== "running" || (j.attempt ?? 1) !== activity.attempt) {
        if (j) await upsertJobRuntime(ctx, j);
        continue;
      }
      // The serialized Trigger task heartbeats every 30 seconds. If its run
      // disappears (for example an OOM kill), the next scheduled invocation is
      // the only possible reaper, so five quiet minutes is ample fencing while
      // avoiding a long ghost-running window.
      const nextAttempt = (j.attempt ?? 1) + 1;
      if (now - j.createdAt > 14 * 86_400_000 || nextAttempt > (j.maxAttempts ?? 12)) {
        await patchJobWithRuntime(ctx, j, {
          status: "error",
          stage: "error",
          completedAt: now,
          result: "abandoned: runner repeatedly stopped without a checkpoint",
        });
        abandoned.push(j.task.slice(0, 80));
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
        await patchJobWithRuntime(ctx, j, {
          status: "pending",
          stage: "queued",
          startedAt: undefined,
          heartbeatAt: now,
          nextRunAt: now + Math.min(6 * 60 * 60 * 1000, 60_000 * 2 ** Math.max(0, nextAttempt - 2)),
          attempt: nextAttempt,
          progress: `recovered after a stalled runner · attempt ${nextAttempt}`,
          checkpoint,
          result: checkpoint.slice(0, 4000),
        });
        requeued.push(j.task.slice(0, 80));
      }
      await ctx.db.insert("workEvents", {
        jobId: String(j._id),
        missionId: j.missionId,
        agentId: j.agentId,
        type: nextAttempt > (j.maxAttempts ?? 12) ? "abandoned" : "recovered",
        message: nextAttempt > (j.maxAttempts ?? 12) ? "Retry budget exhausted" : `Recovered as attempt ${nextAttempt}`,
        stage: nextAttempt > (j.maxAttempts ?? 12) ? "error" : "queued",
        createdAt: now,
      });
    }
    return { requeued, abandoned, releasedDispatches };
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
    const percent = a.percent === undefined ? row.percent : Math.max(0, Math.min(99, a.percent));
    const patch: Record<string, unknown> = {
      progress: a.progress.slice(0, 400),
      heartbeatAt: now,
      percent,
    };
    if (a.stage !== undefined) patch.stage = a.stage.slice(0, 80);
    patch.updatedAt = now;
    await ctx.db.patch(row._id, patch);
    const meaningful = (a.stage && a.stage !== row.stage) || (percent ?? 0) - (row.percent ?? 0) >= 10;
    if (meaningful)
      await ctx.db.insert("workEvents", {
        jobId: String(a.jobId),
        missionId: row.missionId,
        agentId: row.agentId,
        type: "progress",
        message: a.progress.slice(0, 500),
        stage: a.stage ?? row.stage,
        percent,
        createdAt: now,
      });
    return true;
  },
});

export const checkpointAndRequeue = mutation({
  args: {
    jobId: v.id("jobs"),
    expectedAttempt: v.number(),
    checkpoint: v.string(),
    result: v.optional(v.string()),
    branch: v.optional(v.string()),
    delayMs: v.optional(v.number()),
    nextStatus: v.optional(v.union(v.literal("pending"), v.literal("paused"), v.literal("cancelled"))),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const row = await ctx.db.get(a.jobId);
    if (!row || (row.attempt ?? 1) !== a.expectedAttempt) {
      return { requeued: false, exhausted: false, stale: true };
    }
    const requestedStatus = a.nextStatus ?? "pending";
    const stoppedState = requestedStatus === "paused" || requestedStatus === "cancelled";
    if (row.status !== "running") {
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
        await ctx.db.insert("workEvents", {
          jobId: String(a.jobId),
          missionId: row.missionId,
          agentId: row.agentId,
          type: "checkpoint_saved",
          message: `Final checkpoint saved after ${requestedStatus}`,
          stage: requestedStatus,
          percent: row.percent,
          createdAt: now,
        });
        return { requeued: false, exhausted: false, stale: false };
      }
      return { requeued: false, exhausted: false, stale: true };
    }
    const attempt = (row.attempt ?? 1) + (requestedStatus === "pending" ? 1 : 0);
    const delayMs = Math.max(0, Math.min(6 * 60 * 60 * 1000, a.delayMs ?? 0));
    const exhausted =
      requestedStatus === "pending" &&
      (attempt > (row.maxAttempts ?? 12) || Date.now() - row.createdAt > 14 * 86_400_000);
    const status = exhausted ? "error" : requestedStatus;
    await patchJobWithRuntime(ctx, row, {
      status,
      stage: exhausted ? "error" : requestedStatus === "pending" ? "checkpointed" : requestedStatus,
      checkpoint: a.checkpoint.slice(0, 6000),
      result: a.result,
      branch: a.branch ?? row.branch,
      attempt,
      startedAt: undefined,
      heartbeatAt: Date.now(),
      nextRunAt: status === "pending" ? Date.now() + delayMs : undefined,
      dispatchId: undefined,
      dispatchLeaseUntil: undefined,
      workerRunId: status === "pending" ? undefined : row.workerRunId,
      completedAt: requestedStatus === "cancelled" || exhausted ? Date.now() : undefined,
      progress: exhausted
        ? "continuation budget exhausted"
        : requestedStatus === "pending"
          ? `checkpoint saved · continuation ${attempt}${delayMs ? ` eligible in ${Math.max(1, Math.ceil(delayMs / 60_000))}m` : " queued"}`
          : `checkpoint saved · ${requestedStatus}`,
    });
    await ctx.db.insert("workEvents", {
      jobId: String(a.jobId),
      missionId: row.missionId,
      agentId: row.agentId,
      type: exhausted ? "continuation_exhausted" : requestedStatus === "pending" ? "checkpoint" : requestedStatus,
      message: exhausted
        ? "Continuation budget exhausted"
        : requestedStatus === "pending"
          ? `Checkpoint saved; attempt ${attempt}${delayMs ? ` eligible in ${Math.max(1, Math.ceil(delayMs / 60_000))}m` : " queued"}`
          : `Checkpoint saved; job ${requestedStatus}`,
      stage: exhausted ? "error" : requestedStatus === "pending" ? "checkpointed" : requestedStatus,
      percent: row.percent,
      createdAt: Date.now(),
    });
    return { requeued: status === "pending", exhausted, stale: false };
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
    if (row) return { status: row.status, attempt: row.attempt };
    const state = await ctx.db
      .query("controlPlaneMigrations")
      .withIndex("by_key", (q: any) => q.eq("key", CONTROL_PLANE_MIGRATION))
      .first();
    if (state?.jobsComplete) return { status: "missing", attempt: 0 };
    // Rollout-only point compatibility: an old live worker may predate its
    // projection row. This disappears permanently when the cursor completes.
    const legacy = await ctx.db.get(a.jobId);
    return legacy
      ? { status: legacy.status, attempt: legacy.attempt ?? 1 }
      : { status: "missing", attempt: 0 };
  },
});

export const requestInput = mutation({
  args: {
    jobId: v.id("jobs"),
    expectedAttempt: v.number(),
    question: v.string(),
    checkpoint: v.optional(v.string()),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const row = await ctx.db.get(a.jobId);
    if (!row || row.status !== "running" || (row.attempt ?? 1) !== a.expectedAttempt) return false;
    const now = Date.now();
    await patchJobWithRuntime(ctx, row, {
      status: "needs_input",
      stage: "needs Daniel",
      progress: a.question.slice(0, 400),
      checkpoint: a.checkpoint?.slice(0, 6000) ?? row.checkpoint,
      heartbeatAt: now,
    });
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
    await ctx.db.insert("workEvents", {
      jobId: String(a.jobId),
      missionId: row.missionId,
      agentId: row.agentId,
      type: "needs_input",
      message: a.question.slice(0, 1000),
      stage: "needs Daniel",
      percent: row.percent,
      createdAt: now,
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
    const now = Date.now();
    await patchJobWithRuntime(ctx, row, {
      status: "pending",
      stage: "queued",
      progress: "Daniel answered — continuation queued",
      checkpoint: `${row.checkpoint ?? ""}\n\nDaniel's answer: ${a.answer.slice(0, 2000)}`.trim(),
      attempt: (row.attempt ?? 1) + 1,
      heartbeatAt: now,
      nextRunAt: now,
    });
    const attention = await ctx.db
      .query("attentionItems")
      .withIndex("by_fingerprint", (q: any) => q.eq("fingerprint", `job-input:${a.jobId}`))
      .first();
    if (attention) await ctx.db.patch(attention._id, { status: "resolved", updatedAt: now });
    await ctx.db.insert("workEvents", {
      jobId: String(a.jobId),
      missionId: row.missionId,
      agentId: row.agentId,
      type: "input_received",
      message: "Daniel supplied the required decision",
      stage: "queued",
      createdAt: now,
    });
    return true;
  },
});

// Phase one of provider-sensitive delivery. The release lock serializes exact
// repository provider state across otherwise independent specialist jobs.
export const beginProviderRelease = mutation({
  args: {
    jobId: v.id("jobs"),
    expectedAttempt: v.number(),
    release: providerReleaseValidator,
    leaseToken: v.string(),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const row = await ctx.db.get(a.jobId);
    if (!row || row.status !== "running" || (row.attempt ?? 1) !== a.expectedAttempt) return { ok: false, reason: "stale job lease" };
    if (
      row.verificationVerdict !== "pass"
      || !isOwnedRepository(row.repo)
      || classifyWorkSafety(row.task, { repo: row.repo }).approvalRequired
      || (row.deliveryMode !== "auto_merge" && row.goalStage !== "validating")
    ) return { ok: false, reason: "job is not eligible for autonomous verified delivery" };
    if (
      !validProviderReleaseShape(a.release)
      || !["deploying", "verifying_live"].includes(a.release.phase)
      || normalizedRepo(a.release.repository) !== normalizedRepo(row.repo)
      || a.release.branch !== row.branch
      || !/^[0-9a-f]{48}$/.test(a.leaseToken)
    ) return { ok: false, reason: "provider release identity does not match the verified job" };
    if (
      a.release.phase === "verifying_live"
      && (
        !row.providerRelease
        || row.providerRelease.releaseId !== a.release.releaseId
        || row.providerRelease.mergeSha !== a.release.mergeSha
      )
    ) return { ok: false, reason: "post-merge provider resumption does not match the durable release" };

    const now = Date.now();
    const lock = await ctx.db
      .query("providerReleaseLocks")
      .withIndex("by_repo", (q: any) => q.eq("repo", normalizedRepo(row.repo)))
      .first();
    if (
      lock
      && lock.leaseUntil > now
      && (lock.releaseId !== a.release.releaseId || lock.jobId !== a.jobId)
    ) {
      return { ok: false, reason: "another exact provider release owns this repository lease" };
    }
    const lockPatch = {
      repo: normalizedRepo(row.repo),
      releaseId: a.release.releaseId,
      jobId: a.jobId,
      baseSha: a.release.baseSha,
      headSha: a.release.headSha,
      leaseToken: a.leaseToken,
      leaseUntil: now + PROVIDER_RELEASE_LEASE_MS,
      status: a.release.phase === "verifying_live" ? "verifying_live" : "deploying",
      updatedAt: now,
    };
    if (lock) await ctx.db.patch(lock._id, lockPatch);
    else await ctx.db.insert("providerReleaseLocks", lockPatch);
    await patchJobWithRuntime(ctx, row, {
      providerRelease: { ...a.release, updatedAt: now },
      deliveryStatus: a.release.phase === "verifying_live" ? "provider_postmerge" : "provider_release",
      stage: a.release.phase === "verifying_live" ? "provider_postmerge" : "provider_release",
      progress: a.release.phase === "verifying_live"
        ? "merged commit preserved · resuming exact production provider proof"
        : "verified branch preserved · trusted provider prerequisites deploying",
      percent: Math.max(97, row.percent ?? 0),
      heartbeatAt: now,
    });
    await ctx.db.insert("workEvents", {
      jobId: String(a.jobId),
      missionId: row.missionId,
      agentId: row.agentId,
      type: "provider_release_started",
      message: `Trusted provider release ${a.release.releaseId.slice(-12)} entered for ${a.release.providers.join(", ")}`,
      stage: "provider_release",
      percent: Math.max(97, row.percent ?? 0),
      createdAt: now,
    });
    return { ok: true };
  },
});

export const updateProviderRelease = mutation({
  args: {
    jobId: v.id("jobs"),
    expectedAttempt: v.number(),
    release: providerReleaseValidator,
    leaseToken: v.string(),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const row = await ctx.db.get(a.jobId);
    if (!row || row.status !== "running" || (row.attempt ?? 1) !== a.expectedAttempt) return { ok: false, reason: "stale job lease" };
    if (
      !row.providerRelease
      || !validProviderReleaseShape(a.release)
      || row.providerRelease.releaseId !== a.release.releaseId
      || row.providerRelease.baseSha !== a.release.baseSha
      || row.providerRelease.headSha !== a.release.headSha
      || row.providerRelease.impactDigest !== a.release.impactDigest
      || row.providerRelease.boundaryDigest !== a.release.boundaryDigest
      || normalizedRepo(a.release.repository) !== normalizedRepo(row.repo)
      || a.release.branch !== row.branch
    ) return { ok: false, reason: "provider release receipt changed identity" };
    const premergeSteps = a.release.steps.filter((step: any) => !String(step.id).startsWith("live:"));
    const postmergeSteps = a.release.steps.filter((step: any) => String(step.id).startsWith("live:"));
    if (
      ["premerge_ready", "verifying_live", "live"].includes(a.release.phase)
      && premergeSteps.some((step: any) => step.status !== "verified")
    ) {
      return { ok: false, reason: "provider release cannot pass the pre-merge barrier without every exact prerequisite" };
    }
    if (a.release.phase === "live" && postmergeSteps.some((step: any) => step.status !== "verified")) {
      return { ok: false, reason: "provider release cannot become live without every exact post-merge receipt" };
    }
    const lock = await ctx.db
      .query("providerReleaseLocks")
      .withIndex("by_repo", (q: any) => q.eq("repo", normalizedRepo(row.repo)))
      .first();
    const now = Date.now();
    if (
      !lock
      || lock.releaseId !== a.release.releaseId
      || lock.jobId !== a.jobId
      || lock.baseSha !== a.release.baseSha
      || lock.headSha !== a.release.headSha
      || lock.leaseToken !== a.leaseToken
      || lock.leaseUntil <= now
    ) return { ok: false, reason: "trusted provider release lease is missing or expired" };
    const status = a.release.phase;
    await ctx.db.patch(lock._id, {
      status,
      leaseUntil: status === "blocked" ? now : now + PROVIDER_RELEASE_LEASE_MS,
      updatedAt: now,
    });
    const deliveryStatus = status === "premerge_ready"
      ? "provider_ready"
      : ["verifying_live", "live"].includes(status)
        ? "provider_postmerge"
        : status === "blocked"
          ? "blocked"
          : "provider_release";
    await patchJobWithRuntime(ctx, row, {
      providerRelease: { ...a.release, updatedAt: now },
      deliveryStatus,
      stage: status === "premerge_ready" ? "delivery" : status === "verifying_live" || status === "live" ? "provider_postmerge" : "provider_release",
      progress: status === "premerge_ready"
        ? "provider prerequisites verified · GitHub merge unlocked"
        : status === "verifying_live"
          ? "merged commit preserved · verifying exact production aliases and provider bundles"
          : status === "live"
            ? "exact merged commit attested live · atomically finalizing delivery"
        : status === "blocked"
          ? `provider release blocked · ${String(a.release.note ?? "verification failed").slice(0, 300)}`
          : String(a.release.note ?? "trusted provider release in progress").slice(0, 500),
      heartbeatAt: now,
    });
    if (["premerge_ready", "live", "blocked"].includes(status)) {
      await ctx.db.insert("workEvents", {
        jobId: String(a.jobId),
        missionId: row.missionId,
        agentId: row.agentId,
        type: status === "premerge_ready"
          ? "provider_release_ready"
          : status === "live"
            ? "provider_release_live"
            : "provider_release_blocked",
        message: String(a.release.note ?? status).slice(0, 500),
        stage: status === "premerge_ready" ? "delivery" : status === "live" ? "provider_postmerge" : "provider_release",
        percent: row.percent,
        createdAt: now,
      });
    }
    return { ok: true };
  },
});

// Heartbeats are controller-authenticated lock renewals, not elapsed-time
// guesses. The same identity check is called once more immediately before the
// GitHub PUT and before atomic post-merge finalization.
export const renewProviderReleaseLock = mutation({
  args: {
    jobId: v.id("jobs"),
    expectedAttempt: v.number(),
    releaseId: v.string(),
    baseSha: v.string(),
    headSha: v.string(),
    leaseToken: v.string(),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const row = await ctx.db.get(a.jobId);
    if (
      !row
      || row.status !== "running"
      || (row.attempt ?? 1) !== a.expectedAttempt
      || row.providerRelease?.releaseId !== a.releaseId
      || row.providerRelease?.baseSha !== a.baseSha
      || row.providerRelease?.headSha !== a.headSha
    ) return { ok: false, reason: "provider release job ownership changed" };
    const lock = await ctx.db
      .query("providerReleaseLocks")
      .withIndex("by_repo", (q: any) => q.eq("repo", normalizedRepo(row.repo)))
      .first();
    const now = Date.now();
    if (
      !lock
      || lock.releaseId !== a.releaseId
      || lock.jobId !== a.jobId
      || lock.baseSha !== a.baseSha
      || lock.headSha !== a.headSha
      || lock.leaseToken !== a.leaseToken
      || lock.leaseUntil <= now
      || lock.status === "delivered"
    ) return { ok: false, reason: "provider release lock is missing, expired, or owned elsewhere" };
    await ctx.db.patch(lock._id, {
      leaseUntil: now + PROVIDER_RELEASE_LEASE_MS,
      updatedAt: now,
    });
    return { ok: true, leaseUntil: now + PROVIDER_RELEASE_LEASE_MS };
  },
});

export const finalizeProviderDelivery = mutation({
  args: {
    jobId: v.id("jobs"),
    expectedAttempt: v.number(),
    releaseId: v.string(),
    baseSha: v.string(),
    headSha: v.string(),
    mergeSha: v.string(),
    leaseToken: v.string(),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const row = await ctx.db.get(a.jobId);
    if (!row || row.status !== "running" || (row.attempt ?? 1) !== a.expectedAttempt) {
      return { ok: false, reason: "stale job lease" };
    }
    const release = row.providerRelease;
    if (
      row.deliveryStatus === "merged"
      && release?.phase === "live"
      && row.deliveredHeadSha === a.headSha
      && row.mergeCommitSha === a.mergeSha
      && release.mergeSha === a.mergeSha
    ) return { ok: true, alreadyFinalized: true };
    if (
      !release
      || !validProviderReleaseShape(release)
      || release.releaseId !== a.releaseId
      || release.baseSha !== a.baseSha
      || release.headSha !== a.headSha
      || release.mergeSha !== a.mergeSha
      || release.phase !== "live"
      || !/^[0-9a-f]{40,64}$/i.test(a.mergeSha)
      || release.steps.some((step: any) => step.status !== "verified")
    ) return { ok: false, reason: "exact post-merge provider evidence is incomplete" };
    const lock = await ctx.db
      .query("providerReleaseLocks")
      .withIndex("by_repo", (q: any) => q.eq("repo", normalizedRepo(row.repo)))
      .first();
    const now = Date.now();
    if (
      !lock
      || lock.releaseId !== a.releaseId
      || lock.jobId !== a.jobId
      || lock.baseSha !== a.baseSha
      || lock.headSha !== a.headSha
      || lock.leaseToken !== a.leaseToken
      || lock.leaseUntil <= now
    ) return { ok: false, reason: "repository release ownership was not held at finalization" };
    await patchJobWithRuntime(ctx, row, {
      deliveryStatus: "merged",
      mergeCommitSha: a.mergeSha,
      deliveredHeadSha: a.headSha,
      mergedAt: now,
      stage: "delivered",
      percent: Math.max(99, row.percent ?? 0),
      progress: "exact merged commit attested on Vercel and every impacted provider",
      heartbeatAt: now,
    });
    await ctx.db.patch(lock._id, {
      status: "delivered",
      leaseUntil: now,
      updatedAt: now,
    });
    await ctx.db.insert("workEvents", {
      jobId: String(a.jobId),
      missionId: row.missionId,
      agentId: row.agentId,
      type: "provider_delivery_finalized",
      message: `Exact merged commit ${a.mergeSha.slice(0, 12)} attested live on every required provider`,
      stage: "delivered",
      percent: Math.max(99, row.percent ?? 0),
      createdAt: now,
    });
    return { ok: true };
  },
});

export const setDelivery = mutation({
  args: {
    jobId: v.id("jobs"),
    expectedAttempt: v.number(),
    branch: v.optional(v.string()),
    pullRequestUrl: v.optional(v.string()),
    deliveryStatus: v.optional(v.union(
      v.literal("branch"),
      v.literal("pull_request"),
      v.literal("merged"),
      v.literal("blocked"),
    )),
    mergeCommitSha: v.optional(v.string()),
    deliveredHeadSha: v.optional(v.string()),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const row = await ctx.db.get(a.jobId);
    if (!row || row.status !== "running" || (row.attempt ?? 1) !== a.expectedAttempt) return false;
    // Provider-sensitive delivery has a separate atomic mutation which owns
    // the release token and exact live receipts. Generic callers cannot bypass
    // that boundary by writing `merged` directly.
    if (a.deliveryStatus === "merged" && row.providerRelease) return false;
    const now = Date.now();
    await patchJobWithRuntime(ctx, row, {
      branch: a.branch,
      pullRequestUrl: a.pullRequestUrl,
      deliveryStatus: a.deliveryStatus,
      mergeCommitSha: a.mergeCommitSha?.slice(0, 80),
      deliveredHeadSha: a.deliveredHeadSha?.slice(0, 80),
      mergedAt: a.deliveryStatus === "merged" ? now : undefined,
      heartbeatAt: now,
    });
    return true;
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
    result: v.string(),
    verificationNote: v.string(),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const row = await ctx.db.get(a.jobId);
    if (!row || row.status !== "running" || (row.attempt ?? 1) !== a.expectedAttempt) return false;
    if (!isOwnedRepository(row.repo)) return false;
    if (classifyWorkSafety(row.task, { repo: row.repo }).approvalRequired) return false;
    if (row.deliveryMode !== "auto_merge" && row.goalStage !== "validating") return false;
    const now = Date.now();
    await patchJobWithRuntime(ctx, row, {
      result: a.result.slice(0, 4_000),
      verificationVerdict: "pass",
      verificationNote: a.verificationNote.slice(0, 1_000),
      verifiedAt: now,
      stage: "delivery",
      progress: "supervisor passed — controller delivery in progress",
      percent: Math.max(96, row.percent ?? 0),
      heartbeatAt: now,
    });
    return true;
  },
});

export const control = mutation({
  args: {
    jobId: v.id("jobs"),
    action: v.union(v.literal("pause"), v.literal("resume"), v.literal("cancel"), v.literal("retry")),
    authTokenHash: v.optional(v.string()),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const row = await ctx.db.get(a.jobId);
    if (!row) return false;
    const now = Date.now();
    if (a.action === "pause" && ["pending", "dispatching", "running"].includes(row.status))
      await patchJobWithRuntime(ctx, row, {
        status: "paused",
        stage: "paused",
        progress: "paused by Daniel",
        nextRunAt: undefined,
        dispatchId: undefined,
        dispatchLeaseUntil: undefined,
      });
    else if (a.action === "resume" && row.status === "paused")
      await patchJobWithRuntime(ctx, row, {
        status: "pending",
        stage: "queued",
        progress: "resumed — queued",
        attempt: (row.attempt ?? 1) + 1,
        startedAt: undefined,
        heartbeatAt: now,
        nextRunAt: now,
        dispatchId: undefined,
        dispatchLeaseUntil: undefined,
        workerRunId: undefined,
      });
    else if (a.action === "cancel" && !["done", "error", "cancelled"].includes(row.status)) {
      await patchJobWithRuntime(ctx, row, {
        status: "cancelled",
        stage: "cancelled",
        completedAt: now,
        progress: "cancelled by Daniel",
        nextRunAt: undefined,
      });
      const approvals = await ctx.db
        .query("approvals")
        .withIndex("by_job", (q: any) => q.eq("jobId", String(a.jobId)))
        .take(20);
      for (const approval of approvals) {
        if (approval.status === "pending") await ctx.db.patch(approval._id, { status: "cancelled", resolvedAt: now });
      }
    } else if (a.action === "retry" && ["error", "cancelled"].includes(row.status)) {
      const renewApproval = row.approvalRequired === true && row.approvalStatus !== "approved";
      await patchJobWithRuntime(ctx, row, {
        status: renewApproval ? "awaiting_approval" : "pending",
        stage: renewApproval ? "approval" : "queued",
        completedAt: undefined,
        startedAt: undefined,
        heartbeatAt: now,
        attempt: (row.attempt ?? 1) + 1,
        approvalStatus: renewApproval ? "pending" : row.approvalStatus,
        progress: renewApproval ? "retry waiting for Daniel's approval" : "manual retry queued",
        nextRunAt: renewApproval ? undefined : now,
        dispatchId: undefined,
        dispatchLeaseUntil: undefined,
        workerRunId: undefined,
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
    } else return false;
    const retryNeedsApproval =
      a.action === "retry" && row.approvalRequired === true && row.approvalStatus !== "approved";
    await ctx.db.insert("workEvents", {
      jobId: String(a.jobId),
      missionId: row.missionId,
      agentId: row.agentId,
      type: a.action,
      message: `${a.action} requested by Daniel`,
      stage: retryNeedsApproval ? "approval" : a.action === "resume" || a.action === "retry" ? "queued" : `${a.action}d`,
      createdAt: now,
    });
    return true;
  },
});

export const active = query({
  args: { ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    const statuses = ["running", "dispatching", "pending", "awaiting_approval", "paused", "needs_input"];
    const groups = await Promise.all(
      statuses.map((status) =>
        ctx.db
          .query("jobRuntime")
          .withIndex("by_status_priority", (q: any) => q.eq("status", status))
          .take(30),
      ),
    );
    return groups
      .flat()
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
