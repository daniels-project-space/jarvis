import { mutation, query, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import {
  dispatcherAuthArgs,
  requireDispatcher,
  requireWorker,
} from "./controlAuth";
import {
  insertMissionWithRuntime,
  patchMissionWithRuntime,
} from "./controlPlane";
import {
  projectSourceAdmissionValidator,
  validProjectAdmissions,
} from "./sourceAdmission";
import {
  sha256Hex,
  type ProjectSourceAdmission,
} from "../src/lib/source-admission";
import { canonicalizeRepository } from "../src/lib/workflow-contract";

export const MISSION_SUPERVISOR_LEASE_MS = 10 * 60_000;
export const MISSION_SUPERVISOR_MAX_JOBS = 24;
export const MISSION_SUPERVISOR_MAX_DECISIONS = 64;
export const MISSION_SUPERVISOR_MAX_DUE = 8;

const REQUEST_PAYLOAD_MAX_BYTES = 16 * 1024;
const SNAPSHOT_MAX_BYTES = 96 * 1024;
const DEFAULT_DEADLINE_MS = 7 * 24 * 60 * 60_000;
const MIN_DEADLINE_MS = 10 * 60_000;
const MAX_DEADLINE_MS = 30 * 24 * 60 * 60_000;
const FAILURE_ESCALATION_COUNT = 5;
const FAILURE_BACKOFF_BASE_MS = 30_000;
const FAILURE_BACKOFF_MAX_MS = 15 * 60_000;
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
const SAFE_LEASE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._~:/+=-]{15,239}$/;
const SAFE_ERROR_CODE = /^[a-z][a-z0-9_:-]{0,79}$/;

const profileValidator = v.union(
  v.literal("short_fleet"),
  v.literal("durable_goal"),
);
const modelTierValidator = v.union(
  v.literal("luna"),
  v.literal("terra"),
  v.literal("sol"),
);
const agentValidator = v.union(
  v.literal("paul"),
  v.literal("atlas"),
  v.literal("iris"),
  v.literal("maya"),
  v.literal("sentry"),
);
const riskValidator = v.union(
  v.literal("low"),
  v.literal("medium"),
  v.literal("high"),
  v.literal("consequential"),
);
const requestedWorkstreamValidator = v.object({
  task: v.string(),
  label: v.optional(v.string()),
  repo: v.optional(v.string()),
  model: v.optional(modelTierValidator),
  agentId: v.optional(agentValidator),
  readonly: v.optional(v.boolean()),
  approvalRequired: v.optional(v.boolean()),
  risk: v.optional(riskValidator),
  acceptanceCriteria: v.optional(v.array(v.string())),
});

type MissionSupervisorState = Doc<"missionSupervisorState">;
type Mission = Doc<"missions">;
type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

type RequestedWorkstreamInput = {
  task: string;
  label?: string;
  repo?: string;
  model?: "luna" | "terra" | "sol";
  agentId?: "paul" | "atlas" | "iris" | "maya" | "sentry";
  readonly?: boolean;
  approvalRequired?: boolean;
  risk?: "low" | "medium" | "high" | "consequential";
  acceptanceCriteria?: string[];
};

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function boundedText(
  value: string,
  field: string,
  minimumBytes: number,
  maximumBytes: number,
): string {
  const normalized = value.trim();
  const bytes = utf8Bytes(normalized);
  if (bytes < minimumBytes || bytes > maximumBytes) {
    throw new Error(`${field} must be between ${minimumBytes} and ${maximumBytes} UTF-8 bytes`);
  }
  return normalized;
}

function optionalBoundedText(
  value: string | undefined,
  field: string,
  maximumBytes: number,
  minimumBytes = 1,
): string | undefined {
  if (value === undefined) return undefined;
  return boundedText(value, field, minimumBytes, maximumBytes);
}

function boundedInteger(
  value: number | undefined,
  field: string,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return normalized;
}

function boundedCriteria(
  value: readonly string[] | undefined,
  field: string,
  maximumItems: number,
): string[] {
  if (value === undefined) return [];
  if (value.length > maximumItems) {
    throw new Error(`${field} may contain at most ${maximumItems} items`);
  }
  const normalized = value.map((item, index) =>
    boundedText(item, `${field}[${index}]`, 1, 500)
  );
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${field} contains duplicate items`);
  }
  return normalized;
}

function canonicalRepository(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  const bounded = boundedText(value, field, 1, 120);
  const repository = canonicalizeRepository(bounded, { allowShortName: true }) ?? undefined;
  if (!repository) throw new Error(`${field} must be a canonical admitted repository`);
  return repository;
}

function normalizeWorkstreams(
  workstreams: readonly RequestedWorkstreamInput[] | undefined,
): Array<{
  task: string;
  label?: string;
  repo?: string;
  model?: "luna" | "terra" | "sol";
  agentId?: "paul" | "atlas" | "iris" | "maya" | "sentry";
  readonly?: boolean;
  approvalRequired?: boolean;
  risk?: "low" | "medium" | "high" | "consequential";
  acceptanceCriteria: string[];
}> {
  if (workstreams === undefined) return [];
  if (workstreams.length > 6) {
    throw new Error("requestedWorkstreams may contain at most 6 items");
  }
  return workstreams.map((workstream, index) => {
    const acceptanceCriteria = boundedCriteria(
      workstream.acceptanceCriteria,
      `requestedWorkstreams[${index}].acceptanceCriteria`,
      8,
    );
    if (acceptanceCriteria.length === 0) {
      throw new Error(
        `requestedWorkstreams[${index}].acceptanceCriteria must contain at least 1 item`,
      );
    }
    return {
      task: boundedText(
        workstream.task,
        `requestedWorkstreams[${index}].task`,
        12,
        4_000,
      ),
      label: optionalBoundedText(
        workstream.label,
        `requestedWorkstreams[${index}].label`,
        80,
        3,
      ),
      repo: canonicalRepository(
        workstream.repo,
        `requestedWorkstreams[${index}].repo`,
      ),
      model: workstream.model,
      agentId: workstream.agentId,
      readonly: workstream.readonly,
      approvalRequired: workstream.approvalRequired,
      risk: workstream.risk,
      acceptanceCriteria,
    };
  });
}

function sortedAdmissions(
  admissions: readonly ProjectSourceAdmission[],
): ProjectSourceAdmission[] {
  return admissions
    .map((admission) => ({ ...admission }))
    .sort((left, right) =>
      (left.repository ?? "evidence").localeCompare(right.repository ?? "evidence")
    );
}

function canonicalJson(value: unknown): string {
  const counter = { nodes: 0 };
  const encode = (item: unknown, depth: number): string => {
    counter.nodes += 1;
    if (counter.nodes > 4_096 || depth > 16) {
      throw new Error("Canonical payload exceeds structural bounds");
    }
    if (item === null) return "null";
    if (typeof item === "string" || typeof item === "boolean") {
      return JSON.stringify(item);
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new Error("Canonical payload contains a non-finite number");
      return JSON.stringify(item);
    }
    if (Array.isArray(item)) {
      return `[${item.map((entry) => {
        if (entry === undefined) throw new Error("Canonical arrays may not contain undefined");
        return encode(entry, depth + 1);
      }).join(",")}]`;
    }
    if (typeof item === "object") {
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error("Canonical payload must contain plain objects only");
      }
      const record = item as Record<string, unknown>;
      const members = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${encode(record[key], depth + 1)}`);
      return `{${members.join(",")}}`;
    }
    throw new Error("Canonical payload contains an unsupported value");
  };
  return encode(value, 0);
}

function normalizedStartRequest(args: {
  requestKey: string;
  goal: string;
  profile?: "short_fleet" | "durable_goal";
  context?: string;
  repo?: string;
  desiredWorkstreams?: number;
  requestedWorkstreams?: RequestedWorkstreamInput[];
  acceptanceCriteria?: string[];
  projectAdmissions: ProjectSourceAdmission[];
  originThreadId?: string;
  priority?: number;
  risk?: "low" | "medium" | "high" | "consequential";
  deadlineMs?: number;
}) {
  const requestKey = boundedText(args.requestKey, "requestKey", 1, 160);
  if (!SAFE_KEY.test(requestKey)) throw new Error("requestKey has an invalid format");
  const goal = boundedText(args.goal, "goal", 12, 500);
  const profile = args.profile ?? "short_fleet";
  const context = optionalBoundedText(args.context, "context", 8_000);
  const repo = canonicalRepository(args.repo, "repo");
  const requestedWorkstreams = normalizeWorkstreams(args.requestedWorkstreams);
  const minimumDesiredWorkstreams = profile === "durable_goal" ? 2 : 1;
  const desiredWorkstreams = boundedInteger(
    args.desiredWorkstreams,
    "desiredWorkstreams",
    minimumDesiredWorkstreams,
    6,
    Math.max(minimumDesiredWorkstreams, requestedWorkstreams.length),
  );
  const acceptanceCriteria = boundedCriteria(
    args.acceptanceCriteria,
    "acceptanceCriteria",
    8,
  );
  const projectAdmissions = sortedAdmissions(args.projectAdmissions);
  const originThreadId =
    optionalBoundedText(args.originThreadId, "originThreadId", 120) ?? "main";
  const priority = boundedInteger(args.priority, "priority", 0, 100, 50);
  const risk = args.risk ?? "low";
  const deadlineMs = boundedInteger(
    args.deadlineMs,
    "deadlineMs",
    MIN_DEADLINE_MS,
    MAX_DEADLINE_MS,
    DEFAULT_DEADLINE_MS,
  );
  const payload = {
    protocolVersion: 1,
    goal,
    profile,
    context,
    repo,
    desiredWorkstreams,
    requestedWorkstreams,
    acceptanceCriteria,
    projectAdmissions,
    originThreadId,
    priority,
    risk,
    deadlineMs,
  };
  const requestPayloadJson = canonicalJson(payload);
  if (utf8Bytes(requestPayloadJson) > REQUEST_PAYLOAD_MAX_BYTES) {
    throw new Error(`Canonical request payload exceeds ${REQUEST_PAYLOAD_MAX_BYTES} UTF-8 bytes`);
  }
  return {
    requestKey,
    payload,
    requestPayloadJson,
  };
}

async function stateForMission(
  ctx: Pick<MutationCtx, "db">,
  missionId: Id<"missions">,
): Promise<MissionSupervisorState | null> {
  const rows = await ctx.db
    .query("missionSupervisorState")
    .withIndex("by_mission", (q) => q.eq("missionId", missionId))
    .take(2);
  if (rows.length > 1) throw new Error("Mission supervisor state is not unique");
  return rows[0] ?? null;
}

function validFenceInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
}

function validateLeaseIdentity(owner: string, token: string): void {
  if (!SAFE_KEY.test(owner)) throw new Error("leaseOwner has an invalid format");
  if (!SAFE_LEASE_TOKEN.test(token)) throw new Error("leaseToken has an invalid format");
}

function clearLease() {
  return {
    leaseOwner: undefined,
    leaseToken: undefined,
    leaseHeartbeatAt: undefined,
    leaseUntil: undefined,
  };
}

function isDue(state: MissionSupervisorState, now: number): boolean {
  if (state.state === "ready" || state.state === "waiting") {
    return typeof state.nextTickAt === "number" && state.nextTickAt <= now;
  }
  return state.state === "leased"
    && typeof state.leaseUntil === "number"
    && state.leaseUntil <= now;
}

function excerpt(value: unknown, maximum: number): string | null {
  return typeof value === "string" ? value.slice(0, maximum) : null;
}

async function snapshotJob(job: Doc<"jobs">): Promise<JsonValue> {
  const task = String(job.task ?? "");
  const result = typeof job.result === "string" ? job.result : undefined;
  const criteria = Array.isArray(job.acceptanceCriteria)
    ? job.acceptanceCriteria.map(String)
    : [];
  const dependsOn = Array.isArray(job.dependsOn)
    ? job.dependsOn.map(String).sort()
    : [];
  const steer = typeof job.steer === "string" ? job.steer : undefined;
  const evidenceSummary =
    typeof job.evidenceSummary === "string" ? job.evidenceSummary : undefined;
  return {
    jobId: String(job._id),
    supervisorEpoch: job.supervisorEpoch ?? null,
    supervisorDecisionKey: job.supervisorDecisionKey ?? null,
    supervisorJobOrdinal: job.supervisorJobOrdinal ?? null,
    label: excerpt(job.label, 80),
    task: task.slice(0, 600),
    taskDigest: await sha256Hex(task),
    repo: excerpt(job.repo, 120),
    status: String(job.status),
    readonly: job.readonly ?? null,
    agentId: excerpt(job.agentId, 40),
    model: excerpt(job.model, 24),
    reasoningEffort: excerpt(job.reasoningEffort, 24),
    risk: excerpt(job.risk, 24),
    priority: typeof job.priority === "number" ? job.priority : null,
    approvalRequired: job.approvalRequired ?? null,
    approvalStatus: excerpt(job.approvalStatus, 32),
    approvalReason: excerpt(job.approvalReason, 300),
    attempt: job.attempt ?? 1,
    maxAttempts: job.maxAttempts ?? 1,
    steer: steer?.slice(0, 500) ?? null,
    steerDigest: steer ? await sha256Hex(steer) : null,
    steerRevision: job.steerRevision ?? 0,
    dependsOn: dependsOn.slice(0, 16),
    dependsOnDigest: await sha256Hex(canonicalJson(dependsOn)),
    acceptanceCriteria: criteria.slice(0, 8).map((item) => item.slice(0, 500)),
    acceptanceCriteriaDigest: await sha256Hex(canonicalJson(criteria)),
    workOrderRevision: job.workOrderRevision ?? null,
    workOrderRevisionDigest: excerpt(job.workOrderRevisionDigest, 64),
    schedulingBindingDigest: excerpt(job.schedulingBindingDigest, 64),
    sourceAdmissionDigest: excerpt(job.sourceAdmissionDigest, 64),
    sourceHeadSha: excerpt(job.sourceHeadSha, 80),
    integrationState: excerpt(job.integrationState, 40),
    deliveryStatus: excerpt(job.deliveryStatus, 32),
    reviewReceiptDigest: excerpt(job.reviewReceiptDigest, 64),
    result: result?.slice(0, 2_000) ?? null,
    resultDigest: result ? await sha256Hex(result) : null,
    verificationVerdict: excerpt(job.verificationVerdict, 32),
    verificationNote: excerpt(job.verificationNote, 500),
    evidenceSummary: evidenceSummary?.slice(0, 500) ?? null,
    evidenceSummaryDigest: evidenceSummary
      ? await sha256Hex(evidenceSummary)
      : null,
    stallReason: job.status === "stalled" ? excerpt(job.stallReason, 400) : null,
    completedAt: job.completedAt ?? null,
  };
}

async function authoritativeSnapshot(
  mission: Mission,
  state: MissionSupervisorState,
  jobs: Doc<"jobs">[],
): Promise<{ snapshot: JsonValue; snapshotJson: string; snapshotDigest: string }> {
  const missionCriteria = Array.isArray(mission.acceptanceCriteria)
    ? mission.acceptanceCriteria.map(String)
    : [];
  const missionSteer = typeof mission.steer === "string" ? mission.steer : undefined;
  const failureReason =
    typeof mission.failureReason === "string" ? mission.failureReason : undefined;
  const jobSnapshots = await Promise.all(
    [...jobs]
      .sort((left, right) => String(left._id).localeCompare(String(right._id)))
      .map(snapshotJob),
  );
  const snapshot: JsonValue = {
    protocolVersion: 1,
    mission: {
      missionId: String(mission._id),
      goal: mission.goal,
      mode: mission.mode ?? null,
      status: mission.status,
      originThreadId: mission.originThreadId ?? "main",
      priority: mission.priority ?? 50,
      risk: mission.risk ?? "low",
      acceptanceCriteria: missionCriteria.slice(0, 8).map((item) =>
        item.slice(0, 500)
      ),
      acceptanceCriteriaDigest: await sha256Hex(canonicalJson(missionCriteria)),
      projectAdmissions: sortedAdmissions(mission.projectAdmissions ?? []),
      controlRequested: mission.controlRequested ?? null,
      steer: missionSteer?.slice(0, 2_000) ?? null,
      steerDigest: missionSteer ? await sha256Hex(missionSteer) : null,
      steerRevision: mission.steerRevision ?? 0,
      failureReason: failureReason?.slice(0, 600) ?? null,
      failureReasonDigest: failureReason ? await sha256Hex(failureReason) : null,
    },
    supervisor: {
      requestDigest: state.requestDigest,
      requestPayloadJson: state.requestPayloadJson,
      epoch: state.epoch,
      nextDecisionSequence: state.nextDecisionSequence,
      inputRevision: state.inputRevision,
      handledInputRevision: state.handledInputRevision,
      dirtyJobIds: [...state.dirtyJobIds].map(String).sort(),
      totalJobs: state.totalJobs,
      maxJobs: state.maxJobs,
      decisionCount: state.decisionCount,
      maxDecisions: state.maxDecisions,
      deadlineAt: state.deadlineAt,
      lastDecisionKey: state.lastDecisionKey ?? null,
      lastDecisionDigest: state.lastDecisionDigest ?? null,
    },
    jobs: jobSnapshots,
  };
  const snapshotJson = canonicalJson(snapshot);
  if (utf8Bytes(snapshotJson) > SNAPSHOT_MAX_BYTES) {
    throw new Error("supervisor_snapshot_too_large");
  }
  return {
    snapshot,
    snapshotJson,
    snapshotDigest: await sha256Hex(snapshotJson),
  };
}

async function upsertSupervisorAttention(
  ctx: Pick<MutationCtx, "db">,
  mission: Mission,
  code: string,
  failures: number,
  detail: string,
  now: number,
) {
  const fingerprint = `mission-supervisor:${String(mission._id)}:needs-input`;
  const existing = await ctx.db
    .query("attentionItems")
    .withIndex("by_fingerprint", (q) => q.eq("fingerprint", fingerprint))
    .first();
  const value = {
    fingerprint,
    project: mission.primaryRepo,
    title: `Supervisor needs input · ${mission.goal.slice(0, 96)}`,
    detail: detail.slice(0, 2_000),
    evidence: [code, `failures:${failures}`],
    severity: failures >= FAILURE_ESCALATION_COUNT ? "high" : "medium",
    impact: Math.min(100, 55 + failures * 8),
    urgency: Math.min(100, 50 + failures * 10),
    confidence: 1,
    actionClass: "ask",
    authority: "mission-supervisor",
    status: "open",
    updatedAt: now,
  };
  if (existing) {
    await ctx.db.patch(existing._id, value);
    return existing._id;
  }
  return await ctx.db.insert("attentionItems", { ...value, createdAt: now });
}

async function holdMissionForInput(
  ctx: MutationCtx,
  state: MissionSupervisorState,
  mission: Mission,
  code: string,
  detail: string,
  failures: number,
  now: number,
) {
  const attentionItemId = await upsertSupervisorAttention(
    ctx,
    mission,
    code,
    failures,
    detail,
    now,
  );
  await ctx.db.patch(state._id, {
    state: "needs_input",
    nextTickAt: undefined,
    ...clearLease(),
    consecutiveFailures: failures,
    lastErrorCode: code,
    lastErrorAt: now,
    updatedAt: now,
  });
  await patchMissionWithRuntime(ctx, mission, {
    status: "needs_input",
    phase: "needs_input",
    failureReason: detail.slice(0, 600),
    updatedAt: now,
  });
  return attentionItemId;
}

export const startV1 = mutation({
  args: {
    requestKey: v.string(),
    goal: v.string(),
    profile: v.optional(profileValidator),
    context: v.optional(v.string()),
    repo: v.optional(v.string()),
    desiredWorkstreams: v.optional(v.number()),
    requestedWorkstreams: v.optional(v.array(requestedWorkstreamValidator)),
    acceptanceCriteria: v.optional(v.array(v.string())),
    projectAdmissions: v.array(projectSourceAdmissionValidator),
    originThreadId: v.optional(v.string()),
    priority: v.optional(v.number()),
    risk: v.optional(riskValidator),
    deadlineMs: v.optional(v.number()),
    ...dispatcherAuthArgs,
  },
  handler: async (ctx, args) => {
    await requireDispatcher(ctx, args);
    const normalized = normalizedStartRequest(args);
    const requestDigest = await sha256Hex(normalized.requestPayloadJson);
    const prior = await ctx.db
      .query("missionSupervisorState")
      .withIndex("by_request", (q) =>
        q.eq("requestKey", normalized.requestKey)
      )
      .take(2);
    if (prior.length > 1) throw new Error("Supervisor request key is not unique");
    if (prior[0]) {
      if (prior[0].requestDigest !== requestDigest) {
        throw new Error("Supervisor request key conflicts with a different payload");
      }
      const mission = await ctx.db.get(prior[0].missionId);
      if (!mission || mission.mode !== "supervised") {
        throw new Error("Supervisor request replay references invalid authority");
      }
      return {
        replayed: true,
        missionId: prior[0].missionId,
        stateId: prior[0]._id,
        requestDigest,
        deadlineAt: prior[0].deadlineAt,
      };
    }

    if (!await validProjectAdmissions(normalized.payload.projectAdmissions, {
      requireFresh: true,
    })) {
      throw new Error("Supervisor mission requires fresh canonical project admissions");
    }
    const admittedRepositories = new Set(
      normalized.payload.projectAdmissions
        .map((admission) => admission.repository)
        .filter((repository): repository is string => typeof repository === "string"),
    );
    const requestedRepositories = [
      normalized.payload.repo,
      ...normalized.payload.requestedWorkstreams.map((workstream) => workstream.repo),
    ].filter((repository): repository is string => typeof repository === "string");
    if (requestedRepositories.some((repository) => !admittedRepositories.has(repository))) {
      throw new Error("Supervisor request references a repository outside its project admissions");
    }

    const now = Date.now();
    const primaryAdmission = normalized.payload.repo
      ? normalized.payload.projectAdmissions.find((admission) =>
          admission.repository === normalized.payload.repo
        )
      : normalized.payload.projectAdmissions.length === 1
        ? normalized.payload.projectAdmissions[0]
        : undefined;
    const missionId = await insertMissionWithRuntime(ctx, {
      goal: normalized.payload.goal,
      admissionProtocolVersion: 2,
      mode: "supervised",
      status: "running",
      agentCount: 0,
      originThreadId: normalized.payload.originThreadId,
      managerAgentId: "jarvis",
      priority: normalized.payload.priority,
      risk: normalized.payload.risk,
      phase: "supervising",
      percent: 0,
      acceptanceCriteria: normalized.payload.acceptanceCriteria,
      projectAdmissions: normalized.payload.projectAdmissions,
      canonicalProjectId: primaryAdmission?.canonicalProjectId,
      primaryRepo: primaryAdmission?.repository,
      sourceProvider: primaryAdmission?.sourceProvider,
      sourceBranch: primaryAdmission?.sourceBranch,
      sourceRef: primaryAdmission?.sourceRef,
      sourceHeadSha: primaryAdmission?.sourceHeadSha,
      sourceObservedAt: primaryAdmission?.sourceObservedAt,
      sourceAdmissionDigest: primaryAdmission?.sourceAdmissionDigest,
      createdAt: now,
      updatedAt: now,
    });
    const deadlineAt = now + normalized.payload.deadlineMs;
    const stateId = await ctx.db.insert("missionSupervisorState", {
      protocolVersion: 1,
      missionId,
      requestKey: normalized.requestKey,
      requestDigest,
      requestPayloadJson: normalized.requestPayloadJson,
      state: "ready",
      epoch: 1,
      nextDecisionSequence: 1,
      inputRevision: 1,
      handledInputRevision: 0,
      dirtyJobIds: [],
      nextTickAt: now,
      leaseVersion: 0,
      totalJobs: 0,
      maxJobs: MISSION_SUPERVISOR_MAX_JOBS,
      decisionCount: 0,
      maxDecisions: MISSION_SUPERVISOR_MAX_DECISIONS,
      deadlineAt,
      consecutiveFailures: 0,
      createdAt: now,
      updatedAt: now,
    });
    return {
      replayed: false,
      missionId,
      stateId,
      requestDigest,
      deadlineAt,
    };
  },
});

export const dueV1 = query({
  args: {
    limit: v.optional(v.number()),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    const limit = boundedInteger(
      args.limit,
      "limit",
      1,
      MISSION_SUPERVISOR_MAX_DUE,
      MISSION_SUPERVISOR_MAX_DUE,
    );
    const now = Date.now();
    const [ready, waiting, expired] = await Promise.all([
      ctx.db
        .query("missionSupervisorState")
        .withIndex("by_state_due", (q) =>
          q.eq("state", "ready").gt("nextTickAt", 0).lte("nextTickAt", now)
        )
        .order("asc")
        .take(limit),
      ctx.db
        .query("missionSupervisorState")
        .withIndex("by_state_due", (q) =>
          q.eq("state", "waiting").gt("nextTickAt", 0).lte("nextTickAt", now)
        )
        .order("asc")
        .take(limit),
      ctx.db
        .query("missionSupervisorState")
        .withIndex("by_state_lease", (q) =>
          q.eq("state", "leased").gt("leaseUntil", 0).lte("leaseUntil", now)
        )
        .order("asc")
        .take(limit),
    ]);
    return [...ready, ...waiting, ...expired]
      .sort((left, right) => {
        const leftDue =
          left.state === "leased" ? left.leaseUntil ?? 0 : left.nextTickAt ?? 0;
        const rightDue =
          right.state === "leased" ? right.leaseUntil ?? 0 : right.nextTickAt ?? 0;
        return leftDue - rightDue
          || String(left.missionId).localeCompare(String(right.missionId));
      })
      .slice(0, limit)
      .map((state) => ({
        missionId: state.missionId,
        state: state.state,
        epoch: state.epoch,
        nextDecisionSequence: state.nextDecisionSequence,
        inputRevision: state.inputRevision,
        expectedLeaseVersion: state.leaseVersion,
        nextTickAt: state.nextTickAt,
        leaseUntil: state.leaseUntil,
      }));
  },
});

export const claimV1 = mutation({
  args: {
    missionId: v.id("missions"),
    leaseOwner: v.string(),
    leaseToken: v.string(),
    expectedLeaseVersion: v.number(),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    validateLeaseIdentity(args.leaseOwner, args.leaseToken);
    validFenceInteger(args.expectedLeaseVersion, "expectedLeaseVersion");
    const state = await stateForMission(ctx, args.missionId);
    if (!state) return { claimed: false as const, reason: "missing_state" };
    if (state.leaseVersion !== args.expectedLeaseVersion) {
      return { claimed: false as const, reason: "lease_version_mismatch" };
    }
    const now = Date.now();
    if (!isDue(state, now)) {
      return { claimed: false as const, reason: "not_due" };
    }
    const mission = await ctx.db.get(args.missionId);
    if (!mission || mission.mode !== "supervised") {
      return { claimed: false as const, reason: "invalid_mission" };
    }
    if (mission.status !== "running") {
      return { claimed: false as const, reason: "mission_not_running" };
    }
    if (state.deadlineAt <= now || state.decisionCount >= state.maxDecisions) {
      const code = state.deadlineAt <= now
        ? "supervisor_deadline_reached"
        : "supervisor_decision_limit";
      const detail = state.deadlineAt <= now
        ? "The supervised mission reached its bounded deadline and needs Daniel to continue or stop it."
        : "The supervised mission exhausted its bounded decision budget and needs Daniel to choose the next step.";
      const attentionItemId = await holdMissionForInput(
        ctx,
        state,
        mission,
        code,
        detail,
        state.consecutiveFailures,
        now,
      );
      return {
        claimed: false as const,
        reason: code,
        escalated: true,
        attentionItemId,
      };
    }

    const jobs = await ctx.db
      .query("jobs")
      .withIndex("by_mission", (q) => q.eq("missionId", String(args.missionId)))
      .take(MISSION_SUPERVISOR_MAX_JOBS + 1);
    if (jobs.length > MISSION_SUPERVISOR_MAX_JOBS || jobs.length > state.maxJobs) {
      const attentionItemId = await holdMissionForInput(
        ctx,
        state,
        mission,
        "supervisor_job_limit",
        "The supervised mission contains more jobs than its bounded authority permits.",
        state.consecutiveFailures,
        now,
      );
      return {
        claimed: false as const,
        reason: "supervisor_job_limit",
        escalated: true,
        attentionItemId,
      };
    }

    let snapshotResult;
    try {
      snapshotResult = await authoritativeSnapshot(mission, state, jobs);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "supervisor_snapshot_too_large") {
        throw error;
      }
      const attentionItemId = await holdMissionForInput(
        ctx,
        state,
        mission,
        "supervisor_snapshot_too_large",
        "The mission snapshot exceeded its bounded supervisor envelope and needs a narrower scope.",
        state.consecutiveFailures,
        now,
      );
      return {
        claimed: false as const,
        reason: "supervisor_snapshot_too_large",
        escalated: true,
        attentionItemId,
      };
    }

    const leaseVersion = state.leaseVersion + 1;
    const leaseUntil = now + MISSION_SUPERVISOR_LEASE_MS;
    await ctx.db.patch(state._id, {
      state: "leased",
      nextTickAt: undefined,
      leaseOwner: args.leaseOwner,
      leaseToken: args.leaseToken,
      leaseVersion,
      leaseHeartbeatAt: now,
      leaseUntil,
      lastSnapshotDigest: snapshotResult.snapshotDigest,
      updatedAt: now,
    });
    return {
      claimed: true as const,
      missionId: args.missionId,
      epoch: state.epoch,
      nextDecisionSequence: state.nextDecisionSequence,
      inputRevision: state.inputRevision,
      leaseVersion,
      leaseUntil,
      snapshot: snapshotResult.snapshot,
      snapshotDigest: snapshotResult.snapshotDigest,
    };
  },
});

const leaseFenceArgs = {
  missionId: v.id("missions"),
  leaseOwner: v.string(),
  leaseToken: v.string(),
  leaseVersion: v.number(),
  expectedEpoch: v.number(),
  expectedDecisionSequence: v.number(),
  expectedInputRevision: v.number(),
  workerToken: v.optional(v.string()),
};

function validateLeaseFenceInput(args: {
  leaseOwner: string;
  leaseToken: string;
  leaseVersion: number;
  expectedEpoch: number;
  expectedDecisionSequence: number;
  expectedInputRevision: number;
}) {
  validateLeaseIdentity(args.leaseOwner, args.leaseToken);
  validFenceInteger(args.leaseVersion, "leaseVersion");
  validFenceInteger(args.expectedEpoch, "expectedEpoch");
  validFenceInteger(args.expectedDecisionSequence, "expectedDecisionSequence");
  validFenceInteger(args.expectedInputRevision, "expectedInputRevision");
}

function leaseFenceMatches(
  state: MissionSupervisorState,
  args: {
    leaseOwner: string;
    leaseToken: string;
    leaseVersion: number;
    expectedEpoch: number;
    expectedDecisionSequence: number;
  },
): boolean {
  return state.state === "leased"
    && state.leaseOwner === args.leaseOwner
    && state.leaseToken === args.leaseToken
    && state.leaseVersion === args.leaseVersion
    && state.epoch === args.expectedEpoch
    && state.nextDecisionSequence === args.expectedDecisionSequence;
}

export const renewV1 = mutation({
  args: leaseFenceArgs,
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    validateLeaseFenceInput(args);
    const state = await stateForMission(ctx, args.missionId);
    if (!state) return { renewed: false as const, reason: "missing_state" };
    if (!leaseFenceMatches(state, args)) {
      return { renewed: false as const, reason: "fence_mismatch" };
    }
    const now = Date.now();
    if (state.inputRevision !== args.expectedInputRevision) {
      await ctx.db.patch(state._id, {
        state: "ready",
        nextTickAt: now,
        ...clearLease(),
        updatedAt: now,
      });
      return {
        renewed: false as const,
        reason: "input_revision_changed",
        stale: true,
        released: true,
        inputRevision: state.inputRevision,
      };
    }
    if ((state.leaseUntil ?? 0) <= now) {
      return { renewed: false as const, reason: "lease_expired" };
    }
    if (state.deadlineAt <= now) {
      await ctx.db.patch(state._id, {
        state: "ready",
        nextTickAt: now,
        ...clearLease(),
        updatedAt: now,
      });
      return {
        renewed: false as const,
        reason: "deadline_reached",
        stale: true,
        released: true,
        inputRevision: state.inputRevision,
      };
    }
    const leaseUntil = now + MISSION_SUPERVISOR_LEASE_MS;
    await ctx.db.patch(state._id, {
      leaseHeartbeatAt: now,
      leaseUntil,
      updatedAt: now,
    });
    return {
      renewed: true as const,
      leaseVersion: state.leaseVersion,
      leaseUntil,
      inputRevision: state.inputRevision,
    };
  },
});

export const releaseFailureV1 = mutation({
  args: {
    ...leaseFenceArgs,
    errorCode: v.string(),
  },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    validateLeaseFenceInput(args);
    if (!SAFE_ERROR_CODE.test(args.errorCode)) {
      throw new Error("errorCode must be a redacted lower-case code of at most 80 characters");
    }
    const state = await stateForMission(ctx, args.missionId);
    if (!state) return { released: false as const, reason: "missing_state" };
    if (!leaseFenceMatches(state, args)) {
      return { released: false as const, reason: "fence_mismatch" };
    }
    const now = Date.now();
    if (state.inputRevision !== args.expectedInputRevision) {
      await ctx.db.patch(state._id, {
        state: "ready",
        nextTickAt: now,
        ...clearLease(),
        updatedAt: now,
      });
      return {
        released: true as const,
        stale: true,
        escalated: false,
        reason: "input_revision_changed",
        inputRevision: state.inputRevision,
      };
    }
    const mission = await ctx.db.get(args.missionId);
    if (!mission || mission.mode !== "supervised") {
      return { released: false as const, reason: "invalid_mission" };
    }
    const failures = state.consecutiveFailures + 1;
    const escalated =
      failures >= FAILURE_ESCALATION_COUNT || state.deadlineAt <= now;
    if (escalated) {
      const detail = state.deadlineAt <= now
        ? `Supervisor stopped at its bounded deadline after ${failures} failure(s) (${args.errorCode}).`
        : `Supervisor paused after ${failures} consecutive bounded failures (${args.errorCode}).`;
      const attentionItemId = await holdMissionForInput(
        ctx,
        state,
        mission,
        args.errorCode,
        detail,
        failures,
        now,
      );
      return {
        released: true as const,
        stale: false,
        escalated: true,
        failures,
        errorCode: args.errorCode,
        attentionItemId,
      };
    }
    const exponent = Math.min(10, Math.max(0, failures - 1));
    const backoffMs = Math.min(
      FAILURE_BACKOFF_MAX_MS,
      FAILURE_BACKOFF_BASE_MS * (2 ** exponent),
    );
    const nextTickAt = now + backoffMs;
    await ctx.db.patch(state._id, {
      state: "waiting",
      nextTickAt,
      ...clearLease(),
      consecutiveFailures: failures,
      lastErrorCode: args.errorCode,
      lastErrorAt: now,
      updatedAt: now,
    });
    return {
      released: true as const,
      stale: false,
      escalated: false,
      failures,
      errorCode: args.errorCode,
      backoffMs,
      nextTickAt,
    };
  },
});
