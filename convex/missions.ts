import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireDispatcher, requireViewer, requireWorker, viewerAuthArgs } from "./controlAuth";
import { normalizeWorkModelTier } from "../src/lib/work-models";

const SYNTHESIS_LEASE_MS = 20 * 60 * 1000;

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

// Orchestration layer: a mission is a decomposed goal running as a fleet of
// parallel agent jobs. The runner calls checkComplete after every job — the
// LAST one to land flips the mission to "synthesizing" exactly once, and the
// runner then merges all results into a single report.

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
    const { authTokenHash: _authTokenHash, dispatchToken: _dispatchToken, workerToken: _workerToken, ...mission } = a;
    return await ctx.db.insert("missions", {
      goal: mission.goal.slice(0, 500),
      mode: "fleet",
      status: "running",
      agentCount: mission.agentCount,
      originThreadId: mission.originThreadId,
      managerAgentId: mission.managerAgentId ?? "jarvis",
      priority: Math.max(0, Math.min(100, mission.priority ?? 50)),
      risk: mission.risk ?? "low",
      phase: "delegating",
      percent: 0,
      acceptanceCriteria: mission.acceptanceCriteria,
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
  args: { ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    // Goal Mode can live for days. Indexed status reads keep it visible without
    // repeatedly scanning a large mission history on every reactive UI update.
    const [recent, ...openGroups] = await Promise.all([
      ctx.db.query("missions").withIndex("by_createdAt").order("desc").take(20),
      ...["running", "synthesizing", "paused", "needs_input"].map((status) =>
        ctx.db.query("missions").withIndex("by_status", (q: any) => q.eq("status", status)).order("desc").take(20),
      ),
    ]);
    const rows = [...openGroups.flat(), ...recent]
      .filter((mission: any, index: number, all: any[]) => all.findIndex((candidate: any) => candidate._id === mission._id) === index)
      .sort((left: any, right: any) => right.createdAt - left.createdAt);
    const live = rows.filter(
      (m: any) => ["running", "synthesizing", "paused", "needs_input"].includes(m.status) || Date.now() - m.updatedAt < 14 * 86_400_000,
    );
    const out = [];
    for (const m of live) {
      const jobs = await ctx.db
        .query("jobs")
        .withIndex("by_mission", (q: any) => q.eq("missionId", m._id))
        .collect();
      out.push({
        _id: m._id,
        goal: m.goal,
        mode: m.mode ?? "fleet",
        status: m.status,
        agentCount: m.agentCount,
        summary: m.summary ?? null,
        originThreadId: m.originThreadId ?? "main",
        managerAgentId: m.managerAgentId ?? "jarvis",
        phase: m.phase ?? m.status,
        percent: m.percent ?? 0,
        route: m.route ?? null,
        routeReason: m.routeReason ?? null,
        primaryRepo: m.primaryRepo ?? null,
        plan: m.plan ?? null,
        validation: m.validation ?? null,
        validationHistory: m.validationHistory ?? [],
        revisionWave: m.revisionWave ?? 0,
        maxRevisionWaves: m.maxRevisionWaves ?? 0,
        maxBuildSessions: m.maxBuildSessions ?? 0,
        sharedBranch: m.sharedBranch ?? null,
        pausedPhase: m.pausedPhase ?? null,
        externalKind: m.externalKind ?? null,
        externalRunId: m.externalRunId ?? null,
        externalSlug: m.externalSlug ?? null,
        externalStatus: m.externalStatus ?? null,
        externalStage: m.externalStage ?? null,
        externalPollFailures: m.externalPollFailures ?? 0,
        externalRevisionRequested: m.externalRevisionRequested ?? null,
        canExtendExternal: Boolean(
          m.externalKind === "app-factory" &&
          m.validation?.verdict === "refine" &&
          Array.isArray(m.pendingRefinements) &&
          m.pendingRefinements.length > 0,
        ),
        failureReason: m.failureReason ?? null,
        completedAt: m.completedAt ?? null,
        updatedAt: m.updatedAt,
        jobs: jobs.map((j: any) => ({
          _id: j._id,
          label: j.label ?? j.task.slice(0, 50),
          status: j.status,
          progress: j.progress ?? "",
          stage: j.stage ?? j.status,
          percent: j.percent ?? 0,
          agentId: j.agentId ?? null,
          attempt: j.attempt ?? 1,
          model: j.model ? normalizeWorkModelTier(j.model) : null,
          reasoningEffort: j.reasoningEffort ?? null,
          goalStage: j.goalStage ?? null,
          goalWorkstreamId: j.goalWorkstreamId ?? null,
          goalWave: j.goalWave ?? 0,
          readonly: Boolean(j.readonly),
          dependsOn: j.dependsOn ?? [],
          branch: j.branch ?? null,
          pullRequestUrl: j.pullRequestUrl ?? null,
          verificationNote: j.verificationNote ?? null,
        })),
      });
    }
    return out;
  },
});

// Atomically claim the synthesis step: returns the finished jobs ONLY for the
// single caller that flips running → synthesizing (no double reports).
export const checkComplete = mutation({
  args: { id: v.id("missions"), workerToken: v.optional(v.string()) },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const m = await ctx.db.get(a.id);
    if (!m || m.status !== "running" || m.mode === "goal") return null;
    const jobs = await ctx.db
      .query("jobs")
      .withIndex("by_mission", (q: any) => q.eq("missionId", a.id))
      .collect();
    if (jobs.length === 0) return null;
    const unfinished = jobs.filter((j: any) => !["done", "error", "cancelled"].includes(j.status));
    if (unfinished.length > 0) return null;
    const now = Date.now();
    const synthesisAttempt = (m.synthesisAttempt ?? 0) + 1;
    await ctx.db.patch(a.id, {
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
      .query("missions")
      .withIndex("by_status", (q: any) => q.eq("status", "synthesizing"))
      .order("asc")
      .take(30);
    for (const mission of synthesizing) {
      if (mission.mode === "goal") continue;
      if ((mission.synthesisLeaseUntil ?? mission.updatedAt + SYNTHESIS_LEASE_MS) > now) continue;
      const jobs = await ctx.db
        .query("jobs")
        .withIndex("by_mission", (q: any) => q.eq("missionId", mission._id))
        .collect();
      const synthesisAttempt = (mission.synthesisAttempt ?? 0) + 1;
      await ctx.db.patch(mission._id, {
        synthesisAttempt,
        synthesisLeaseUntil: now + SYNTHESIS_LEASE_MS,
        updatedAt: now,
      });
      return synthesisPayload(mission, jobs, synthesisAttempt);
    }
    const missions = await ctx.db
      .query("missions")
      .withIndex("by_status", (q: any) => q.eq("status", "running"))
      .order("asc")
      .take(30);
    for (const mission of missions) {
      if (mission.mode === "goal") continue;
      const jobs = await ctx.db
        .query("jobs")
        .withIndex("by_mission", (q: any) => q.eq("missionId", mission._id))
        .collect();
      if (!jobs.length || jobs.some((job: any) => !["done", "error", "cancelled"].includes(job.status))) continue;
      const synthesisAttempt = (mission.synthesisAttempt ?? 0) + 1;
      await ctx.db.patch(mission._id, {
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
    if (!mission || mission.status !== "synthesizing" || (mission.synthesisAttempt ?? 0) !== a.expectedSynthesisAttempt) {
      return false;
    }
    await ctx.db.patch(a.id, {
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
