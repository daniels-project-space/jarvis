import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { isResumeOnlyUntouchedGoalJob } from "../src/lib/goal-job-lifecycle";
import { workApprovalPolicy } from "./workPolicy";
import { classifyWorkSafety, isOwnedRepository } from "../src/lib/work-safety";
import { requireActor, requireDispatcher, requireViewer, requireWorker, viewerAuthArgs } from "./controlAuth";
import { buildContinuationCheckpoint } from "../src/lib/work-checkpoint";
import { normalizeWorkModelTier } from "../src/lib/work-models";
import { canonicalizeRepository } from "../src/lib/workflow-contract";
import { goalJobMatchesMissionPhase } from "../src/lib/goal-mode";
import { redactSensitiveText } from "../src/lib/secret-redaction";
import { hasAttemptBudget, isMeaningfulWorkProgress } from "../src/lib/work-attempt";
import { claimDisposition, completionReceiptAllowed, isSha256Digest, replayEnvelope, shouldAdvanceAttempt } from "../src/lib/durable-attempt-protocol";
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
// A live process that cannot produce a causal stage/percentage advance is not
// healthy work. Keep this comfortably above a normal Codex tool segment while
// still surfacing a genuinely stuck attempt before its lease disappears.
const STALLED_PROGRESS_MS = 20 * 60 * 1000;
const DISPATCH_LEASE_MS = 2 * 60 * 1000;
const DELIVERY_LEASE_MS = 45_000;
const REVIEW_RECEIPT_MAX_CHARS = 300_000;

async function sha256Hex(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function invalidateDeliveryLease(row: any) {
  return {
    deliveryLeaseVersion: Math.max(0, Number(row.deliveryLeaseVersion ?? 0)) + 1,
    deliveryLeaseOwner: undefined,
    deliveryLeaseToken: undefined,
    deliveryLeaseUntil: undefined,
  };
}

function hasLiveDeliveryLease(row: any, a: any, now = Date.now()) {
  return typeof a.deliveryLeaseOwner === "string"
    && typeof a.deliveryLeaseToken === "string"
    && a.deliveryLeaseOwner === row.deliveryLeaseOwner
    && a.deliveryLeaseToken === row.deliveryLeaseToken
    && Number(a.deliveryLeaseVersion) === Number(row.deliveryLeaseVersion)
    && Number(row.deliveryLeaseUntil ?? 0) >= now;
}

async function attemptFor(ctx: any, jobId: any, attempt: number) {
  return await ctx.db
    .query("workAttempts")
    .withIndex("by_job_attempt", (q: any) => q.eq("jobId", jobId).eq("attempt", attempt))
    .first();
}

async function deliveryAttemptFor(ctx: any, jobId: any, sourceWorkAttempt: number, generation: number) {
  return await ctx.db.query("deliveryAttempts")
    .withIndex("by_job_source_generation", (q: any) => q.eq("jobId", jobId).eq("sourceWorkAttempt", sourceWorkAttempt).eq("generation", generation))
    .first();
}

function deliveryClaimMatches(row: any, attempt: any, a: any) {
  return Boolean(attempt
    && (!row.activeDeliveryAttemptId || String(row.activeDeliveryAttemptId) === String(attempt._id))
    && (a.deliveryAttemptId === undefined || String(a.deliveryAttemptId) === String(attempt._id))
    && Number(a.sourceWorkAttempt) === Number(attempt.sourceWorkAttempt)
    && Number(a.deliveryGeneration) === Number(attempt.generation)
    && typeof a.deliveryRunId === "string" && a.deliveryRunId === attempt.deliveryRunId
    && row.deliveryRunId === attempt.deliveryRunId
    && Number(row.deliveryGeneration ?? 0) === Number(attempt.generation));
}

function eventIdentity(value: unknown) {
  // Event keys are replay identifiers, not evidence digests or a security
  // boundary. Completion evidence is SHA-256 computed by the controller.
  let hash = 2166136261;
  for (const char of String(value)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(36);
}

async function appendAttemptEvidence(ctx: any, row: any, type: string, message: string, options: {
  stage?: string;
  percent?: number;
  evidenceKind?: string;
  causationId?: string;
  data?: unknown;
  eventKey?: string;
  attempt?: number;
} = {}) {
  // Mutations are serialized by Convex, but callers can hold a deliberately
  // stale job object after a state transition. Read the authority row here so
  // one job-wide cursor, rather than a per-attempt counter, orders every
  // queue/launch/control/terminal event.
  const durable = await ctx.db.get(row._id) ?? row;
  const attemptNumber = options.attempt ?? row.attempt ?? 1;
  const causationId = options.causationId ?? `attempt:${String(row._id)}:${attemptNumber}`;
  const eventKey = options.eventKey ?? `${attemptNumber}:${type}:${eventIdentity(`${causationId}|${message}|${JSON.stringify(options.data ?? null)}`)}`;
  const existing = await ctx.db
    .query("workEvents")
    .withIndex("by_job_event", (q: any) => q.eq("jobId", String(row._id)).eq("eventKey", eventKey))
    .first();
  if (existing) return existing._id;
  const attempt = await attemptFor(ctx, row._id, attemptNumber);
  const sequence = Number(durable.lifecycleSequence ?? 0) + 1;
  const predecessorKey = durable.lifecycleEventKey;
  const id = await ctx.db.insert("workEvents", {
    jobId: String(row._id),
    missionId: row.missionId,
    agentId: row.agentId,
    type,
    message: message.slice(0, 1200),
    stage: options.stage,
    percent: options.percent,
    attempt: attemptNumber,
    causationId,
    evidenceKind: options.evidenceKind ?? "lifecycle",
    data: options.data,
    eventKey,
    sequence,
    predecessorKey,
    createdAt: Date.now(),
  });
  await ctx.db.patch(row._id, { lifecycleSequence: sequence, lifecycleEventKey: eventKey });
  if (attempt) await ctx.db.patch(attempt._id, { lastEventSeq: sequence, lastEventKey: eventKey, lastEventAt: Date.now() });
  return id;
}

async function ensureAttempt(ctx: any, jobId: any, attempt: number, status: string, now: number, patch: Record<string, unknown> = {}) {
  const existing = await attemptFor(ctx, jobId, attempt);
  if (existing) return existing;
  const id = await ctx.db.insert("workAttempts", {
    jobId, attempt, status, lastEventSeq: 0,
    livenessAt: now, progressAt: now, lastEventAt: now, createdAt: now, ...patch,
  });
  return { _id: id, jobId, attempt, status, ...patch };
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
    const repo = input.repo === undefined ? undefined : canonicalizeRepository(input.repo, { allowShortName: true }) ?? undefined;
    if (input.repo !== undefined && !repo) {
      throw new Error("Repository must be an owner/repo slug or credential-free https://github.com/owner/repo(.git) URL");
    }
    const normalizedInput = { ...input, repo };
    const approval = workApprovalPolicy(normalizedInput);
    const approvalRequired = approval.required;
    const status = approvalRequired ? "awaiting_approval" : "pending";
    const id = await insertJobWithRuntime(ctx, {
      ...normalizedInput,
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
      progressAt: now,
      stallCount: 0,
      steerRevision: 0,
      attempt: 1,
      maxAttempts: Math.max(1, Math.min(48, input.maxAttempts ?? 12)),
      nextRunAt: now,
      createdAt: now,
    });
    const queued = await ctx.db.get(id);
    // This early lifecycle row is the serialized cursor for queue, dispatch,
    // launch and terminal events. Provider identities are bound later.
    await ctx.db.insert("workAttempts", {
      jobId: id, attempt: 1, status, lastEventSeq: 0,
      livenessAt: now, progressAt: now, lastEventAt: now, createdAt: now,
    });
    if (queued) await appendAttemptEvidence(ctx, queued, approvalRequired ? "approval_requested" : "queued",
      approvalRequired ? `Waiting for Daniel's approval${approval.reason ? ` · ${approval.reason}` : ""}` : "Work queued",
      { stage: approvalRequired ? "approval" : "queued", percent: 0, evidenceKind: "intent", eventKey: `intent:${String(id)}` });
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

// v1 completed in production before active/priority became a required live
// projection. Never reuse its completed cursor: v2 deliberately reprojects
// every durable job and is the only gate for retiring compatibility reads.
const CONTROL_PLANE_MIGRATION = "active-projection-v2";

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
    // v1 placed the full review patch on the hot jobs document. Re-home only
    // structurally complete legacy receipts into the immutable cold table;
    // malformed values stay unavailable rather than becoming delivery proof.
    if (row.repo && row.reviewReceiptJson && row.reviewReceiptSignature && !row.reviewReceiptId) {
      try {
        const receipt = JSON.parse(row.reviewReceiptJson);
        // Never truncate signed JSON: a truncated document is neither valid
        // JSON nor the document its digest/signature describe.
        if (String(row.reviewReceiptJson).length > REVIEW_RECEIPT_MAX_CHARS) throw new Error("legacy receipt exceeds limit");
        const receiptJson = String(row.reviewReceiptJson);
        const digest = await sha256Hex(receiptJson);
        if (receipt?.jobId === String(row._id) && Number(receipt?.attempt) === (row.attempt ?? 1)
          && receipt?.repository === row.repo && isSha256Digest(row.reviewReceiptSignature)
          && isSha256Digest(receipt?.diffSha256) && isSha256Digest(receipt?.agentEvidenceSha256)) {
          const existingReceipt = await ctx.db.query("reviewReceipts")
            .withIndex("by_job_attempt_digest", (q: any) => q.eq("jobId", row._id).eq("attempt", row.attempt ?? 1).eq("receiptDigest", digest)).first();
          const reviewReceiptId = existingReceipt?._id ?? await ctx.db.insert("reviewReceipts", {
            jobId: row._id, attempt: row.attempt ?? 1, repository: row.repo, receiptJson, receiptDigest: digest,
            signature: row.reviewReceiptSignature, diffSha256: receipt.diffSha256,
            baseSha: String(receipt.baseSha ?? ""), headSha: String(receipt.headSha ?? ""), baseTreeSha: String(receipt.baseTreeSha ?? ""), headTreeSha: String(receipt.headTreeSha ?? ""),
            agentEvidenceSha256: receipt.agentEvidenceSha256, createdAt: now,
          });
          await ctx.db.patch(row._id, { reviewReceiptId, reviewReceiptDigest: digest, reviewReceiptJson: undefined });
          row.reviewReceiptId = reviewReceiptId; row.reviewReceiptDigest = digest; row.reviewReceiptJson = undefined;
        }
      } catch { /* fail closed; a malformed old row is not a review receipt */ }
    }
    // Old rows can already contain append-only evidence. Seed the job-wide
    // cursor from it so rollout never restarts causal numbering at one.
    // The sequence index finds the real durable maximum even for an old job
    // with more than one migration-page worth of audit events.
    const newest = await ctx.db.query("workEvents")
      .withIndex("by_job_sequence", (q: any) => q.eq("jobId", String(row._id)))
      .order("desc").first();
    if (newest && Number(row.lifecycleSequence ?? 0) < Number(newest.sequence ?? 0)) {
      await ctx.db.patch(row._id, { lifecycleSequence: Number(newest.sequence ?? 0), lifecycleEventKey: newest.eventKey });
      row.lifecycleSequence = Number(newest.sequence ?? 0);
      row.lifecycleEventKey = newest.eventKey;
    }
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
      await appendAttemptEvidence(ctx, row, "autonomy_reconciled", "Legacy software-delivery approval removed; verified delivery is automatic", {
        stage: "queued", percent: row.percent ?? 0, evidenceKind: "reconcile", eventKey: `autonomy-reconciled:${row.attempt ?? 1}`,
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

function claimedJob(j: any, upstreamEvidence: readonly any[] = []) {
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
    sourceWorkAttempt: j.attempt ?? 1,
    deliveryGeneration: j.deliveryGeneration ?? null,
    deliveryRunId: j.deliveryRunId ?? null,
    activeDeliveryAttemptId: j.activeDeliveryAttemptId ?? null,
    verificationVerdict: j.verificationVerdict ?? null,
    verificationNote: j.verificationNote ?? null,
    reviewReceiptId: j.reviewReceiptId ?? null,
    reviewReceiptDigest: j.reviewReceiptDigest ?? null,
    reviewReceiptSignature: j.reviewReceiptSignature ?? null,
    acceptanceCriteria: j.acceptanceCriteria ?? [],
    modelReason: j.modelReason ?? null,
    parentJobId: j.parentJobId ?? null,
    goalStage: j.goalStage ?? null,
    goalWorkstreamId: j.goalWorkstreamId ?? null,
    goalWave: j.goalWave ?? 0,
    steer: j.steer ?? null,
    steerRevision: j.steerRevision ?? 0,
    upstreamEvidence,
  };
}

async function upstreamEvidenceForClaim(ctx: any, j: any) {
  // Dependencies are an explicit contract, not an invitation to read all
  // mission siblings. Preserve declared order so the claim snapshot is stable.
  const upstreamRows = await Promise.all((j.dependsOn ?? []).slice(0, 8).map(async (dependency: string) => {
    const id = ctx.db.normalizeId("jobs", dependency);
    return id ? await ctx.db.get(id) : null;
  }));
  return upstreamRows
    .filter((row: any) => row && row._id !== j._id && row.status === "done" && String(row.result ?? "").trim())
    .map((row: any) => ({
      label: String(row.label ?? row.task ?? "Upstream workstream").slice(0, 120), status: row.status,
      result: String(row.result).slice(0, 1_400), verificationNote: String(row.verificationNote ?? "").slice(0, 300),
    }));
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
      let attemptNumber = j.attempt ?? 1;
      let attempt = await attemptFor(ctx, j._id, attemptNumber);
      // A malformed/legacy pending row may still point at a launched worker.
      // Never overwrite that binding into an unclaimable reservation: close
      // it first, record its terminal lineage, then reserve a fresh attempt.
      const deliveryContinuation = j.verificationVerdict === "pass" && Boolean(j.reviewReceiptId);
      if (attempt?.workerRunId && !deliveryContinuation) {
        if (!hasAttemptBudget(attemptNumber + 1, j.maxAttempts ?? 12)) continue;
        await ctx.db.patch(attempt._id, { status: "checkpointed", completedAt: now, lastEventAt: now });
        await appendAttemptEvidence(ctx, j, "reservation_repaired", "Malformed launched reservation fenced before redispatch", {
          stage: "checkpointed", evidenceKind: "reconcile", eventKey: `reservation-repaired:${attemptNumber}`, attempt: attemptNumber,
        });
        attemptNumber += 1;
        await patchJobWithRuntime(ctx, j, { attempt: attemptNumber, ...invalidateDeliveryLease(j) });
        await ensureAttempt(ctx, j._id, attemptNumber, "pending", now);
        await appendAttemptEvidence(ctx, j, "queued", `Fresh attempt ${attemptNumber} queued after reservation repair`, {
          stage: "queued", evidenceKind: "intent", eventKey: `intent:${attemptNumber}`, attempt: attemptNumber,
        });
        j.attempt = attemptNumber;
        attempt = await attemptFor(ctx, j._id, attemptNumber);
      }
      const dispatchId = `${String(j._id)}:${attemptNumber}:${now}`;
      await patchJobWithRuntime(ctx, j, {
        status: "dispatching",
        stage: "dispatching",
        progress: "cloud worker reserved",
        dispatchId,
        dispatchLeaseUntil: now + DISPATCH_LEASE_MS,
        dispatchReason: a.reason?.slice(0, 160),
        workerRunId: undefined,
        deliveryRunId: undefined,
        // Generation one is allocated exactly once with the cold review
        // receipt. Dispatching/recovery binds that existing generation; it
        // must never allocate a second number for the same controller pass.
        deliveryGeneration: deliveryContinuation ? Math.max(1, Number(j.deliveryGeneration ?? 1)) : j.deliveryGeneration,
        workerRuntime: "trigger",
        heartbeatAt: now,
      });
      attempt = await attemptFor(ctx, j._id, attemptNumber);
      if (attempt && !attempt.workerRunId) await ctx.db.patch(attempt._id, { status: "dispatching", dispatchId, lastEventAt: now });
      else if (!attempt) await ensureAttempt(ctx, j._id, attemptNumber, "dispatching", now, { dispatchId });
      await appendAttemptEvidence(ctx, j, "dispatched", `Independent Trigger worker reserved${a.reason ? ` · ${a.reason.slice(0, 120)}` : ""}`, {
        stage: "dispatching", percent: Math.max(1, j.percent ?? 0), evidenceKind: "dispatch", eventKey: `dispatch:${attemptNumber}:${dispatchId}`,
      });
      reservations.push({
        jobId: String(j._id),
        dispatchId,
        attempt: attemptNumber,
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
    const attemptNumber = j?.attempt ?? 1;
    const priorAttempt = j ? await attemptFor(ctx, a.jobId, attemptNumber) : null;
    // Trigger can redeliver after Convex committed the claim but before the
    // worker received the response. Recover exactly the already-bound launch;
    // a competing Trigger session is fenced rather than stranding `running`.
    const disposition = claimDisposition({
      jobStatus: j?.status ?? "missing", jobDispatchId: j?.dispatchId,
      requestDispatchId: a.dispatchId, requestWorkerRunId: a.workerRunId, attempt: priorAttempt,
    });
    // Do not execute a dependency query on a redelivery. The original response
    // may have been lost after commit; this is an immutable replay envelope.
    if (disposition === "replay") return claimedJob(j, priorAttempt?.upstreamEvidence ?? []);
    if (j?.status === "running" && j.dispatchId === a.dispatchId && j.deliveryRunId === a.workerRunId.slice(0, 120)
      && j.verificationVerdict === "pass" && j.reviewReceiptId) return claimedJob(j, priorAttempt?.upstreamEvidence ?? []);
    if (
      !j ||
      j.status !== "dispatching" ||
      j.dispatchId !== a.dispatchId ||
      (j.dispatchLeaseUntil ?? 0) < now
    ) return null;
    const deliveryContinuation = j.verificationVerdict === "pass" && Boolean(j.reviewReceiptId);
    if (priorAttempt?.workerRunId && deliveryContinuation) {
      const generation = Math.max(1, Number(j.deliveryGeneration ?? 1));
      const existingDelivery = await deliveryAttemptFor(ctx, a.jobId, attemptNumber, generation);
      // A lost response may only replay the immutable generation/run binding.
      if (existingDelivery && ((existingDelivery.dispatchId && existingDelivery.dispatchId !== a.dispatchId) || (existingDelivery.deliveryRunId && existingDelivery.deliveryRunId !== a.workerRunId.slice(0, 120)))) return null;
      const review: any = j.reviewReceiptId ? await ctx.db.get(j.reviewReceiptId) : null;
      const deliveryId = existingDelivery?._id ?? await ctx.db.insert("deliveryAttempts", {
        jobId: a.jobId, sourceWorkAttempt: attemptNumber, generation,
        dispatchId: a.dispatchId, deliveryRunId: a.workerRunId.slice(0, 120),
        policy: String(j.deliveryMode ?? "manual"), status: "running",
        reviewReceiptId: j.reviewReceiptId, reviewReceiptDigest: j.reviewReceiptDigest,
        reviewedHeadSha: review?.headSha, reviewedBaseSha: review?.baseSha,
        reviewedHeadTreeSha: review?.headTreeSha, reviewedDiffSha256: review?.diffSha256,
        heartbeatAt: now, retries: 0, cumulativeRetries: 0, currentStep: "preflight", createdAt: now, updatedAt: now,
      });
      if (existingDelivery) await ctx.db.patch(deliveryId, { dispatchId: a.dispatchId, deliveryRunId: a.workerRunId.slice(0, 120), status: "running", currentStep: "preflight", heartbeatAt: now, updatedAt: now });
      await patchJobWithRuntime(ctx, j, {
        status: "running", stage: "delivery", progress: "resuming verified controller delivery", startedAt: now,
        heartbeatAt: now, nextRunAt: undefined, dispatchLeaseUntil: undefined, dispatchId: a.dispatchId,
        workerRunId: a.workerRunId.slice(0, 120), deliveryRunId: a.workerRunId.slice(0, 120), deliveryGeneration: generation, activeDeliveryAttemptId: deliveryId, workerRuntime: "trigger",
      });
      await appendAttemptEvidence(ctx, j, "delivery_resumed", "Trusted controller resumed verified delivery without rerunning the specialist", {
        stage: "delivery", evidenceKind: "delivery", eventKey: `delivery-resume:${j.attempt ?? 1}:${a.dispatchId}`,
      });
      return claimedJob(j, priorAttempt.upstreamEvidence ?? []);
    }
    if (priorAttempt?.workerRunId || (priorAttempt?.dispatchId && priorAttempt.dispatchId !== a.dispatchId)) {
      // A stale platform redelivery must not replace the original workspace
      // or session receipt. It cannot cross the launch fence a second time.
      return null;
    }
    // Legacy rows may have been reserved before attempt rows existed. Create
    // that missing causal record before changing jobs to running; otherwise a
    // lost response could strand a running job with no replay binding.
    const attempt = priorAttempt ?? await ensureAttempt(ctx, a.jobId, attemptNumber, "dispatching", now, { dispatchId: a.dispatchId });
    if (attempt.dispatchId && attempt.dispatchId !== a.dispatchId) return null;
    const upstreamEvidence = await upstreamEvidenceForClaim(ctx, j);
    await patchJobWithRuntime(ctx, j, {
      status: "running",
      stage: "starting",
      progress: "starting secure workspace",
      percent: Math.max(2, j.percent ?? 0),
      startedAt: now,
      heartbeatAt: now,
      progressAt: now,
      stalledAt: undefined,
      stallReason: undefined,
      nextRunAt: undefined,
      dispatchLeaseUntil: undefined,
      workerRunId: a.workerRunId.slice(0, 120),
      dispatchId: a.dispatchId,
      workerRuntime: "trigger",
    });
    // Bind dispatch, worker identities and the exact upstream snapshot in the
    // same transaction as running. This makes exact lost-response replay
    // reachable while fencing every competing delivery.
    await ctx.db.patch(attempt._id, {
      status: "running",
      workspaceKey: `convex:${String(a.jobId)}:attempt:${j.attempt ?? 1}`,
      sessionId: a.workerRunId.slice(0, 120),
      workerRunId: a.workerRunId.slice(0, 120),
      dispatchId: a.dispatchId,
      upstreamEvidence,
      launchedAt: now,
      livenessAt: now,
      progressAt: now,
      lastEventAt: now,
    });
    await appendAttemptEvidence(ctx, j, "started", `Attempt ${j.attempt ?? 1} started`, {
      stage: "starting",
      percent: Math.max(2, j.percent ?? 0),
      evidenceKind: "attempt_launch",
      data: { workspace: `convex:${String(a.jobId)}:attempt:${j.attempt ?? 1}`, session: a.workerRunId.slice(0, 120) },
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
      ...invalidateDeliveryLease(row),
      status: "pending",
      stage: "queued",
      progress: `worker launch deferred · ${a.reason.slice(0, 240)}`,
      nextRunAt: now + delayMs,
      dispatchId: undefined,
      dispatchLeaseUntil: undefined,
      workerRunId: undefined,
      heartbeatAt: now,
    });
    await appendAttemptEvidence(ctx, row, "dispatch_released", a.reason.slice(0, 500), {
      stage: "queued", percent: row.percent, evidenceKind: "dispatch", eventKey: `dispatch-release:${row.attempt ?? 1}:${a.dispatchId}`,
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
    resultDigest: v.optional(v.string()),
    evidenceDigest: v.optional(v.string()),
    reviewReceiptSignature: v.optional(v.string()),
    reviewDiffSha256: v.optional(v.string()),
    reviewReceiptJson: v.optional(v.string()),
    deliveryLeaseOwner: v.optional(v.string()),
    deliveryLeaseToken: v.optional(v.string()),
    deliveryLeaseVersion: v.optional(v.number()),
    sourceWorkAttempt: v.optional(v.number()),
    deliveryGeneration: v.optional(v.number()),
    deliveryRunId: v.optional(v.string()),
    deliveryAttemptId: v.optional(v.id("deliveryAttempts")),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const row = await ctx.db.get(a.jobId);
    if (!row || row.status !== "running" || (row.attempt ?? 1) !== a.expectedAttempt) return false;
    if (row.repo && !hasLiveDeliveryLease(row, a)) return false;
    const delivery = a.deliveryGeneration === undefined ? null : await deliveryAttemptFor(ctx, a.jobId, Number(a.sourceWorkAttempt), Number(a.deliveryGeneration));
    if (row.repo && (!delivery || !deliveryClaimMatches(row, delivery, a))) return false;
    // A completed job is called "verified" only when the supervisor actually
    // returned pass. This invariant lives in Convex, not only in the runner.
    if (a.status === "done" && (a.verificationVerdict !== "pass" || !completionReceiptAllowed(a))) return false;
    // Repository completion is impossible unless the controller persisted its
    // signed checkout review before any delivery continuation. Convex checks
    // immutable binding fields; the Trigger controller validates the HMAC with
    // its private stable authority before it ever sends this mutation.
    if (a.status === "done" && row.repo && (!row.reviewReceiptId || !row.reviewReceiptDigest || !row.reviewReceiptSignature)) return false;
    if (a.status === "done" && row.repo) {
      const review: any = await ctx.db.get(row.reviewReceiptId as any);
      if (!review || review.jobId !== a.jobId || review.attempt !== a.expectedAttempt
        || review.receiptDigest !== row.reviewReceiptDigest || review.signature !== row.reviewReceiptSignature
        || review.diffSha256 !== a.reviewDiffSha256 || review.signature !== a.reviewReceiptSignature) return false;
    }
    const normalizedResult = String(a.result ?? "").slice(0, 4_000);
    const normalizedNote = String(a.verificationNote ?? "").slice(0, 1_000);
    if (a.status === "done" && (
      a.resultDigest !== await sha256Hex(normalizedResult)
      || a.evidenceDigest !== await sha256Hex(normalizedNote)
    )) return false;
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
      result: normalizedResult || undefined,
      pullRequestUrl: a.pullRequestUrl,
      completedAt: now,
      heartbeatAt: now,
      stage: success ? (delivered ? "delivered" : "verified") : a.status,
      percent: finalPercent,
      progress: finalProgress,
      verificationVerdict: a.verificationVerdict,
      verificationNote: normalizedNote || undefined,
      verifiedAt: success ? now : undefined,
    };
    const terminalEventKey = `terminal:${a.expectedAttempt}:${a.status}:${a.status === "done" ? a.resultDigest : eventIdentity(`${a.result ?? ""}|${a.verificationNote ?? ""}`)}`;
    if (success) {
      const priorReceipt = await ctx.db.query("workReceipts")
        .withIndex("by_job_attempt", (q: any) => q.eq("jobId", a.jobId).eq("attempt", a.expectedAttempt)).first();
      if (priorReceipt) return false;
    }
    await patchJobWithRuntime(ctx, row, finalPatch);
    if (delivery) await ctx.db.patch(delivery._id, {
      status: success ? "done" : "blocked",
      currentStep: "terminal",
      terminalReceiptDigest: success ? a.resultDigest : undefined,
      completedAt: now,
      leaseUntil: undefined,
      heartbeatAt: now,
      updatedAt: now,
    });
    const attempt = await attemptFor(ctx, a.jobId, a.expectedAttempt);
    if (attempt) await ctx.db.patch(attempt._id, {
      status: success ? "done" : "error",
      completedAt: now,
      lastEventAt: now,
    });
    await appendAttemptEvidence(ctx, row, a.status,
      success ? delivered ? "Work verified and merged automatically" : "Work verified and complete" : (a.result ?? a.status),
      { stage: success ? (delivered ? "delivered" : "verified") : a.status, percent: finalPercent, evidenceKind: success ? "completion_receipt" : "terminal", eventKey: terminalEventKey },
    );
    if (success) {
      const artifacts = [row.branch, a.pullRequestUrl ?? row.pullRequestUrl, row.mergeCommitSha]
        .filter((value): value is string => typeof value === "string" && value.length > 0).slice(0, 8);
      // Read-only results remain concrete immutable references to the exact
      // durable attempt record, never arbitrary result text masquerading as an artifact.
      if (!artifacts.length) artifacts.push(`convex://jobs/${String(a.jobId)}/attempt/${a.expectedAttempt}/result`);
      await ctx.db.insert("workReceipts", {
        jobId: a.jobId, attempt: a.expectedAttempt, status: "succeeded",
        acceptanceEvidence: [String(a.verificationNote).slice(0, 1_000)], artifacts, verification: "pass",
        terminalEventKey, resultDigest: a.resultDigest, evidenceDigest: a.evidenceDigest,
        reviewReceiptSignature: a.reviewReceiptSignature, reviewDiffSha256: a.reviewDiffSha256,
        reviewReceiptId: row.reviewReceiptId, reviewReceiptDigest: row.reviewReceiptDigest, createdAt: now,
      });
    }
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
      await appendAttemptEvidence(ctx, j, "dispatch_recovered", "Expired Trigger worker reservation released", {
        stage: "queued", percent: j.percent, evidenceKind: "reconcile", eventKey: `dispatch-recovered:${j.attempt ?? 1}:${activity.dispatchId}`,
      });
      releasedDispatches.push(j.task.slice(0, 80));
    }
    const running = await ctx.db
      .query("jobRuntime")
      .withIndex("by_status_heartbeat", (q: any) => q.eq("status", "running").lte("heartbeatAt", now - STALE_RUNNER_MS))
      .take(100);
    // A steered worker has a short opportunity to save its local checkpoint.
    // If it never observes the reactive control update, the same liveness
    // reaper preserves the last durable branch/checkpoint and releases a
    // fresh scoped attempt instead of leaving `steering` forever.
    const steering = await ctx.db
      .query("jobRuntime")
      .withIndex("by_status_heartbeat", (q: any) => q.eq("status", "steering").lte("heartbeatAt", now - STALE_RUNNER_MS))
      .take(100);
    const requeued: string[] = [];
    const abandoned: string[] = [];
    const stalled: string[] = [];
    // This pass catches the important case the old heartbeat-only design
    // could not see: a responsive container emitting liveness ticks while no
    // stage, percentage, or evidence has advanced.
    const noProgress = await ctx.db
      .query("jobRuntime")
      .withIndex("by_status_progress", (q: any) => q.eq("status", "running").lte("progressAt", now - STALLED_PROGRESS_MS))
      .take(100);
    for (const activity of noProgress) {
      if ((activity.heartbeatAt ?? 0) <= now - STALE_RUNNER_MS) continue;
      const j = await ctx.db.get(activity.jobId);
      if (!j || j.status !== "running" || (j.attempt ?? 1) !== activity.attempt) {
        if (j) await upsertJobRuntime(ctx, j);
        continue;
      }
      const attempt = await attemptFor(ctx, j._id, j.attempt ?? 1);
      if (!attempt || attempt.status !== "running") continue;
      const reason = `No causal progress for ${Math.floor((now - (activity.progressAt ?? activity.createdAt)) / 60_000)} minutes while the worker remained live`;
      await patchJobWithRuntime(ctx, j, {
        status: "stalled",
        stage: "stalled",
        progress: reason,
        stalledAt: now,
        stallReason: reason,
        stallCount: (j.stallCount ?? 0) + 1,
        nextRunAt: undefined,
      });
      await ctx.db.patch(attempt._id, { status: "stalled", completedAt: now, lastEventAt: now });
      await appendAttemptEvidence(ctx, j, "stalled", reason, {
        stage: "stalled",
        percent: activity.percent,
        evidenceKind: "watchdog",
      });
      stalled.push(j.task.slice(0, 80));
    }
    for (const activity of [...running, ...steering]) {
      const j = await ctx.db.get(activity.jobId);
      if (!j || !["running", "steering"].includes(j.status) || (j.attempt ?? 1) !== activity.attempt) {
        if (j) await upsertJobRuntime(ctx, j);
        continue;
      }
      // A delivery controller is not a specialist workspace.  Its source
      // attempt is already closed with an immutable receipt, so reaping this
      // run must queue only another bounded controller generation.
      if (j.stage === "delivery" && j.deliveryRunId && Number(j.deliveryGeneration ?? 0) > 0) {
        const delivery = await deliveryAttemptFor(ctx, j._id, j.attempt ?? 1, Number(j.deliveryGeneration));
        if (delivery?.status === "running") {
          const retries = Number(delivery.cumulativeRetries ?? delivery.retries ?? 0) + 1;
          const exhaustedDelivery = retries > 6;
          await ctx.db.patch(delivery._id, {
            status: exhaustedDelivery ? "blocked" : "checkpointed", retries: Number(delivery.retries ?? 0) + 1, cumulativeRetries: retries, completedAt: now,
            leaseUntil: undefined, heartbeatAt: now, updatedAt: now,
          });
          const nextGeneration = Number(j.deliveryGeneration) + 1;
          const nextDeliveryId = exhaustedDelivery ? undefined : await ctx.db.insert("deliveryAttempts", {
            jobId: j._id, sourceWorkAttempt: j.attempt ?? 1, generation: nextGeneration,
            policy: String(delivery.policy), status: "checkpointed", reviewReceiptId: delivery.reviewReceiptId,
            reviewReceiptDigest: delivery.reviewReceiptDigest, reviewedHeadSha: delivery.reviewedHeadSha,
            reviewedBaseSha: delivery.reviewedBaseSha, reviewedHeadTreeSha: delivery.reviewedHeadTreeSha,
            reviewedDiffSha256: delivery.reviewedDiffSha256, heartbeatAt: now, retries: 0,
            cumulativeRetries: retries, currentStep: "queued", createdAt: now, updatedAt: now,
          });
          await patchJobWithRuntime(ctx, j, {
            ...invalidateDeliveryLease(j),
            status: exhaustedDelivery ? "needs_input" : "pending",
            stage: exhaustedDelivery ? "delivery attention" : "checkpointed",
            progress: exhaustedDelivery
              ? "verified delivery retry budget exhausted — Daniel's attention required"
              : "delivery controller stopped — retrying the same reviewed receipt",
            nextRunAt: exhaustedDelivery ? undefined : now + Math.min(30 * 60_000, 30_000 * 2 ** Math.max(0, retries - 1)),
            dispatchId: undefined, dispatchLeaseUntil: undefined, workerRunId: undefined, deliveryRunId: undefined,
            deliveryGeneration: exhaustedDelivery ? j.deliveryGeneration : nextGeneration,
            activeDeliveryAttemptId: exhaustedDelivery ? j.activeDeliveryAttemptId : nextDeliveryId,
          });
          await appendAttemptEvidence(ctx, j, exhaustedDelivery ? "delivery_attention" : "delivery_recovered",
            exhaustedDelivery ? "Delivery retry budget exhausted" : `Delivery generation ${j.deliveryGeneration} requeued without rerunning specialist`, {
              stage: exhaustedDelivery ? "delivery attention" : "checkpointed", evidenceKind: "delivery",
              eventKey: `delivery-recovery:${j.attempt ?? 1}:${j.deliveryGeneration}:${retries}`,
            });
          if (exhaustedDelivery) abandoned.push(j.task.slice(0, 80)); else requeued.push(j.task.slice(0, 80));
          continue;
        }
      }
      // The serialized Trigger task heartbeats every 30 seconds. If its run
      // disappears (for example an OOM kill), the next scheduled invocation is
      // the only possible reaper, so five quiet minutes is ample fencing while
      // avoiding a long ghost-running window.
      const nextAttempt = (j.attempt ?? 1) + 1;
      let recoveryEventEmitted = false;
      if (now - j.createdAt > 14 * 86_400_000 || nextAttempt > (j.maxAttempts ?? 12)) {
        await patchJobWithRuntime(ctx, j, {
          status: "error",
          stage: "error",
          completedAt: now,
          result: "abandoned: runner repeatedly stopped without a checkpoint",
        });
        abandoned.push(j.task.slice(0, 80));
        const attempt = await attemptFor(ctx, j._id, j.attempt ?? 1);
        if (attempt) await ctx.db.patch(attempt._id, { status: "error", completedAt: now, lastEventAt: now });
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
        // The old attempt's terminal event must precede allocation of the
        // replacement attempt, otherwise causal readers see a child before
        // its failed parent.
        await appendAttemptEvidence(ctx, j, "recovered", `Recovered as attempt ${nextAttempt}`, {
          stage: "checkpointed", evidenceKind: "watchdog", eventKey: `recovery:${j.attempt ?? 1}:${nextAttempt}`,
          attempt: j.attempt ?? 1,
        });
        recoveryEventEmitted = true;
        const attempt = await attemptFor(ctx, j._id, j.attempt ?? 1);
        if (attempt && !attempt.completedAt) await ctx.db.patch(attempt._id, { status: "checkpointed", completedAt: now, lastEventAt: now });
        await patchJobWithRuntime(ctx, j, {
          ...invalidateDeliveryLease(j),
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
        await ensureAttempt(ctx, j._id, nextAttempt, "pending", now);
        await appendAttemptEvidence(ctx, j, "queued", `Recovered attempt ${nextAttempt} queued`, {
          stage: "queued", evidenceKind: "intent", eventKey: `intent:${nextAttempt}`, attempt: nextAttempt,
        });
      }
      if (!recoveryEventEmitted) await appendAttemptEvidence(ctx, j, nextAttempt > (j.maxAttempts ?? 12) ? "abandoned" : "recovered",
        nextAttempt > (j.maxAttempts ?? 12) ? "Retry budget exhausted" : `Recovered as attempt ${nextAttempt}`,
        { stage: nextAttempt > (j.maxAttempts ?? 12) ? "error" : "queued", evidenceKind: "watchdog", eventKey: `recovery:${j.attempt ?? 1}:${nextAttempt}` });
    }
    return { requeued, abandoned, stalled, releasedDispatches };
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
    const percent = a.percent === undefined ? row.percent : Math.max(row.percent ?? 0, Math.min(99, a.percent));
    // Heartbeats are deliberately excluded from this test. A changed stage,
    // percentage advance, or new evidence line is causal progress; liveness
    // traffic alone can never postpone the stall watchdog.
    const meaningful = isMeaningfulWorkProgress({
      currentStage: row.stage,
      currentPercent: row.percent,
      currentProgress: row.progress,
      nextStage: a.stage,
      nextPercent: a.percent,
      nextProgress: a.progress,
    });
    const patch: Record<string, unknown> = {
      progress: a.progress.slice(0, 400),
      percent,
    };
    if (a.stage !== undefined) patch.stage = a.stage.slice(0, 80);
    if (meaningful) patch.progressAt = now;
    patch.updatedAt = now;
    await ctx.db.patch(row._id, patch);
    if (meaningful) {
      const durable = await ctx.db.get(a.jobId);
      const attempt = await attemptFor(ctx, a.jobId, a.expectedAttempt);
      if (!durable || !attempt) return false;
      await ctx.db.patch(attempt._id, { progressAt: now, lastEventAt: now });
      await appendAttemptEvidence(ctx, durable, "progress", a.progress, {
        stage: a.stage ?? row.stage,
        percent,
        evidenceKind: "progress",
      });
    }
    return true;
  },
});

// Liveness is intentionally a different fenced operation from progress. It
// is cheap enough to send every thirty seconds and cannot make a stalled job
// look productive.
export const touchHeartbeat = mutation({
  args: {
    jobId: v.id("jobs"),
    expectedAttempt: v.number(),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const job = await ctx.db.get(a.jobId);
    if (!job || job.status !== "running" || (job.attempt ?? 1) !== a.expectedAttempt) return false;
    const runtime = await jobRuntimeFor(ctx, a.jobId);
    const attempt = await attemptFor(ctx, a.jobId, a.expectedAttempt);
    if (!runtime || !attempt || attempt.status !== "running") return false;
    const now = Date.now();
    await ctx.db.patch(runtime._id, { heartbeatAt: now, updatedAt: now });
    // Attempt rows are immutable evidence except for causal/terminal updates;
    // runtime owns the compact liveness clock used by the five-minute reaper.
    return true;
  },
});

// Delivery liveness is separate from the closed specialist attempt that
// produced the receipt.  GitHub check waits can therefore remain durable
// without reopening or consuming specialist work.
export const touchDeliveryHeartbeat = mutation({
  args: {
    jobId: v.id("jobs"), expectedAttempt: v.number(), sourceWorkAttempt: v.number(),
    deliveryGeneration: v.number(), deliveryRunId: v.string(), deliveryAttemptId: v.optional(v.id("deliveryAttempts")),
    deliveryLeaseOwner: v.optional(v.string()), deliveryLeaseToken: v.optional(v.string()), deliveryLeaseVersion: v.optional(v.number()), workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const row = await ctx.db.get(a.jobId);
    const delivery = await deliveryAttemptFor(ctx, a.jobId, a.sourceWorkAttempt, a.deliveryGeneration);
    if (!row || row.status !== "running" || (row.attempt ?? 1) !== a.expectedAttempt || !hasLiveDeliveryLease(row, a) || !deliveryClaimMatches(row, delivery, a)
      || delivery.status !== "running") return false;
    const now = Date.now();
    await ctx.db.patch(delivery._id, { heartbeatAt: now, updatedAt: now });
    const runtime = await jobRuntimeFor(ctx, a.jobId);
    if (runtime) await ctx.db.patch(runtime._id, { heartbeatAt: now, updatedAt: now });
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
    deliveryAttemptId: v.optional(v.id("deliveryAttempts")),
    sourceWorkAttempt: v.optional(v.number()),
    deliveryGeneration: v.optional(v.number()),
    deliveryRunId: v.optional(v.string()),
    deliveryLeaseOwner: v.optional(v.string()),
    deliveryLeaseToken: v.optional(v.string()),
    deliveryLeaseVersion: v.optional(v.number()),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const row = await ctx.db.get(a.jobId);
    if (!row || (row.attempt ?? 1) !== a.expectedAttempt) {
      return { requeued: false, exhausted: false, stale: true };
    }
    const delivery = a.deliveryGeneration === undefined ? null : await deliveryAttemptFor(ctx, a.jobId, Number(a.sourceWorkAttempt), Number(a.deliveryGeneration));
    if (a.deliveryGeneration !== undefined && (!hasLiveDeliveryLease(row, a) || !deliveryClaimMatches(row, delivery, a))) {
      return { requeued: false, exhausted: false, stale: true };
    }
    const requestedStatus = a.nextStatus ?? "pending";
    const stoppedState = requestedStatus === "paused" || requestedStatus === "cancelled";
    if (row.status !== "running") {
      // Steering closes the current attempt before a replacement workspace is
      // allowed. The old worker may contribute one safe checkpoint only.
      if (row.status === "steering" && requestedStatus === "pending") {
        const now = Date.now();
        const nextAttempt = (row.attempt ?? 1) + 1;
        if (!hasAttemptBudget(nextAttempt, row.maxAttempts ?? 12)) return { requeued: false, exhausted: true, stale: false };
        await patchJobWithRuntime(ctx, row, {
          ...invalidateDeliveryLease(row),
          status: "pending", stage: "checkpointed", attempt: nextAttempt,
          checkpoint: a.checkpoint.slice(0, 6000), result: a.result, branch: a.branch ?? row.branch,
          startedAt: undefined, heartbeatAt: now, nextRunAt: now, dispatchId: undefined,
          dispatchLeaseUntil: undefined, workerRunId: undefined,
          progress: `steering checkpoint saved · fresh attempt ${nextAttempt} queued`,
        });
        await appendAttemptEvidence(ctx, row, "steering_checkpoint", "Steering checkpoint saved before fresh scoped attempt", {
          stage: "checkpointed", percent: row.percent, evidenceKind: "checkpoint", eventKey: `steering-checkpoint:${a.expectedAttempt}`, attempt: a.expectedAttempt,
        });
        await ensureAttempt(ctx, a.jobId, nextAttempt, "pending", now);
        await appendAttemptEvidence(ctx, row, "queued", `Fresh attempt ${nextAttempt} queued after steering`, {
          stage: "queued", evidenceKind: "intent", eventKey: `intent:${nextAttempt}`, attempt: nextAttempt,
        });
        return { requeued: true, exhausted: false, stale: false };
      }
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
        await appendAttemptEvidence(ctx, row, "checkpoint_saved", `Final checkpoint saved after ${requestedStatus}`, {
          stage: requestedStatus, percent: row.percent, evidenceKind: "checkpoint", eventKey: `stopped-checkpoint:${a.expectedAttempt}:${requestedStatus}`,
        });
        const attempt = await attemptFor(ctx, a.jobId, a.expectedAttempt);
        if (attempt) await ctx.db.patch(attempt._id, { status: requestedStatus, completedAt: now, lastEventAt: now });
        return { requeued: false, exhausted: false, stale: false };
      }
      return { requeued: false, exhausted: false, stale: true };
    }
    // A controller-only delivery retry carries a signed, immutable review of
    // this exact work attempt. Keep that work attempt stable and increment a
    // separate delivery generation so a resume cannot pretend old evidence
    // was observed by a new specialist attempt.
    const deliveryContinuation = requestedStatus === "pending"
      && row.verificationVerdict === "pass"
      && Boolean(row.reviewReceiptId);
    const attempt = (row.attempt ?? 1) + (requestedStatus === "pending" && !deliveryContinuation ? 1 : 0);
    const delayMs = Math.max(0, Math.min(6 * 60 * 60 * 1000, a.delayMs ?? 0));
    const exhausted =
      requestedStatus === "pending" &&
      (attempt > (row.maxAttempts ?? 12) || Date.now() - row.createdAt > 14 * 86_400_000);
    const status = exhausted ? "error" : requestedStatus;
    await patchJobWithRuntime(ctx, row, {
      ...invalidateDeliveryLease(row),
      status,
      stage: exhausted ? "error" : requestedStatus === "pending" ? "checkpointed" : requestedStatus,
      checkpoint: a.checkpoint.slice(0, 6000),
      result: a.result,
      branch: a.branch ?? row.branch,
      attempt,
      // Allocate the next controller generation once here. reserveDispatch
      // only dispatches it, so retries cannot double-increment.
      deliveryGeneration: deliveryContinuation ? Number(row.deliveryGeneration ?? 1) + 1 : row.deliveryGeneration,
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
    const attemptRecord = await attemptFor(ctx, a.jobId, a.expectedAttempt);
    if (attemptRecord) await ctx.db.patch(attemptRecord._id, {
      status: exhausted ? "error" : requestedStatus === "pending" ? "checkpointed" : requestedStatus,
      completedAt: Date.now(),
      lastEventAt: Date.now(),
    });
    await appendAttemptEvidence(ctx, row, exhausted ? "continuation_exhausted" : requestedStatus === "pending" ? "checkpoint" : requestedStatus,
      exhausted
        ? "Continuation budget exhausted"
        : requestedStatus === "pending"
          ? `Checkpoint saved; attempt ${attempt}${delayMs ? ` eligible in ${Math.max(1, Math.ceil(delayMs / 60_000))}m` : " queued"}`
          : `Checkpoint saved; job ${requestedStatus}`,
      { stage: exhausted ? "error" : requestedStatus === "pending" ? "checkpointed" : requestedStatus,
        percent: row.percent, evidenceKind: "checkpoint", eventKey: `checkpoint:${a.expectedAttempt}:${requestedStatus}`, attempt: a.expectedAttempt });
    if (status === "pending" && !deliveryContinuation) {
      await ensureAttempt(ctx, a.jobId, attempt, "pending", Date.now());
      await appendAttemptEvidence(ctx, row, "queued", `Continuation attempt ${attempt} queued`, {
        stage: "queued", evidenceKind: "intent", eventKey: `intent:${attempt}`, attempt,
      });
    }
    if (deliveryContinuation && delivery) {
      const cumulativeRetries = Number(delivery.cumulativeRetries ?? delivery.retries ?? 0) + 1;
      await ctx.db.patch(delivery._id, { status: "checkpointed", completedAt: Date.now(), currentStep: "retry", retries: Number(delivery.retries ?? 0) + 1, cumulativeRetries, leaseUntil: undefined, updatedAt: Date.now() });
      if (status === "pending") {
        const nextGeneration = Number(row.deliveryGeneration ?? 1) + 1;
        const existing = await deliveryAttemptFor(ctx, a.jobId, a.expectedAttempt, nextGeneration);
        const nextDeliveryId = existing?._id ?? await ctx.db.insert("deliveryAttempts", {
          jobId: a.jobId, sourceWorkAttempt: a.expectedAttempt, generation: nextGeneration,
          policy: String(row.deliveryMode ?? (row.readonly ? "read_only" : "manual")), status: "checkpointed",
          reviewReceiptId: row.reviewReceiptId, reviewReceiptDigest: row.reviewReceiptDigest,
          heartbeatAt: Date.now(), retries: 0, cumulativeRetries, currentStep: "queued", createdAt: Date.now(), updatedAt: Date.now(),
        });
        await patchJobWithRuntime(ctx, row, { activeDeliveryAttemptId: nextDeliveryId });
      }
    }
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
    if (row) return { status: row.status, attempt: row.attempt, steerRevision: row.steerRevision ?? 0 };
    const state = await ctx.db
      .query("controlPlaneMigrations")
      .withIndex("by_key", (q: any) => q.eq("key", CONTROL_PLANE_MIGRATION))
      .first();
    if (state?.jobsComplete) return { status: "missing", attempt: 0, steerRevision: 0 };
    // Rollout-only point compatibility: an old live worker may predate its
    // projection row. This disappears permanently when the cursor completes.
    const legacy = await ctx.db.get(a.jobId);
    return legacy
      ? { status: legacy.status, attempt: legacy.attempt ?? 1, steerRevision: legacy.steerRevision ?? 0 }
      : { status: "missing", attempt: 0, steerRevision: 0 };
  },
});

// Cold receipt access is worker-only and returns exactly the immutable record
// named by the compact claim pointer. It is never part of an agent prompt or
// sandbox configuration.
export const reviewReceipt = query({
  args: { jobId: v.id("jobs"), expectedAttempt: v.number(), reviewReceiptId: v.id("reviewReceipts"), workerToken: v.optional(v.string()) },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const row: any = await ctx.db.get(a.jobId);
    if (!row || (row.attempt ?? 1) !== a.expectedAttempt || row.reviewReceiptId !== a.reviewReceiptId) return null;
    const receipt: any = await ctx.db.get(a.reviewReceiptId);
    if (!receipt || receipt.jobId !== a.jobId || receipt.attempt !== a.expectedAttempt || receipt.receiptDigest !== row.reviewReceiptDigest) return null;
    return receipt;
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
    const attempt = await attemptFor(ctx, a.jobId, a.expectedAttempt);
    if (!attempt || attempt.status !== "running") return false;
    await ctx.db.patch(attempt._id, { status: "needs_input", completedAt: now, lastEventAt: now });
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
    await appendAttemptEvidence(ctx, row, "needs_input", a.question.slice(0, 1000), {
      stage: "needs Daniel", percent: row.percent, evidenceKind: "checkpoint", eventKey: `needs-input:${a.expectedAttempt}`,
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
    const previousAttempt = await attemptFor(ctx, a.jobId, row.attempt ?? 1);
    if (!previousAttempt || previousAttempt.status !== "needs_input") return false;
    // Close and journal the old lineage before allocating its continuation.
    await ctx.db.patch(previousAttempt._id, { status: "needs_input", completedAt: now, lastEventAt: now });
    await appendAttemptEvidence(ctx, row, "input_received", "Daniel supplied the required decision", {
      stage: "needs Daniel", evidenceKind: "control", eventKey: `input-received:${row.attempt ?? 1}`, attempt: row.attempt ?? 1,
    });
    const nextAttempt = (row.attempt ?? 1) + 1;
    await patchJobWithRuntime(ctx, row, {
      ...invalidateDeliveryLease(row),
      status: "pending",
      stage: "queued",
      progress: "Daniel answered — continuation queued",
      checkpoint: `${row.checkpoint ?? ""}\n\nDaniel's answer: ${a.answer.slice(0, 2000)}`.trim(),
      attempt: nextAttempt,
      heartbeatAt: now,
      nextRunAt: now,
    });
    await ensureAttempt(ctx, a.jobId, nextAttempt, "pending", now);
    await appendAttemptEvidence(ctx, row, "queued", `Continuation attempt ${nextAttempt} queued after input`, {
      stage: "queued", evidenceKind: "intent", eventKey: `intent:${nextAttempt}`, attempt: nextAttempt,
    });
    const attention = await ctx.db
      .query("attentionItems")
      .withIndex("by_fingerprint", (q: any) => q.eq("fingerprint", `job-input:${a.jobId}`))
      .first();
    if (attention) await ctx.db.patch(attention._id, { status: "resolved", updatedAt: now });
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
    observedPullRequestHead: v.optional(v.string()),
    providerCall: v.optional(v.boolean()),
    deliveryAttemptId: v.optional(v.id("deliveryAttempts")),
    deliveryLeaseOwner: v.optional(v.string()),
    deliveryLeaseToken: v.optional(v.string()),
    deliveryLeaseVersion: v.optional(v.number()),
    sourceWorkAttempt: v.optional(v.number()),
    deliveryGeneration: v.optional(v.number()),
    deliveryRunId: v.optional(v.string()),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const row = await ctx.db.get(a.jobId);
    if (!row || row.status !== "running" || (row.attempt ?? 1) !== a.expectedAttempt) return false;
    if (!hasLiveDeliveryLease(row, a)) return false;
    const delivery = a.deliveryGeneration === undefined ? null : await deliveryAttemptFor(ctx, a.jobId, Number(a.sourceWorkAttempt), Number(a.deliveryGeneration));
    if (!delivery || !deliveryClaimMatches(row, delivery, a)) return false;
    const policy = String(delivery.policy);
    if ((policy === "manual" && a.deliveryStatus === "merged")
      || (policy === "read_only" && (a.providerCall === true || a.deliveryStatus === "merged" || a.pullRequestUrl))
      || (a.deliveryStatus === "merged" && policy !== "auto_merge")) return false;
    if (a.observedPullRequestHead && a.observedPullRequestHead !== delivery.reviewedHeadSha) return false;
    await patchJobWithRuntime(ctx, row, {
      branch: a.branch,
      pullRequestUrl: a.pullRequestUrl,
      deliveryStatus: a.deliveryStatus,
      mergeCommitSha: a.mergeCommitSha?.slice(0, 80),
      mergedAt: a.deliveryStatus === "merged" ? Date.now() : undefined,
      heartbeatAt: Date.now(),
    });
    await ctx.db.patch(delivery._id, {
      observedPullRequestHead: a.observedPullRequestHead ?? delivery.observedPullRequestHead,
      currentStep: a.deliveryStatus === "merged" ? "receipt" : a.deliveryStatus === "pull_request" ? "merge" : "preflight",
      heartbeatAt: Date.now(), updatedAt: Date.now(),
    });
    return true;
  },
});

// Convex is the delivery linearization point. The controller acquires this
// immediately before a push, PR, merge, receipt or finalization; control can
// still arrive during an in-flight external call, so the following durable
// writer rechecks status/attempt and never resurrects the old lease.
export const linearizeDelivery = mutation({
  args: {
    jobId: v.id("jobs"), expectedAttempt: v.number(), deliveryLeaseOwner: v.string(), deliveryLeaseToken: v.string(),
    deliveryLeaseVersion: v.optional(v.number()), workerToken: v.optional(v.string()),
    sourceWorkAttempt: v.optional(v.number()), deliveryGeneration: v.optional(v.number()), deliveryRunId: v.optional(v.string()), deliveryAttemptId: v.optional(v.id("deliveryAttempts")),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const row = await ctx.db.get(a.jobId);
    if (!row || row.status !== "running" || (row.attempt ?? 1) !== a.expectedAttempt) return null;
    const deliveryAttempt = a.deliveryGeneration === undefined ? null : await deliveryAttemptFor(
      ctx, a.jobId, Number(a.sourceWorkAttempt), Number(a.deliveryGeneration),
    );
    if (a.deliveryGeneration !== undefined && !deliveryClaimMatches(row, deliveryAttempt, a)) return null;
    const now = Date.now();
    const sameOwner = row.deliveryLeaseOwner === a.deliveryLeaseOwner && row.deliveryLeaseToken === a.deliveryLeaseToken;
    const requestedVersion = Number(a.deliveryLeaseVersion ?? 0);
    const live = sameOwner && Number(row.deliveryLeaseUntil ?? 0) >= now && requestedVersion === Number(row.deliveryLeaseVersion);
    if (row.deliveryLeaseUntil && Number(row.deliveryLeaseUntil) >= now && !live) return null;
    const version = live ? Number(row.deliveryLeaseVersion) : Math.max(0, Number(row.deliveryLeaseVersion ?? 0)) + 1;
    const until = now + DELIVERY_LEASE_MS;
    await patchJobWithRuntime(ctx, row, {
      deliveryLeaseVersion: version, deliveryLeaseOwner: a.deliveryLeaseOwner.slice(0, 120),
      deliveryLeaseToken: a.deliveryLeaseToken.slice(0, 160), deliveryLeaseUntil: until, heartbeatAt: now,
    });
    if (deliveryAttempt) await ctx.db.patch(deliveryAttempt._id, {
      leaseOwner: a.deliveryLeaseOwner.slice(0, 120), leaseToken: a.deliveryLeaseToken.slice(0, 160),
      leaseVersion: version, leaseUntil: until, heartbeatAt: now, updatedAt: now,
    });
    return { owner: a.deliveryLeaseOwner, token: a.deliveryLeaseToken, version, until };
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
    reviewReceiptJson: v.optional(v.string()),
    reviewReceiptSignature: v.optional(v.string()),
    reviewDiffSha256: v.optional(v.string()),
    resultDigest: v.optional(v.string()),
    evidenceDigest: v.optional(v.string()),
    deliveryLeaseOwner: v.optional(v.string()),
    deliveryLeaseToken: v.optional(v.string()),
    deliveryLeaseVersion: v.optional(v.number()),
    sourceWorkAttempt: v.optional(v.number()),
    deliveryGeneration: v.optional(v.number()),
    deliveryRunId: v.optional(v.string()),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const row = await ctx.db.get(a.jobId);
    if (!row || row.status !== "running" || (row.attempt ?? 1) !== a.expectedAttempt) return false;
    if (!hasLiveDeliveryLease(row, a)) return false;
    if (a.deliveryGeneration !== undefined && !deliveryClaimMatches(row, await deliveryAttemptFor(ctx, a.jobId, Number(a.sourceWorkAttempt), Number(a.deliveryGeneration)), a)) return false;
    // A controller review receipt is completion evidence for every scoped
    // repository job. Delivery policy separately decides whether a PR/merge
    // may happen; manual and read-only work must still be able to finish.
    if (!row.repo) return false;
    if (!a.reviewReceiptJson || !isSha256Digest(a.reviewReceiptSignature) || !isSha256Digest(a.reviewDiffSha256)) return false;
    if (a.reviewReceiptJson.length > REVIEW_RECEIPT_MAX_CHARS) return false;
    const result = a.result.slice(0, 4_000);
    const verificationNote = a.verificationNote.slice(0, 1_000);
    if (a.resultDigest !== await sha256Hex(result) || a.evidenceDigest !== await sha256Hex(verificationNote)) return false;
    let receipt: any;
    try { receipt = JSON.parse(a.reviewReceiptJson); } catch { return false; }
    if (
      receipt?.jobId !== String(a.jobId)
      || Number(receipt?.attempt) !== a.expectedAttempt
      || receipt?.repository !== row.repo
      || receipt?.diffSha256 !== a.reviewDiffSha256
      || !isSha256Digest(receipt?.agentEvidenceSha256)
    ) return false;
    const receiptJson = a.reviewReceiptJson;
    const receiptDigest = await sha256Hex(receiptJson);
    const existing = await ctx.db.query("reviewReceipts")
      .withIndex("by_job_attempt_digest", (q: any) => q.eq("jobId", a.jobId).eq("attempt", a.expectedAttempt).eq("receiptDigest", receiptDigest)).first();
    const reviewReceiptId = existing?._id ?? await ctx.db.insert("reviewReceipts", {
      jobId: a.jobId, attempt: a.expectedAttempt, repository: String(row.repo), receiptJson, receiptDigest,
      signature: a.reviewReceiptSignature, diffSha256: a.reviewDiffSha256,
      baseSha: String(receipt.baseSha), headSha: String(receipt.headSha), baseTreeSha: String(receipt.baseTreeSha), headTreeSha: String(receipt.headTreeSha),
      agentEvidenceSha256: String(receipt.agentEvidenceSha256), createdAt: Date.now(),
    });
    const now = Date.now();
    // Review is the phase boundary.  Persist the immutable cold receipt and
    // allocate exactly one queued controller generation before the specialist
    // exits.  The first GitHub effect can therefore never be untracked.
    const sourceAttempt = await attemptFor(ctx, a.jobId, a.expectedAttempt);
    const generation = Math.max(1, Number(row.deliveryGeneration ?? 0) || 1);
    const existingDelivery = await deliveryAttemptFor(ctx, a.jobId, a.expectedAttempt, generation);
    if (existingDelivery && existingDelivery.reviewReceiptDigest && existingDelivery.reviewReceiptDigest !== receiptDigest) return false;
    const deliveryAttemptId = existingDelivery?._id ?? await ctx.db.insert("deliveryAttempts", {
      jobId: a.jobId,
      sourceWorkAttempt: a.expectedAttempt,
      generation,
      policy: String(row.deliveryMode ?? (row.readonly ? "read_only" : "manual")),
      status: "checkpointed",
      reviewReceiptId,
      reviewReceiptDigest: receiptDigest,
      reviewedHeadSha: String(receipt.headSha),
      reviewedBaseSha: String(receipt.baseSha),
      reviewedHeadTreeSha: String(receipt.headTreeSha),
      reviewedDiffSha256: a.reviewDiffSha256,
      heartbeatAt: now,
      retries: 0,
      cumulativeRetries: 0,
      currentStep: "queued",
      createdAt: now,
      updatedAt: now,
    });
    if (existingDelivery) await ctx.db.patch(existingDelivery._id, {
      status: "checkpointed", reviewReceiptId, reviewReceiptDigest: receiptDigest,
      reviewedHeadSha: String(receipt.headSha), reviewedBaseSha: String(receipt.baseSha),
      reviewedHeadTreeSha: String(receipt.headTreeSha), reviewedDiffSha256: a.reviewDiffSha256,
      currentStep: "queued", heartbeatAt: now, updatedAt: now,
    });
    if (sourceAttempt && !sourceAttempt.completedAt) await ctx.db.patch(sourceAttempt._id, {
      status: "done", completedAt: now, lastEventAt: now,
    });
    await patchJobWithRuntime(ctx, row, {
      result,
      verificationVerdict: "pass",
      verificationNote,
      verifiedAt: now,
      // A controller-only Trigger run will claim this cold receipt.  Do not
      // keep the reviewing specialist alive through provider effects.
      status: "pending",
      stage: "delivery",
      progress: "supervisor passed — controller delivery queued",
      percent: Math.max(96, row.percent ?? 0),
      heartbeatAt: now,
      reviewReceiptJson: undefined,
      reviewReceiptSignature: a.reviewReceiptSignature,
      reviewReceiptId,
      reviewReceiptDigest: receiptDigest,
      activeDeliveryAttemptId: deliveryAttemptId,
      deliveryGeneration: generation,
      deliveryRunId: undefined,
      dispatchId: undefined,
      dispatchLeaseUntil: undefined,
      workerRunId: undefined,
      deliveryLeaseUntil: undefined,
      deliveryLeaseOwner: undefined,
      deliveryLeaseToken: undefined,
      nextRunAt: now,
    });
    await appendAttemptEvidence(ctx, row, "delivery_queued", "Supervisor receipt persisted; controller-only delivery queued", {
      stage: "delivery", evidenceKind: "delivery", eventKey: `delivery-queued:${a.expectedAttempt}:${generation}`, attempt: a.expectedAttempt,
    });
    return true;
  },
});

export const control = mutation({
  args: {
    jobId: v.id("jobs"),
    action: v.union(v.literal("pause"), v.literal("resume"), v.literal("cancel"), v.literal("retry"), v.literal("steer")),
    input: v.optional(v.string()),
    authTokenHash: v.optional(v.string()),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const row = await ctx.db.get(a.jobId);
    if (!row) return false;
    const now = Date.now();
    let controlEventEmitted = false;
    const closeAttempt = async (status: string) => {
      const attempt = await attemptFor(ctx, a.jobId, row.attempt ?? 1);
      if (attempt && !attempt.completedAt) await ctx.db.patch(attempt._id, { status, completedAt: now, lastEventAt: now });
      return attempt;
    };
    if (a.action === "pause" && ["pending", "dispatching", "running", "steering"].includes(row.status)) {
      if (["running", "steering"].includes(row.status) && !await closeAttempt("paused")) return false;
      if (["pending", "dispatching"].includes(row.status)) {
        const attempt = await ensureAttempt(ctx, a.jobId, row.attempt ?? 1, "queued", now);
        await ctx.db.patch(attempt._id, { status: "paused", dispatchId: undefined, lastEventAt: now });
      }
      await patchJobWithRuntime(ctx, row, {
        ...invalidateDeliveryLease(row),
        status: "paused",
        stage: "paused",
        progress: "paused by Daniel",
        nextRunAt: undefined,
        dispatchId: undefined,
        dispatchLeaseUntil: undefined,
        deliveryLeaseUntil: undefined,
        deliveryLeaseToken: undefined,
      });
    }
    else if (a.action === "resume" && ["paused", "stalled"].includes(row.status)) {
      const previous = await attemptFor(ctx, a.jobId, row.attempt ?? 1);
      if (previous && !previous.completedAt && previous.status !== "paused") return false;
      // A paused reservation never launched a worker and therefore must not
      // consume a retry budget. A closed launched workspace gets a fresh id.
      const nextAttempt = (row.attempt ?? 1) + (shouldAdvanceAttempt(Boolean(previous?.workerRunId)) ? 1 : 0);
      if (!hasAttemptBudget(nextAttempt, row.maxAttempts ?? 12)) return false;
      await patchJobWithRuntime(ctx, row, {
        ...invalidateDeliveryLease(row),
        status: "pending",
        stage: "queued",
        progress: row.status === "stalled" ? "stalled attempt resumed — fresh workspace queued" : "resumed — queued",
        attempt: nextAttempt,
        startedAt: undefined,
        heartbeatAt: now,
        progressAt: now,
        stalledAt: undefined,
        stallReason: undefined,
        nextRunAt: now,
        dispatchId: undefined,
        dispatchLeaseUntil: undefined,
        workerRunId: undefined,
        deliveryLeaseUntil: undefined,
        deliveryLeaseToken: undefined,
      });
      if (nextAttempt === (row.attempt ?? 1) && previous?.status === "paused") {
        await ctx.db.patch(previous._id, { status: "queued", dispatchId: undefined, lastEventAt: now });
      } else {
        await appendAttemptEvidence(ctx, row, "resume", `${row.status} resumed by Daniel`, {
          stage: "queued", evidenceKind: "control", eventKey: `control:resume:${row.attempt ?? 1}:${now}`,
          attempt: row.attempt ?? 1,
        });
        controlEventEmitted = true;
        await ensureAttempt(ctx, a.jobId, nextAttempt, "pending", now);
        await appendAttemptEvidence(ctx, row, "queued", `Fresh attempt ${nextAttempt} queued after ${row.status}`, {
          stage: "queued", evidenceKind: "intent", eventKey: `intent:${nextAttempt}`, attempt: nextAttempt,
        });
      }
    }
    else if (a.action === "cancel" && !["done", "error", "cancelled"].includes(row.status)) {
      if (["running", "steering"].includes(row.status) && !await closeAttempt("cancelled")) return false;
      if (["pending", "dispatching", "paused"].includes(row.status)) await closeAttempt("cancelled");
      await patchJobWithRuntime(ctx, row, {
        ...invalidateDeliveryLease(row),
        status: "cancelled",
        stage: "cancelled",
        completedAt: now,
        progress: "cancelled by Daniel",
        nextRunAt: undefined,
        deliveryLeaseUntil: undefined,
        deliveryLeaseToken: undefined,
      });
      const approvals = await ctx.db
        .query("approvals")
        .withIndex("by_job", (q: any) => q.eq("jobId", String(a.jobId)))
        .take(20);
      for (const approval of approvals) {
        if (approval.status === "pending") await ctx.db.patch(approval._id, { status: "cancelled", resolvedAt: now });
      }
    } else if (a.action === "retry" && ["error", "cancelled"].includes(row.status)) {
      const previous = await attemptFor(ctx, a.jobId, row.attempt ?? 1);
      if (previous && !previous.completedAt) return false;
      if (!hasAttemptBudget((row.attempt ?? 1) + 1, row.maxAttempts ?? 12)) return false;
      const renewApproval = row.approvalRequired === true && row.approvalStatus !== "approved";
      await patchJobWithRuntime(ctx, row, {
        ...invalidateDeliveryLease(row),
        status: renewApproval ? "awaiting_approval" : "pending",
        stage: renewApproval ? "approval" : "queued",
        completedAt: undefined,
        startedAt: undefined,
        heartbeatAt: now,
        progressAt: now,
        attempt: (row.attempt ?? 1) + 1,
        approvalStatus: renewApproval ? "pending" : row.approvalStatus,
        progress: renewApproval ? "retry waiting for Daniel's approval" : "manual retry queued",
        nextRunAt: renewApproval ? undefined : now,
        dispatchId: undefined,
        dispatchLeaseUntil: undefined,
        workerRunId: undefined,
        deliveryLeaseUntil: undefined,
        deliveryLeaseToken: undefined,
      });
      await ensureAttempt(ctx, a.jobId, (row.attempt ?? 1) + 1, renewApproval ? "awaiting_approval" : "pending", now);
      await appendAttemptEvidence(ctx, row, "retry", "Daniel requested a fresh attempt", {
        stage: renewApproval ? "approval" : "queued", evidenceKind: "control", eventKey: `control:retry:${row.attempt ?? 1}:${now}`,
        attempt: row.attempt ?? 1,
      });
      controlEventEmitted = true;
      await appendAttemptEvidence(ctx, row, renewApproval ? "approval_requested" : "queued",
        renewApproval ? `Fresh attempt ${(row.attempt ?? 1) + 1} awaits approval` : `Fresh attempt ${(row.attempt ?? 1) + 1} queued after retry`, {
          stage: renewApproval ? "approval" : "queued", evidenceKind: "intent", eventKey: `intent:${(row.attempt ?? 1) + 1}`,
          attempt: (row.attempt ?? 1) + 1,
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
    } else if (a.action === "steer" && ["pending", "dispatching", "running", "paused", "stalled", "steering"].includes(row.status)) {
      const steer = String(a.input ?? "").trim().slice(0, 2_000);
      if (!steer) return false;
      const running = row.status === "running";
      if (running && !await closeAttempt("steered")) return false;
      await patchJobWithRuntime(ctx, row, {
        ...invalidateDeliveryLease(row),
        status: running ? "steering" : row.status,
        stage: running ? "steering" : row.stage,
        steer,
        steerRevision: (row.steerRevision ?? 0) + 1,
        checkpoint: `${row.checkpoint ?? ""}\n\nDaniel steering instruction:\n${steer}`.trim().slice(-6_000),
        progress: "Daniel supplied steering — the current attempt will checkpoint into a fresh scoped session",
        deliveryLeaseUntil: undefined,
        deliveryLeaseToken: undefined,
      });
      if (running) {
        await appendAttemptEvidence(ctx, row, "steer", `Daniel steering: ${steer.slice(0, 500)}`, {
          stage: "steering", evidenceKind: "steering", eventKey: `control:steer:${row.attempt ?? 1}:${row.steerRevision ?? 0}`,
          attempt: row.attempt ?? 1,
        });
        controlEventEmitted = true;
        const nextAttempt = (row.attempt ?? 1) + 1;
        await ensureAttempt(ctx, a.jobId, nextAttempt, "queued", now);
        await appendAttemptEvidence(ctx, row, "queued", `Fresh attempt ${nextAttempt} reserved for steering continuation`, {
          stage: "queued", evidenceKind: "intent", eventKey: `intent:${nextAttempt}`, attempt: nextAttempt,
        });
      }
    } else return false;
    const retryNeedsApproval =
      a.action === "retry" && row.approvalRequired === true && row.approvalStatus !== "approved";
    if (!controlEventEmitted) await appendAttemptEvidence(ctx, row, a.action,
      a.action === "steer" ? `Daniel steering: ${String(a.input ?? "").trim().slice(0, 500)}` : `${a.action} requested by Daniel`,
      { stage: retryNeedsApproval ? "approval" : a.action === "resume" || a.action === "retry" ? "queued" : a.action === "steer" ? "steering" : `${a.action}d`,
        evidenceKind: a.action === "steer" ? "steering" : "control", eventKey: `control:${a.action}:${row.attempt ?? 1}:${a.action === "steer" ? row.steerRevision ?? 0 : now}` });
    return true;
  },
});

export const active = query({
  args: { ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    const state = await ctx.db
      .query("controlPlaneMigrations")
      .withIndex("by_key", (q: any) => q.eq("key", CONTROL_PLANE_MIGRATION))
      .first();
    // The indexed v2 path is the permanent read. Before its independent
    // cursor completes, add only a bounded legacy page so an already-complete
    // v1 record cannot make the panel silently empty during rollout.
    const projected = await ctx.db
      .query("jobRuntime")
      .withIndex("by_active_priority", (q: any) => q.eq("active", true))
      .order("desc")
      .take(100);
    let active = projected;
    if (!state?.jobsComplete) {
      const legacy = await ctx.db.query("jobs").withIndex("by_createdAt").order("desc").take(100);
      const projectedIds = new Set(projected.map((row: any) => String(row.jobId)));
      const legacyActive = legacy.filter((job: any) =>
        ["running", "dispatching", "pending", "awaiting_approval", "paused", "stalled", "needs_input", "steering"].includes(job.status)
        && !projectedIds.has(String(job._id)),
      ).map((job: any) => ({ ...job, jobId: job._id }));
      active = [...projected, ...legacyActive].slice(0, 100);
    }
    return active
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
        progressAt: j.progressAt ?? j.startedAt ?? j.createdAt,
        stalledAt: j.stalledAt ?? null,
        stallReason: j.stallReason ?? null,
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
