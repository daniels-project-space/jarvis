import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { redactSensitiveText } from "../src/lib/secret-redaction";

type CommandContext = Pick<MutationCtx, "db">;
type SupervisorMission = Doc<"missions">;
type SupervisorState = Doc<"missionSupervisorState">;

export type SupervisorCommandQuestionUpdate =
  | { mode: "preserve" }
  | { mode: "set"; question: string }
  | { mode: "clear" };

const TERMINAL_MISSION_STATUSES = new Set([
  "done",
  "failed",
  "cancelled",
]);

function boundedNumber(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(minimum, Math.min(maximum, numeric));
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric)) return fallback;
  return Math.max(minimum, Math.min(maximum, numeric));
}

function truncateUtf8(value: string, maximumBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maximumBytes) return value;
  const characters: string[] = [];
  let byteLength = 0;
  for (const character of value) {
    const characterBytes = encoder.encode(character).byteLength;
    if (byteLength + characterBytes > maximumBytes) break;
    characters.push(character);
    byteLength += characterBytes;
  }
  return characters.join("");
}

function projectedQuestion(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return truncateUtf8(redactSensitiveText(value), 1_000);
}

function activeJobControlCapability(state: SupervisorState) {
  return state.activeJobControlProtocolVersion === 1
    && state.activeJobControlActions?.length === 2
    && state.activeJobControlActions[0] === "pause"
    && state.activeJobControlActions[1] === "resume"
    ? {
      activeJobControlProtocolVersion: 1 as const,
      activeJobControlActions: [
        "pause" as const,
        "resume" as const,
      ],
    }
    : null;
}

type SupervisorControlAction =
  | "pause"
  | "resume"
  | "cancel"
  | "steer"
  | "provide_input";

function supportedControlActions(
  state: SupervisorState,
  missionStatus: string,
  inputTargeted: boolean,
): SupervisorControlAction[] {
  const capability = activeJobControlCapability(state);
  const count = state.nonterminalJobCount;
  if (
    !capability
    || !Number.isSafeInteger(count)
    || Number(count) < 0
    || Number(count) > state.totalJobs
    || Number(count) > 24
  ) {
    return [];
  }
  if (
    state.state === "terminal"
    || TERMINAL_MISSION_STATUSES.has(missionStatus)
  ) {
    return [];
  }
  if (Number(count) > 0) {
    if (
      ["ready", "waiting", "leased"].includes(state.state)
      && missionStatus === "running"
    ) {
      return ["pause"];
    }
    if (state.state === "paused" && missionStatus === "paused") {
      return ["resume"];
    }
    return [];
  }
  if (
    ["ready", "waiting", "leased"].includes(state.state)
    && missionStatus === "running"
  ) {
    return ["pause", "cancel", "steer"];
  }
  if (state.state === "paused" && missionStatus === "paused") {
    return ["resume", "cancel"];
  }
  if (state.state === "needs_input" && missionStatus === "needs_input") {
    return state.totalJobs === 0 || inputTargeted
      ? ["cancel", "provide_input"]
      : ["cancel"];
  }
  return [];
}

export function projectMissionSupervisorCommand(
  mission: SupervisorMission,
  state: SupervisorState,
  question?: string,
  inputTargeted = false,
) {
  if (
    mission.mode !== "supervised"
    || String(state.missionId) !== String(mission._id)
  ) {
    throw new Error(
      "Mission supervisor command projection requires matching supervised authority",
    );
  }
  const missionCreatedAt = boundedInteger(
    mission.createdAt ?? mission._creationTime,
    0,
    Number.MAX_SAFE_INTEGER - 1,
    0,
  );
  const stateCreatedAt = boundedInteger(
    state.createdAt ?? state._creationTime,
    0,
    Number.MAX_SAFE_INTEGER - 1,
    missionCreatedAt,
  );
  const createdAt = Math.min(missionCreatedAt, stateCreatedAt);
  const safeQuestion = projectedQuestion(question);
  const activeJobControl = activeJobControlCapability(state);
  const actions = supportedControlActions(
    state,
    String(mission.status),
    inputTargeted,
  );
  return {
    protocolVersion: 1 as const,
    missionId: mission._id,
    originThreadId: String(mission.originThreadId ?? "main").slice(0, 120),
    active:
      state.state !== "terminal"
      && !TERMINAL_MISSION_STATUSES.has(String(mission.status)),
    priority: boundedNumber(mission.priority, 0, 100, 50),
    goal: String(mission.goal).slice(0, 500),
    mode: "supervised" as const,
    status: String(mission.status).slice(0, 40),
    phase: String(mission.phase ?? mission.status).slice(0, 80),
    percent: boundedNumber(mission.percent, 0, 100, 0),
    ...(typeof mission.primaryRepo === "string"
      ? { primaryRepo: mission.primaryRepo.slice(0, 120) }
      : {}),
    ...(typeof mission.canonicalProjectId === "string"
      ? { canonicalProjectId: mission.canonicalProjectId.slice(0, 120) }
      : {}),
    state: state.state,
    inputRevision: boundedInteger(
      state.inputRevision,
      0,
      Number.MAX_SAFE_INTEGER - 1,
      0,
    ),
    steerRevision: boundedInteger(
      mission.steerRevision,
      0,
      Number.MAX_SAFE_INTEGER - 1,
      0,
    ),
    deadlineAt: boundedInteger(
      state.deadlineAt,
      0,
      Number.MAX_SAFE_INTEGER - 1,
      createdAt,
    ),
    totalJobs: boundedInteger(state.totalJobs, 0, 24, 0),
    ...(state.nonterminalJobCount === undefined
      ? {}
      : {
        nonterminalJobCount: boundedInteger(
          state.nonterminalJobCount,
          0,
          24,
          0,
        ),
      }),
    ...(activeJobControl ?? {}),
    controlAffordanceProtocolVersion: 1 as const,
    supportedControlActions: actions,
    ...(state.pauseCohortProtocolVersion === 1
      && state.pauseCohortJobCount !== undefined
      ? {
        pauseCohortProtocolVersion: 1 as const,
        pauseCohortJobCount: boundedInteger(
          state.pauseCohortJobCount,
          0,
          24,
          0,
        ),
      }
      : {}),
    inputTargeted,
    ...(typeof state.nextTickAt === "number"
      ? { nextTickAt: state.nextTickAt }
      : {}),
    ...(typeof state.leaseUntil === "number"
      ? { leaseUntil: state.leaseUntil }
      : {}),
    ...(safeQuestion === undefined ? {} : { question: safeQuestion }),
    createdAt,
    updatedAt: boundedInteger(
      Math.max(
        createdAt,
        boundedInteger(
          mission.updatedAt,
          0,
          Number.MAX_SAFE_INTEGER - 1,
          createdAt,
        ),
        boundedInteger(
          state.updatedAt,
          0,
          Number.MAX_SAFE_INTEGER - 1,
          createdAt,
        ),
      ),
      createdAt,
      Number.MAX_SAFE_INTEGER - 1,
      createdAt,
    ),
  };
}

/**
 * Replace the one compact UI projection in the same Convex transaction as a
 * meaningful supervisor transition. Scheduler heartbeats intentionally do not
 * call this helper, so lease renewal chatter cannot fan out to the UI.
 */
export async function syncMissionSupervisorCommand(
  ctx: CommandContext,
  mission: SupervisorMission,
  state: SupervisorState,
  questionUpdate: SupervisorCommandQuestionUpdate = { mode: "preserve" },
  inputTargeted?: boolean,
) {
  const rows = await ctx.db
    .query("missionSupervisorCommand")
    .withIndex("by_mission", (q) => q.eq("missionId", mission._id))
    .take(2);
  if (rows.length > 1) {
    throw new Error("Mission supervisor command projection is not unique");
  }
  const question = questionUpdate.mode === "set"
    ? questionUpdate.question
    : questionUpdate.mode === "clear"
      ? undefined
      : rows[0]?.question
        ?? (state.state === "needs_input"
          && typeof mission.failureReason === "string"
          ? mission.failureReason
          : undefined);
  const targeted = inputTargeted
    ?? (questionUpdate.mode === "clear"
      ? false
      : rows[0]?.inputTargeted ?? false);
  const projection = projectMissionSupervisorCommand(
    mission,
    state,
    question,
    targeted,
  );
  if (rows[0]) {
    await ctx.db.replace(rows[0]._id, projection);
    return rows[0]._id;
  }
  return await ctx.db.insert("missionSupervisorCommand", projection);
}

/**
 * A job wake changes supervisor state but never mission display metadata. Patch
 * only the state-derived projection fields on the normal path, avoiding a
 * mission read and full-document replace for every authoritative job update.
 * Pre-projection missions still receive an atomic one-time backfill.
 */
export async function syncMissionSupervisorCommandForJobWake(
  ctx: CommandContext,
  missionId: Id<"missions">,
  state: SupervisorState,
) {
  const rows = await ctx.db
    .query("missionSupervisorCommand")
    .withIndex("by_mission", (q) => q.eq("missionId", missionId))
    .take(2);
  if (rows.length > 1) {
    throw new Error("Mission supervisor command projection is not unique");
  }
  const existing = rows[0];
  if (!existing) {
    const mission = await ctx.db.get(missionId);
    if (mission?.mode !== "supervised") return null;
    const question = state.state === "needs_input"
      && typeof mission.failureReason === "string"
      ? mission.failureReason
      : undefined;
    return await ctx.db.insert(
      "missionSupervisorCommand",
      projectMissionSupervisorCommand(mission, state, question),
    );
  }

  const updatedAt = boundedInteger(
    Math.max(existing.updatedAt, state.updatedAt),
    existing.createdAt,
    Number.MAX_SAFE_INTEGER - 1,
    existing.updatedAt,
  );
  const activeJobControl = activeJobControlCapability(state);
  const actions = supportedControlActions(
    state,
    existing.status,
    existing.inputTargeted,
  );
  await ctx.db.patch(existing._id, {
    state: state.state,
    inputRevision: boundedInteger(
      state.inputRevision,
      0,
      Number.MAX_SAFE_INTEGER - 1,
      existing.inputRevision,
    ),
    deadlineAt: boundedInteger(
      state.deadlineAt,
      0,
      Number.MAX_SAFE_INTEGER - 1,
      existing.deadlineAt,
    ),
    totalJobs: boundedInteger(state.totalJobs, 0, 24, existing.totalJobs),
    ...(state.nonterminalJobCount === undefined
      ? {}
      : {
        nonterminalJobCount: boundedInteger(
          state.nonterminalJobCount,
          0,
          24,
          existing.nonterminalJobCount ?? 0,
        ),
      }),
    ...(activeJobControl ?? {
      activeJobControlProtocolVersion: undefined,
      activeJobControlActions: undefined,
    }),
    controlAffordanceProtocolVersion: 1,
    supportedControlActions: actions,
    ...(state.pauseCohortProtocolVersion === 1
      && state.pauseCohortJobCount !== undefined
      ? {
        pauseCohortProtocolVersion: 1 as const,
        pauseCohortJobCount: boundedInteger(
          state.pauseCohortJobCount,
          0,
          24,
          existing.pauseCohortJobCount ?? 0,
        ),
      }
      : {
        pauseCohortProtocolVersion: undefined,
        pauseCohortJobCount: undefined,
      }),
    nextTickAt: typeof state.nextTickAt === "number"
      ? state.nextTickAt
      : undefined,
    leaseUntil: typeof state.leaseUntil === "number"
      ? state.leaseUntil
      : undefined,
    ...(state.state === "needs_input"
      ? {}
      : { question: undefined, inputTargeted: false }),
    updatedAt,
  });
  return existing._id;
}
