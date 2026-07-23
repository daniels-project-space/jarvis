import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import {
  syncMissionSupervisorCommandForJobWake,
} from "./missionSupervisorCommand";

export const MISSION_SUPERVISOR_WAKE_MAX_JOBS = 24;

const AUTHORITATIVE_JOB_FIELDS = [
  "supervisorEpoch",
  "supervisorDecisionKey",
  "supervisorJobOrdinal",
  "label",
  "task",
  "repo",
  "status",
  "readonly",
  "agentId",
  "model",
  "reasoningEffort",
  "risk",
  "priority",
  "approvalRequired",
  "approvalStatus",
  "approvalReason",
  "attempt",
  "maxAttempts",
  "steer",
  "steerRevision",
  "dependsOn",
  "acceptanceCriteria",
  "workOrderRevision",
  "workOrderRevisionDigest",
  "schedulingBindingDigest",
  "sourceAdmissionDigest",
  "sourceHeadSha",
  "integrationState",
  "deliveryStatus",
  "reviewReceiptDigest",
  "result",
  "verificationVerdict",
  "verificationNote",
  "evidenceSummary",
  "stallReason",
  "completedAt",
] as const;

type AuthoritativeJobField = (typeof AUTHORITATIVE_JOB_FIELDS)[number];
type SupervisorState = Doc<"missionSupervisorState">;
type WakeContext = Pick<MutationCtx, "db">;

export type SupervisorJobDecisionProvenance = {
  missionId: string;
  epoch: number;
  decisionKey: string;
  ordinal: number;
};

export type ExactSupervisorJobDecisionProvenance =
  | {
      ok: true;
      missionId: Id<"missions">;
      provenance: SupervisorJobDecisionProvenance;
      decision: Doc<"missionSupervisorDecisions">;
    }
  | {
      ok: false;
      reason:
        | "legacy_or_invalid_provenance"
        | "missing_or_ambiguous_decision"
        | "provenance_mismatch";
    };

export type SupervisorDecisionProvenanceCache = Map<
  string,
  readonly Doc<"missionSupervisorDecisions">[]
>;

export type MissionSupervisorWakeResult =
  | {
      signaled: true;
      reason: "authoritative_change";
      inputRevision: number;
      state: SupervisorState["state"];
    }
  | {
      signaled: false;
      reason:
        | "legacy_or_invalid_provenance"
        | "unchanged_snapshot"
        | "missing_or_ambiguous_decision"
        | "provenance_mismatch"
        | "missing_or_ambiguous_state"
        | "invalid_state_bounds"
        | "terminal_state";
    };

const authoritativeJobFields = new Set<string>(AUTHORITATIVE_JOB_FIELDS);

function excerpt(value: unknown, maximum: number): string | null {
  return typeof value === "string" ? value.slice(0, maximum) : null;
}

function canonicalStringArray(
  value: unknown,
  sort: boolean,
): string {
  const normalized = Array.isArray(value)
    ? value.map(String)
    : [];
  if (sort) normalized.sort();
  return JSON.stringify(normalized);
}

function authoritativeValue(
  row: Record<string, unknown>,
  field: AuthoritativeJobField,
): unknown {
  switch (field) {
    case "task":
      return String(row.task ?? "");
    case "status":
      return String(row.status);
    case "label":
      return excerpt(row.label, 80);
    case "repo":
      return excerpt(row.repo, 120);
    case "agentId":
      return excerpt(row.agentId, 40);
    case "model":
    case "reasoningEffort":
    case "risk":
      return excerpt(row[field], 24);
    case "approvalStatus":
    case "deliveryStatus":
    case "verificationVerdict":
      return excerpt(row[field], 32);
    case "approvalReason":
      return excerpt(row.approvalReason, 300);
    case "workOrderRevisionDigest":
    case "schedulingBindingDigest":
    case "sourceAdmissionDigest":
    case "reviewReceiptDigest":
      return excerpt(row[field], 64);
    case "sourceHeadSha":
      return excerpt(row.sourceHeadSha, 80);
    case "integrationState":
      return excerpt(row.integrationState, 40);
    case "verificationNote":
      // The snapshot also hashes the full note.
      return typeof row.verificationNote === "string"
        ? row.verificationNote
        : null;
    case "stallReason":
      return row.status === "stalled"
        ? excerpt(row.stallReason, 400)
        : null;
    case "steer":
    case "result":
    case "evidenceSummary":
      // Each has a digest in the authoritative snapshot, so compare its full
      // admitted value rather than only the display excerpt.
      return typeof row[field] === "string" ? row[field] : null;
    case "dependsOn":
      // Display excerpts are bounded, but their digests cover the full arrays.
      return canonicalStringArray(row.dependsOn, true);
    case "acceptanceCriteria":
      return canonicalStringArray(row.acceptanceCriteria, false);
    case "attempt":
    case "maxAttempts":
      return row[field] ?? 1;
    case "steerRevision":
      return row.steerRevision ?? 0;
    case "priority":
      return typeof row.priority === "number" ? row.priority : null;
    case "supervisorEpoch":
    case "supervisorDecisionKey":
    case "supervisorJobOrdinal":
    case "readonly":
    case "approvalRequired":
    case "workOrderRevision":
    case "completedAt":
      return row[field] ?? null;
  }
}

export function supervisorAuthoritativePatchChanges(
  job: Record<string, unknown>,
  patch: Record<string, unknown>,
): boolean {
  const includedFields = Object.keys(patch).filter(
    (field): field is AuthoritativeJobField =>
      authoritativeJobFields.has(field),
  );
  if (includedFields.length === 0) return false;
  const prospective = { ...job, ...patch };
  return includedFields.some((field) =>
    !Object.is(
      authoritativeValue(job, field),
      authoritativeValue(prospective, field),
    )
  );
}

export function supervisorJobDecisionProvenance(
  job: Doc<"jobs">,
): SupervisorJobDecisionProvenance | null {
  if (
    typeof job.missionId !== "string" ||
    job.missionId.length === 0 ||
    !Number.isSafeInteger(job.supervisorEpoch) ||
    Number(job.supervisorEpoch) < 1 ||
    typeof job.supervisorDecisionKey !== "string" ||
    job.supervisorDecisionKey.length < 1 ||
    job.supervisorDecisionKey.length > 160 ||
    !Number.isSafeInteger(job.supervisorJobOrdinal) ||
    Number(job.supervisorJobOrdinal) < 0 ||
    Number(job.supervisorJobOrdinal) >= MISSION_SUPERVISOR_WAKE_MAX_JOBS
  ) {
    return null;
  }
  return {
    missionId: job.missionId,
    epoch: Number(job.supervisorEpoch),
    decisionKey: job.supervisorDecisionKey,
    ordinal: Number(job.supervisorJobOrdinal),
  };
}

/**
 * Resolve one job's exact append-only delegate/recover creation receipt.
 * Optional provenance on the mutable job is never authority by itself.
 *
 * A caller validating a bounded mission batch may pass a transaction-local
 * cache so sibling jobs created by the same decision share one indexed read.
 */
export async function readExactSupervisorJobDecisionProvenance(
  ctx: WakeContext,
  job: Doc<"jobs">,
  cache?: SupervisorDecisionProvenanceCache,
): Promise<ExactSupervisorJobDecisionProvenance> {
  const provenance = supervisorJobDecisionProvenance(job);
  if (!provenance) {
    return { ok: false, reason: "legacy_or_invalid_provenance" };
  }
  const missionId = ctx.db.normalizeId("missions", provenance.missionId);
  if (!missionId) {
    return { ok: false, reason: "legacy_or_invalid_provenance" };
  }
  let decisions = cache?.get(provenance.decisionKey);
  if (!decisions) {
    decisions = await ctx.db
      .query("missionSupervisorDecisions")
      .withIndex("by_key", (q) =>
        q.eq("decisionKey", provenance.decisionKey)
      )
      .take(2);
    cache?.set(provenance.decisionKey, decisions);
  }
  if (decisions.length !== 1) {
    return { ok: false, reason: "missing_or_ambiguous_decision" };
  }
  const decision = decisions[0];
  if (
    decision.protocolVersion !== 1 ||
    !["delegate", "recover"].includes(decision.kind) ||
    String(decision.missionId) !== String(missionId) ||
    decision.epoch !== provenance.epoch ||
    decision.decisionKey !== provenance.decisionKey ||
    decision.createdJobIds.length > MISSION_SUPERVISOR_WAKE_MAX_JOBS ||
    provenance.ordinal >= decision.createdJobIds.length ||
    String(decision.createdJobIds[provenance.ordinal]) !== String(job._id)
  ) {
    return { ok: false, reason: "provenance_mismatch" };
  }
  return { ok: true, missionId, provenance, decision };
}

function boundedDirtyJobIds(
  current: readonly Id<"jobs">[],
  jobId: Id<"jobs">,
  maximum: number,
): Id<"jobs">[] {
  const seen = new Set<string>();
  const withoutCurrent: Id<"jobs">[] = [];
  for (const id of current) {
    const key = String(id);
    if (key === String(jobId) || seen.has(key)) continue;
    seen.add(key);
    withoutCurrent.push(id);
  }
  return [
    ...withoutCurrent.slice(Math.max(0, withoutCurrent.length - (maximum - 1))),
    jobId,
  ];
}

/**
 * Mark one supervisor-owned job as dirty in the same Convex transaction as
 * its authoritative job/runtime patch. Legacy and display-only updates return
 * before querying. Optional provenance is never accepted without its exact
 * append-only decision receipt.
 */
export async function signalMissionSupervisorForJobPatch(
  ctx: WakeContext,
  job: Doc<"jobs">,
  patch: Record<string, unknown>,
  now = Date.now(),
): Promise<MissionSupervisorWakeResult> {
  const provenance = supervisorJobDecisionProvenance(job);
  if (!provenance) {
    return { signaled: false, reason: "legacy_or_invalid_provenance" };
  }

  const jobRecord = job as unknown as Record<string, unknown>;
  if (!supervisorAuthoritativePatchChanges(jobRecord, patch)) {
    return { signaled: false, reason: "unchanged_snapshot" };
  }

  const exactProvenance = await readExactSupervisorJobDecisionProvenance(
    ctx,
    job,
  );
  if (!exactProvenance.ok) {
    return { signaled: false, reason: exactProvenance.reason };
  }
  const { missionId } = exactProvenance;

  const states = await ctx.db
    .query("missionSupervisorState")
    .withIndex("by_mission", (q) => q.eq("missionId", missionId))
    .take(2);
  if (states.length !== 1) {
    return { signaled: false, reason: "missing_or_ambiguous_state" };
  }
  const state = states[0];
  if (state.state === "terminal") {
    return { signaled: false, reason: "terminal_state" };
  }
  if (
    !Number.isSafeInteger(state.maxJobs) ||
    state.maxJobs < 1 ||
    state.maxJobs > MISSION_SUPERVISOR_WAKE_MAX_JOBS ||
    !Number.isSafeInteger(state.inputRevision) ||
    state.inputRevision < 0 ||
    state.inputRevision >= Number.MAX_SAFE_INTEGER
  ) {
    return { signaled: false, reason: "invalid_state_bounds" };
  }

  const dirtyJobIds = boundedDirtyJobIds(
    state.dirtyJobIds,
    job._id,
    state.maxJobs,
  );
  const inputRevision = state.inputRevision + 1;
  const wakePatch = {
    inputRevision,
    dirtyJobIds,
    updatedAt: now,
    ...(state.state === "ready" || state.state === "waiting"
      ? { state: "ready" as const, nextTickAt: now }
      : {}),
  };
  await ctx.db.patch(state._id, wakePatch);
  await syncMissionSupervisorCommandForJobWake(
    ctx,
    missionId,
    { ...state, ...wakePatch },
  );
  return {
    signaled: true,
    reason: "authoritative_change",
    inputRevision,
    state: wakePatch.state ?? state.state,
  };
}
