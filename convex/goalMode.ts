import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireAdmin, requireDispatcher, requireWorker } from "./controlAuth";
import { workApprovalPolicy } from "./workPolicy";
import {
  goalBranch,
  plannerTask,
  validatorTask,
  type GoalPlan,
  type GoalRefinement,
  type GoalRoute,
  type GoalValidation,
} from "../src/lib/goal-mode";

const ADVANCE_LEASE_MS = 10 * 60 * 1000;
const TERMINAL = new Set(["done", "error", "cancelled"]);

type GoalJobInput = {
  task: string;
  missionId: string;
  label: string;
  repo?: string;
  readonly?: boolean;
  model: "terra" | "sol";
  reasoningEffort: "high" | "max";
  mcp?: string[];
  originThreadId?: string;
  agentId: string;
  risk?: string;
  priority: number;
  acceptanceCriteria: string[];
  modelReason: string;
  dependsOn?: string[];
  maxAttempts?: number;
  branch?: string;
  goalStage: "planning" | "building" | "validating" | "refining";
  goalWorkstreamId?: string;
  goalWave: number;
};

async function insertGoalJob(ctx: any, input: GoalJobInput) {
  const now = Date.now();
  const approval = workApprovalPolicy(input);
  const approvalRequired = approval.required;
  const status = approvalRequired ? "awaiting_approval" : "pending";
  const jobId = await ctx.db.insert("jobs", {
    ...input,
    task: input.task.slice(0, 6000),
    label: input.label.slice(0, 80),
    visibility: "conversation",
    status,
    risk: approvalRequired ? (input.risk ?? "consequential") : (input.risk ?? "high"),
    approvalRequired,
    approvalReason: approval.reason,
    approvalStatus: approvalRequired ? "pending" : undefined,
    stage: approvalRequired ? "approval" : "queued",
    percent: 0,
    attempt: 1,
    maxAttempts: Math.max(1, Math.min(48, input.maxAttempts ?? 24)),
    nextRunAt: approvalRequired ? undefined : now,
    createdAt: now,
  });
  await ctx.db.insert("workEvents", {
    jobId: String(jobId),
    missionId: input.missionId,
    agentId: input.agentId,
    type: approvalRequired ? "approval_requested" : "queued",
    message: approvalRequired
      ? `Goal session waiting for Daniel's approval${approval.reason ? ` · ${approval.reason}` : ""}`
      : `Goal Mode ${input.goalStage} session queued`,
    stage: approvalRequired ? "approval" : "queued",
    percent: 0,
    data: { goalStage: input.goalStage, goalWave: input.goalWave, reasoningEffort: input.reasoningEffort },
    createdAt: now,
  });
  if (approvalRequired) {
    await ctx.db.insert("approvals", {
      jobId: String(jobId),
      kind: "goal-mode-work",
      summary: input.label.slice(0, 240),
      risk: input.risk ?? "consequential",
      payload: { repo: input.repo, agentId: input.agentId, reason: approval.reason },
      status: "pending",
      requestedAt: now,
    });
  }
  return jobId;
}

function missionBranch(mission: any, repo?: string) {
  if (!repo) return undefined;
  if (mission.sharedBranch) return String(mission.sharedBranch);
  return goalBranch(mission.goal, String(mission._id));
}

async function recordMissionEvent(ctx: any, missionId: string, type: string, message: string, stage: string, percent?: number, data?: unknown) {
  await ctx.db.insert("workEvents", {
    missionId,
    agentId: "jarvis",
    type,
    message: message.slice(0, 1000),
    stage,
    percent,
    data,
    createdAt: Date.now(),
  });
}

export const create = mutation({
  args: {
    goal: v.string(),
    route: v.string(),
    routeReason: v.string(),
    primaryRepo: v.optional(v.string()),
    infrastructureContext: v.string(),
    originThreadId: v.optional(v.string()),
    priority: v.optional(v.number()),
    risk: v.optional(v.string()),
    acceptanceCriteria: v.optional(v.array(v.string())),
    maxBuildSessions: v.optional(v.number()),
    maxRevisionWaves: v.optional(v.number()),
    authTokenHash: v.optional(v.string()),
    dispatchToken: v.optional(v.string()),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireDispatcher(ctx, args);
    const now = Date.now();
    const goal = args.goal.trim().slice(0, 500);
    if (goal.length < 12) throw new Error("Goal Mode needs a concrete outcome");
    const maxBuildSessions = Math.max(2, Math.min(8, Math.floor(args.maxBuildSessions ?? 6)));
    const maxRevisionWaves = Math.max(1, Math.min(4, Math.floor(args.maxRevisionWaves ?? 2)));
    const criteria = (args.acceptanceCriteria ?? []).map((item) => item.trim().slice(0, 500)).filter(Boolean).slice(0, 10);
    const route: GoalRoute = {
      kind: args.route as GoalRoute["kind"],
      primaryRepo: args.primaryRepo,
      reason: args.routeReason.slice(0, 1000),
      infrastructureContext: args.infrastructureContext.slice(0, 4000),
    };
    const missionId = await ctx.db.insert("missions", {
      goal,
      mode: "goal",
      status: "running",
      agentCount: 1,
      originThreadId: args.originThreadId,
      managerAgentId: "jarvis",
      priority: Math.max(0, Math.min(100, args.priority ?? 95)),
      risk: args.risk ?? "high",
      phase: "planning",
      percent: 3,
      acceptanceCriteria: criteria,
      route: route.kind,
      routeReason: route.reason,
      primaryRepo: route.primaryRepo,
      infrastructureContext: route.infrastructureContext,
      revisionWave: 0,
      maxRevisionWaves,
      maxBuildSessions,
      advanceAttempt: 0,
      createdAt: now,
      updatedAt: now,
    });
    const plannerJobId = await insertGoalJob(ctx, {
      task: plannerTask(goal, route, criteria, maxBuildSessions),
      missionId: String(missionId),
      label: "JARVIS · goal architecture",
      repo: route.primaryRepo,
      readonly: true,
      model: "sol",
      reasoningEffort: "max",
      mcp: ["context7"],
      originThreadId: args.originThreadId,
      agentId: "jarvis",
      risk: "low",
      priority: 100,
      acceptanceCriteria: [
        "Inspect the current ownership boundary and reusable infrastructure",
        `Return a valid 2-${maxBuildSessions} session GOAL_PLAN_JSON contract`,
        "Keep consequential actions explicitly gated",
      ],
      modelReason: "Goal Mode uses exactly one Sol/max architecture session before implementation",
      maxAttempts: 16,
      goalStage: "planning",
      goalWorkstreamId: "goal-plan",
      goalWave: 0,
    });
    await ctx.db.patch(missionId, { planningJobId: String(plannerJobId) });
    await recordMissionEvent(ctx, String(missionId), "goal_started", "Goal Mode started with a Sol/max planning session", "planning", 3, {
      route: route.kind,
      primaryRepo: route.primaryRepo,
      maxBuildSessions,
      maxRevisionWaves,
    });
    return { missionId, plannerJobId, route: route.kind };
  },
});

function activeStageJobs(jobs: any[], mission: any) {
  const stage = mission.phase === "refining" ? "refining" : "building";
  const wave = Number(mission.revisionWave ?? 0);
  return jobs.filter((job) => job.goalStage === stage && Number(job.goalWave ?? 0) === wave);
}

async function enqueueValidator(ctx: any, mission: any, jobs: any[]) {
  const plan = mission.plan as GoalPlan;
  // App Factory owns its own repository/build lifecycle. Its final Sol session
  // validates the external run and must not be pointed at a made-up Jarvis branch.
  const branch = mission.externalRunId
    ? undefined
    : mission.sharedBranch || missionBranch(mission, mission.primaryRepo);
  const buildEvidence = jobs
    .filter((job) => job.goalStage === "building" || job.goalStage === "refining")
    .map((job) => ({
      label: job.label ?? job.task.slice(0, 80),
      status: job.status,
      result: String(job.result ?? job.progress ?? "").slice(0, 2_000),
    }));
  const task = validatorTask({
    goal: mission.goal,
    plan,
    acceptanceCriteria: mission.acceptanceCriteria ?? [],
    buildEvidence,
    revisionWave: Number(mission.revisionWave ?? 0),
  });
  const validatorJobId = await insertGoalJob(ctx, {
    task,
    missionId: String(mission._id),
    label: `JARVIS · deep validation ${Number(mission.revisionWave ?? 0) + 1}`,
    repo: mission.primaryRepo ?? plan.primaryRepo,
    readonly: true,
    model: "sol",
    reasoningEffort: "max",
    mcp: plan.validation.liveChecks.length ? ["playwright", "context7"] : ["context7"],
    originThreadId: mission.originThreadId,
    agentId: "jarvis",
    risk: "low",
    priority: 100,
    acceptanceCriteria: [
      "Run the plan's deep tests and inspect their actual evidence",
      "Validate the end-to-end outcome and relevant live/provider surfaces",
      "Return a valid GOAL_VALIDATION_JSON verdict",
    ],
    modelReason: "Goal Mode reserves Sol/max for skeptical end-to-end validation and refinement planning",
    branch,
    maxAttempts: 16,
    goalStage: "validating",
    goalWorkstreamId: `validation-${Number(mission.revisionWave ?? 0)}`,
    goalWave: Number(mission.revisionWave ?? 0),
  });
  const now = Date.now();
  await ctx.db.patch(mission._id, {
    phase: "validating",
    percent: Math.min(96, 82 + Number(mission.revisionWave ?? 0) * 5),
    validatorJobId: String(validatorJobId),
    agentCount: Number(mission.agentCount ?? 0) + 1,
    advanceLeaseUntil: undefined,
    updatedAt: now,
  });
  await recordMissionEvent(ctx, String(mission._id), "goal_validation_queued", "Sol/max deep validation queued", "validating", 82, {
    revisionWave: Number(mission.revisionWave ?? 0),
  });
  return validatorJobId;
}

export const claimAdvance = mutation({
  args: { workerToken: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    const now = Date.now();
    const running = await ctx.db
      .query("missions")
      .withIndex("by_status", (q: any) => q.eq("status", "running"))
      .order("asc")
      .take(50);
    for (const mission of running) {
      if (mission.mode !== "goal" || mission.externalRunId) continue;
      const jobs = await ctx.db
        .query("jobs")
        .withIndex("by_mission", (q: any) => q.eq("missionId", String(mission._id)))
        .collect();
      if (mission.phase === "planning") {
        const planner = jobs.find((job: any) => String(job._id) === mission.planningJobId);
        if (!planner || !TERMINAL.has(planner.status)) continue;
        if (planner.status !== "done") {
          await ctx.db.patch(mission._id, {
            status: "needs_input",
            phase: "blocked",
            failureReason: `The Sol planning session ended ${planner.status}: ${String(planner.result ?? "no result").slice(0, 800)}`,
            updatedAt: now,
          });
          await recordMissionEvent(ctx, String(mission._id), "goal_blocked", "Planning could not produce a verified plan", "blocked", mission.percent);
          continue;
        }
        if ((mission.advanceLeaseUntil ?? 0) > now) continue;
        const advanceAttempt = Number(mission.advanceAttempt ?? 0) + 1;
        await ctx.db.patch(mission._id, {
          advanceAttempt,
          advanceLeaseUntil: now + ADVANCE_LEASE_MS,
          updatedAt: now,
        });
        return {
          kind: "plan",
          missionId: mission._id,
          jobId: planner._id,
          result: String(planner.result ?? ""),
          route: mission.route,
          routeReason: mission.routeReason,
          primaryRepo: mission.primaryRepo,
          infrastructureContext: mission.infrastructureContext,
          expectedAdvanceAttempt: advanceAttempt,
          maxBuildSessions: mission.maxBuildSessions ?? 6,
        };
      }
      if (mission.phase === "building" || mission.phase === "refining") {
        const phaseJobs = activeStageJobs(jobs, mission);
        if (!phaseJobs.length || phaseJobs.some((job: any) => !TERMINAL.has(job.status))) continue;
        await enqueueValidator(ctx, mission, jobs);
        return { kind: "advanced", missionId: mission._id, phase: "validating" };
      }
      if (mission.phase === "validating") {
        const validator = jobs.find((job: any) => String(job._id) === mission.validatorJobId);
        if (!validator || !TERMINAL.has(validator.status)) continue;
        if (validator.status !== "done") {
          await ctx.db.patch(mission._id, {
            status: "needs_input",
            phase: "blocked",
            failureReason: `The Sol validation session ended ${validator.status}: ${String(validator.result ?? "no result").slice(0, 800)}`,
            updatedAt: now,
          });
          await recordMissionEvent(ctx, String(mission._id), "goal_blocked", "Deep validation could not complete", "blocked", mission.percent);
          continue;
        }
        if ((mission.advanceLeaseUntil ?? 0) > now) continue;
        const advanceAttempt = Number(mission.advanceAttempt ?? 0) + 1;
        await ctx.db.patch(mission._id, {
          advanceAttempt,
          advanceLeaseUntil: now + ADVANCE_LEASE_MS,
          updatedAt: now,
        });
        return {
          kind: "validation",
          missionId: mission._id,
          jobId: validator._id,
          result: String(validator.result ?? ""),
          expectedAdvanceAttempt: advanceAttempt,
        };
      }
    }
    return null;
  },
});

export const recordPlan = mutation({
  args: {
    id: v.id("missions"),
    expectedAdvanceAttempt: v.number(),
    plan: v.any(),
    externalRun: v.optional(v.object({ kind: v.string(), id: v.string(), slug: v.optional(v.string()) })),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    const mission = await ctx.db.get(args.id);
    if (
      !mission || mission.mode !== "goal" || mission.status !== "running" || mission.phase !== "planning" ||
      Number(mission.advanceAttempt ?? 0) !== args.expectedAdvanceAttempt
    ) return { advanced: false, stale: true };
    const plan = args.plan as GoalPlan;
    if (!Array.isArray(plan?.workstreams) || plan.workstreams.length < 2 || plan.workstreams.length > (mission.maxBuildSessions ?? 6)) {
      throw new Error("Goal plan workstream budget is invalid");
    }
    const now = Date.now();
    if (mission.route === "app_factory") {
      if (!args.externalRun?.id) throw new Error("App Factory route requires a live factory run");
      await ctx.db.patch(args.id, {
        plan,
        phase: "building",
        percent: 12,
        externalKind: args.externalRun.kind,
        externalRunId: args.externalRun.id,
        externalSlug: args.externalRun.slug,
        externalStatus: "queued",
        externalStage: "inception",
        externalUpdatedAt: now,
        advanceLeaseUntil: undefined,
        updatedAt: now,
      });
      await recordMissionEvent(ctx, String(args.id), "goal_plan_ready", "Sol plan accepted; App Factory now owns the build lifecycle", "building", 12, {
        externalRunId: args.externalRun.id,
        externalSlug: args.externalRun.slug,
      });
      return { advanced: true, external: true, jobs: 0 };
    }

    const branch = missionBranch(mission, mission.primaryRepo ?? plan.primaryRepo);
    const workstreamJobs = new Map<string, string>();
    const lastWritableByRepo = new Map<string, string>();
    let waitingApprovals = 0;
    for (const stream of plan.workstreams) {
      const repo = stream.repo || mission.primaryRepo || plan.primaryRepo;
      const dependencies = stream.dependsOn
        .map((id) => workstreamJobs.get(id))
        .filter((id): id is string => Boolean(id));
      if (!stream.readonly && repo) {
        const prior = lastWritableByRepo.get(repo);
        if (prior && !dependencies.includes(prior)) dependencies.push(prior);
      }
      const task = [
        stream.task,
        `Goal Mode outcome: ${mission.goal}`,
        `Reuse/ownership boundary: ${mission.infrastructureContext ?? "Inspect the current project boundary before editing."}`,
        `This is Terra/high implementation session ${workstreamJobs.size + 1} of ${plan.workstreams.length}. Preserve completed branch work, stay inside this workstream, and leave a compact evidence-rich checkpoint for the final Sol validator.`,
      ].join("\n\n");
      const id = await insertGoalJob(ctx, {
        task,
        missionId: String(args.id),
        label: stream.label,
        repo,
        readonly: stream.readonly,
        model: "terra",
        reasoningEffort: "high",
        mcp: stream.mcp,
        originThreadId: mission.originThreadId,
        agentId: stream.agentId,
        risk: "high",
        priority: 92,
        acceptanceCriteria: stream.acceptanceCriteria,
        modelReason: "Goal Mode builder sessions use Terra/high for maximum implementation per token",
        dependsOn: dependencies,
        branch: !stream.readonly && repo ? branch : undefined,
        maxAttempts: 24,
        goalStage: "building",
        goalWorkstreamId: stream.id,
        goalWave: 0,
      });
      const row: any = await ctx.db.get(id);
      if (row?.status === "awaiting_approval") waitingApprovals += 1;
      workstreamJobs.set(stream.id, String(id));
      if (!stream.readonly && repo) lastWritableByRepo.set(repo, String(id));
    }
    await ctx.db.patch(args.id, {
      plan,
      phase: "building",
      percent: 12,
      primaryRepo: mission.primaryRepo ?? plan.primaryRepo,
      sharedBranch: branch,
      agentCount: 1 + workstreamJobs.size,
      advanceLeaseUntil: undefined,
      updatedAt: now,
    });
    await recordMissionEvent(ctx, String(args.id), "goal_plan_ready", `Sol plan accepted; ${workstreamJobs.size} Terra/high sessions queued`, "building", 12, {
      waitingApprovals,
      branch,
    });
    return { advanced: true, external: false, jobs: workstreamJobs.size, waitingApprovals };
  },
});

export const rejectAdvance = mutation({
  args: {
    id: v.id("missions"),
    jobId: v.id("jobs"),
    expectedAdvanceAttempt: v.number(),
    error: v.string(),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    const mission = await ctx.db.get(args.id);
    const job = await ctx.db.get(args.jobId);
    if (
      !mission || mission.mode !== "goal" || mission.status !== "running" ||
      Number(mission.advanceAttempt ?? 0) !== args.expectedAdvanceAttempt ||
      !job || job.missionId !== String(args.id) || job.status !== "done"
    ) return { requeued: false, stale: true };
    const nextAttempt = Number(job.attempt ?? 1) + 1;
    const now = Date.now();
    if (nextAttempt > Number(job.maxAttempts ?? 16)) {
      const reason = `Goal session repeatedly returned an invalid machine contract: ${args.error.slice(0, 800)}`;
      await ctx.db.patch(args.id, {
        status: "needs_input",
        phase: "blocked",
        failureReason: reason,
        advanceLeaseUntil: undefined,
        updatedAt: now,
      });
      await upsertGoalAttention(ctx, mission, reason);
      return { requeued: false, stale: false };
    }
    await ctx.db.patch(args.jobId, {
      status: "pending",
      stage: "checkpointed",
      progress: `Structured contract rejected; correction attempt ${nextAttempt} queued`,
      checkpoint: `JARVIS rejected the previous result because: ${args.error.slice(0, 1_200)}\nReturn the required compact marker and valid JSON contract. Do not redo completed investigation unless needed to repair the contract.`,
      attempt: nextAttempt,
      nextRunAt: now + 5_000,
      completedAt: undefined,
      startedAt: undefined,
      verificationVerdict: undefined,
      verificationNote: undefined,
      verifiedAt: undefined,
    });
    await ctx.db.patch(args.id, { advanceLeaseUntil: undefined, updatedAt: now });
    await recordMissionEvent(ctx, String(args.id), "goal_contract_rejected", args.error, mission.phase ?? "goal", mission.percent, {
      attempt: nextAttempt,
    });
    return { requeued: true, stale: false };
  },
});

export const releaseAdvance = mutation({
  args: {
    id: v.id("missions"),
    expectedAdvanceAttempt: v.number(),
    error: v.string(),
    delayMs: v.optional(v.number()),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    const mission = await ctx.db.get(args.id);
    if (!mission || mission.mode !== "goal" || Number(mission.advanceAttempt ?? 0) !== args.expectedAdvanceAttempt) return false;
    const delay = Math.max(10_000, Math.min(30 * 60_000, args.delayMs ?? 60_000));
    await ctx.db.patch(args.id, {
      advanceLeaseUntil: Date.now() + delay,
      failureReason: `Temporary Goal Mode integration error: ${args.error.slice(0, 800)}`,
      updatedAt: Date.now(),
    });
    return true;
  },
});

async function enqueueRefinements(ctx: any, mission: any, refinements: GoalRefinement[], wave: number) {
  const branch = mission.sharedBranch || missionBranch(mission, mission.primaryRepo);
  let previous: string | undefined;
  const ids: string[] = [];
  for (const refinement of refinements.slice(0, 3)) {
    const id = await insertGoalJob(ctx, {
      task: [
        refinement.task,
        `Goal Mode outcome: ${mission.goal}`,
        `Final validator gap from wave ${wave - 1}: close only this gap, preserve the shared branch, run the relevant checks, and report exact evidence for the next Sol validation.`,
      ].join("\n\n"),
      missionId: String(mission._id),
      label: refinement.label,
      repo: mission.primaryRepo,
      readonly: false,
      model: "terra",
      reasoningEffort: "high",
      mcp: ["context7"],
      originThreadId: mission.originThreadId,
      agentId: "paul",
      risk: "high",
      priority: 96,
      acceptanceCriteria: refinement.acceptanceCriteria,
      modelReason: "Goal Mode uses a bounded Terra/high repair wave before another Sol validation",
      dependsOn: previous ? [previous] : undefined,
      branch,
      maxAttempts: 20,
      goalStage: "refining",
      goalWorkstreamId: refinement.id,
      goalWave: wave,
    });
    previous = String(id);
    ids.push(String(id));
  }
  return ids;
}

async function upsertGoalAttention(ctx: any, mission: any, detail: string) {
  const now = Date.now();
  const fingerprint = `goal-mode:${mission._id}`;
  const existing = await ctx.db
    .query("attentionItems")
    .withIndex("by_fingerprint", (q: any) => q.eq("fingerprint", fingerprint))
    .first();
  const item = {
    fingerprint,
    project: mission.primaryRepo,
    title: `Goal Mode needs your decision`,
    detail: detail.slice(0, 2000),
    evidence: [`Goal ${mission._id}`, mission.goal.slice(0, 300)],
    severity: "decision",
    impact: 90,
    urgency: 72,
    confidence: 1,
    actionClass: "ask",
    status: "open",
    updatedAt: now,
  };
  if (existing) await ctx.db.patch(existing._id, item);
  else await ctx.db.insert("attentionItems", { ...item, createdAt: now });
}

export const recordValidation = mutation({
  args: {
    id: v.id("missions"),
    expectedAdvanceAttempt: v.number(),
    validation: v.any(),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    const mission = await ctx.db.get(args.id);
    if (
      !mission || mission.mode !== "goal" || mission.status !== "running" || mission.phase !== "validating" ||
      Number(mission.advanceAttempt ?? 0) !== args.expectedAdvanceAttempt
    ) return { advanced: false, stale: true };
    const validation = args.validation as GoalValidation;
    const now = Date.now();
    const history = [...(mission.validationHistory ?? []), validation].slice(-6);
    if (validation.verdict === "pass") {
      await ctx.db.patch(args.id, {
        status: "done",
        phase: "complete",
        percent: 100,
        validation,
        validationHistory: history,
        summary: validation.summary.slice(0, 4000),
        completedAt: now,
        advanceLeaseUntil: undefined,
        failureReason: undefined,
        updatedAt: now,
      });
      await recordMissionEvent(ctx, String(args.id), "goal_complete", "Sol validation passed the complete outcome", "complete", 100, {
        evidence: validation.evidence,
      });
      return { advanced: true, status: "done", summary: validation.summary };
    }
    const nextWave = Number(mission.revisionWave ?? 0) + 1;
    if (validation.verdict === "refine" && nextWave <= Number(mission.maxRevisionWaves ?? 2)) {
      const ids = await enqueueRefinements(ctx, mission, validation.refinements, nextWave);
      await ctx.db.patch(args.id, {
        phase: "refining",
        percent: Math.min(94, 84 + nextWave * 4),
        validation,
        validationHistory: history,
        revisionWave: nextWave,
        validatorJobId: undefined,
        agentCount: Number(mission.agentCount ?? 0) + ids.length,
        advanceLeaseUntil: undefined,
        updatedAt: now,
      });
      await recordMissionEvent(ctx, String(args.id), "goal_refinement_queued", `${ids.length} Terra/high refinement session${ids.length === 1 ? "" : "s"} queued`, "refining", 88, {
        wave: nextWave,
        gaps: validation.gaps,
      });
      return { advanced: true, status: "refining", jobs: ids.length };
    }
    const reason = validation.verdict === "blocked"
      ? validation.blocker || validation.summary
      : `The bounded ${mission.maxRevisionWaves ?? 2}-wave refinement budget is exhausted. Remaining gaps: ${validation.gaps.join("; ")}`;
    await ctx.db.patch(args.id, {
      status: "needs_input",
      phase: "needs Daniel",
      validation,
      validationHistory: history,
      pendingRefinements: validation.refinements,
      failureReason: reason.slice(0, 2000),
      advanceLeaseUntil: undefined,
      updatedAt: now,
    });
    await upsertGoalAttention(ctx, mission, reason);
    await recordMissionEvent(ctx, String(args.id), "goal_needs_input", reason, "needs Daniel", mission.percent);
    return { advanced: true, status: "needs_input", reason };
  },
});

export const externalPending = query({
  args: { workerToken: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    const rows = await ctx.db.query("missions").withIndex("by_createdAt").order("desc").take(80);
    return rows
      .filter((mission: any) => mission.mode === "goal" && mission.externalRunId && ["running", "needs_input"].includes(mission.status))
      .map((mission: any) => ({
        id: mission._id,
        goal: mission.goal,
        status: mission.status,
        phase: mission.phase,
        externalKind: mission.externalKind,
        externalRunId: mission.externalRunId,
        externalSlug: mission.externalSlug,
        externalStatus: mission.externalStatus,
        externalStage: mission.externalStage,
      }));
  },
});

export const updateExternal = mutation({
  args: {
    id: v.id("missions"),
    status: v.string(),
    stage: v.string(),
    stageState: v.optional(v.string()),
    detail: v.optional(v.string()),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    const mission = await ctx.db.get(args.id);
    if (!mission || mission.mode !== "goal" || !mission.externalRunId || ["done", "cancelled"].includes(mission.status)) return false;
    const now = Date.now();
    const stageOrder = ["inception", "roadmap", "design", "build", "validate", "review", "approval", "package"];
    const progress = 12 + Math.max(0, stageOrder.indexOf(args.stage)) * 8;
    const waiting = args.status === "waiting_approval" || args.stage === "approval" || args.stageState === "waiting";
    const failed = args.status === "failed" || args.stageState === "failed";
    if (waiting) {
      const detail = args.detail || `App Factory reached ${args.stage} and is waiting for Daniel's review.`;
      await ctx.db.patch(args.id, {
        status: "needs_input",
        phase: "factory approval",
        percent: Math.max(68, progress),
        externalStatus: args.status,
        externalStage: args.stage,
        externalUpdatedAt: now,
        failureReason: detail.slice(0, 2000),
        updatedAt: now,
      });
      await upsertGoalAttention(ctx, mission, `${detail} Open App Factory to review; Jarvis will resume monitoring after the gate is decided.`);
      return true;
    }
    if (failed) {
      const detail = args.detail || `App Factory failed during ${args.stage}.`;
      await ctx.db.patch(args.id, {
        status: "needs_input",
        phase: "blocked",
        externalStatus: args.status,
        externalStage: args.stage,
        externalUpdatedAt: now,
        failureReason: detail.slice(0, 2000),
        updatedAt: now,
      });
      await upsertGoalAttention(ctx, mission, detail);
      return true;
    }
    if (args.status === "shipped") {
      const jobs = await ctx.db
        .query("jobs")
        .withIndex("by_mission", (q: any) => q.eq("missionId", String(args.id)))
        .collect();
      await ctx.db.patch(args.id, {
        status: "running",
        externalStatus: args.status,
        externalStage: args.stage,
        externalUpdatedAt: now,
        failureReason: undefined,
        updatedAt: now,
      });
      const refreshed = await ctx.db.get(args.id);
      if (refreshed?.phase !== "validating") await enqueueValidator(ctx, refreshed, jobs);
      return true;
    }
    await ctx.db.patch(args.id, {
      status: "running",
      phase: "building",
      percent: Math.max(Number(mission.percent ?? 0), Math.min(76, progress)),
      externalStatus: args.status,
      externalStage: args.stage,
      externalUpdatedAt: now,
      failureReason: undefined,
      updatedAt: now,
    });
    return true;
  },
});

export const control = mutation({
  args: {
    id: v.id("missions"),
    action: v.union(v.literal("pause"), v.literal("resume"), v.literal("cancel")),
    authTokenHash: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.authTokenHash);
    const mission = await ctx.db.get(args.id);
    if (!mission || mission.mode !== "goal") return false;
    const jobs = await ctx.db
      .query("jobs")
      .withIndex("by_mission", (q: any) => q.eq("missionId", String(args.id)))
      .collect();
    const now = Date.now();
    if (args.action === "pause" && mission.status === "running") {
      await ctx.db.patch(args.id, { status: "paused", pausedPhase: mission.phase, phase: "paused", updatedAt: now });
      for (const job of jobs) {
        if (["pending", "running"].includes(job.status)) {
          await ctx.db.patch(job._id, { status: "paused", stage: "paused", progress: "Goal Mode paused by Daniel", nextRunAt: undefined });
        }
      }
    } else if (args.action === "resume" && mission.status === "paused") {
      await ctx.db.patch(args.id, { status: "running", phase: mission.pausedPhase ?? "building", pausedPhase: undefined, updatedAt: now });
      for (const job of jobs) {
        if (job.status === "paused") {
          await ctx.db.patch(job._id, {
            status: "pending",
            stage: "queued",
            progress: "Goal Mode resumed",
            attempt: Number(job.attempt ?? 1) + 1,
            startedAt: undefined,
            heartbeatAt: now,
            nextRunAt: now,
          });
        }
      }
    } else if (args.action === "resume" && mission.status === "needs_input") {
      const refinements = Array.isArray(mission.pendingRefinements) ? mission.pendingRefinements as GoalRefinement[] : [];
      if (refinements.length) {
        const nextWave = Number(mission.revisionWave ?? 0) + 1;
        const ids = await enqueueRefinements(ctx, mission, refinements, nextWave);
        await ctx.db.patch(args.id, {
          status: "running",
          phase: "refining",
          revisionWave: nextWave,
          maxRevisionWaves: Math.max(nextWave, Number(mission.maxRevisionWaves ?? 2) + 1),
          pendingRefinements: undefined,
          failureReason: undefined,
          agentCount: Number(mission.agentCount ?? 0) + ids.length,
          updatedAt: now,
        });
      } else if (mission.externalRunId) {
        await ctx.db.patch(args.id, { status: "running", phase: "building", failureReason: undefined, updatedAt: now });
      } else return false;
    } else if (args.action === "cancel" && !["done", "cancelled"].includes(mission.status)) {
      await ctx.db.patch(args.id, { status: "cancelled", phase: "cancelled", completedAt: now, updatedAt: now });
      for (const job of jobs) {
        if (!TERMINAL.has(job.status)) {
          await ctx.db.patch(job._id, { status: "cancelled", stage: "cancelled", progress: "Goal Mode cancelled by Daniel", completedAt: now, nextRunAt: undefined });
        }
      }
    } else return false;
    await recordMissionEvent(ctx, String(args.id), args.action, `Goal Mode ${args.action} requested by Daniel`, args.action, mission.percent);
    return true;
  },
});
