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
  ensureWorkAttempt,
  insertJobWithRuntime,
  insertMissionWithRuntime,
  patchJobWithRuntime,
  patchMissionWithRuntime,
  readExactWorkAttempt,
  runtimeJob,
  stageJobWorkOrderRevision,
  transitionJobWorkOrderRevision,
} from "./controlPlane";
import { canonicalizeRepository } from "../src/lib/workflow-contract";
import { exactTextWorkOrder } from "../src/lib/work-order";
import { validateWorkDag } from "../src/lib/workspace-protocol";
import { controlIntegrationForJob } from "./goalIntegration";
import {
  canonicalGoalPlan,
  canonicalGoalPlanJson,
  GOAL_DAG_MAX_NODES,
  goalDagEdgeId,
  topologicalGoalWorkstreams,
} from "../src/lib/goal-dag";
import { ensureGoalNodeHandoff } from "./goalHandoffs";
import {
  admissionForRepository,
  projectSourceAdmissionValidator,
  validProjectAdmissions,
} from "./sourceAdmission";
import {
  sealProjectSourceAdmission,
  type ProjectSourceAdmission,
} from "../src/lib/source-admission";

const ADVANCE_LEASE_MS = 10 * 60 * 1000;
const COORDINATOR_RECEIPT_FRESH_MS = 10 * 60 * 1000;
const GOAL_MATERIALIZATION_BATCH = 3;
const TERMINAL = new Set(["done", "error", "cancelled"]);

type AdvanceLeaseFence = {
  advanceLeaseOwner?: string;
  advanceLeaseToken?: string;
  advanceLeaseVersion?: number;
};

// Older rows had only an expiry timestamp. Keep those rows recoverable, but
// once a modern owner has claimed an advance every write must carry its exact
// fence. An expired owner cannot turn a late model/external response into a
// second plan or validation transition.
function ownsAdvanceLease(mission: any, fence: AdvanceLeaseFence, now = Date.now(), requireFresh = true) {
  if (!mission.advanceLeaseToken) return true;
  return Boolean(
    fence.advanceLeaseOwner &&
    fence.advanceLeaseToken &&
    Number.isFinite(fence.advanceLeaseVersion) &&
    mission.advanceLeaseOwner === fence.advanceLeaseOwner &&
    mission.advanceLeaseToken === fence.advanceLeaseToken &&
    Number(mission.advanceLeaseVersion ?? 0) === Number(fence.advanceLeaseVersion) &&
    (!requireFresh || Number(mission.advanceLeaseUntil ?? 0) >= now),
  );
}

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
  planParentMissionId?: any;
  planDigest?: string;
  planGeneration?: number;
  planNodeId?: string;
  maxAttempts?: number;
  branch?: string;
  sourceBranch?: string;
  sourceHeadSha?: string;
  integrationBranch?: string;
  goalStage: "planning" | "building" | "validating" | "refining";
  goalWorkstreamId?: string;
  goalWave: number;
  dispatchReady?: boolean;
};

async function sha256Hex(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function acceptedPlan(value: GoalPlan, maxNodes: number) {
  const canonical = canonicalGoalPlan(value, maxNodes);
  return { plan: canonical, digest: await sha256Hex(canonicalGoalPlanJson(canonical, maxNodes)) };
}

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
  const task = exactTextWorkOrder(input.task);
  const now = Date.now();
  const repo = input.repo === undefined ? undefined : canonicalizeRepository(input.repo, { allowShortName: true }) ?? undefined;
  if (input.repo !== undefined && !repo) {
    throw new Error("Goal repository must be an owner/repo slug or credential-free https://github.com/owner/repo(.git) URL");
  }
  input = { ...input, repo, task };
  const missionId = ctx.db.normalizeId("missions", input.missionId);
  const mission: any = missionId ? await ctx.db.get(missionId) : null;
  if (!mission || mission.admissionProtocolVersion !== 2) {
    throw new Error("Goal job requires one admitted v2 mission ledger");
  }
  const projectAdmission = await missionProjectAdmission(
    mission,
    repo,
    input.goalStage === "validating" || input.goalStage === "refining",
  );
  const approval = goalWorkApprovalPolicy({
    ...input,
    task: input.policyTask?.trim() || input.task,
  });
  const approvalRequired = approval.required;
  const status = approvalRequired ? "awaiting_approval" : "pending";
  const jobId = await insertJobWithRuntime(ctx, {
    ...input,
    admissionProtocolVersion: 2,
    projectAdmission,
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
    integrationState: !input.readonly && repo ? "awaiting_review" : "not_applicable",
    dispatchReady: input.dispatchReady,
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

async function missionProjectAdmission(
  mission: any,
  repository?: string,
  preferIntegration = false,
): Promise<ProjectSourceAdmission> {
  const canonicalRepository = repository
    ? canonicalizeRepository(repository, { allowShortName: true }) ?? undefined
    : undefined;
  const inherited = admissionForRepository(mission.projectAdmissions, canonicalRepository);
  if (!canonicalRepository) {
    if (!inherited) throw new Error("Mission has no immutable evidence-project admission");
    return inherited;
  }
  if (!inherited) throw new Error(`Mission has no immutable source admission for ${canonicalRepository}`);
  if (!preferIntegration || !mission.integrationBranch || !mission.integrationHeadSha || !mission.integrationObservedAt) return inherited;
  return await sealProjectSourceAdmission({
    protocolVersion: 2,
    canonicalProjectId: inherited.canonicalProjectId,
    repository: canonicalRepository,
    sourceProvider: "github",
    sourceBranch: String(mission.integrationBranch),
    sourceRef: `refs/heads/${String(mission.integrationBranch)}`,
    sourceHeadSha: String(mission.integrationHeadSha),
    sourceObservedAt: Number(mission.integrationObservedAt),
  });
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
  const generation = Number(parent.planGeneration ?? 0);
  const nodes = generation ? await ctx.db.query("goalPlanNodes")
    .withIndex("by_parent_generation", (q: any) => q.eq("parentMissionId", parent._id).eq("planGeneration", generation))
    .take(GOAL_DAG_MAX_NODES + 1) : [];
  if (!parent.planDigest || nodes.length !== Number(parent.planNodeCount ?? 0) || nodes.length > GOAL_DAG_MAX_NODES) return false;
  const [children, jobs] = await Promise.all([
    Promise.all(parent.splitChildMissionIds.slice(0, GOAL_DAG_MAX_NODES).map((id: any) => ctx.db.get(id))),
    Promise.all(nodes.map((node: any) => ctx.db.get(node.jobId))),
  ]);
  const validChildren = children.filter((child: any) => child && child.parentMissionId === parent._id
    && child.planDigest === parent.planDigest && Number(child.planGeneration) === generation);
  if (validChildren.length !== parent.splitChildMissionIds.length || jobs.some((job: any) => !job)) return false;
  const now = Date.now();
  const handoffs = new Map<string, any>();
  for (const job of jobs) {
    if (job.status === "done") {
      const handoff = await ensureGoalNodeHandoff(ctx, job);
      if (handoff) handoffs.set(String(job._id), handoff);
    }
  }
  const weight = nodes.reduce((sum: number, node: any) => sum + Number(node.weight ?? 1), 0) || 1;
  const percent = Math.min(96, Math.round(nodes.reduce((sum: number, node: any, index: number) => {
    const job = jobs[index];
    const nodePercent = handoffs.has(String(job._id)) ? 100 : Number(job.percent ?? 0);
    return sum + Math.max(0, Math.min(100, nodePercent)) * Number(node.weight ?? 1);
  }, 0) / weight));
  const childSummaries: string[] = [];
  for (const child of validChildren) {
    const childIndexes = nodes.map((node: any, index: number) => node.childMissionId === child._id ? index : -1).filter((index: number) => index >= 0);
    const childJobs = childIndexes.map((index: number) => jobs[index]);
    const childDone = childJobs.length > 0 && childJobs.every((job: any) => handoffs.has(String(job._id)));
    const childBlocked = childJobs.find((job: any) => ["needs_input", "error", "cancelled"].includes(job.status));
    const childAttention = childJobs.find((job: any) => job.status === "awaiting_approval" || job.approvalStatus === "pending");
    const childPercent = Math.round(childJobs.reduce((sum: number, job: any) =>
      sum + (handoffs.has(String(job._id)) ? 100 : Number(job.percent ?? 0)), 0) / Math.max(1, childJobs.length));
    const childStatus = childBlocked ? "needs_input" : childDone ? "done" : "running";
    const childPhase = childBlocked ? "blocked" : childDone ? "complete" : "building";
    const failureReason = childBlocked
      ? String(childBlocked.failureReason ?? childBlocked.progress ?? `${childBlocked.label ?? childBlocked.planNodeId} needs attention`).slice(0, 2_000)
      : childAttention ? `${childAttention.label ?? childAttention.planNodeId} is waiting for approval` : undefined;
    if (child.status !== childStatus || child.phase !== childPhase || Number(child.percent ?? 0) !== childPercent
      || child.failureReason !== failureReason) await patchMissionWithRuntime(ctx, child, {
      status: childStatus, phase: childPhase, percent: childPercent,
      summary: `${childJobs.filter((job: any) => handoffs.has(String(job._id))).length}/${childJobs.length} immutable node handoffs complete`,
      failureReason, completedAt: childDone ? (child.completedAt ?? now) : undefined, updatedAt: now,
    });
    childSummaries.push(`${child.primaryRepo ?? "read-only evidence"}: ${childStatus} · ${childJobs.filter((job: any) => handoffs.has(String(job._id))).length}/${childJobs.length} nodes`);
  }
  const summary = childSummaries.join("\n").slice(0, 4_000);
  const requested = parent.controlRequested as "pause" | "cancel" | undefined;
  let patch: Record<string, unknown>;
  if (requested === "cancel" && jobs.every((job: any) => ["done", "cancelled"].includes(job.status))) {
    patch = { status: "cancelled", phase: "cancelled", percent, summary, controlRequested: undefined,
      controlRequestedAt: undefined, completedAt: now, updatedAt: now };
  } else if (requested === "pause" && jobs.every((job: any) => ["paused", "done", "cancelled"].includes(job.status))) {
    patch = { status: "paused", phase: "paused", percent, summary, controlRequested: undefined,
      controlRequestedAt: undefined, pausedPhase: "split", updatedAt: now };
  } else if (jobs.every((job: any) => handoffs.has(String(job._id)))) {
    if (!parent.validatorJobId) {
      await enqueueValidator(ctx, parent, jobs);
      return true;
    }
    patch = { status: "running", phase: "validating", percent: Math.max(96, percent), summary,
      failureReason: undefined, updatedAt: now };
  } else {
    const blocked = jobs.filter((job: any) => ["needs_input", "failed", "error", "cancelled"].includes(job.status));
    if (blocked.length) {
      const reason = blocked.map((job: any) => `${job.label ?? job.planNodeId}: ${job.failureReason ?? job.progress ?? job.status}`).join("; ").slice(0, 2_000);
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
      children: validChildren.map((child: any) => ({ id: String(child._id), repository: child.primaryRepo, status: child.status })),
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
    const primaryRepo = args.primaryRepo === undefined
      ? undefined
      : canonicalizeRepository(args.primaryRepo, { allowShortName: true }) ?? undefined;
    if (args.primaryRepo !== undefined && !primaryRepo) {
      throw new Error("Goal repository must be an owner/repo slug or credential-free https://github.com/owner/repo(.git) URL");
    }
    const missionId = await insertMissionWithRuntime(ctx, {
      goal,
      mode: "goal",
      status: "needs_input",
      agentCount: 0,
      originThreadId: args.originThreadId,
      managerAgentId: "jarvis",
      priority: Math.max(0, Math.min(100, args.priority ?? 95)),
      risk: args.risk ?? "high",
      phase: "protocol_hold",
      percent: 0,
      acceptanceCriteria: (args.acceptanceCriteria ?? []).map((item) => item.trim().slice(0, 500)).filter(Boolean).slice(0, 10),
      route: args.route.slice(0, 80),
      routeReason: args.routeReason.slice(0, 1000),
      primaryRepo,
      infrastructureContext: args.infrastructureContext.slice(0, 4000),
      revisionWave: 0,
      maxRevisionWaves: Math.max(1, Math.min(4, Math.floor(args.maxRevisionWaves ?? 2))),
      maxBuildSessions: Math.max(2, Math.min(8, Math.floor(args.maxBuildSessions ?? 6))),
      admissionProtocolVersion: 1,
      protocolHoldReason: "protocol_v1_admission_held",
      failureReason: "Legacy Goal Mode admission is durably held until the v2 source-authority rollout is active",
      advanceAttempt: 0,
      createdAt: now,
      updatedAt: now,
    });
    await recordMissionEvent(ctx, String(missionId), "protocol_hold",
      "Legacy Goal Mode request held before planner dispatch", "protocol_hold", 0,
      { reason: "protocol_v1_admission_held", primaryRepo });
    return {
      missionId,
      plannerJobId: null,
      route: args.route,
      held: true,
      reason: "protocol_v1_admission_held",
    };
  },
});

export const createV2 = mutation({
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
    projectAdmission: projectSourceAdmissionValidator,
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
    if (!await validProjectAdmissions([args.projectAdmission], { requireFresh: true })
      || args.projectAdmission.repository !== primaryRepo) {
      throw new Error("Goal Mode requires one fresh canonical project source admission");
    }
    const missionId = await insertMissionWithRuntime(ctx, {
      goal,
      admissionProtocolVersion: 2,
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
      projectAdmissions: [args.projectAdmission],
      canonicalProjectId: args.projectAdmission.canonicalProjectId,
      sourceProvider: args.projectAdmission.sourceProvider,
      sourceBranch: args.projectAdmission.sourceBranch,
      sourceRef: args.projectAdmission.sourceRef,
      sourceHeadSha: args.projectAdmission.sourceHeadSha,
      sourceObservedAt: args.projectAdmission.sourceObservedAt,
      sourceAdmissionDigest: args.projectAdmission.sourceAdmissionDigest,
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
  let buildEvidence = jobs
    .filter((job) => job.goalStage === "building" || job.goalStage === "refining")
    .map((job) => ({ label: job.label ?? job.task.slice(0, 80), status: job.status,
      result: String(job.result ?? job.progress ?? "").slice(0, 2_000) }));
  let auditSnapshot = await validatorAuditSnapshot(ctx, mission, jobs);
  if (Array.isArray(mission.splitChildMissionIds) && mission.planDigest && mission.planGeneration) {
    const [nodes, handoffs, children] = await Promise.all([
      ctx.db.query("goalPlanNodes").withIndex("by_parent_generation", (q: any) =>
        q.eq("parentMissionId", mission._id).eq("planGeneration", Number(mission.planGeneration))).take(GOAL_DAG_MAX_NODES + 1),
      ctx.db.query("goalHandoffs").withIndex("by_parent_generation", (q: any) =>
        q.eq("parentMissionId", mission._id).eq("planGeneration", Number(mission.planGeneration))).take(GOAL_DAG_MAX_NODES + 1),
      Promise.all(mission.splitChildMissionIds.slice(0, GOAL_DAG_MAX_NODES).map((id: any) => ctx.db.get(id))),
    ]);
    if (nodes.length !== mission.planNodeCount || handoffs.length !== nodes.length
      || nodes.length > GOAL_DAG_MAX_NODES || handoffs.some((row: any) => row.handoffProtocolVersion !== 2
        || typeof row.handoffPayloadDigest !== "string" || typeof row.workReceiptDigest !== "string"
        || row.planDigest !== mission.planDigest)) {
      throw new Error("Parent validation requires one current immutable handoff per accepted plan node");
    }
    const byNode = new Map(handoffs.map((row: any) => [row.sourceNodeId, row]));
    buildEvidence = nodes.map((node: any) => {
      const handoff: any = byNode.get(node.nodeId);
      return {
        label: `${node.label} [${node.repository ?? "read-only"}]`, status: "done",
        result: `${handoff.summary}\nReceipts: work=${handoff.workReceiptDigest}; review=${handoff.reviewReceiptDigest ?? "n/a"}; integration=${handoff.integrationTerminalReceiptDigest ?? "n/a"}; result=${handoff.acceptedResultDigest}`,
      };
    });
    auditSnapshot = JSON.stringify({
      authority: "Convex immutable split-parent validation snapshot",
      parent: { id: String(mission._id), planDigest: mission.planDigest, planGeneration: mission.planGeneration,
        originalGoal: mission.goal, declaredLiveChecks: plan.validation.liveChecks },
      nodes: nodes.map((node: any) => ({ id: node.nodeId, jobId: String(node.jobId), childMissionId: String(node.childMissionId),
        repository: node.repository ?? null, readonly: node.readonly, dependencyCount: node.dependencyCount,
        handoff: byNode.get(node.nodeId) ? {
          attempt: (byNode.get(node.nodeId) as any).sourceAttempt,
          steerRevision: (byNode.get(node.nodeId) as any).sourceSteerRevision,
          reviewReceiptDigest: (byNode.get(node.nodeId) as any).reviewReceiptDigest ?? null,
          integrationReceiptDigest: (byNode.get(node.nodeId) as any).integrationTerminalReceiptDigest ?? null,
          integrationHeadSha: (byNode.get(node.nodeId) as any).integrationHeadSha ?? null,
          artifacts: (byNode.get(node.nodeId) as any).artifactRefs,
          resultDigest: (byNode.get(node.nodeId) as any).acceptedResultDigest,
        } : null })),
      children: children.filter(Boolean).map((child: any) => ({ id: String(child._id), repository: child.primaryRepo ?? null,
        status: child.status, integrationBranch: child.integrationBranch ?? null, integrationHeadSha: child.integrationHeadSha ?? null })),
    });
  }
  return validatorTask({
    goal: mission.goal,
    plan,
    acceptanceCriteria: mission.acceptanceCriteria ?? [],
    buildEvidence,
    revisionWave: Number(mission.revisionWave ?? 0),
    auditSnapshot,
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
  const splitParent = Array.isArray(mission.splitChildMissionIds) && mission.splitChildMissionIds.length > 0;
  const branch = mission.externalRunId || splitParent
    ? undefined
    : mission.integrationBranch || mission.sharedBranch || missionBranch(mission, mission.primaryRepo);
  const task = await validatorTaskForMission(ctx, mission, jobs);
  const repository = splitParent ? undefined : mission.primaryRepo ?? plan.primaryRepo;
  const validatorJobId = await insertGoalJob(ctx, {
    task,
    missionId: String(mission._id),
    label: `JARVIS · deep validation ${Number(mission.revisionWave ?? 0) + 1}`,
    repo: repository,
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
    integrationBranch: branch,
    maxAttempts: 16,
    goalStage: "validating",
    goalWorkstreamId: `validation-${Number(mission.revisionWave ?? 0)}`,
    goalWave: Number(mission.revisionWave ?? 0),
    ...(splitParent ? {
      planParentMissionId: mission._id,
      planDigest: mission.planDigest,
      planGeneration: mission.planGeneration,
      planNodeId: `parent-validation-${Number(mission.revisionWave ?? 0)}`,
    } : {}),
  });
  const now = Date.now();
  await patchMissionWithRuntime(ctx, mission, {
    status: "running",
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
  args: {
    // Trigger supplies a run-scoped owner/token. They are optional only to
    // preserve recovery of pre-fence rows during a rolling deployment.
    advanceLeaseOwner: v.optional(v.string()),
    advanceLeaseToken: v.optional(v.string()),
    workerToken: v.optional(v.string()),
  },
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
      if (activity.phase === "materializing") {
        const mission: any = await ctx.db.get(activity.missionId);
        if (!mission || mission.parentMissionId || mission.admissionProtocolVersion !== 2
          || mission.status !== "running" || mission.phase !== "materializing" || !mission.planDigest) continue;
        return {
          kind: "materialize",
          missionId: mission._id,
          planDigest: mission.planDigest,
          cursor: Number(mission.materializationCursor ?? 0),
          totalJobs: Number(mission.planNodeCount ?? 0),
        };
      }
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
          if (await recoverGoalPhaseLeaves(ctx, mission, [planner], "planning")) {
            return { kind: "advanced", missionId: mission._id, phase: "planning_recovered" };
          }
          await blockGoalForPhaseFailure(ctx, mission, [planner], "planning");
          continue;
        }
        if ((mission.advanceLeaseUntil ?? 0) > now) continue;
        const advanceAttempt = Number(mission.advanceAttempt ?? 0) + 1;
        const advanceLeaseVersion = Number(mission.advanceLeaseVersion ?? 0) + 1;
        await patchMissionWithRuntime(ctx, mission, {
          advanceAttempt,
          advanceLeaseOwner: args.advanceLeaseOwner?.slice(0, 160),
          advanceLeaseToken: args.advanceLeaseToken?.slice(0, 240),
          advanceLeaseVersion,
          advanceLeaseHeartbeatAt: now,
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
          advanceLeaseOwner: args.advanceLeaseOwner,
          advanceLeaseToken: args.advanceLeaseToken,
          advanceLeaseVersion,
          maxBuildSessions: mission.maxBuildSessions ?? 6,
          admissionProtocolVersion: mission.admissionProtocolVersion,
          admittedProjectScopes: (mission.projectAdmissions ?? []).map((admission: ProjectSourceAdmission) =>
            admission.repository ?? "evidence"),
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
          if (await recoverGoalPhaseLeaves(ctx, mission, phaseJobs, mission.phase)) {
            return { kind: "advanced", missionId: mission._id, phase: `${mission.phase}_recovered` };
          }
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
          if (await recoverGoalPhaseLeaves(ctx, mission, [validator], "validating")) {
            return { kind: "advanced", missionId: mission._id, phase: "validation_recovered" };
          }
          await blockGoalForPhaseFailure(ctx, mission, [validator], "validating");
          continue;
        }
        if ((mission.advanceLeaseUntil ?? 0) > now) continue;
        const advanceAttempt = Number(mission.advanceAttempt ?? 0) + 1;
        const advanceLeaseVersion = Number(mission.advanceLeaseVersion ?? 0) + 1;
        await patchMissionWithRuntime(ctx, mission, {
          advanceAttempt,
          advanceLeaseOwner: args.advanceLeaseOwner?.slice(0, 160),
          advanceLeaseToken: args.advanceLeaseToken?.slice(0, 240),
          advanceLeaseVersion,
          advanceLeaseHeartbeatAt: now,
          advanceLeaseUntil: now + ADVANCE_LEASE_MS,
          updatedAt: now,
        });
        return {
          kind: "validation",
          missionId: mission._id,
          jobId: validator._id,
          result: String(validator.result ?? ""),
          expectedAdvanceAttempt: advanceAttempt,
          advanceLeaseOwner: args.advanceLeaseOwner,
          advanceLeaseToken: args.advanceLeaseToken,
          advanceLeaseVersion,
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

function planRepositories(mission: any, plan: GoalPlan, admissions: readonly ProjectSourceAdmission[]) {
  const repositoryByNode = new Map<string, string | undefined>();
  const writableRepositories = new Set<string>();
  for (const stream of plan.workstreams) {
    const requested = stream.repo || (!stream.readonly ? mission.primaryRepo || plan.primaryRepo : undefined);
    const repository = requested ? canonicalizeRepository(requested, { allowShortName: true }) ?? undefined : undefined;
    if (!stream.readonly && !repository) throw new Error(`Writable goal workstream ${stream.id} requires one canonical repository`);
    if (!admissionForRepository(admissions, repository)) {
      throw new Error(`Goal plan workstream ${stream.id} has no admitted canonical project source`);
    }
    repositoryByNode.set(stream.id, repository);
    if (!stream.readonly && repository) writableRepositories.add(repository);
  }
  return { repositoryByNode, writableRepositories };
}

// Exact pre-v2 worker contract. It can drain/park historical planning work,
// but is categorically unable to mutate an admitted v2 mission.
export const recordPlan = mutation({
  args: {
    id: v.id("missions"), expectedAdvanceAttempt: v.number(),
    advanceLeaseOwner: v.optional(v.string()), advanceLeaseToken: v.optional(v.string()),
    advanceLeaseVersion: v.optional(v.number()), plan: v.any(),
    externalRun: v.optional(v.object({ kind: v.string(), id: v.string(), slug: v.optional(v.string()) })),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    const mission: any = await ctx.db.get(args.id);
    if (!mission || mission.admissionProtocolVersion === 2) {
      return { advanced: false, stale: true, held: mission?.admissionProtocolVersion !== 2 };
    }
    if (Number(mission.advanceAttempt ?? 0) !== args.expectedAdvanceAttempt || !ownsAdvanceLease(mission, args)) {
      return { advanced: false, stale: true };
    }
    await patchMissionWithRuntime(ctx, mission, {
      status: "needs_input", phase: "protocol_hold", protocolHoldReason: "protocol_v1_worker_held",
      failureReason: "Legacy planner output held; it cannot mint v2 project or execution authority",
      advanceLeaseUntil: undefined, updatedAt: Date.now(),
    });
    await recordMissionEvent(ctx, String(mission._id), "protocol_hold",
      "Legacy planner output held without materializing work", "protocol_hold", Number(mission.percent ?? 3),
      { reason: "protocol_v1_worker_held" });
    return { advanced: false, stale: false, held: true, reason: "protocol_v1_worker_held" };
  },
});

export const admitPlanProjectsV2 = mutation({
  args: {
    id: v.id("missions"), expectedAdvanceAttempt: v.number(),
    advanceLeaseOwner: v.optional(v.string()), advanceLeaseToken: v.optional(v.string()),
    advanceLeaseVersion: v.optional(v.number()),
    projectAdmissions: v.array(projectSourceAdmissionValidator),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    const mission: any = await ctx.db.get(args.id);
    if (!mission || mission.admissionProtocolVersion !== 2 || mission.mode !== "goal"
      || mission.status !== "running" || mission.phase !== "planning"
      || Number(mission.advanceAttempt ?? 0) !== args.expectedAdvanceAttempt || !ownsAdvanceLease(mission, args)) {
      return { admitted: false, stale: true };
    }
    if (!await validProjectAdmissions(args.projectAdmissions, { requireFresh: true })) {
      throw new Error("Goal plan project extension requires fresh canonical source admissions");
    }
    const existing = (mission.projectAdmissions ?? []) as ProjectSourceAdmission[];
    if (!await validProjectAdmissions(existing)) throw new Error("Mission source admission ledger is invalid");
    const byScope = new Map(existing.map((admission) => [admission.repository ?? "evidence", admission]));
    let added = 0;
    for (const admission of args.projectAdmissions) {
      const scope = admission.repository ?? "evidence";
      const prior = byScope.get(scope);
      if (prior) {
        if (prior.sourceAdmissionDigest !== admission.sourceAdmissionDigest) {
          throw new Error(`Mission source admission for ${scope} is immutable`);
        }
        continue;
      }
      byScope.set(scope, admission);
      added += 1;
    }
    const projectAdmissions = [...byScope.values()];
    if (!await validProjectAdmissions(projectAdmissions)) throw new Error("Extended mission source admission ledger is invalid");
    if (added) await patchMissionWithRuntime(ctx, mission, { projectAdmissions, updatedAt: Date.now() });
    return { admitted: true, stale: false, added, total: projectAdmissions.length };
  },
});

export const recordPlanV2 = mutation({
  args: {
    id: v.id("missions"), expectedAdvanceAttempt: v.number(),
    advanceLeaseOwner: v.optional(v.string()), advanceLeaseToken: v.optional(v.string()),
    advanceLeaseVersion: v.optional(v.number()), plan: v.any(),
    externalRun: v.optional(v.object({ kind: v.string(), id: v.string(), slug: v.optional(v.string()) })),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    const mission: any = await ctx.db.get(args.id);
    const maxNodes = Math.min(GOAL_DAG_MAX_NODES, Number(mission?.maxBuildSessions ?? 6));
    const accepted = mission ? await acceptedPlan(args.plan as GoalPlan, maxNodes) : null;
    if (mission && mission.admissionProtocolVersion !== 2) return { advanced: false, stale: true };
    if (mission?.planDigest) {
      if (!ownsAdvanceLease(mission, args, Date.now(), false)) return { advanced: false, stale: true };
      if (!accepted || mission.planDigest !== accepted.digest) return { advanced: false, stale: true, conflict: true };
      const materializing = mission.materializationStatus !== "complete" && mission.route !== "app_factory";
      return {
        advanced: true, stale: false, replay: true, materializing,
        splitRequired: Array.isArray(mission.splitChildMissionIds) && mission.splitChildMissionIds.length > 0,
        parentMissionId: String(mission._id), planDigest: mission.planDigest,
        planGeneration: mission.planGeneration, jobs: Number(mission.materializationCursor ?? 0),
        totalJobs: Number(mission.planNodeCount ?? 0), childMissionIds: (mission.splitChildMissionIds ?? []).map(String),
      };
    }
    if (!mission || mission.admissionProtocolVersion !== 2 || mission.mode !== "goal" || mission.status !== "running" || mission.phase !== "planning"
      || Number(mission.advanceAttempt ?? 0) !== args.expectedAdvanceAttempt || !ownsAdvanceLease(mission, args)) {
      return { advanced: false, stale: true };
    }
    const { plan, digest: planDigest } = accepted!;
    const projectAdmissions = (mission.projectAdmissions ?? []) as ProjectSourceAdmission[];
    if (!await validProjectAdmissions(projectAdmissions, { requireFresh: true })) {
      throw new Error("Accepted GoalPlan requires a fresh stored canonical project admission ledger");
    }
    const planGeneration = 1;
    if (!Array.isArray(plan.workstreams) || plan.workstreams.length < 2
      || plan.workstreams.length > Number(mission.maxBuildSessions ?? 6)) {
      throw new Error("Goal plan workstream budget is invalid");
    }
    validateWorkDag(plan.workstreams, maxNodes);
    const { repositoryByNode, writableRepositories } = planRepositories(mission, plan, projectAdmissions);
    const now = Date.now();
    if (mission.planningJobId) {
      const plannerId = ctx.db.normalizeId("jobs", mission.planningJobId);
      const planner: any = plannerId ? await ctx.db.get(plannerId) : null;
      if (planner?.status === "pending" && planner.dispatchReady === true) {
        await patchJobWithRuntime(ctx, planner, { dispatchReady: false, nextRunAt: undefined });
      }
    }
    if (mission.route === "app_factory") {
      if (!args.externalRun?.id) throw new Error("App Factory route requires a live factory run");
      await patchMissionWithRuntime(ctx, mission, {
        plan, planDigest, planGeneration, planNodeCount: 0,
        materializationStatus: "complete", materializationCursor: 0, materializationCompletedAt: now,
        phase: "building", percent: 12, externalKind: args.externalRun.kind,
        externalRunId: args.externalRun.id, externalSlug: args.externalRun.slug,
        externalStatus: "queued", externalStage: "inception", externalUpdatedAt: now,
        advanceLeaseUntil: undefined, updatedAt: now,
      });
      await resolveGoalAttention(ctx, args.id);
      await recordMissionEvent(ctx, String(args.id), "goal_plan_ready", "Sol plan accepted; App Factory now owns the build lifecycle", "building", 12, {
        externalRunId: args.externalRun.id, externalSlug: args.externalRun.slug,
      });
      return { advanced: true, external: true, jobs: 0 };
    }

    const childMissionIds: any[] = [];
    if (writableRepositories.size > 1) {
      const groups = new Map<string, typeof plan.workstreams>();
      for (const stream of plan.workstreams) {
        const repository = repositoryByNode.get(stream.id);
        const key = repository ? `repo:${repository}` : "evidence:read-only";
        groups.set(key, [...(groups.get(key) ?? []), stream]);
      }
      for (const [key, streams] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
        const repository = key.startsWith("repo:") ? key.slice(5) : undefined;
        const writable = streams.some((stream) => !stream.readonly);
        const projectAdmission = admissionForRepository(projectAdmissions, repository);
        if (!projectAdmission) throw new Error(`Goal project ${repository ?? "evidence"} lost its source admission`);
        const childGoal = `${mission.goal} [${repository ? `project scope: ${repository}` : "read-only evidence"}]`;
        const childId = await insertMissionWithRuntime(ctx, {
          goal: childGoal.slice(0, 500), mode: "goal", status: "running", agentCount: streams.length,
          admissionProtocolVersion: 2,
          parentMissionId: mission._id, originThreadId: mission.originThreadId, managerAgentId: "jarvis",
          splitChildKind: writable ? "repository" : "evidence", plan, planDigest, planGeneration,
          planNodeCount: streams.length, materializationStatus: "pending", materializationCursor: 0,
          priority: mission.priority ?? 95, risk: mission.risk ?? "high", phase: "materializing", percent: 8,
          acceptanceCriteria: streams.flatMap((stream) => stream.acceptanceCriteria).slice(0, 10), route: "existing_project",
          routeReason: `Immutable executable projection of parent ${String(mission._id)}`, primaryRepo: repository,
          projectAdmissions: [projectAdmission], canonicalProjectId: projectAdmission.canonicalProjectId,
          sourceProvider: projectAdmission.sourceProvider, sourceBranch: projectAdmission.sourceBranch,
          sourceRef: projectAdmission.sourceRef, sourceHeadSha: projectAdmission.sourceHeadSha,
          sourceObservedAt: projectAdmission.sourceObservedAt, sourceAdmissionDigest: projectAdmission.sourceAdmissionDigest,
          infrastructureContext: `${mission.infrastructureContext ?? ""}\nExecute only parent plan ${planDigest} generation ${planGeneration}; ids, dependencies, scope, acceptance and consequence policy are immutable.`.trim().slice(0, 4_000),
          revisionWave: 0, maxRevisionWaves: mission.maxRevisionWaves ?? 2,
          maxBuildSessions: mission.maxBuildSessions ?? 6, advanceAttempt: 0, createdAt: now, updatedAt: now,
        });
        const integrationBranch = writable && repository ? goalBranch(childGoal, String(childId)) : undefined;
        if (integrationBranch) {
          const child: any = await ctx.db.get(childId);
          if (child) await patchMissionWithRuntime(ctx, child, { integrationBranch, integrationGeneration: 0 });
        }
        childMissionIds.push(childId);
      }
    }
    const integrationBranch = childMissionIds.length
      ? undefined
      : mission.integrationBranch || missionBranch(mission, mission.primaryRepo ?? plan.primaryRepo);
    await patchMissionWithRuntime(ctx, mission, {
      plan, planDigest, planGeneration, planNodeCount: plan.workstreams.length,
      splitChildMissionIds: childMissionIds.length ? childMissionIds : undefined,
      materializationStatus: "pending", materializationCursor: 0, materializationWaitingApprovals: 0,
      phase: "materializing", percent: 8, primaryRepo: mission.primaryRepo ?? plan.primaryRepo,
      sharedBranch: undefined, integrationBranch, integrationGeneration: 0,
      advanceLeaseUntil: undefined, updatedAt: now,
    });
    await recordMissionEvent(ctx, String(args.id), "goal_plan_materializing",
      `Accepted plan ${planDigest.slice(0, 12)}; durable DAG materialization started`, "materializing", 8, {
        planDigest, planGeneration, nodeCount: plan.workstreams.length,
        repositories: [...writableRepositories].sort(), childMissionIds: childMissionIds.map(String),
      });
    return {
      advanced: true, stale: false, materializing: true,
      splitRequired: childMissionIds.length > 0, repositories: [...writableRepositories].sort(),
      parentMissionId: String(args.id), childMissionIds: childMissionIds.map(String),
      planDigest, planGeneration, jobs: 0, totalJobs: plan.workstreams.length, waitingApprovals: 0,
    };
  },
});

export const materializePlanBatch = mutation({
  args: { id: v.id("missions"), planDigest: v.string(), workerToken: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    const mission: any = await ctx.db.get(args.id);
    if (!mission || mission.admissionProtocolVersion !== 2 || mission.mode !== "goal" || mission.planDigest !== args.planDigest
      || Number(mission.planGeneration ?? 0) !== 1 || !mission.plan) {
      return { advanced: false, stale: true };
    }
    if (mission.materializationStatus === "complete") {
      return { advanced: true, complete: true, replay: true, jobs: Number(mission.planNodeCount ?? 0) };
    }
    if (mission.phase !== "materializing" || !["pending", "running"].includes(String(mission.materializationStatus))) {
      return { advanced: false, stale: true };
    }
    const plan = canonicalGoalPlan(mission.plan as GoalPlan, Number(mission.maxBuildSessions ?? GOAL_DAG_MAX_NODES));
    validateWorkDag(plan.workstreams, Math.min(GOAL_DAG_MAX_NODES, Number(mission.maxBuildSessions ?? GOAL_DAG_MAX_NODES)));
    const admissions = mission.projectAdmissions as ProjectSourceAdmission[] | undefined;
    if (!admissions || !await validProjectAdmissions(admissions)) throw new Error("Stored GoalPlan project admission is invalid");
    const { repositoryByNode, writableRepositories } = planRepositories(mission, plan, admissions);
    const ordered = topologicalGoalWorkstreams(plan.workstreams);
    const cursor = Math.max(0, Math.min(ordered.length, Number(mission.materializationCursor ?? 0)));
    const existingNodes = await ctx.db.query("goalPlanNodes")
      .withIndex("by_parent_generation", (q: any) => q.eq("parentMissionId", mission._id).eq("planGeneration", 1))
      .take(GOAL_DAG_MAX_NODES + 1);
    if (existingNodes.length !== cursor) throw new Error("GoalPlan materialization cursor lost its immutable node ledger");
    const jobByNode = new Map(existingNodes.map((node: any) => [String(node.nodeId), String(node.jobId)]));
    const childMissions = await Promise.all((mission.splitChildMissionIds ?? []).map((id: any) => ctx.db.get(id)));
    if (childMissions.some((child) => !child || child.parentMissionId !== mission._id || child.planDigest !== mission.planDigest)) {
      throw new Error("GoalPlan project child ledger is incomplete");
    }
    const now = Date.now();
    let waitingApprovals = Number(mission.materializationWaitingApprovals ?? 0);
    const batch = ordered.slice(cursor, cursor + GOAL_MATERIALIZATION_BATCH);
    for (const stream of batch) {
      const repository = repositoryByNode.get(stream.id);
      const child: any = childMissions.length
        ? childMissions.find((candidate: any) => candidate.primaryRepo === repository
          && (repository !== undefined || candidate.splitChildKind === "evidence"))
        : mission;
      if (!child) throw new Error(`Goal workstream ${stream.id} lost its immutable project child`);
      const projectAdmission = admissionForRepository(child.projectAdmissions ?? admissions, repository);
      if (!projectAdmission) throw new Error(`Goal workstream ${stream.id} lost its stored source admission`);
      const dependencies = stream.dependsOn.map((dependency) => jobByNode.get(dependency)).filter((id): id is string => Boolean(id));
      if (dependencies.length !== stream.dependsOn.length) throw new Error(`Goal plan workstream ${stream.id} lost an executable dependency`);
      const split = child._id !== mission._id;
      const task = split ? [
        stream.task, `Original Goal Mode outcome: ${mission.goal}`,
        `Immutable parent plan: ${mission.planDigest} generation 1; node ${stream.id}.`,
        "Repository inspection may enrich context but cannot change this node id, scope, dependencies, acceptance criteria, or consequence policy.",
      ].join("\n\n") : [
        stream.task, `Goal Mode outcome: ${mission.goal}`,
        `Reuse/ownership boundary: ${mission.infrastructureContext ?? "Inspect the current project boundary before editing."}`,
        `This is Terra/high implementation session ${cursor + jobByNode.size + 1} of ${ordered.length}. Preserve completed branch work, stay inside this workstream, and leave a compact evidence-rich checkpoint for the final Sol validator.`,
      ].join("\n\n");
      const id = await insertGoalJob(ctx, {
        task, policyTask: stream.task, missionId: String(child._id), label: stream.label,
        repo: repository, readonly: stream.readonly, model: "terra", reasoningEffort: "high", mcp: stream.mcp,
        originThreadId: mission.originThreadId, agentId: stream.agentId, risk: "high", priority: 92,
        acceptanceCriteria: stream.acceptanceCriteria,
        modelReason: split
          ? "Goal Mode executes the accepted parent DAG node without child replanning"
          : "Goal Mode builder sessions use Terra/high for maximum implementation per token",
        dependsOn: dependencies, integrationBranch: repository && !stream.readonly ? child.integrationBranch : undefined,
        maxAttempts: 24, goalStage: "building", goalWorkstreamId: stream.id, goalWave: 0,
        planParentMissionId: mission._id, planDigest: mission.planDigest, planGeneration: 1, planNodeId: stream.id,
        dispatchReady: dependencies.length === 0,
      });
      const row: any = await ctx.db.get(id);
      if (row?.status === "awaiting_approval") waitingApprovals += 1;
      jobByNode.set(stream.id, String(id));
      await ctx.db.insert("goalPlanNodes", {
        parentMissionId: mission._id, planDigest: mission.planDigest, planGeneration: 1, nodeId: stream.id,
        childMissionId: child._id, jobId: id, label: stream.label, agentId: stream.agentId,
        repository, readonly: stream.readonly, dependencyCount: stream.dependsOn.length,
        weight: Math.max(1, stream.acceptanceCriteria.length), createdAt: now,
      });
      for (const dependency of stream.dependsOn) {
        await ctx.db.insert("goalPlanEdges", {
          parentMissionId: mission._id, planDigest: mission.planDigest, planGeneration: 1,
          edgeId: goalDagEdgeId(dependency, stream.id), sourceNodeId: dependency, targetNodeId: stream.id,
          sourceJobId: ctx.db.normalizeId("jobs", jobByNode.get(dependency)!)!, targetJobId: id, createdAt: now,
        });
      }
    }
    const nextCursor = cursor + batch.length;
    const complete = nextCursor === ordered.length;
    if (!complete) {
      await patchMissionWithRuntime(ctx, mission, {
        materializationStatus: "running", materializationCursor: nextCursor,
        materializationWaitingApprovals: waitingApprovals, percent: Math.max(8, Math.floor(8 + (nextCursor / ordered.length) * 3)),
        updatedAt: now,
      });
      return { advanced: true, complete: false, jobs: nextCursor, totalJobs: ordered.length, waitingApprovals };
    }
    for (const child of childMissions as any[]) {
      await patchMissionWithRuntime(ctx, child, {
        phase: "building", percent: 12, materializationStatus: "complete",
        materializationCursor: Number(child.planNodeCount ?? 0), materializationCompletedAt: now, updatedAt: now,
      });
    }
    const splitRequired = childMissions.length > 0;
    await patchMissionWithRuntime(ctx, mission, {
      status: splitRequired ? "split" : "running", phase: splitRequired ? "split" : "building", percent: 12,
      materializationStatus: "complete", materializationCursor: nextCursor,
      materializationWaitingApprovals: waitingApprovals, materializationCompletedAt: now,
      summary: splitRequired
        ? `${ordered.length} immutable DAG nodes projected into ${childMissions.length} bounded children`
        : mission.summary,
      agentCount: splitRequired ? mission.agentCount : 1 + ordered.length, updatedAt: now,
    });
    await resolveGoalAttention(ctx, mission._id);
    await recordMissionEvent(ctx, String(mission._id), splitRequired ? "goal_split" : "goal_plan_ready",
      splitRequired
        ? `Accepted plan ${mission.planDigest.slice(0, 12)} projected without replanning`
        : `Sol plan accepted; ${ordered.length} Terra/high sessions queued`,
      splitRequired ? "split" : "building", 12, {
        planDigest: mission.planDigest, planGeneration: 1, nodeCount: ordered.length,
        edgeCount: plan.workstreams.reduce((sum, stream) => sum + stream.dependsOn.length, 0),
        repositories: [...writableRepositories].sort(), childMissionIds: childMissions.map((child: any) => String(child._id)),
        waitingApprovals, integrationBranch: mission.integrationBranch,
      });
    return {
      advanced: true, complete: true, materializing: false, splitRequired,
      code: splitRequired ? "WRITABLE_REPOSITORY_SPLIT_REQUIRED" : undefined,
      repositories: [...writableRepositories].sort(), parentMissionId: String(mission._id),
      childMissionIds: childMissions.map((child: any) => String(child._id)),
      planDigest: mission.planDigest, planGeneration: 1, jobs: nextCursor, waitingApprovals,
    };
  },
});

// Compact bounded fleet/UI projection. Full plans, prompts, reviews, terminal
// receipts and artifacts stay cold and no heartbeat writes this graph.
export const dagProjection = query({
  args: { id: v.id("missions"), ...viewerAuthArgs },
  handler: async (ctx, args) => {
    await requireViewer(ctx, args);
    const mission: any = await ctx.db.get(args.id);
    if (!mission?.planDigest || !mission.planGeneration) return null;
    const [nodes, handoffs] = await Promise.all([
      ctx.db.query("goalPlanNodes").withIndex("by_parent_generation", (q: any) =>
        q.eq("parentMissionId", mission._id).eq("planGeneration", Number(mission.planGeneration))).take(GOAL_DAG_MAX_NODES + 1),
      ctx.db.query("goalHandoffs").withIndex("by_parent_generation", (q: any) =>
        q.eq("parentMissionId", mission._id).eq("planGeneration", Number(mission.planGeneration))).take(GOAL_DAG_MAX_NODES + 1),
    ]);
    if (nodes.length > GOAL_DAG_MAX_NODES || handoffs.length > GOAL_DAG_MAX_NODES) throw new Error("Goal DAG projection exceeds its hot-data bound");
    const activities = await Promise.all(nodes.map((node: any) => ctx.db.query("jobRuntime")
      .withIndex("by_job", (q: any) => q.eq("jobId", node.jobId)).first()));
    const validHandoffs = new Set(handoffs.filter((handoff: any) => {
      const activity = activities.find((row: any) => row?.jobId === handoff.sourceJobId);
      return activity && handoff.handoffProtocolVersion === 2
        && typeof handoff.handoffPayloadDigest === "string" && typeof handoff.workReceiptDigest === "string"
        && handoff.planDigest === mission.planDigest
        && Number(handoff.sourceAttempt) === Number(activity.attempt ?? 1)
        && Number(handoff.sourceSteerRevision) === Number(activity.steerRevision ?? 0);
    }).map((handoff: any) => String(handoff.sourceJobId)));
    return {
      missionId: String(mission._id), planDigest: mission.planDigest, planGeneration: mission.planGeneration,
      nodeCount: nodes.length, maxNodes: GOAL_DAG_MAX_NODES,
      nodes: nodes.map((node: any, index: number) => {
        const activity: any = activities[index];
        const dependencies = activity?.dependsOn ?? [];
        const attention = Boolean(activity && (["awaiting_approval", "needs_input", "error", "cancelled", "stalled"].includes(activity.status)
          || activity.integrationState === "needs_attention"));
        return {
          id: node.nodeId, label: node.label, agent: node.agentId, repository: node.repository ?? null,
          status: activity?.status ?? "missing", dependencyCount: node.dependencyCount,
          dependenciesSatisfied: dependencies.filter((id: string) => validHandoffs.has(String(id))).length,
          progress: Math.max(0, Math.min(100, Number(activity?.percent ?? 0))),
          progressText: String(activity?.progress ?? "").slice(0, 160), attention,
        };
      }),
    };
  },
});

export const rejectAdvance = mutation({
  args: {
    id: v.id("missions"),
    jobId: v.id("jobs"),
    expectedAdvanceAttempt: v.number(),
    advanceLeaseOwner: v.optional(v.string()),
    advanceLeaseToken: v.optional(v.string()),
    advanceLeaseVersion: v.optional(v.number()),
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
      !ownsAdvanceLease(mission, args) ||
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
    await ensureWorkAttempt(ctx, job, nextAttempt, "pending", now, { parentAttempt: Number(job.attempt ?? 1) });
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
    advanceLeaseOwner: v.optional(v.string()),
    advanceLeaseToken: v.optional(v.string()),
    advanceLeaseVersion: v.optional(v.number()),
    error: v.string(),
    delayMs: v.optional(v.number()),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    const mission = await ctx.db.get(args.id);
    if (!mission || mission.mode !== "goal" || Number(mission.advanceAttempt ?? 0) !== args.expectedAdvanceAttempt || !ownsAdvanceLease(mission, args)) return false;
    const delay = Math.max(10_000, Math.min(30 * 60_000, args.delayMs ?? 60_000));
    await patchMissionWithRuntime(ctx, mission, {
      advanceLeaseUntil: Date.now() + delay,
      advanceLeaseHeartbeatAt: Date.now(),
      failureReason: `Temporary Goal Mode integration error: ${args.error.slice(0, 800)}`,
      updatedAt: Date.now(),
    });
    return true;
  },
});

// Renewal deliberately accepts no model output. A long parse, provider poll,
// or idempotent external create therefore keeps the exact claim alive even
// while it has nothing new to report. Late writers are fenced by the version.
export const renewAdvance = mutation({
  args: {
    id: v.id("missions"),
    expectedAdvanceAttempt: v.number(),
    advanceLeaseOwner: v.string(),
    advanceLeaseToken: v.string(),
    advanceLeaseVersion: v.number(),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    const mission = await ctx.db.get(args.id);
    const now = Date.now();
    if (!mission || mission.mode !== "goal" || Number(mission.advanceAttempt ?? 0) !== args.expectedAdvanceAttempt || !ownsAdvanceLease(mission, args, now)) {
      return false;
    }
    await patchMissionWithRuntime(ctx, mission, {
      advanceLeaseUntil: now + ADVANCE_LEASE_MS,
      advanceLeaseHeartbeatAt: now,
      updatedAt: now,
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
    advanceLeaseOwner: v.optional(v.string()),
    advanceLeaseToken: v.optional(v.string()),
    advanceLeaseVersion: v.optional(v.number()),
    validation: v.any(),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    const mission = await ctx.db.get(args.id);
    if (
      !mission || mission.mode !== "goal" || mission.status !== "running" || mission.phase !== "validating" ||
      Number(mission.advanceAttempt ?? 0) !== args.expectedAdvanceAttempt || !ownsAdvanceLease(mission, args)
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
    if (Array.isArray(mission.splitChildMissionIds) && mission.splitChildMissionIds.length) {
      const reason = validation.verdict === "blocked"
        ? validation.blocker || validation.summary
        : `Parent Sol validation did not prove the original accepted plan: ${validation.gaps.join("; ") || validation.summary}`;
      await patchMissionWithRuntime(ctx, mission, {
        status: "needs_input", phase: "needs Daniel", pausedPhase: "validating",
        validation, validationHistory: history, failureReason: reason.slice(0, 2_000),
        advanceLeaseUntil: undefined, updatedAt: now,
      });
      await upsertGoalAttention(ctx, mission, reason);
      await recordMissionEvent(ctx, String(args.id), "goal_parent_validation_failed",
        reason, "needs Daniel", mission.percent, { planDigest: mission.planDigest, planGeneration: mission.planGeneration });
      return { advanced: true, status: "needs_input", reason };
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

async function resetGoalJob(ctx: any, job: any, now: number, force = false, extendAttemptBudget = true) {
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
      authorityDigest: prior.authorityDigest,
      schedulingBindingDigest: prior.schedulingBindingDigest,
      workOrderRevisionId: prior.workOrderRevisionId,
      workOrderRevision: prior.workOrderRevision,
      workOrderRevisionDigest: prior.workOrderRevisionDigest,
      canonicalProjectId: prior.canonicalProjectId,
      repository: prior.repository,
      missionGroupId: prior.missionGroupId,
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
    maxAttempts: extendAttemptBudget
      ? Math.min(48, Math.max(Number(job.maxAttempts ?? 12), nextAttempt + 4))
      : Number(job.maxAttempts ?? 12),
    approvalStatus: awaitingApproval ? "pending" : job.approvalStatus,
    completedAt: undefined,
    startedAt: undefined,
    heartbeatAt: now,
    nextRunAt: awaitingApproval ? undefined : now,
    verificationVerdict: undefined,
    verificationNote: undefined,
    verifiedAt: undefined,
  });
  await ensureWorkAttempt(ctx, job, nextAttempt, awaitingApproval ? "awaiting_approval" : "pending", now, {
    parentAttempt: Number(job.attempt ?? 1),
  });
  return true;
}

function goalSteeringRevision(job: any, steer: string) {
  const policyTask = exactTextWorkOrder(`${String(job.policyTask ?? job.task)}\n\nDaniel steering instruction:\n${steer}`);
  const goalStage = ["planning", "building", "validating", "refining"].includes(String(job.goalStage))
    ? job.goalStage as GoalJobInput["goalStage"]
    : "building";
  const approval = goalWorkApprovalPolicy({
    task: policyTask,
    repo: job.repo,
    readonly: job.readonly,
    risk: job.risk,
    approvalRequired: job.approvalRequired,
    goalStage,
  });
  return {
    changes: {
      steer,
      policyTask,
      approvalRequired: approval.required,
      approvalReason: approval.reason,
      deliveryMode: approval.deliveryMode,
      risk: approval.required ? "consequential" : String(job.risk ?? "high"),
    },
    approval,
  };
}

async function ensureGoalSteeringApproval(ctx: any, job: any, steer: string, now: number) {
  if (!job.approvalRequired) return;
  const approvals = await ctx.db.query("approvals")
    .withIndex("by_job", (q: any) => q.eq("jobId", String(job._id))).take(20);
  if (approvals.some((approval: any) => approval.status === "pending")) return;
  await ctx.db.insert("approvals", {
    jobId: String(job._id), kind: "goal-mode-steering",
    summary: (job.label || job.task).slice(0, 240), risk: job.risk ?? "consequential",
    payload: { repo: job.repo, agentId: job.agentId, reason: job.approvalReason, steer: steer.slice(0, 500) },
    status: "pending", requestedAt: now,
  });
}

// A worker crash, stale provider result, or lost Trigger wake is not an
// operator decision. Recover bounded terminal leaves in place and preserve
// independent siblings; only an exhausted leaf can turn the parent into a
// genuine attention state. Manual resume still uses resetGoalJob's extensible
// budget, while autonomous recovery cannot grow its own retry ceiling.
async function recoverGoalPhaseLeaves(ctx: any, mission: any, phaseJobs: any[], phase: string) {
  const now = Date.now();
  const candidates = phaseJobs.filter((job: any) => ["error", "cancelled", "needs_input"].includes(job.status));
  const recoverable = candidates.filter((job: any) => Number(job.attempt ?? 1) < Number(job.maxAttempts ?? 12));
  if (!recoverable.length) return false;
  const recovered: string[] = [];
  for (const job of recoverable) {
    if (await resetGoalJob(ctx, job, now, true, false)) recovered.push(String(job._id));
  }
  if (!recovered.length) return false;
  await patchMissionWithRuntime(ctx, mission, {
    status: "running", phase, pausedPhase: undefined, failureReason: undefined,
    advanceLeaseUntil: undefined, advanceLeaseOwner: undefined, advanceLeaseToken: undefined,
    advanceLeaseHeartbeatAt: undefined, updatedAt: now,
  });
  await resolveGoalAttention(ctx, mission._id);
  await recordMissionEvent(ctx, String(mission._id), "goal_leaf_recovered",
    `Recovered ${recovered.length} terminal Goal Mode ${recovered.length === 1 ? "leaf" : "leaves"} without pausing independent siblings`,
    phase, mission.percent, { jobIds: recovered, phase });
  return true;
}

export const control = mutation({
  args: {
    id: v.id("missions"),
    action: v.union(v.literal("pause"), v.literal("resume"), v.literal("cancel"), v.literal("steer")),
    input: v.optional(v.string()),
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
      if (mission.planDigest && mission.planGeneration) {
        if (mission.status === "done") return false;
        if (mission.status === "cancelled") return args.action === "cancel";
        const nodes = await ctx.db.query("goalPlanNodes")
          .withIndex("by_parent_generation", (q: any) => q.eq("parentMissionId", mission._id)
            .eq("planGeneration", Number(mission.planGeneration))).take(GOAL_DAG_MAX_NODES + 1);
        if (nodes.length !== Number(mission.planNodeCount ?? 0) || nodes.length > GOAL_DAG_MAX_NODES) return false;
        const nodeJobs: any[] = await Promise.all(nodes.map((node: any) => ctx.db.get(node.jobId)));
        if (nodeJobs.some((job) => !job)) return false;
        if (mission.validatorJobId) {
          const validatorId = ctx.db.normalizeId("jobs", mission.validatorJobId);
          const validator: any = validatorId ? await ctx.db.get(validatorId) : null;
          if (validator && !nodeJobs.some((job) => job._id === validator._id)) nodeJobs.push(validator);
        }
        if (args.action === "steer") {
          const steer = String(args.input ?? "").trim().slice(0, 2_000);
          if (!steer) return false;
          if (mission.steer === steer && Number(mission.steerRevision ?? 0) > 0) return true;
          let reconciliationPending = false;
          for (const job of nodeJobs) {
            if (["done", "error", "cancelled"].includes(job.status)) continue;
            const integrationControl = await controlIntegrationForJob(ctx, job, "steer");
            reconciliationPending ||= Boolean(integrationControl?.reconcile);
            const current: any = await ctx.db.get(job._id);
            if (!current) return false;
            const jobSteerRevision = Number(current.steerRevision ?? 0) + 1;
            const revision = goalSteeringRevision(current, steer);
            const steerPatch = {
              steerRevision: jobSteerRevision,
              checkpoint: `${current.checkpoint ?? ""}\n\nDaniel steering instruction:\n${steer}`.trim().slice(-6_000),
              progress: "Split-parent steering preserved this node scope and queued a fresh execution generation",
            };
            if (integrationControl?.reconcile) {
              await stageJobWorkOrderRevision(ctx, current, revision.changes);
              await patchJobWithRuntime(ctx, current, steerPatch);
            } else {
              const attemptLookup = await readExactWorkAttempt(
                ctx,
                current._id,
                Number(current.attempt ?? 1),
              );
              if (attemptLookup.kind === "ambiguous") return false;
              const attempt = attemptLookup.kind === "exact"
                ? attemptLookup.attempt
                : null;
              // Steering an admitted but never-dispatched node revises the
              // sealed work order in place; it cannot manufacture a spent
              // execution generation. Once a worker lineage exists, steering
              // closes it and allocates the next immutable attempt.
              const nextAttempt = Number(current.attempt ?? 1) + (attempt ? 1 : 0);
              if (nextAttempt > Number(current.maxAttempts ?? 12)) return false;
              if (attempt && !attempt.completedAt) await ctx.db.patch(attempt._id, {
                status: "steered", completedAt: now, dispatchId: undefined, lastEventAt: now,
              });
              const activeDelivery: any = current.activeDeliveryAttemptId ? await ctx.db.get(current.activeDeliveryAttemptId) : null;
              if (activeDelivery && !["done", "blocked", "abandoned"].includes(activeDelivery.status)) {
                await ctx.db.patch(activeDelivery._id, {
                  status: "abandoned", outcome: "stale", currentStep: "terminal",
                  retryReason: "superseded by parent mission steering", completedAt: now,
                  leaseOwner: undefined, leaseToken: undefined, leaseUntil: undefined,
                  heartbeatAt: now, updatedAt: now,
                });
              }
              const revised = await transitionJobWorkOrderRevision(ctx, current, revision.changes, {
                ...steerPatch,
                status: revision.approval.required ? "awaiting_approval" : "pending",
                approvalStatus: revision.approval.required ? "pending" : undefined,
                stage: revision.approval.required ? "approval" : "queued", attempt: nextAttempt,
                startedAt: undefined, completedAt: undefined, heartbeatAt: now, progressAt: now,
                nextRunAt: revision.approval.required ? undefined : now,
                dispatchId: undefined, dispatchLeaseUntil: undefined, workerRunId: undefined, workerRuntime: undefined,
                providerRunState: undefined, providerObservedAt: undefined,
                deliveryLeaseVersion: Math.max(0, Number(current.deliveryLeaseVersion ?? 0)) + 1,
                deliveryLeaseOwner: undefined, deliveryLeaseToken: undefined, deliveryLeaseUntil: undefined,
                deliveryRunId: undefined, activeDeliveryAttemptId: undefined, deliveryGeneration: undefined,
                integrationAttemptId: undefined, integrationState: undefined,
                reviewReceiptId: undefined, reviewReceiptDigest: undefined, reviewReceiptSignature: undefined,
                verificationVerdict: undefined, verificationNote: undefined, verifiedAt: undefined,
              });
              if (attempt) await ensureWorkAttempt(ctx, revised, nextAttempt,
                revision.approval.required ? "awaiting_approval" : "pending", now, {
                  parentAttempt: Number(current.attempt ?? 1),
                  parentCheckpointHeadSha: attempt.checkpointHeadSha,
                });
              await ensureGoalSteeringApproval(ctx, revised, steer, now);
            }
          }
          await patchMissionWithRuntime(ctx, mission, {
            steer, steerRevision: Number(mission.steerRevision ?? 0) + 1,
            controlRequested: reconciliationPending ? "steer" : undefined,
            controlRequestedAt: reconciliationPending ? now : undefined, updatedAt: now,
          });
          await recordMissionEvent(ctx, String(mission._id), "goal_split_steer",
            "Split-parent steering reached every unfinished immutable node", "steering", mission.percent,
            { planDigest: mission.planDigest, planGeneration: mission.planGeneration, reconciliationPending });
          return true;
        }
        if ((args.action === "pause" && mission.status === "paused")
          || (args.action === "resume" && (mission.status === "split" || (mission.status === "running" && mission.phase === "validating")))
          || (args.action === "cancel" && mission.status === "cancelled")) return true;
        let reconciliationPending = false;
        for (const job of nodeJobs) {
          if (args.action === "resume") {
            const retryCompletedValidator = String(job._id) === mission.validatorJobId && mission.status === "needs_input" && job.status === "done";
            if (["paused", "error", "needs_input"].includes(job.status) || retryCompletedValidator) {
              await resetGoalJob(ctx, job, now, job.status === "needs_input" || retryCompletedValidator);
            }
            continue;
          }
          const result = await controlIntegrationForJob(ctx, job, args.action);
          reconciliationPending ||= Boolean(result?.reconcile);
          const current: any = await ctx.db.get(job._id);
          if (!current || current.integrationState === `${args.action}_requested` || TERMINAL.has(current.status)) continue;
          await patchJobWithRuntime(ctx, current, args.action === "pause" ? {
            status: "paused", stage: "paused", progress: "split parent paused", nextRunAt: undefined,
          } : {
            status: "cancelled", stage: "cancelled", progress: "split parent cancelled", completedAt: now, nextRunAt: undefined,
          });
        }
        for (const childId of mission.splitChildMissionIds.slice(0, GOAL_DAG_MAX_NODES)) {
          const child: any = await ctx.db.get(childId);
          if (!child || child.parentMissionId !== mission._id || child.planDigest !== mission.planDigest) return false;
          if (child.status === "done") continue;
          await patchMissionWithRuntime(ctx, child, args.action === "resume" ? {
            status: "running", phase: "building", pausedPhase: undefined, failureReason: undefined, updatedAt: now,
          } : reconciliationPending ? {
            controlRequested: args.action, controlRequestedAt: now, pausedPhase: child.phase, updatedAt: now,
          } : args.action === "pause" ? {
            status: "paused", phase: "paused", pausedPhase: "building", updatedAt: now,
          } : { status: "cancelled", phase: "cancelled", completedAt: now, updatedAt: now });
        }
        await patchMissionWithRuntime(ctx, mission, args.action === "resume" ? {
          status: mission.pausedPhase === "validating" ? "running" : "split",
          phase: mission.pausedPhase === "validating" ? "validating" : "split", pausedPhase: undefined, controlRequested: undefined,
          controlRequestedAt: undefined, failureReason: undefined, updatedAt: now,
        } : reconciliationPending ? {
          status: "split", phase: "split", controlRequested: args.action, controlRequestedAt: now,
          pausedPhase: "split", updatedAt: now,
        } : args.action === "pause" ? {
          status: "paused", phase: "paused", pausedPhase: mission.phase === "validating" ? "validating" : "split", updatedAt: now,
        } : { status: "cancelled", phase: "cancelled", completedAt: now, updatedAt: now });
        await recordMissionEvent(ctx, String(mission._id), `goal_split_${args.action}`,
          `Split parent ${args.action} applied to ${nodeJobs.length} immutable nodes`, args.action, mission.percent,
          { planDigest: mission.planDigest, planGeneration: mission.planGeneration, reconciliationPending });
        return true;
      }
      if (args.action === "steer") return false;
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
        let resetJob = job;
        if (phase === "validating") {
          const nextTask = (await validatorTaskForMission(ctx, mission, jobs)).slice(0, GOAL_VALIDATOR_TASK_MAX_CHARS);
          resetJob = await transitionJobWorkOrderRevision(ctx, job, { task: nextTask, policyTask: nextTask });
        }
        if (!(await resetGoalJob(ctx, resetJob, now, true))) return false;
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
