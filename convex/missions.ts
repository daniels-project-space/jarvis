import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireDispatcher, requireViewer, requireWorker, viewerAuthArgs } from "./controlAuth";
import { normalizeWorkModelTier } from "../src/lib/work-models";
import {
  insertMissionWithRuntime,
  patchMissionWithRuntime,
  projectMissionRuntime,
  runtimeMission,
} from "./controlPlane";
import { classifyFleetHealth } from "../src/lib/fleet-health";
import { projectSourceAdmissionValidator, validProjectAdmissions } from "./sourceAdmission";

const SYNTHESIS_LEASE_MS = 20 * 60 * 1000;
const LEGACY_ADMISSION_TIMEOUT_MS = 15 * 60 * 1000;
const LEGACY_ADMISSION_INTERRUPTED = "Legacy mission admission was interrupted before any canonical jobs were created";

// Legacy fleet synthesis is an explicit allowlist. Goal Mode and every future
// supervisor protocol own their own leases, receipts, and terminal delivery;
// they must never enter this historical raw-result synthesizer by omission.
export function isLegacySynthesisMode(mode: unknown): mode is undefined | "fleet" | "single" {
  return mode === undefined || mode === "fleet" || mode === "single";
}

function missionProjectionDiffers(runtime: Record<string, unknown>, projected: Record<string, unknown>) {
  const runtimeKeys = Object.keys(runtime).filter((key) => key !== "_id" && key !== "_creationTime");
  const projectedKeys = Object.keys(projected);
  if (runtimeKeys.length !== projectedKeys.length) return true;
  return projectedKeys.some((key) => JSON.stringify(runtime[key]) !== JSON.stringify(projected[key]));
}

function synthesisPayload(mission: any, jobs: any[], attempt: number) {
  return {
    id: mission._id,
    goal: mission.goal,
    originThreadId: mission.originThreadId ?? "main",
    synthesisAttempt: attempt,
    results: jobs.map((job: any) => ({
      label: job.label ?? job.task.slice(0, 60),
      status: job.status,
      result: (job.result ?? "").slice(0, 6000),
    })),
  };
}

function missionJobActivity(job: any) {
  const now = Date.now();
  return {
    _id: job.jobId,
    label: job.label ?? job.task.slice(0, 50),
    status: job.status,
    progress: job.progress ?? "",
    stage: job.stage ?? job.status,
    percent: job.percent ?? 0,
    agentId: job.agentId ?? null,
    attempt: job.attempt ?? 1,
    model: job.model ? normalizeWorkModelTier(job.model) : null,
    reasoningEffort: job.reasoningEffort ?? null,
    goalStage: job.goalStage ?? null,
    goalWorkstreamId: job.goalWorkstreamId ?? null,
    goalWave: job.goalWave ?? 0,
    readonly: Boolean(job.readonly),
    dependsOn: job.dependsOn ?? [],
    parentGoal: job.missionId ?? null,
    currentActivity: classifyFleetHealth(job, now),
    heartbeatAt: job.heartbeatAt ?? null,
    heartbeatFresh: Number(job.heartbeatAt ?? 0) >= now - 5 * 60_000,
    sourceBranch: job.sourceBranch ?? null,
    sourceHeadSha: job.sourceHeadSha ?? null,
    workerBranch: job.workerBranch ?? null,
    workspaceLineage: job.workspaceLineage ?? null,
    retryLineage: job.retryLineage ?? null,
    retryReason: job.stallReason ?? null,
    integrationState: job.integrationState ?? "not_applicable",
    evidenceSummary: job.evidenceSummary ?? null,
    createdAt: job.createdAt,
    startedAt: job.startedAt ?? null,
    completedAt: job.completedAt ?? null,
    branch: job.branch ?? null,
    pullRequestUrl: job.pullRequestUrl ?? null,
    verificationNote: null,
    workerRunId: job.workerRunId ?? null,
    workerRuntime: job.workerRuntime ?? null,
  };
}

// Orchestration layer: a mission is a decomposed goal running as a fleet of
// parallel agent jobs. The runner calls checkComplete after every job — the
// LAST one to land flips the mission to "synthesizing" exactly once, and the
// runner then merges all results into a single report.

const LEGACY_ADMISSION_HOLD = "protocol_v1_admission_held";

// Kept byte-for-byte compatible with the pre-v2 caller contract. Once the
// additive Convex release lands, old producers still receive a durable mission
// id, but cannot accidentally create executable work without source authority.
export const create = mutation({
  args: {
    goal: v.string(),
    agentCount: v.number(),
    originThreadId: v.optional(v.string()),
    managerAgentId: v.optional(v.string()),
    priority: v.optional(v.number()),
    risk: v.optional(v.string()),
    acceptanceCriteria: v.optional(v.array(v.string())),
    authTokenHash: v.optional(v.string()),
    dispatchToken: v.optional(v.string()),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    await requireDispatcher(ctx, a);
    const now = Date.now();
    return await insertMissionWithRuntime(ctx, {
      goal: a.goal.slice(0, 500),
      mode: "fleet",
      status: "needs_input",
      agentCount: Math.max(0, Math.floor(a.agentCount)),
      originThreadId: a.originThreadId,
      managerAgentId: a.managerAgentId ?? "jarvis",
      priority: Math.max(0, Math.min(100, a.priority ?? 50)),
      risk: a.risk ?? "low",
      phase: "protocol_hold",
      percent: 0,
      acceptanceCriteria: a.acceptanceCriteria,
      admissionProtocolVersion: 1,
      protocolHoldReason: LEGACY_ADMISSION_HOLD,
      failureReason: "Legacy mission admission is durably held until the v2 source-authority rollout is active",
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const createV2 = mutation({
  args: {
    goal: v.string(),
    agentCount: v.number(),
    originThreadId: v.optional(v.string()),
    managerAgentId: v.optional(v.string()),
    priority: v.optional(v.number()),
    risk: v.optional(v.string()),
    acceptanceCriteria: v.optional(v.array(v.string())),
    mode: v.optional(v.union(v.literal("fleet"), v.literal("single"))),
    projectAdmissions: v.array(projectSourceAdmissionValidator),
    authTokenHash: v.optional(v.string()),
    dispatchToken: v.optional(v.string()),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    await requireDispatcher(ctx, a);
    if (!await validProjectAdmissions(a.projectAdmissions, { requireFresh: true })) {
      throw new Error("Mission requires fresh canonical project source admissions");
    }
    const { authTokenHash: _authTokenHash, dispatchToken: _dispatchToken, workerToken: _workerToken, ...mission } = a;
    const repositoryAdmission = mission.projectAdmissions.length === 1 ? mission.projectAdmissions[0] : undefined;
    return await insertMissionWithRuntime(ctx, {
      goal: mission.goal.slice(0, 500),
      admissionProtocolVersion: 2,
      mode: mission.mode ?? "fleet",
      status: "running",
      agentCount: mission.agentCount,
      originThreadId: mission.originThreadId,
      managerAgentId: mission.managerAgentId ?? "jarvis",
      priority: Math.max(0, Math.min(100, mission.priority ?? 50)),
      risk: mission.risk ?? "low",
      phase: "delegating",
      percent: 0,
      acceptanceCriteria: mission.acceptanceCriteria,
      projectAdmissions: mission.projectAdmissions,
      canonicalProjectId: repositoryAdmission?.canonicalProjectId,
      primaryRepo: repositoryAdmission?.repository,
      sourceProvider: repositoryAdmission?.sourceProvider,
      sourceBranch: repositoryAdmission?.sourceBranch,
      sourceRef: repositoryAdmission?.sourceRef,
      sourceHeadSha: repositoryAdmission?.sourceHeadSha,
      sourceObservedAt: repositoryAdmission?.sourceObservedAt,
      sourceAdmissionDigest: repositoryAdmission?.sourceAdmissionDigest,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  },
});

export const get = query({
  args: { id: v.id("missions"), ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    return ctx.db.get(a.id);
  },
});

// Missions still in flight plus recent history. Finished missions remain useful
// context for the command centre; do not make them disappear after ten minutes.
export const active = query({
  args: { includeJobs: v.optional(v.boolean()), ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    // Goal Mode can live for days. Indexed status reads keep it visible without
    // repeatedly scanning a large mission history on every reactive UI update.
    const [recent, ...openGroups] = await Promise.all([
      ctx.db.query("missionRuntime").withIndex("by_createdAt").order("desc").take(20),
      ...["running", "split", "synthesizing", "paused", "needs_input"].map((status) =>
        ctx.db.query("missionRuntime").withIndex("by_status", (q: any) => q.eq("status", status)).order("desc").take(20),
      ),
    ]);
    const rows = [...openGroups.flat(), ...recent]
      .filter((mission: any, index: number, all: any[]) => all.findIndex((candidate: any) => candidate.missionId === mission.missionId) === index)
      .sort((left: any, right: any) => right.createdAt - left.createdAt);
    const live = rows.filter(
      (m: any) => ["running", "split", "synthesizing", "paused", "needs_input"].includes(m.status) || Date.now() - m.updatedAt < 14 * 86_400_000,
    );
    const out = [];
    for (const m of live) {
      // Human/model status summaries may opt into child rows for a one-shot
      // read. The reactive fleet list stays mission-only so one heartbeat does
      // not fan out across every historical mission's children.
      const jobs = a.includeJobs
        ? await ctx.db
            .query("jobRuntime")
            .withIndex("by_mission", (q: any) => q.eq("missionId", String(m.missionId)))
            .take(100)
        : [];
      out.push({
        ...runtimeMission(m),
        _id: m.missionId,
        goal: m.goal,
        mode: m.mode ?? "fleet",
        status: m.status,
        agentCount: m.agentCount,
        summary: null,
        originThreadId: m.originThreadId ?? "main",
        managerAgentId: m.managerAgentId ?? "jarvis",
        phase: m.phase ?? m.status,
        percent: m.percent ?? 0,
        route: m.route ?? null,
        routeReason: null,
        primaryRepo: m.primaryRepo ?? null,
        plan: null,
        validation: null,
        validationHistory: [],
        revisionWave: m.revisionWave ?? 0,
        maxRevisionWaves: m.maxRevisionWaves ?? 0,
        maxBuildSessions: m.maxBuildSessions ?? 0,
        sharedBranch: null,
        sourceBranch: m.sourceBranch ?? null,
        integrationBranch: m.integrationBranch ?? null,
        integrationHeadSha: m.integrationHeadSha ?? null,
        integrationGeneration: m.integrationGeneration ?? 0,
        activeIntegrationAttemptId: m.activeIntegrationAttemptId ?? null,
        integrationLeaseUntil: m.integrationLeaseUntil ?? null,
        pausedPhase: m.pausedPhase ?? null,
        externalKind: m.externalKind ?? null,
        externalRunId: m.externalRunId ?? null,
        externalSlug: m.externalSlug ?? null,
        externalStatus: m.externalStatus ?? null,
        externalStage: m.externalStage ?? null,
        externalPollFailures: m.externalPollFailures ?? 0,
        externalRevisionRequested: m.externalRevisionRequested ?? null,
        canExtendExternal: false,
        failureReason: m.failureReason ?? null,
        completedAt: m.completedAt ?? null,
        updatedAt: m.updatedAt,
        jobs: jobs.map(missionJobActivity),
      });
    }
    return out;
  },
});

// The fleet panel subscribes only to the selected mission's compact children.
// This is the live detail surface; rich plans and reports remain in get().
export const activity = query({
  args: { id: v.id("missions"), ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    const jobs = await ctx.db
      .query("jobRuntime")
      .withIndex("by_mission", (q: any) => q.eq("missionId", String(a.id)))
      .take(100);
    return jobs.map(missionJobActivity);
  },
});

// Atomically claim the synthesis step: returns the finished jobs ONLY for the
// single caller that flips running → synthesizing (no double reports).
export const checkComplete = mutation({
  args: { id: v.id("missions"), workerToken: v.optional(v.string()) },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const m = await ctx.db.get(a.id);
    if (!m || m.status !== "running" || !isLegacySynthesisMode(m.mode)) return null;
    const jobs = await ctx.db
      .query("jobs")
      .withIndex("by_mission", (q: any) => q.eq("missionId", a.id))
      .take(100);
    if (jobs.length === 0) return null;
    const unfinished = jobs.filter((j: any) => !["done", "error", "cancelled"].includes(j.status));
    if (unfinished.length > 0) return null;
    const now = Date.now();
    const synthesisAttempt = (m.synthesisAttempt ?? 0) + 1;
    await patchMissionWithRuntime(ctx, m, {
      status: "synthesizing",
      phase: "reviewing",
      percent: 90,
      synthesisAttempt,
      synthesisLeaseUntil: now + SYNTHESIS_LEASE_MS,
      updatedAt: now,
    });
    return synthesisPayload(m, jobs, synthesisAttempt);
  },
});

// A mission can become terminal without a worker completing (for example,
// Daniel declines its only approval-gated workstream). The scheduled supervisor
// atomically claims these orphaned completions so they are synthesized once
// instead of remaining as ghost "running" missions forever.
export const claimReady = mutation({
  args: { workerToken: v.optional(v.string()) },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const now = Date.now();
    // A Trigger task can be interrupted after the atomic claim but before the
    // report is committed. Reclaim only after the 15-minute synthesizer ceiling
    // plus margin, and increment the lease so a late first writer is rejected.
    const synthesizing = await ctx.db
      .query("missionRuntime")
      .withIndex("by_status", (q: any) => q.eq("status", "synthesizing"))
      .order("asc")
      .take(30);
    for (const activity of synthesizing) {
      const mission = await ctx.db.get(activity.missionId);
      if (!mission) {
        if (isLegacySynthesisMode(activity.mode)) await ctx.db.delete(activity._id);
        continue;
      }
      if (!isLegacySynthesisMode(mission.mode)) continue;
      const projectedMission = projectMissionRuntime(mission);
      if (missionProjectionDiffers(activity, projectedMission)) {
        await ctx.db.replace(activity._id, projectedMission);
      }
      if (mission.status !== "synthesizing"
        || (mission.synthesisLeaseUntil ?? mission.updatedAt + SYNTHESIS_LEASE_MS) > now) continue;
      const jobs = await ctx.db
        .query("jobs")
        .withIndex("by_mission", (q: any) => q.eq("missionId", String(mission._id)))
        .take(100);
      if (!jobs.length) {
        if (mission.createdAt + LEGACY_ADMISSION_TIMEOUT_MS > now) continue;
        await patchMissionWithRuntime(ctx, mission, {
          status: "failed",
          phase: "failed",
          percent: 100,
          failureReason: LEGACY_ADMISSION_INTERRUPTED,
          completedAt: now,
          synthesisLeaseUntil: undefined,
          updatedAt: now,
        });
        continue;
      }
      if (jobs.some((job) => !["done", "error", "cancelled"].includes(job.status))) continue;
      const synthesisAttempt = (mission.synthesisAttempt ?? 0) + 1;
      await patchMissionWithRuntime(ctx, mission, {
        synthesisAttempt,
        synthesisLeaseUntil: now + SYNTHESIS_LEASE_MS,
        updatedAt: now,
      });
      return synthesisPayload(mission, jobs, synthesisAttempt);
    }
    const missions = await ctx.db
      .query("missionRuntime")
      .withIndex("by_status", (q: any) => q.eq("status", "running"))
      .order("asc")
      .take(30);
    for (const activity of missions) {
      const mission = await ctx.db.get(activity.missionId);
      if (!mission) {
        // A projection cannot prove what a deleted mission's protocol was. Only
        // remove rows that positively identify themselves as legacy.
        if (isLegacySynthesisMode(activity.mode)) await ctx.db.delete(activity._id);
        continue;
      }
      // The canonical mission owns protocol and lifecycle authority. Goal and
      // supervised missions are deliberately outside this legacy reconciler.
      if (!isLegacySynthesisMode(mission.mode)) continue;

      const projectedMission = projectMissionRuntime(mission);
      if (missionProjectionDiffers(activity, projectedMission)) {
        await ctx.db.replace(activity._id, projectedMission);
      }
      if (mission.status !== "running") continue;

      // Canonical jobs are the only completion authority. A missing or stale
      // jobRuntime projection must never suppress a valid synthesis claim, and
      // a terminal projection must never fabricate one.
      const jobs = await ctx.db
        .query("jobs")
        .withIndex("by_mission", (q: any) => q.eq("missionId", String(mission._id)))
        .take(100);
      if (!jobs.length) {
        if (mission.createdAt + LEGACY_ADMISSION_TIMEOUT_MS > now) continue;
        await patchMissionWithRuntime(ctx, mission, {
          status: "failed",
          phase: "failed",
          percent: 100,
          failureReason: LEGACY_ADMISSION_INTERRUPTED,
          completedAt: now,
          synthesisLeaseUntil: undefined,
          updatedAt: now,
        });
        continue;
      }
      if (jobs.some((job) => !["done", "error", "cancelled"].includes(job.status))) continue;
      const synthesisAttempt = (mission.synthesisAttempt ?? 0) + 1;
      await patchMissionWithRuntime(ctx, mission, {
        status: "synthesizing",
        phase: "reviewing",
        percent: 90,
        synthesisAttempt,
        synthesisLeaseUntil: now + SYNTHESIS_LEASE_MS,
        updatedAt: now,
      });
      return synthesisPayload(mission, jobs, synthesisAttempt);
    }
    return null;
  },
});

export const finish = mutation({
  args: {
    id: v.id("missions"),
    summary: v.string(),
    failed: v.optional(v.boolean()),
    expectedSynthesisAttempt: v.number(),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const mission = await ctx.db.get(a.id);
    if (!mission || mission.status !== "synthesizing" || !isLegacySynthesisMode(mission.mode)
      || (mission.synthesisAttempt ?? 0) !== a.expectedSynthesisAttempt) {
      return false;
    }
    await patchMissionWithRuntime(ctx, mission, {
      status: a.failed ? "failed" : "done",
      phase: a.failed ? "failed" : "complete",
      percent: 100,
      summary: a.summary.slice(0, 4000),
      synthesisLeaseUntil: undefined,
      updatedAt: Date.now(),
    });
    return true;
  },
});
