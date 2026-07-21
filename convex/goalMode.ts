import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { shouldPauseGoalJob } from "../src/lib/goal-job-lifecycle";
import { requireActor, requireDispatcher, requireViewer, requireWorker, viewerAuthArgs } from "./controlAuth";
import { goalWorkApprovalPolicy } from "./workPolicy";
import {
  goalBranch,
  goalJobRunnableForMission,
  GOAL_VALIDATOR_TASK_MAX_CHARS,
  plannerTask,
  summarizeGoalPhase,
  validatorTask,
  type GoalPlan,
  type GoalRefinement,
  type GoalRoute,
  type GoalValidation,
} from "../src/lib/goal-mode";
import {
  insertJobWithRuntime,
  insertMissionWithRuntime,
  patchJobWithRuntime,
  patchMissionWithRuntime,
  runtimeJob,
} from "./controlPlane";
import { canonicalizeRepository } from "../src/lib/workflow-contract";
import { validateWorkDag, workItemIdentity } from "../src/lib/workspace-protocol";
import { controlIntegrationForJob, writeIntegrationTerminalReceipt } from "./goalIntegration";

const ADVANCE_LEASE_MS = 10 * 60 * 1000;
const COORDINATOR_RECEIPT_FRESH_MS = 10 * 60 * 1000;
const TERMINAL = new Set(["done", "error", "cancelled"]);

type GoalJobInput = {
  task: string;
  /** Internally-owned executable scope, excluding quoted goal/evidence context. */
  policyTask?: string;
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
  sourceBranch?: string;
  sourceHeadSha?: string;
  integrationBranch?: string;
  goalStage: "planning" | "building" | "validating" | "refining";
  goalWorkstreamId?: string;
  goalWave: number;
};

function receiptError(value: unknown): string | undefined {
  if (!value) return undefined;
  return String(value).slice(0, 1000);
}

function receiptCount(value: unknown): number {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

export const recordCoordinatorReceipt = mutation({
  args: {
    deploymentVersion: v.string(),
    demand: v.object({
      needed: v.boolean(),
      reasons: v.array(v.string()),
      error: v.optional(v.string()),
    }),
    controls: v.object({
      checked: v.number(),
      applied: v.number(),
      blocked: v.number(),
      error: v.optional(v.string()),
    }),
    revisions: v.object({
      checked: v.number(),
      applied: v.number(),
      blocked: v.number(),
      error: v.optional(v.string()),
    }),
    external: v.object({
      checked: v.number(),
      updated: v.number(),
      blocked: v.number(),
      error: v.optional(v.string()),
    }),
    wakeRequested: v.boolean(),
    wakeResult: v.string(),
    wakeTarget: v.optional(v.string()),
    wakeReason: v.optional(v.string()),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    const id = await ctx.db.insert("goalCoordinatorReceipts", {
      deploymentVersion: args.deploymentVersion.slice(0, 160),
      demandNeeded: args.demand.needed,
      demandReasons: args.demand.reasons.map((reason) => reason.slice(0, 400)).slice(0, 12),
      demandError: receiptError(args.demand.error),
      controlsChecked: receiptCount(args.controls.checked),
      controlsApplied: receiptCount(args.controls.applied),
      controlsBlocked: receiptCount(args.controls.blocked),
      controlsError: receiptError(args.controls.error),
      revisionsChecked: receiptCount(args.revisions.checked),
      revisionsApplied: receiptCount(args.revisions.applied),
      revisionsBlocked: receiptCount(args.revisions.blocked),
      revisionsError: receiptError(args.revisions.error),
      externalChecked: receiptCount(args.external.checked),
      externalUpdated: receiptCount(args.external.updated),
      externalBlocked: receiptCount(args.external.blocked),
      externalError: receiptError(args.external.error),
      wakeRequested: args.wakeRequested,
      wakeResult: args.wakeResult.slice(0, 40),
      wakeTarget: args.wakeTarget?.slice(0, 240),
      wakeReason: args.wakeReason?.slice(0, 160),
      createdAt: Date.now(),
    });
    return { id };
  },
});

// Viewer-only audit surface for the last coordinator pass. Freshness is
// computed server-side so a panel cannot mistake an old receipt for a healthy
// five-minute coordinator.
export const latestCoordinatorReceipt = query({
  args: { ...viewerAuthArgs },
  handler: async (ctx, args) => {
    await requireViewer(ctx, args);
    const receipt = await ctx.db.query("goalCoordinatorReceipts").withIndex("by_createdAt").order("desc").first();
    if (!receipt) return { receipt: null, fresh: false, ageMs: null };
    const ageMs = Math.max(0, Date.now() - receipt.createdAt);
    return { receipt, fresh: ageMs < COORDINATOR_RECEIPT_FRESH_MS, ageMs };
  },
});

async function insertGoalJob(ctx: any, input: GoalJobInput) {
  const now = Date.now();
  const repo = input.repo === undefined ? undefined : canonicalizeRepository(input.repo, { allowShortName: true }) ?? undefined;
  if (input.repo !== undefined && !repo) {
    throw new Error("Goal repository must be an owner/repo slug or credential-free https://github.com/owner/repo(.git) URL");
  }
  input = { ...input, repo };
  const approval = goalWorkApprovalPolicy({
    ...input,
    task: input.policyTask?.trim() || input.task,
  });
  const approvalRequired = approval.required;
  const status = approvalRequired ? "awaiting_approval" : "pending";
  const { policyTask: _policyTask, ...persistedInput } = input;
  const jobId = await insertJobWithRuntime(ctx, {
    ...persistedInput,
    task: input.task.slice(0, input.goalStage === "validating" ? GOAL_VALIDATOR_TASK_MAX_CHARS : 6_000),
    label: input.label.slice(0, 80),
    visibility: "conversation",
    status,
    risk: approvalRequired ? (input.risk ?? "consequential") : (input.risk ?? "high"),
    approvalRequired,
    approvalReason: approval.reason,
    approvalStatus: approvalRequired ? "pending" : undefined,
    deliveryMode: approval.deliveryMode,
    stage: approvalRequired ? "approval" : "queued",
    percent: 0,
    attempt: 1,
    maxAttempts: Math.max(1, Math.min(48, input.maxAttempts ?? 24)),
    nextRunAt: approvalRequired ? undefined : now,
    createdAt: now,
  });
  const identity = workItemIdentity({
    missionId: input.missionId,
    jobId: String(jobId),
    workstreamId: input.goalWorkstreamId,
    readonly: Boolean(input.readonly || !repo),
  });
  const inserted: any = await ctx.db.get(jobId);
  if (inserted) await patchJobWithRuntime(ctx, inserted, {
    sourceBranch: input.sourceBranch,
    sourceHeadSha: input.sourceHeadSha,
    integrationBranch: input.integrationBranch,
    workerBranch: identity.workerBranch,
    workspaceLineage: identity.workspaceLineage,
    retryLineage: identity.retryLineage,
    // Writable jobs own only their worker ref. A read-only validator may be
    // explicitly pinned to the immutable integration branch supplied above.
    branch: identity.workerBranch ?? input.branch,
    integrationState: identity.workerBranch ? "awaiting_review" : "not_applicable",
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

async function rollupSplitParent(ctx: any, parentOrId: any) {
  const parent: any = typeof parentOrId === "object" ? parentOrId : await ctx.db.get(parentOrId);
  if (!parent || !Array.isArray(parent.splitChildMissionIds) || !parent.splitChildMissionIds.length
    || ["done", "cancelled"].includes(parent.status)) return false;
  const children = (await Promise.all(parent.splitChildMissionIds.map((id: any) => ctx.db.get(id))))
    .filter((child: any) => child && child.parentMissionId === parent._id);
  if (children.length !== parent.splitChildMissionIds.length) return false;
  const now = Date.now();
  const percent = Math.round(children.reduce((sum: number, child: any) => sum + Number(child.percent ?? 0), 0) / children.length);
  const summary = children.map((child: any) =>
    `${child.primaryRepo ?? child.goal}: ${child.status}${child.summary ? ` — ${String(child.summary).slice(0, 700)}` : ""}`,
  ).join("\n").slice(0, 4_000);
  const requested = parent.controlRequested as "pause" | "cancel" | undefined;
  let patch: Record<string, unknown>;
  if (requested === "cancel" && children.every((child: any) => ["done", "cancelled"].includes(child.status))) {
    patch = { status: "cancelled", phase: "cancelled", percent, summary, controlRequested: undefined,
      controlRequestedAt: undefined, completedAt: now, updatedAt: now };
  } else if (requested === "pause" && children.every((child: any) => ["paused", "done", "cancelled"].includes(child.status))) {
    patch = { status: "paused", phase: "paused", percent, summary, controlRequested: undefined,
      controlRequestedAt: undefined, pausedPhase: "split", updatedAt: now };
  } else if (children.every((child: any) => child.status === "done")) {
    patch = { status: "done", phase: "complete", percent: 100, summary, failureReason: undefined,
      completedAt: now, updatedAt: now };
  } else {
    const blocked = children.filter((child: any) => ["needs_input", "failed", "error"].includes(child.status));
    if (blocked.length) {
      const reason = blocked.map((child: any) => `${child.primaryRepo ?? child.goal}: ${child.failureReason ?? child.summary ?? child.status}`).join("; ").slice(0, 2_000);
      patch = { status: "needs_input", phase: "blocked", pausedPhase: "split", percent, summary,
        failureReason: reason, updatedAt: now };
    } else {
      patch = { status: "split", phase: "split", percent, summary, updatedAt: now };
    }
  }
  const changed = Object.entries(patch).some(([key, value]) => key !== "updatedAt" && parent[key] !== value);
  if (!changed) return false;
  await patchMissionWithRuntime(ctx, parent, patch);
  await recordMissionEvent(ctx, String(parent._id), "goal_split_rollup",
    `Repository child missions rolled up as ${String(patch.status)}`, String(patch.phase), Number(patch.percent), {
      children: children.map((child: any) => ({ id: String(child._id), repository: child.primaryRepo, status: child.status })),
    });
  return true;
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
    const primaryRepo = args.primaryRepo === undefined ? undefined : canonicalizeRepository(args.primaryRepo, { allowShortName: true }) ?? undefined;
    if (args.primaryRepo !== undefined && !primaryRepo) {
      throw new Error("Goal repository must be an owner/repo slug or credential-free https://github.com/owner/repo(.git) URL");
    }
    const route: GoalRoute = {
      kind: args.route as GoalRoute["kind"],
      primaryRepo,
      reason: args.routeReason.slice(0, 1000),
      infrastructureContext: args.infrastructureContext.slice(0, 4000),
    };
    const missionId = await insertMissionWithRuntime(ctx, {
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
    const mission = await ctx.db.get(missionId);
    if (mission) await patchMissionWithRuntime(ctx, mission, {
      planningJobId: String(plannerJobId),
      integrationBranch: route.primaryRepo ? goalBranch(goal, String(missionId)) : undefined,
      integrationGeneration: 0,
    });
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

async function hasTerminalReviewedOutcomes(ctx: any, jobs: any[]) {
  for (const job of jobs) {
    if (job.status !== "done" || job.verificationVerdict !== "pass") return false;
    if (job.readonly || !job.repo) continue;
    if (!job.reviewReceiptId || !job.integrationAttemptId) return false;
    const integration: any = await ctx.db.get(job.integrationAttemptId);
    if (!integration || integration.jobId !== job._id || !integration.terminalReceiptDigest) return false;
    if (integration.status === "integrated") {
      if (integration.providerObservedHeadSha !== integration.preparedIntegrationHeadSha) return false;
    } else if (!["conflict", "stale"].includes(integration.status) || !integration.repairJobId) return false;
  }
  return true;
}

async function validatorAuditSnapshot(ctx: any, mission: any, jobs: any[]): Promise<string> {
  const capturedAt = Date.now();
  const [eventRows, receipt] = await Promise.all([
    ctx.db
      .query("workEvents")
      .withIndex("by_mission", (q: any) => q.eq("missionId", String(mission._id)))
      .order("desc")
      .take(200),
    ctx.db.query("goalCoordinatorReceipts").withIndex("by_createdAt").order("desc").first(),
  ]);
  const pauseResumeEvents = eventRows
    .filter((event: any) => event.type === "pause" || event.type === "resume")
    .slice(0, 20)
    .reverse()
    .map((event: any) => ({
      id: String(event._id),
      type: event.type,
      message: event.message,
      stage: event.stage ?? null,
      percent: event.percent ?? null,
      createdAt: event.createdAt,
    }));
  const coordinator = receipt
    ? {
        id: String(receipt._id),
        createdAt: receipt.createdAt,
        ageMs: Math.max(0, capturedAt - receipt.createdAt),
        fresh: capturedAt - receipt.createdAt < COORDINATOR_RECEIPT_FRESH_MS,
        deploymentVersion: receipt.deploymentVersion,
        demandNeeded: receipt.demandNeeded,
        demandReasons: receipt.demandReasons,
        controls: {
          checked: receipt.controlsChecked,
          applied: receipt.controlsApplied,
          blocked: receipt.controlsBlocked,
        },
        revisions: {
          checked: receipt.revisionsChecked,
          applied: receipt.revisionsApplied,
          blocked: receipt.revisionsBlocked,
        },
        external: {
          checked: receipt.externalChecked,
          updated: receipt.externalUpdated,
          blocked: receipt.externalBlocked,
        },
        wakeRequested: receipt.wakeRequested,
        wakeResult: receipt.wakeResult,
        wakeTarget: receipt.wakeTarget ?? receipt.wakeWorkflow ?? null,
        wakeReason: receipt.wakeReason ?? null,
      }
    : null;
  return JSON.stringify({
    authority: "Convex server-side Goal Mode snapshot",
    capturedAt,
    mission: {
      id: String(mission._id),
      status: mission.status,
      phase: mission.phase,
      nextPhase: "validating",
      percent: mission.percent ?? 0,
      route: mission.route ?? null,
      primaryRepo: mission.primaryRepo ?? null,
      revisionWave: Number(mission.revisionWave ?? 0),
      pausedPhase: mission.pausedPhase ?? null,
    },
    jobs: jobs.map((job: any) => ({
      id: String(job._id),
      label: job.label ?? job.task?.slice(0, 80) ?? "Goal session",
      status: job.status,
      stage: job.stage ?? job.status,
      attempt: Number(job.attempt ?? 1),
      readonly: Boolean(job.readonly),
      dependsOn: job.dependsOn ?? [],
      goalStage: job.goalStage ?? null,
      goalWave: Number(job.goalWave ?? 0),
      verificationVerdict: job.verificationVerdict ?? null,
    })),
    pauseResumeEvents,
    coordinator,
  });
}

async function validatorTaskForMission(ctx: any, mission: any, jobs: any[]): Promise<string> {
  const plan = mission.plan as GoalPlan;
  const buildEvidence = jobs
    .filter((job) => job.goalStage === "building" || job.goalStage === "refining")
    .map((job) => ({
      label: job.label ?? job.task.slice(0, 80),
      status: job.status,
      result: String(job.result ?? job.progress ?? "").slice(0, 2_000),
    }));
  return validatorTask({
    goal: mission.goal,
    plan,
    acceptanceCriteria: mission.acceptanceCriteria ?? [],
    buildEvidence,
    revisionWave: Number(mission.revisionWave ?? 0),
    auditSnapshot: await validatorAuditSnapshot(ctx, mission, jobs),
    externalContext: mission.externalRunId
      ? [
          `App Factory run ${mission.externalRunId}${mission.externalSlug ? ` (${mission.externalSlug})` : ""}.`,
          `Current provider state: ${mission.externalStatus ?? "unknown"} · ${mission.externalStage ?? "unknown"}.`,
          mission.externalSlug
            ? `Inspect the real run and its demo/deployment evidence at https://app-factory-v2.vercel.app/apps/${encodeURIComponent(String(mission.externalSlug))}.`
            : "Inspect the real App Factory run and its demo/deployment evidence.",
          "Any fixable product gap must be returned as a refinement; Jarvis will feed it back into this same factory run rather than editing the factory platform itself.",
        ].join(" ")
      : undefined,
  });
}

async function enqueueValidator(ctx: any, mission: any, jobs: any[]) {
  const plan = mission.plan as GoalPlan;
  // App Factory owns its own repository/build lifecycle. Its final Sol session
  // validates the external run and must not be pointed at a made-up Jarvis branch.
  const branch = mission.externalRunId
    ? undefined
    : mission.integrationBranch || mission.sharedBranch || missionBranch(mission, mission.primaryRepo);
  const task = await validatorTaskForMission(ctx, mission, jobs);
  const validatorJobId = await insertGoalJob(ctx, {
    task,
    missionId: String(mission._id),
    label: `JARVIS · deep validation ${Number(mission.revisionWave ?? 0) + 1}`,
    repo: mission.primaryRepo ?? plan.primaryRepo,
    readonly: true,
    model: "sol",
    reasoningEffort: "max",
    mcp: mission.externalRunId || plan.validation.liveChecks.length ? ["playwright", "context7"] : ["context7"],
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
    sourceBranch: branch,
    sourceHeadSha: mission.integrationHeadSha,
    integrationBranch: branch,
    maxAttempts: 16,
    goalStage: "validating",
    goalWorkstreamId: `validation-${Number(mission.revisionWave ?? 0)}`,
    goalWave: Number(mission.revisionWave ?? 0),
  });
  const now = Date.now();
  await patchMissionWithRuntime(ctx, mission, {
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

async function resolveGoalAttention(ctx: any, missionId: unknown) {
  const attention = await ctx.db
    .query("attentionItems")
    .withIndex("by_fingerprint", (q: any) => q.eq("fingerprint", `goal-mode:${missionId}`))
    .first();
  if (attention && attention.status !== "resolved") {
    await ctx.db.patch(attention._id, { status: "resolved", updatedAt: Date.now() });
  }
}

async function blockGoalForPhaseFailure(ctx: any, mission: any, phaseJobs: any[], phase: string) {
  const failed = phaseJobs.filter((job) => job.status === "error" || job.status === "cancelled");
  const reason = failed.length
    ? `${failed.map((job) => `${job.label ?? job.task?.slice(0, 80) ?? "Goal session"} ended ${job.status}`).join("; ")}. Checkpoints and dependent work are preserved; resume retries this phase.`
    : `Goal Mode could not continue the ${phase} phase.`;
  const now = Date.now();
  // Stop independent siblings as well as dependency-blocked children. Their
  // workers observe the lease change, save a final checkpoint, and cannot be
  // reclaimed until Daniel resumes the parent mission.
  for (const job of phaseJobs) {
    if (job.status === "pending" || job.status === "running") {
      await patchJobWithRuntime(ctx, job, {
        status: "paused",
        stage: "blocked dependency",
        progress: "Goal Mode held after a phase failure",
        nextRunAt: undefined,
      });
    }
  }
  await patchMissionWithRuntime(ctx, mission, {
    status: "needs_input",
    phase: "blocked",
    pausedPhase: phase,
    failureReason: reason.slice(0, 2000),
    advanceLeaseUntil: undefined,
    updatedAt: now,
  });
  await upsertGoalAttention(ctx, mission, reason);
  await recordMissionEvent(ctx, String(mission._id), "goal_blocked", reason, "blocked", mission.percent, {
    failedJobIds: failed.map((job) => String(job._id)),
    phase,
  });
  return reason;
}

export const claimAdvance = mutation({
  args: { workerToken: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    const now = Date.now();
    const splitParents = await ctx.db.query("missions").withIndex("by_status", (q: any) => q.eq("status", "split")).take(100);
    for (const parent of splitParents) {
      if (await rollupSplitParent(ctx, parent)) return { kind: "split_rollup", missionId: parent._id };
    }
    const running = await ctx.db
      .query("missionRuntime")
      .withIndex("by_status", (q: any) => q.eq("status", "running"))
      .order("asc")
      .take(100);
    for (const activity of running) {
      if (activity.mode !== "goal") continue;
      // External factories own their build loop, but their completed Sol
      // validator still returns through this same durable contract parser.
      if (activity.externalRunId && activity.phase !== "validating") continue;
      const projectedJobs = await ctx.db
        .query("jobRuntime")
        .withIndex("by_mission", (q: any) => q.eq("missionId", String(activity.missionId)))
        .take(100);
      if (activity.phase === "planning") {
        const plannerActivity = projectedJobs.find((job: any) =>
          String(job.jobId) === activity.planningJobId || job.goalStage === "planning",
        );
        if (!plannerActivity || !TERMINAL.has(plannerActivity.status) || (activity.advanceLeaseUntil ?? 0) > now) continue;
        const [mission, planner] = await Promise.all([
          ctx.db.get(activity.missionId),
          ctx.db.get(plannerActivity.jobId),
        ]);
        if (!mission || mission.status !== "running" || mission.phase !== "planning" || !planner || !TERMINAL.has(planner.status)) continue;
        if (planner.status !== "done") {
          await blockGoalForPhaseFailure(ctx, mission, [planner], "planning");
          continue;
        }
        if ((mission.advanceLeaseUntil ?? 0) > now) continue;
        const advanceAttempt = Number(mission.advanceAttempt ?? 0) + 1;
        await patchMissionWithRuntime(ctx, mission, {
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
      if (activity.phase === "building" || activity.phase === "refining") {
        const projectedPhaseJobs = activeStageJobs(projectedJobs, activity);
        const phaseState = summarizeGoalPhase(projectedPhaseJobs);
        if (phaseState.state !== "blocked" && phaseState.state !== "complete") continue;
        const mission = await ctx.db.get(activity.missionId);
        if (!mission || mission.status !== "running" || mission.phase !== activity.phase) continue;
        const jobs = await ctx.db
          .query("jobs")
          .withIndex("by_mission", (q: any) => q.eq("missionId", String(mission._id)))
          .take(100);
        const phaseJobs = activeStageJobs(jobs, mission);
        const authoritativeState = summarizeGoalPhase(phaseJobs);
        if (authoritativeState.state === "blocked") {
          await blockGoalForPhaseFailure(ctx, mission, phaseJobs, mission.phase);
          return { kind: "advanced", missionId: mission._id, phase: "blocked" };
        }
        if (authoritativeState.state !== "complete") continue;
        // Completion text is not authority. The validator is pinned only
        // after every leaf has a reviewed terminal result and every writable
        // receipt has an exact terminal integration observation.
        if (!await hasTerminalReviewedOutcomes(ctx, phaseJobs)) continue;
        await enqueueValidator(ctx, mission, jobs);
        return { kind: "advanced", missionId: mission._id, phase: "validating" };
      }
      if (activity.phase === "validating") {
        const validatorActivity = projectedJobs.find((job: any) =>
          String(job.jobId) === activity.validatorJobId ||
          (job.goalStage === "validating" && Number(job.goalWave ?? 0) === Number(activity.revisionWave ?? 0)),
        );
        if (!validatorActivity || !TERMINAL.has(validatorActivity.status) || (activity.advanceLeaseUntil ?? 0) > now) continue;
        const [mission, validator] = await Promise.all([
          ctx.db.get(activity.missionId),
          ctx.db.get(validatorActivity.jobId),
        ]);
        if (!mission || mission.status !== "running" || mission.phase !== "validating" || !validator || !TERMINAL.has(validator.status)) continue;
        if (validator.status !== "done") {
          await blockGoalForPhaseFailure(ctx, mission, [validator], "validating");
          continue;
        }
        if ((mission.advanceLeaseUntil ?? 0) > now) continue;
        const advanceAttempt = Number(mission.advanceAttempt ?? 0) + 1;
        await patchMissionWithRuntime(ctx, mission, {
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
          externalKind: mission.externalKind,
          externalRunId: mission.externalRunId,
          revisionWave: Number(mission.revisionWave ?? 0),
          maxRevisionWaves: Number(mission.maxRevisionWaves ?? 2),
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
    validateWorkDag(plan.workstreams, Math.min(8, Number(mission.maxBuildSessions ?? 6)));
    const writableRepositories = new Set<string>();
    for (const stream of plan.workstreams) {
      if (stream.readonly) continue;
      const requested = stream.repo || mission.primaryRepo || plan.primaryRepo;
      const canonical = requested ? canonicalizeRepository(requested, { allowShortName: true }) : null;
      if (!canonical) throw new Error(`Writable goal workstream ${stream.id} requires one canonical repository`);
      writableRepositories.add(canonical);
    }
    if (writableRepositories.size > 1) {
      const now = Date.now();
      const childMissionIds: any[] = [];
      for (const repository of [...writableRepositories].sort()) {
        const childGoal = `${mission.goal} [project scope: ${repository}]`;
        const childId = await insertMissionWithRuntime(ctx, {
          goal: childGoal.slice(0, 500), mode: "goal", status: "running", agentCount: 1,
          parentMissionId: mission._id, originThreadId: mission.originThreadId, managerAgentId: "jarvis",
          priority: mission.priority ?? 95, risk: mission.risk ?? "high", phase: "planning", percent: 3,
          acceptanceCriteria: mission.acceptanceCriteria ?? [], route: "existing_project",
          routeReason: `Writable multi-project goal split atomically from parent ${String(mission._id)}`,
          primaryRepo: repository,
          infrastructureContext: `${mission.infrastructureContext ?? ""}\nThis child owns only ${repository}; coordinate results through parent ${String(mission._id)}.`.trim().slice(0, 4_000),
          revisionWave: 0, maxRevisionWaves: mission.maxRevisionWaves ?? 2,
          maxBuildSessions: mission.maxBuildSessions ?? 6, advanceAttempt: 0, createdAt: now, updatedAt: now,
        });
        const route: GoalRoute = {
          kind: "existing_project", primaryRepo: repository,
          reason: `Atomic child scope of parent ${String(mission._id)}`,
          infrastructureContext: `Work only in ${repository}; preserve the parent goal and return independently integrable evidence.`,
        };
        const plannerJobId = await insertGoalJob(ctx, {
          task: plannerTask(childGoal, route, mission.acceptanceCriteria ?? [], mission.maxBuildSessions ?? 6),
          missionId: String(childId), label: `JARVIS · ${repository.split("/").pop()} architecture`, repo: repository,
          readonly: true, model: "sol", reasoningEffort: "max", mcp: ["context7"],
          originThreadId: mission.originThreadId, agentId: "jarvis", risk: "low", priority: 100,
          acceptanceCriteria: ["Plan only this canonical repository scope", "Return a valid GOAL_PLAN_JSON contract"],
          modelReason: "A cross-project parent is split into independently serialized repository missions",
          maxAttempts: 16, goalStage: "planning", goalWorkstreamId: "goal-plan", goalWave: 0,
        });
        const child: any = await ctx.db.get(childId);
        if (child) await patchMissionWithRuntime(ctx, child, {
          planningJobId: String(plannerJobId), integrationBranch: goalBranch(childGoal, String(childId)), integrationGeneration: 0,
        });
        childMissionIds.push(childId);
      }
      await patchMissionWithRuntime(ctx, mission, {
        status: "split", phase: "split", plan, splitChildMissionIds: childMissionIds,
        summary: `Writable work split into ${childMissionIds.length} canonical repository child missions`,
        advanceLeaseUntil: undefined, updatedAt: now,
      });
      await recordMissionEvent(ctx, String(args.id), "goal_split", `Writable plan split into ${childMissionIds.length} repository child missions`, "split", mission.percent, {
        repositories: [...writableRepositories].sort(), childMissionIds: childMissionIds.map(String),
      });
      return {
        advanced: true,
        stale: false,
        splitRequired: true,
        code: "WRITABLE_REPOSITORY_SPLIT_REQUIRED",
        repositories: [...writableRepositories].sort(),
        parentMissionId: String(args.id),
        childMissionIds: childMissionIds.map(String),
      };
    }
    const now = Date.now();
    if (mission.route === "app_factory") {
      if (!args.externalRun?.id) throw new Error("App Factory route requires a live factory run");
      await patchMissionWithRuntime(ctx, mission, {
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
      await resolveGoalAttention(ctx, args.id);
      await recordMissionEvent(ctx, String(args.id), "goal_plan_ready", "Sol plan accepted; App Factory now owns the build lifecycle", "building", 12, {
        externalRunId: args.externalRun.id,
        externalSlug: args.externalRun.slug,
      });
      return { advanced: true, external: true, jobs: 0 };
    }

    const integrationBranch = mission.integrationBranch || missionBranch(mission, mission.primaryRepo ?? plan.primaryRepo);
    const workstreamJobs = new Map<string, string>();
    let waitingApprovals = 0;
    for (const stream of plan.workstreams) {
      const repo = stream.repo || mission.primaryRepo || plan.primaryRepo;
      const dependencies = stream.dependsOn
        .map((id) => workstreamJobs.get(id))
        .filter((id): id is string => Boolean(id));
      if (dependencies.length !== stream.dependsOn.length) {
        throw new Error(`Goal plan workstream ${stream.id} is not in validated topological order`);
      }
      const task = [
        stream.task,
        `Goal Mode outcome: ${mission.goal}`,
        `Reuse/ownership boundary: ${mission.infrastructureContext ?? "Inspect the current project boundary before editing."}`,
        `This is Terra/high implementation session ${workstreamJobs.size + 1} of ${plan.workstreams.length}. Preserve completed branch work, stay inside this workstream, and leave a compact evidence-rich checkpoint for the final Sol validator.`,
      ].join("\n\n");
      const id = await insertGoalJob(ctx, {
        task,
        // The outcome below is quoted context. Only the planner-authored
        // workstream is executable scope for consequence classification.
        policyTask: stream.task,
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
        sourceBranch: repo ? integrationBranch : undefined,
        integrationBranch: repo ? integrationBranch : undefined,
        maxAttempts: 24,
        goalStage: "building",
        goalWorkstreamId: stream.id,
        goalWave: 0,
      });
      const row: any = await ctx.db.get(id);
      if (row?.status === "awaiting_approval") waitingApprovals += 1;
      workstreamJobs.set(stream.id, String(id));
    }
    await patchMissionWithRuntime(ctx, mission, {
      plan,
      phase: "building",
      percent: 12,
      primaryRepo: mission.primaryRepo ?? plan.primaryRepo,
      sharedBranch: undefined,
      integrationBranch,
      integrationGeneration: 0,
      agentCount: 1 + workstreamJobs.size,
      advanceLeaseUntil: undefined,
      updatedAt: now,
    });
    await resolveGoalAttention(ctx, args.id);
    await recordMissionEvent(ctx, String(args.id), "goal_plan_ready", `Sol plan accepted; ${workstreamJobs.size} Terra/high sessions queued`, "building", 12, {
      waitingApprovals,
      integrationBranch,
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
      await patchMissionWithRuntime(ctx, mission, {
        status: "needs_input",
        phase: "blocked",
        pausedPhase: mission.phase,
        failureReason: reason,
        advanceLeaseUntil: undefined,
        updatedAt: now,
      });
      await upsertGoalAttention(ctx, mission, reason);
      return { requeued: false, stale: false };
    }
    await patchJobWithRuntime(ctx, job, {
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
    await patchMissionWithRuntime(ctx, mission, { advanceLeaseUntil: undefined, updatedAt: now });
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
    await patchMissionWithRuntime(ctx, mission, {
      advanceLeaseUntil: Date.now() + delay,
      failureReason: `Temporary Goal Mode integration error: ${args.error.slice(0, 800)}`,
      updatedAt: Date.now(),
    });
    return true;
  },
});

async function enqueueRefinements(ctx: any, mission: any, refinements: GoalRefinement[], wave: number) {
  const integrationBranch = mission.integrationBranch || mission.sharedBranch || missionBranch(mission, mission.primaryRepo);
  const ids: string[] = [];
  for (const refinement of refinements.slice(0, 3)) {
    const id = await insertGoalJob(ctx, {
      task: [
        refinement.task,
        `Goal Mode outcome: ${mission.goal}`,
        `Final validator gap from wave ${wave - 1}: close only this gap on your isolated worker branch, run the relevant checks, and report exact evidence for controller integration and the next Sol validation.`,
      ].join("\n\n"),
      policyTask: refinement.task,
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
      sourceBranch: integrationBranch,
      integrationBranch,
      maxAttempts: 20,
      goalStage: "refining",
      goalWorkstreamId: refinement.id,
      goalWave: wave,
    });
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

async function queueExternalRevision(
  ctx: any,
  mission: any,
  validation: GoalValidation,
  wave: number,
  options: { validationHistory?: GoalValidation[]; extendBudget?: boolean; eventType: string },
) {
  if (mission.externalKind !== "app-factory" || !mission.externalRunId) {
    throw new Error("Only an owned App Factory run can accept an external Goal Mode revision");
  }
  const now = Date.now();
  const patch: Record<string, unknown> = {
    status: "running",
    phase: "factory refinement",
    percent: Math.min(94, 84 + wave * 4),
    validation,
    revisionWave: Number(mission.revisionWave ?? 0),
    maxRevisionWaves: options.extendBudget
      ? Math.max(wave, Number(mission.maxRevisionWaves ?? 2) + 1)
      : mission.maxRevisionWaves,
    validatorJobId: undefined,
    pendingRefinements: validation.refinements,
    externalRevisionRequested: "pending",
    externalRevisionWave: wave,
    externalRevisionUpdatedAt: now,
    externalActionFailures: 0,
    externalActionError: undefined,
    externalActionAlertedAt: undefined,
    advanceLeaseUntil: undefined,
    failureReason: undefined,
    pausedPhase: undefined,
    updatedAt: now,
  };
  if (options.validationHistory) patch.validationHistory = options.validationHistory;
  await patchMissionWithRuntime(ctx, mission, patch);
  await resolveGoalAttention(ctx, mission._id);
  await recordMissionEvent(
    ctx,
    String(mission._id),
    options.eventType,
    options.extendBudget
      ? `Daniel approved App Factory repair wave ${wave}; the durable revision outbox is applying it to the same generated app`
      : `Sol validation queued repair wave ${wave} for the same App Factory run`,
    "factory refinement",
    Math.min(94, 84 + wave * 4),
    { wave, gaps: validation.gaps, externalRunId: mission.externalRunId },
  );
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
      await patchMissionWithRuntime(ctx, mission, {
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
      await resolveGoalAttention(ctx, args.id);
      await recordMissionEvent(ctx, String(args.id), "goal_complete", "Sol validation passed the complete outcome", "complete", 100, {
        evidence: validation.evidence,
      });
      if (mission.parentMissionId) await rollupSplitParent(ctx, mission.parentMissionId);
      return { advanced: true, status: "done", summary: validation.summary };
    }
    const nextWave = Number(mission.revisionWave ?? 0) + 1;
    if (validation.verdict === "refine" && nextWave <= Number(mission.maxRevisionWaves ?? 2)) {
      if (mission.externalKind === "app-factory" && mission.externalRunId) {
        await queueExternalRevision(ctx, mission, validation, nextWave, {
          validationHistory: history,
          eventType: "goal_factory_refinement_queued",
        });
        return { advanced: true, status: "external_refining", jobs: 0 };
      }
      const ids = await enqueueRefinements(ctx, mission, validation.refinements, nextWave);
      await patchMissionWithRuntime(ctx, mission, {
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
    await patchMissionWithRuntime(ctx, mission, {
      status: "needs_input",
      phase: "needs Daniel",
      pausedPhase: "validating",
      validation,
      validationHistory: history,
      pendingRefinements: validation.refinements,
      failureReason: reason.slice(0, 2000),
      advanceLeaseUntil: undefined,
      updatedAt: now,
    });
    await upsertGoalAttention(ctx, mission, reason);
    await recordMissionEvent(ctx, String(args.id), "goal_needs_input", reason, "needs Daniel", mission.percent);
    if (mission.parentMissionId) await rollupSplitParent(ctx, mission.parentMissionId);
    return { advanced: true, status: "needs_input", reason };
  },
});

export const externalPending = query({
  args: { workerToken: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    const groups = await Promise.all(
      ["running", "needs_input"].map((status) =>
        ctx.db.query("missionRuntime").withIndex("by_status", (q: any) => q.eq("status", status)).order("asc").take(100),
      ),
    );
    return groups.flat()
      .filter((mission: any) => {
        if (mission.mode !== "goal" || !mission.externalRunId) return false;
        if (mission.externalControlRequested || mission.externalRevisionRequested) return false;
        if (mission.phase === "building" || mission.phase === "factory approval") return true;
        return mission.phase === "blocked" && mission.externalStatus !== "shipped";
      })
      .map((mission: any) => ({
        id: mission.missionId,
        goal: mission.goal,
        status: mission.status,
        phase: mission.phase,
        externalKind: mission.externalKind,
        externalRunId: mission.externalRunId,
        externalSlug: mission.externalSlug,
        externalStatus: mission.externalStatus,
        externalStage: mission.externalStage,
        externalPollFailures: mission.externalPollFailures ?? 0,
      }));
  },
});

export const externalRevisionsPending = query({
  args: { workerToken: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    const rows = await ctx.db
      .query("missionRuntime")
      .withIndex("by_external_revision", (q: any) => q.eq("externalRevisionRequested", "pending"))
      .order("asc")
      .take(50);
    const candidates = rows.filter((mission: any) =>
      mission.mode === "goal" &&
      mission.externalKind === "app-factory" &&
      mission.externalRunId &&
      (mission.status === "running" || (mission.status === "needs_input" && mission.phase === "blocked")),
    );
    const missions = await Promise.all(candidates.map((activity: any) => ctx.db.get(activity.missionId)));
    return missions
      .filter((mission: any) => mission?.validation?.verdict === "refine" && mission.externalRevisionRequested === "pending")
      .map((mission: any) => ({
        id: mission._id,
        externalRunId: mission.externalRunId,
        wave: Number(mission.externalRevisionWave ?? 0),
        validation: mission.validation,
        externalActionFailures: mission.externalActionFailures ?? 0,
      }));
  },
});

export const acknowledgeExternalRevision = mutation({
  args: {
    id: v.id("missions"),
    wave: v.number(),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    const mission = await ctx.db.get(args.id);
    if (
      !mission ||
      mission.externalRevisionRequested !== "pending" ||
      Number(mission.externalRevisionWave ?? 0) !== args.wave ||
      mission.externalKind !== "app-factory" ||
      !mission.externalRunId
    ) return false;
    if (mission.status === "cancelled" || mission.status === "done") {
      await patchMissionWithRuntime(ctx, mission, {
        externalRevisionRequested: undefined,
        externalRevisionWave: undefined,
        externalRevisionUpdatedAt: Date.now(),
        updatedAt: Date.now(),
      });
      return false;
    }
    const now = Date.now();
    const paused = mission.status === "paused";
    await patchMissionWithRuntime(ctx, mission, {
      status: paused ? "paused" : "running",
      phase: paused ? "paused" : "building",
      pausedPhase: paused ? "building" : undefined,
      revisionWave: args.wave,
      maxRevisionWaves: Math.max(args.wave, Number(mission.maxRevisionWaves ?? 2)),
      pendingRefinements: undefined,
      externalRevisionRequested: undefined,
      externalRevisionWave: undefined,
      externalRevisionUpdatedAt: now,
      externalStatus: "active",
      externalStage: "build",
      externalUpdatedAt: now,
      externalControlRequested: paused ? "pause" : mission.externalControlRequested,
      externalControlUpdatedAt: paused ? now : mission.externalControlUpdatedAt,
      externalActionFailures: 0,
      externalActionError: undefined,
      externalActionAlertedAt: undefined,
      failureReason: undefined,
      advanceLeaseUntil: undefined,
      updatedAt: now,
    });
    await resolveGoalAttention(ctx, args.id);
    await recordMissionEvent(ctx, String(args.id), "goal_factory_refinement_applied", `App Factory accepted repair wave ${args.wave} on the same generated app`, paused ? "paused" : "building", mission.percent, {
      wave: args.wave,
      externalRunId: mission.externalRunId,
    });
    return true;
  },
});

export const externalControlsPending = query({
  args: { workerToken: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    const groups = await Promise.all(
      ["pause", "resume", "retry"].map((action) =>
        ctx.db
          .query("missionRuntime")
          .withIndex("by_external_control", (q: any) => q.eq("externalControlRequested", action))
          .order("asc")
          .take(50),
      ),
    );
    return groups.flat()
      .filter((mission: any) => mission.mode === "goal" && mission.externalKind === "app-factory" && mission.externalRunId)
      .map((mission: any) => ({
        id: mission.missionId,
        externalRunId: mission.externalRunId,
        action: mission.externalControlRequested,
        externalActionFailures: mission.externalActionFailures ?? 0,
      }));
  },
});

export const acknowledgeExternalControl = mutation({
  args: {
    id: v.id("missions"),
    action: v.union(v.literal("pause"), v.literal("resume"), v.literal("retry")),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    const mission = await ctx.db.get(args.id);
    if (!mission || mission.externalControlRequested !== args.action) return false;
    const now = Date.now();
    const recoveredResume = (args.action === "resume" || args.action === "retry") && mission.status === "needs_input" && Boolean(mission.externalActionAlertedAt);
    await patchMissionWithRuntime(ctx, mission, {
      externalControlRequested: undefined,
      externalControlUpdatedAt: now,
      externalActionFailures: 0,
      externalActionError: undefined,
      externalActionAlertedAt: undefined,
      status: recoveredResume ? "running" : mission.status,
      phase: recoveredResume ? "building" : mission.phase,
      pausedPhase: recoveredResume ? undefined : mission.pausedPhase,
      failureReason: mission.externalActionAlertedAt ? undefined : mission.failureReason,
      updatedAt: now,
    });
    if (mission.externalActionAlertedAt) await resolveGoalAttention(ctx, args.id);
    return true;
  },
});

export const recordExternalActionFailure = mutation({
  args: {
    id: v.id("missions"),
    action: v.union(v.literal("pause"), v.literal("resume"), v.literal("retry"), v.literal("refine")),
    error: v.string(),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    const mission = await ctx.db.get(args.id);
    if (!mission || mission.mode !== "goal" || !mission.externalRunId) return { recorded: false, blocked: false };
    const pending = args.action === "refine"
      ? mission.externalRevisionRequested === "pending"
      : mission.externalControlRequested === args.action;
    if (!pending) return { recorded: false, blocked: false };
    const failures = Number(mission.externalActionFailures ?? 0) + 1;
    const now = Date.now();
    const detail = `Jarvis could not ${args.action === "refine" ? "apply the App Factory repair" : `${args.action} the App Factory run`} after ${failures} consecutive attempts: ${args.error.slice(0, 800)}`;
    const firstAlert = failures >= 12 && !mission.externalActionAlertedAt;
    const patch: Record<string, unknown> = {
      externalActionFailures: failures,
      externalActionError: args.error.slice(0, 1000),
      updatedAt: now,
    };
    if (firstAlert) {
      patch.externalActionAlertedAt = now;
      patch.failureReason = detail.slice(0, 2000);
      if (args.action === "refine") {
        patch.status = "needs_input";
        patch.phase = "blocked";
        patch.pausedPhase = "factory refinement";
      } else if ((args.action === "resume" || args.action === "retry") && !["done", "cancelled"].includes(mission.status)) {
        patch.status = "needs_input";
        patch.phase = "blocked";
        patch.pausedPhase = "building";
      }
    }
    await patchMissionWithRuntime(ctx, mission, patch);
    if (firstAlert) {
      await upsertGoalAttention(ctx, mission, detail);
      await recordMissionEvent(ctx, String(args.id), "goal_external_action_blocked", detail, "blocked", mission.percent, {
        action: args.action,
        failures,
      });
    }
    return { recorded: true, blocked: failures >= 12, failures };
  },
});

// Lightweight Trigger supervision uses this read model to wake the expensive
// Trigger fleet only when a durable goal has a transition to process. Immediate
// job completion still advances inline; this is the crash/restart backstop.
export const coordinationDemand = query({
  args: { workerToken: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    const now = Date.now();
    const missions = await ctx.db
      .query("missionRuntime")
      .withIndex("by_status", (q: any) => q.eq("status", "running"))
      .order("asc")
      .take(100);
    const reasons: string[] = [];
    for (const mission of missions) {
      if (mission.mode !== "goal") continue;
      if (mission.externalRunId && ["building", "factory approval", "factory refinement", "blocked"].includes(mission.phase ?? "")) continue;
      const jobs = (await ctx.db
        .query("jobRuntime")
        .withIndex("by_mission", (q: any) => q.eq("missionId", String(mission.missionId)))
        .take(100)).map(runtimeJob);
      const completed = new Set(jobs.filter((job: any) => job.status === "done").map((job: any) => String(job._id)));
      const runnable = jobs.find((job: any) => goalJobRunnableForMission(job, mission, completed, now));
      if (runnable) reasons.push(`runnable:${mission.missionId}:${runnable._id}`);
      if (mission.phase === "planning") {
        const planner = jobs.find((job: any) => String(job._id) === mission.planningJobId);
        if (planner && TERMINAL.has(planner.status)) reasons.push(`plan:${mission.missionId}`);
      } else if (mission.phase === "validating") {
        const validator = jobs.find((job: any) => String(job._id) === mission.validatorJobId);
        if (validator && TERMINAL.has(validator.status)) reasons.push(`validation:${mission.missionId}`);
      } else if (mission.phase === "building" || mission.phase === "refining") {
        const state = summarizeGoalPhase(activeStageJobs(jobs, mission)).state;
        if (state === "complete" || state === "blocked") reasons.push(`${mission.phase}:${mission.missionId}`);
      }
      if (reasons.length >= 20) break;
    }
    return { needed: reasons.length > 0, reasons };
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
    if (!["building", "factory approval", "blocked"].includes(mission.phase ?? "")) return false;
    const now = Date.now();
    const stageOrder = ["inception", "roadmap", "design", "build", "validate", "review", "approval", "package"];
    const progress = 12 + Math.max(0, stageOrder.indexOf(args.stage)) * 8;
    const waiting = args.status === "waiting_approval" || args.status === "paused" || args.stage === "approval" || args.stageState === "waiting";
    const failed = args.status === "failed" || args.stageState === "failed";
    const pollStateClean = Number(mission.externalPollFailures ?? 0) === 0 &&
      !mission.externalPollError && !mission.externalPollAlertedAt;
    if (waiting) {
      const detail = args.detail || `App Factory reached ${args.stage} and is waiting for Daniel's review.`;
      if (
        mission.status === "needs_input" &&
        mission.phase === "factory approval" &&
        mission.externalStatus === args.status &&
        mission.externalStage === args.stage &&
        mission.failureReason === detail.slice(0, 2000) &&
        pollStateClean
      ) return { updated: false, wake: false };
      await patchMissionWithRuntime(ctx, mission, {
        status: "needs_input",
        phase: "factory approval",
        percent: Math.max(68, progress),
        externalStatus: args.status,
        externalStage: args.stage,
        externalUpdatedAt: now,
        externalPollFailures: 0,
        externalPollError: undefined,
        externalPollAlertedAt: undefined,
        failureReason: detail.slice(0, 2000),
        updatedAt: now,
      });
      await upsertGoalAttention(ctx, mission, `${detail} Open App Factory to review; Jarvis will resume monitoring after the gate is decided.`);
      return { updated: true, wake: false };
    }
    if (failed) {
      const detail = args.detail || `App Factory failed during ${args.stage}.`;
      if (
        mission.status === "needs_input" &&
        mission.phase === "blocked" &&
        mission.externalStatus === args.status &&
        mission.externalStage === args.stage &&
        mission.failureReason === detail.slice(0, 2000) &&
        pollStateClean
      ) return { updated: false, wake: false };
      await patchMissionWithRuntime(ctx, mission, {
        status: "needs_input",
        phase: "blocked",
        externalStatus: args.status,
        externalStage: args.stage,
        externalUpdatedAt: now,
        externalPollFailures: 0,
        externalPollError: undefined,
        externalPollAlertedAt: undefined,
        failureReason: detail.slice(0, 2000),
        pausedPhase: "building",
        updatedAt: now,
      });
      await upsertGoalAttention(ctx, mission, detail);
      return { updated: true, wake: false };
    }
    if (args.status === "shipped") {
      const jobs = await ctx.db
        .query("jobs")
        .withIndex("by_mission", (q: any) => q.eq("missionId", String(args.id)))
        .take(100);
      await patchMissionWithRuntime(ctx, mission, {
        status: "running",
        externalStatus: args.status,
        externalStage: args.stage,
        externalUpdatedAt: now,
        externalPollFailures: 0,
        externalPollError: undefined,
        externalPollAlertedAt: undefined,
        failureReason: undefined,
        updatedAt: now,
      });
      const refreshed = await ctx.db.get(args.id);
      if (refreshed?.phase !== "validating") await enqueueValidator(ctx, refreshed, jobs);
      await resolveGoalAttention(ctx, args.id);
      return { updated: true, wake: true };
    }
    if (
      mission.status === "running" &&
      mission.phase === "building" &&
      mission.externalStatus === args.status &&
      mission.externalStage === args.stage &&
      !mission.failureReason &&
      pollStateClean
    ) return { updated: false, wake: false };
    await patchMissionWithRuntime(ctx, mission, {
      status: "running",
      phase: "building",
      percent: Math.max(Number(mission.percent ?? 0), Math.min(76, progress)),
      externalStatus: args.status,
      externalStage: args.stage,
      externalUpdatedAt: now,
      externalPollFailures: 0,
      externalPollError: undefined,
      externalPollAlertedAt: undefined,
      failureReason: undefined,
      pausedPhase: undefined,
      updatedAt: now,
    });
    await resolveGoalAttention(ctx, args.id);
    return { updated: true, wake: false };
  },
});

export const recordExternalPollFailure = mutation({
  args: {
    id: v.id("missions"),
    error: v.string(),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    const mission = await ctx.db.get(args.id);
    if (!mission || mission.mode !== "goal" || !mission.externalRunId || !["building", "factory approval", "blocked"].includes(mission.phase ?? "")) {
      return { recorded: false, blocked: false };
    }
    const failures = Number(mission.externalPollFailures ?? 0) + 1;
    const now = Date.now();
    const detail = `App Factory run ${mission.externalRunId} could not be read after ${failures} consecutive checks: ${args.error.slice(0, 800)}`;
    if (failures < 12) {
      await patchMissionWithRuntime(ctx, mission, {
        externalPollFailures: failures,
        externalPollError: args.error.slice(0, 1000),
        updatedAt: now,
      });
      return { recorded: true, blocked: false, failures };
    }
    const firstAlert = !mission.externalPollAlertedAt;
    await patchMissionWithRuntime(ctx, mission, {
      status: "needs_input",
      phase: "blocked",
      pausedPhase: "building",
      externalPollFailures: failures,
      externalPollError: args.error.slice(0, 1000),
      externalPollAlertedAt: mission.externalPollAlertedAt ?? now,
      failureReason: detail.slice(0, 2000),
      updatedAt: now,
    });
    if (firstAlert) {
      await upsertGoalAttention(ctx, mission, detail);
      await recordMissionEvent(ctx, String(args.id), "goal_external_blocked", detail, "blocked", mission.percent, { failures });
    }
    return { recorded: true, blocked: true, failures };
  },
});

async function resetGoalJob(ctx: any, job: any, now: number, force = false) {
  if (!force && !["error", "cancelled", "paused"].includes(job.status)) return false;
  if (job.status === "running") return false;
  if (job.verificationVerdict === "pass" && job.reviewReceiptId && job.integrationAttemptId) {
    const integration: any = await ctx.db.get(job.integrationAttemptId);
    if (!integration || ["integrated", "cancelled", "exhausted", "parked"].includes(integration.status)) return false;
    const prior: any = job.activeDeliveryAttemptId ? await ctx.db.get(job.activeDeliveryAttemptId) : null;
    if (!prior) return false;
    const generation = Number(job.deliveryGeneration ?? prior.generation ?? 1) + 1;
    const nextId = await ctx.db.insert("deliveryAttempts", {
      jobId: job._id, integrationAttemptId: job.integrationAttemptId,
      sourceWorkAttempt: job.attempt ?? 1, generation, policy: "mission_integration",
      status: "checkpointed", parentDeliveryAttemptId: prior._id,
      reviewReceiptId: prior.reviewReceiptId, reviewReceiptDigest: prior.reviewReceiptDigest,
      reviewKeyId: prior.reviewKeyId, reviewLineage: prior.reviewLineage,
      reviewedHeadSha: prior.reviewedHeadSha, reviewedBaseSha: prior.reviewedBaseSha,
      reviewedHeadTreeSha: prior.reviewedHeadTreeSha, reviewedDiffSha256: prior.reviewedDiffSha256,
      heartbeatAt: now, retries: 0, cumulativeRetries: Number(prior.cumulativeRetries ?? 0),
      currentStep: "queued", retryReason: "mission resumed", createdAt: now, updatedAt: now,
    });
    await ctx.db.patch(prior._id, { status: "abandoned", completedAt: now, leaseUntil: undefined, updatedAt: now });
    await patchJobWithRuntime(ctx, job, {
      status: "pending", stage: "delivery", progress: "reviewed integration receipt resumed",
      nextRunAt: now, activeDeliveryAttemptId: nextId, deliveryGeneration: generation,
      dispatchId: undefined, dispatchLeaseUntil: undefined, workerRunId: undefined, deliveryRunId: undefined,
      deliveryLeaseOwner: undefined, deliveryLeaseToken: undefined, deliveryLeaseUntil: undefined,
      integrationState: "retry_due", completedAt: undefined, heartbeatAt: now,
    });
    return true;
  }
  const nextAttempt = Number(job.attempt ?? 1) + 1;
  const awaitingApproval = job.approvalRequired === true && job.approvalStatus !== "approved";
  const priorResult = String(job.result ?? "").trim();
  if (awaitingApproval) {
    const approvals = await ctx.db
      .query("approvals")
      .withIndex("by_job", (q: any) => q.eq("jobId", String(job._id)))
      .take(20);
    if (!approvals.some((approval: any) => approval.status === "pending")) {
      await ctx.db.insert("approvals", {
        jobId: String(job._id),
        kind: "goal-mode-work-retry",
        summary: (job.label || job.task).slice(0, 240),
        risk: job.risk ?? "consequential",
        payload: { repo: job.repo, agentId: job.agentId, reason: job.approvalReason },
        status: "pending",
        requestedAt: now,
      });
    }
  }
  await patchJobWithRuntime(ctx, job, {
    status: awaitingApproval ? "awaiting_approval" : "pending",
    stage: awaitingApproval ? "approval" : "queued",
    progress: awaitingApproval ? "Goal Mode retry waiting for approval" : "Goal Mode recovery queued",
    checkpoint: [
      String(job.checkpoint ?? "").trim(),
      priorResult ? `Previous attempt evidence:\n${priorResult.slice(0, 3000)}` : "",
      "Daniel resumed the parent goal. Preserve completed evidence and retry only the unfinished boundary.",
    ].filter(Boolean).join("\n\n").slice(0, 6000),
    result: undefined,
    attempt: nextAttempt,
    maxAttempts: Math.min(48, Math.max(Number(job.maxAttempts ?? 12), nextAttempt + 4)),
    approvalStatus: awaitingApproval ? "pending" : job.approvalStatus,
    completedAt: undefined,
    startedAt: undefined,
    heartbeatAt: now,
    nextRunAt: awaitingApproval ? undefined : now,
    verificationVerdict: undefined,
    verificationNote: undefined,
    verifiedAt: undefined,
  });
  return true;
}

export const control = mutation({
  args: {
    id: v.id("missions"),
    action: v.union(v.literal("pause"), v.literal("resume"), v.literal("cancel")),
    authTokenHash: v.optional(v.string()),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    const mission = await ctx.db.get(args.id);
    if (!mission || mission.mode !== "goal") return false;
    const jobs = await ctx.db
      .query("jobs")
      .withIndex("by_mission", (q: any) => q.eq("missionId", String(args.id)))
      .take(100);
    const now = Date.now();
    if (Array.isArray(mission.splitChildMissionIds) && mission.splitChildMissionIds.length) {
      if ((args.action === "pause" && mission.status === "paused")
        || (args.action === "resume" && mission.status === "split")
        || (args.action === "cancel" && mission.status === "cancelled")) return true;
      let reconciliationPending = false;
      for (const childId of mission.splitChildMissionIds) {
        const child: any = await ctx.db.get(childId);
        if (!child || child.parentMissionId !== mission._id) return false;
        const childJobs = await ctx.db.query("jobs")
          .withIndex("by_mission", (q: any) => q.eq("missionId", String(child._id))).take(100);
        if (args.action === "resume") {
          if (child.status !== "paused") continue;
          for (const childJob of childJobs) if (childJob.status === "paused") await resetGoalJob(ctx, childJob, now);
          await patchMissionWithRuntime(ctx, child, {
            status: "running", phase: child.pausedPhase ?? "planning", pausedPhase: undefined,
            failureReason: undefined, updatedAt: now,
          });
          continue;
        }
        let childReconciliation = false;
        for (const childJob of childJobs) {
          const result = await controlIntegrationForJob(ctx, childJob, args.action);
          childReconciliation ||= Boolean(result?.reconcile);
        }
        reconciliationPending ||= childReconciliation;
        for (const childJob of childJobs) {
          const current: any = await ctx.db.get(childJob._id);
          if (!current || current.integrationState === `${args.action}_requested` || TERMINAL.has(current.status)) continue;
          await patchJobWithRuntime(ctx, current, args.action === "pause" ? {
            status: "paused", stage: "paused", progress: "split parent paused", nextRunAt: undefined,
          } : {
            status: "cancelled", stage: "cancelled", progress: "split parent cancelled", completedAt: now, nextRunAt: undefined,
          });
        }
        await patchMissionWithRuntime(ctx, child, childReconciliation ? {
          controlRequested: args.action, controlRequestedAt: now, pausedPhase: child.pausedPhase ?? child.phase,
          activeIntegrationAttemptId: undefined, integrationLeaseOwner: undefined, integrationLeaseToken: undefined,
          integrationLeaseUntil: undefined, updatedAt: now,
        } : args.action === "pause" ? {
          status: "paused", phase: "paused", pausedPhase: child.phase, updatedAt: now,
        } : {
          status: "cancelled", phase: "cancelled", completedAt: now, updatedAt: now,
        });
      }
      await patchMissionWithRuntime(ctx, mission, args.action === "resume" ? {
        status: "split", phase: "split", pausedPhase: undefined, controlRequested: undefined,
        controlRequestedAt: undefined, failureReason: undefined, updatedAt: now,
      } : reconciliationPending ? {
        status: "split", phase: "split", controlRequested: args.action, controlRequestedAt: now,
        pausedPhase: "split", updatedAt: now,
      } : args.action === "pause" ? {
        status: "paused", phase: "paused", pausedPhase: "split", updatedAt: now,
      } : {
        status: "cancelled", phase: "cancelled", completedAt: now, updatedAt: now,
      });
      await recordMissionEvent(ctx, String(mission._id), `goal_split_${args.action}`,
        `Split parent ${args.action} propagated to ${mission.splitChildMissionIds.length} repository child missions`,
        args.action, mission.percent, { reconciliationPending });
      return true;
    }
    let externalControl: "pause" | "resume" | "retry" | null = null;
    if ((args.action === "pause" || args.action === "cancel") && !["done", "cancelled"].includes(mission.status)) {
      let reconciliationPending = false;
      for (const job of jobs) {
        const result = await controlIntegrationForJob(ctx, job, args.action);
        reconciliationPending ||= Boolean(result?.reconcile);
      }
      if (reconciliationPending) {
        for (const job of jobs) {
          const current: any = await ctx.db.get(job._id);
          if (!current || current.integrationState === `${args.action}_requested` || TERMINAL.has(current.status)) continue;
          await patchJobWithRuntime(ctx, current, args.action === "pause" ? {
            status: "paused", stage: "paused", progress: "Goal Mode pause requested", nextRunAt: undefined,
          } : {
            status: "cancelled", stage: "cancelled", progress: "Goal Mode cancel requested", completedAt: now, nextRunAt: undefined,
          });
        }
        await patchMissionWithRuntime(ctx, mission, {
          controlRequested: args.action, controlRequestedAt: now,
          pausedPhase: mission.pausedPhase ?? mission.phase,
          activeIntegrationAttemptId: undefined, integrationLeaseOwner: undefined,
          integrationLeaseToken: undefined, integrationLeaseUntil: undefined, updatedAt: now,
        });
        await recordMissionEvent(ctx, String(args.id), `${args.action}_requested`,
          `Goal Mode ${args.action} is reconciling an in-flight provider effect`, String(mission.phase ?? "goal"), mission.percent);
        return true;
      }
    }
    if (args.action === "pause" && mission.status === "running") {
      if (mission.externalRunId && mission.externalStatus !== "shipped") externalControl = "pause";
      await patchMissionWithRuntime(ctx, mission, {
        status: "paused", pausedPhase: mission.phase, phase: "paused",
        activeIntegrationAttemptId: undefined, integrationLeaseOwner: undefined,
        integrationLeaseToken: undefined, integrationLeaseUntil: undefined, updatedAt: now,
      });
      if (mission.activeIntegrationAttemptId) {
        const integration: any = await ctx.db.get(mission.activeIntegrationAttemptId);
        if (integration && !["integrated", "conflict", "stale", "cancelled", "exhausted", "parked"].includes(integration.status)) {
          await ctx.db.patch(integration._id, {
            status: "queued",
            leaseOwner: undefined, leaseToken: undefined, leaseUntil: undefined,
            retryReason: "paused by mission control", updatedAt: now,
          });
        }
      }
      for (const job of jobs) {
        if (shouldPauseGoalJob(job.status)) {
          await patchJobWithRuntime(ctx, job, {
            status: "paused",
            stage: "paused",
            progress: "Goal Mode paused by Daniel",
            nextRunAt: undefined,
            dispatchId: undefined,
            dispatchLeaseUntil: undefined,
            workerRunId: undefined,
            deliveryLeaseOwner: undefined,
            deliveryLeaseToken: undefined,
            deliveryLeaseUntil: undefined,
          });
          if (job.activeDeliveryAttemptId) {
            const delivery: any = await ctx.db.get(job.activeDeliveryAttemptId);
            if (delivery && !["done", "blocked", "abandoned"].includes(delivery.status)) await ctx.db.patch(delivery._id, {
              status: "checkpointed", leaseOwner: undefined, leaseToken: undefined, leaseUntil: undefined,
              retryReason: "paused by mission control", heartbeatAt: now, updatedAt: now,
            });
          }
        }
      }
    } else if (args.action === "resume" && mission.status === "paused") {
      const restoredPhase = mission.pausedPhase ?? "building";
      if (mission.externalRunId && mission.externalStatus !== "shipped" && ["building", "factory approval", "factory refinement"].includes(restoredPhase)) externalControl = "resume";
      for (const job of jobs) {
        if (job.status === "paused") await resetGoalJob(ctx, job, now);
      }
      await patchMissionWithRuntime(ctx, mission, {
        status: "running",
        phase: restoredPhase,
        pausedPhase: undefined,
        failureReason: undefined,
        advanceLeaseUntil: undefined,
        updatedAt: now,
      });
      await resolveGoalAttention(ctx, args.id);
    } else if (args.action === "resume" && mission.status === "needs_input") {
      // Factory approval is a protected human gate. Jarvis monitors it but
      // never turns a generic Resume click into an approval.
      if (mission.phase === "factory approval") return false;
      const refinements = Array.isArray(mission.pendingRefinements) ? mission.pendingRefinements as GoalRefinement[] : [];
      if (
        refinements.length &&
        mission.externalKind === "app-factory" &&
        mission.externalRunId &&
        mission.validation?.verdict === "refine"
      ) {
        const alreadyQueued = mission.externalRevisionRequested === "pending";
        const nextWave = alreadyQueued
          ? Number(mission.externalRevisionWave ?? Number(mission.revisionWave ?? 0) + 1)
          : Number(mission.revisionWave ?? 0) + 1;
        await queueExternalRevision(ctx, mission, mission.validation as GoalValidation, nextWave, {
          extendBudget: !alreadyQueued,
          eventType: alreadyQueued ? "goal_factory_refinement_retried" : "goal_factory_extension_queued",
        });
      } else if (refinements.length) {
        const nextWave = Number(mission.revisionWave ?? 0) + 1;
        const ids = await enqueueRefinements(ctx, mission, refinements, nextWave);
        await patchMissionWithRuntime(ctx, mission, {
          status: "running",
          phase: "refining",
          revisionWave: nextWave,
          maxRevisionWaves: Math.max(nextWave, Number(mission.maxRevisionWaves ?? 2) + 1),
          pendingRefinements: undefined,
          failureReason: undefined,
          agentCount: Number(mission.agentCount ?? 0) + ids.length,
          updatedAt: now,
        });
      } else if (["planning", "validating"].includes(mission.pausedPhase ?? "")) {
        const phase = String(mission.pausedPhase);
        const jobId = phase === "planning" ? mission.planningJobId : mission.validatorJobId;
        const job = jobs.find((candidate) => String(candidate._id) === jobId);
        if (!job) return false;
        if (phase === "validating") {
          await patchJobWithRuntime(ctx, job, {
            task: (await validatorTaskForMission(ctx, mission, jobs)).slice(0, GOAL_VALIDATOR_TASK_MAX_CHARS),
          });
        }
        if (!(await resetGoalJob(ctx, job, now, true))) return false;
        await patchMissionWithRuntime(ctx, mission, {
          status: "running",
          phase,
          pausedPhase: undefined,
          failureReason: undefined,
          advanceLeaseUntil: undefined,
          updatedAt: now,
        });
      } else if (["building", "refining"].includes(mission.pausedPhase ?? "")) {
        const phase = String(mission.pausedPhase);
        const stage = phase === "refining" ? "refining" : "building";
        const wave = phase === "refining" ? Number(mission.revisionWave ?? 0) : 0;
        const phaseJobs = jobs.filter((job) => job.goalStage === stage && Number(job.goalWave ?? 0) === wave);
        let reset = 0;
        for (const job of phaseJobs) if (await resetGoalJob(ctx, job, now)) reset += 1;
        if (!reset && mission.externalRunId) {
          externalControl = mission.externalStatus === "failed"
            ? "retry"
            : mission.externalStatus === "paused" ? "resume" : null;
          await patchMissionWithRuntime(ctx, mission, {
            status: "running",
            phase: "building",
            pausedPhase: undefined,
            failureReason: undefined,
            externalPollFailures: 0,
            externalPollError: undefined,
            externalPollAlertedAt: undefined,
            updatedAt: now,
          });
        } else if (!reset) return false;
        else {
          await patchMissionWithRuntime(ctx, mission, {
            status: "running",
            phase,
            pausedPhase: undefined,
            failureReason: undefined,
            advanceLeaseUntil: undefined,
            updatedAt: now,
          });
        }
      } else if (mission.externalRunId) {
        externalControl = mission.externalStatus === "failed"
          ? "retry"
          : mission.externalStatus === "paused" ? "resume" : null;
        await patchMissionWithRuntime(ctx, mission, {
          status: "running",
          phase: "building",
          pausedPhase: undefined,
          failureReason: undefined,
          externalPollFailures: 0,
          externalPollError: undefined,
          externalPollAlertedAt: undefined,
          updatedAt: now,
        });
      } else return false;
      await resolveGoalAttention(ctx, args.id);
    } else if (args.action === "cancel" && !["done", "cancelled"].includes(mission.status)) {
      if (mission.externalRunId && mission.externalStatus !== "shipped") externalControl = "pause";
      await patchMissionWithRuntime(ctx, mission, {
        status: "cancelled",
        phase: "cancelled",
        activeIntegrationAttemptId: undefined,
        integrationLeaseOwner: undefined,
        integrationLeaseToken: undefined,
        integrationLeaseUntil: undefined,
        externalRevisionRequested: undefined,
        externalRevisionWave: undefined,
        externalRevisionUpdatedAt: now,
        completedAt: now,
        updatedAt: now,
      });
      const integrations = await ctx.db.query("integrationAttempts")
        .withIndex("by_mission_generation", (q: any) => q.eq("missionId", mission._id)).take(100);
      for (const integration of integrations) {
        if (!["integrated", "conflict", "stale", "cancelled", "exhausted", "parked"].includes(integration.status)) {
          const terminal = await writeIntegrationTerminalReceipt(ctx, integration, "cancelled", { reason: "cancelled by mission control" });
          if (!terminal) throw new Error("cancelled integration terminal receipt could not be canonicalized");
          await ctx.db.patch(integration._id, {
            status: "cancelled", outcome: "cancelled", leaseOwner: undefined, leaseToken: undefined, leaseUntil: undefined,
            terminalReceiptDigest: terminal.receiptDigest, completedAt: now, updatedAt: now,
          });
        }
      }
      for (const job of jobs) {
        if (!TERMINAL.has(job.status)) {
          await patchJobWithRuntime(ctx, job, { status: "cancelled", stage: "cancelled", progress: "Goal Mode cancelled by Daniel", completedAt: now, nextRunAt: undefined });
        }
        if (job.activeDeliveryAttemptId) {
          const delivery: any = await ctx.db.get(job.activeDeliveryAttemptId);
          const integration = job.integrationAttemptId ? await ctx.db.get(job.integrationAttemptId) : null;
          if (delivery && integration?.terminalReceiptDigest && !["done", "blocked", "abandoned"].includes(delivery.status)) await ctx.db.patch(delivery._id, {
            status: "blocked", outcome: "cancelled", currentStep: "terminal",
            terminalReceiptDigest: integration.terminalReceiptDigest, leaseOwner: undefined, leaseToken: undefined,
            leaseUntil: undefined, completedAt: now, heartbeatAt: now, updatedAt: now,
          });
        }
        const approvals = await ctx.db
          .query("approvals")
          .withIndex("by_job", (q: any) => q.eq("jobId", String(job._id)))
          .take(20);
        for (const approval of approvals) {
          if (approval.status === "pending") await ctx.db.patch(approval._id, { status: "cancelled", resolvedAt: now });
        }
      }
      await resolveGoalAttention(ctx, args.id);
    } else return false;
    if (externalControl) {
      await patchMissionWithRuntime(ctx, mission, {
        externalControlRequested: externalControl,
        externalControlUpdatedAt: now,
        externalActionFailures: 0,
        externalActionError: undefined,
        externalActionAlertedAt: undefined,
        updatedAt: now,
      });
    }
    await recordMissionEvent(ctx, String(args.id), args.action, `Goal Mode ${args.action} requested by Daniel`, args.action, mission.percent);
    return true;
  },
});
