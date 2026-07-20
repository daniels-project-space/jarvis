import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { workApprovalPolicy } from "./workPolicy";
import { classifyWorkSafety, isOwnedRepository } from "../src/lib/work-safety";
import { requireActor, requireDispatcher, requireViewer, requireWorker, viewerAuthArgs } from "./controlAuth";
import { buildContinuationCheckpoint } from "../src/lib/work-checkpoint";
import { normalizeWorkModelTier } from "../src/lib/work-models";
import { goalJobMatchesMissionPhase } from "../src/lib/goal-mode";
import { redactSensitiveText } from "../src/lib/secret-redaction";

const STALE_RUNNER_MS = 5 * 60 * 1000;
const DISPATCH_LEASE_MS = 2 * 60 * 1000;

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
    const id = await ctx.db.insert("jobs", {
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

// One-time-compatible policy reconciliation. Jobs created before autonomous
// software work could inherit a planner-level approval hint even inside
// Daniel's own repositories. A worker wake upgrades every safe owned-repo job;
// messages, money, public publishing and destructive work remain untouched in
// awaiting_approval.
export const reconcileAutonomousSoftwareWork = mutation({
  args: { workerToken: v.optional(v.string()) },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const rows = await ctx.db
      .query("jobs")
      .withIndex("by_status", (q) => q.eq("status", "awaiting_approval"))
      .take(100);
    const now = Date.now();
    let reconciled = 0;
    for (const row of rows) {
      const safety = classifyWorkSafety(row.task, { repo: row.repo });
      if (safety.approvalRequired || !isOwnedRepository(row.repo)) continue;
      await ctx.db.patch(row._id, {
        status: "pending",
        readonly: false,
        risk: row.risk === "consequential" ? "high" : row.risk,
        approvalRequired: false,
        approvalReason: undefined,
        approvalStatus: "superseded",
        deliveryMode: "auto_merge",
        stage: "queued",
        progress: "autonomous software delivery enabled — queued",
        nextRunAt: now,
      });
      const approvals = await ctx.db
        .query("approvals")
        .withIndex("by_job", (q) => q.eq("jobId", String(row._id)))
        .collect();
      for (const approval of approvals) {
        if (approval.status === "pending") {
          await ctx.db.patch(approval._id, { status: "superseded", resolvedAt: now });
        }
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
      reconciled += 1;
    }
    return reconciled;
  },
});

async function runnableCandidates(ctx: any, now: number, limit: number): Promise<any[]> {
  const candidates = await ctx.db
    .query("jobs")
    .withIndex("by_status_next_run", (q: any) => q.eq("status", "pending").lte("nextRunAt", now))
    .take(Math.max(40, Math.min(120, limit * 8)));
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
        mission = missionId ? await ctx.db.get(missionId) : null;
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
        dep = id ? await ctx.db.get(id) : null;
        dependencyCache.set(dependency, dep ?? null);
      }
      if (!dep || dep.status !== "done") {
        blocked = true;
        break;
      }
    }
    if (!blocked) {
      runnable.push(candidate);
      if (runnable.length >= limit) break;
    }
  }
  return runnable;
}

function claimedJob(j: any) {
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
    verificationVerdict: j.verificationVerdict ?? null,
    verificationNote: j.verificationNote ?? null,
    acceptanceCriteria: j.acceptanceCriteria ?? [],
    modelReason: j.modelReason ?? null,
    parentJobId: j.parentJobId ?? null,
    goalStage: j.goalStage ?? null,
    goalWorkstreamId: j.goalWorkstreamId ?? null,
    goalWave: j.goalWave ?? 0,
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
      await ctx.db.patch(j._id, {
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
    await ctx.db.patch(j._id, {
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
    return claimedJob(j);
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
    await ctx.db.patch(a.jobId, {
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
    const now = Date.now();
    const success = a.status === "done";
    const delivered = success && row.deliveryStatus === "merged";
    await ctx.db.patch(a.jobId, {
      status: a.status,
      result: a.result,
      pullRequestUrl: a.pullRequestUrl,
      completedAt: now,
      heartbeatAt: now,
      stage: success ? (delivered ? "delivered" : "verified") : a.status,
      percent: success ? 100 : row.percent,
      progress: success
        ? delivered ? "verified, merged and handed to deployment" : "verified and complete"
        : row.progress,
      verificationVerdict: a.verificationVerdict,
      verificationNote: a.verificationNote?.slice(0, 1000),
      verifiedAt: success ? now : undefined,
    });
    await ctx.db.insert("workEvents", {
      jobId: String(a.jobId),
      missionId: row.missionId,
      agentId: row.agentId,
      type: a.status,
      message: success
        ? delivered ? "Work verified and merged automatically" : "Work verified and complete"
        : (a.result ?? a.status).slice(0, 500),
      stage: success ? (delivered ? "delivered" : "verified") : a.status,
      percent: success ? 100 : row.percent,
      createdAt: now,
    });
    if (row.missionId) {
      const missionId = ctx.db.normalizeId("missions", row.missionId);
      if (missionId) {
        const mission = await ctx.db.get(missionId);
        const jobs = await ctx.db
          .query("jobs")
          .withIndex("by_mission", (q: any) => q.eq("missionId", row.missionId))
          .collect();
        if (mission && mission.mode === "goal") {
          const stage = mission.phase === "refining" ? "refining" : mission.phase === "building" ? "building" : null;
          if (stage) {
            const wave = mission.revisionWave ?? 0;
            const phaseJobs = jobs.filter((job: any) => job.goalStage === stage && (job.goalWave ?? 0) === wave);
            const finished = phaseJobs.filter((job: any) => ["done", "error", "cancelled"].includes(job.status)).length;
            const start = stage === "building" ? 12 : Math.min(90, 84 + wave * 3);
            const end = stage === "building" ? 78 : Math.min(96, start + 6);
            await ctx.db.patch(missionId, {
              percent: Math.max(mission.percent ?? 0, Math.round(start + ((end - start) * finished) / Math.max(1, phaseJobs.length))),
              updatedAt: now,
            });
          }
        } else if (mission) {
          const finished = jobs.filter((j: any) => ["done", "error", "cancelled"].includes(j.status)).length;
          await ctx.db.patch(missionId, {
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
      .query("jobs")
      .withIndex("by_createdAt")
      .order("desc")
      .take(Math.min(a.limit ?? 20, 100));
    return rows.map((row: any) => ({
      ...row,
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
    await ctx.db.patch(a.jobId, patch);
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
      .query("jobs")
      .withIndex("by_status", (q: any) => q.eq("status", "dispatching"))
      .take(100);
    const releasedDispatches: string[] = [];
    for (const j of dispatching) {
      if ((j.dispatchLeaseUntil ?? j.heartbeatAt ?? j.createdAt) > now) continue;
      await ctx.db.patch(j._id, {
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
      .query("jobs")
      .withIndex("by_status", (q: any) => q.eq("status", "running"))
      .take(100);
    const requeued: string[] = [];
    const abandoned: string[] = [];
    for (const j of running) {
      const heartbeat = j.heartbeatAt ?? j.startedAt ?? j.createdAt;
      // The serialized Trigger task heartbeats every 30 seconds. If its run
      // disappears (for example an OOM kill), the next scheduled invocation is
      // the only possible reaper, so five quiet minutes is ample fencing while
      // avoiding a long ghost-running window.
      if (now - heartbeat < STALE_RUNNER_MS) continue;
      const nextAttempt = (j.attempt ?? 1) + 1;
      if (now - j.createdAt > 14 * 86_400_000 || nextAttempt > (j.maxAttempts ?? 12)) {
        await ctx.db.patch(j._id, {
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
          narrative: j.result ?? j.progress,
          trace: j.log,
          deliveryNote: j.branch ? `checkpoint branch ${j.branch} retained` : undefined,
        });
        await ctx.db.patch(j._id, {
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
    log: v.optional(v.string()),
    stage: v.optional(v.string()),
    percent: v.optional(v.number()),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const row = await ctx.db.get(a.jobId);
    if (!row || row.status !== "running" || (row.attempt ?? 1) !== a.expectedAttempt) return false;
    const now = Date.now();
    const percent = a.percent === undefined ? row.percent : Math.max(0, Math.min(99, a.percent));
    const patch: Record<string, unknown> = {
      progress: a.progress.slice(0, 400),
      heartbeatAt: now,
      percent,
    };
    if (a.stage !== undefined) patch.stage = a.stage.slice(0, 80);
    if (a.log !== undefined) patch.log = a.log.slice(-12_000);
    await ctx.db.patch(a.jobId, patch);
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
        await ctx.db.patch(a.jobId, {
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
    await ctx.db.patch(a.jobId, {
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
    return (await ctx.db.get(a.jobId))?.status ?? "missing";
  },
});

export const executionLease = query({
  args: { jobId: v.id("jobs"), ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    const row = await ctx.db.get(a.jobId);
    return row ? { status: row.status, attempt: row.attempt ?? 1 } : { status: "missing", attempt: 0 };
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
    await ctx.db.patch(a.jobId, {
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
    await ctx.db.patch(a.jobId, {
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
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const row = await ctx.db.get(a.jobId);
    if (!row || row.status !== "running" || (row.attempt ?? 1) !== a.expectedAttempt) return false;
    await ctx.db.patch(a.jobId, {
      branch: a.branch,
      pullRequestUrl: a.pullRequestUrl,
      deliveryStatus: a.deliveryStatus,
      mergeCommitSha: a.mergeCommitSha?.slice(0, 80),
      mergedAt: a.deliveryStatus === "merged" ? Date.now() : undefined,
      heartbeatAt: Date.now(),
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
    await ctx.db.patch(a.jobId, {
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
      await ctx.db.patch(a.jobId, {
        status: "paused",
        stage: "paused",
        progress: "paused by Daniel",
        nextRunAt: undefined,
        dispatchId: undefined,
        dispatchLeaseUntil: undefined,
      });
    else if (a.action === "resume" && row.status === "paused")
      await ctx.db.patch(a.jobId, {
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
      await ctx.db.patch(a.jobId, {
        status: "cancelled",
        stage: "cancelled",
        completedAt: now,
        progress: "cancelled by Daniel",
        nextRunAt: undefined,
      });
      const approvals = await ctx.db
        .query("approvals")
        .withIndex("by_job", (q: any) => q.eq("jobId", String(a.jobId)))
        .collect();
      for (const approval of approvals) {
        if (approval.status === "pending") await ctx.db.patch(approval._id, { status: "cancelled", resolvedAt: now });
      }
    } else if (a.action === "retry" && ["error", "cancelled"].includes(row.status)) {
      const renewApproval = row.approvalRequired === true && row.approvalStatus !== "approved";
      await ctx.db.patch(a.jobId, {
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
          .query("jobs")
          .withIndex("by_status", (q: any) => q.eq("status", status))
          .take(30),
      ),
    );
    return groups
      .flat()
      .sort((a: any, b: any) => (b.priority ?? 50) - (a.priority ?? 50) || a.createdAt - b.createdAt)
      .map((j: any) => ({
        _id: j._id,
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
    const row = await ctx.db.get(a.jobId);
    return row?.workerRunId
      ? { runId: row.workerRunId, taskId: "jarvis-agent-worker", runtime: row.workerRuntime ?? "trigger" }
      : null;
  },
});
