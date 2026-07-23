import { v } from "convex/values";

import { query } from "./_generated/server";
import { requireWorker } from "./controlAuth";

const MISSION_SUPERVISOR_HANDOFF_MAX_JOBS = 24;

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function dueAt(value: unknown, now: number): boolean {
  return typeof value === "number"
    && Number.isFinite(value)
    && value <= now;
}

/**
 * Return the current public wake fences for one completed supervisor-owned
 * worker. Optional job provenance is never trusted by itself: the append-only
 * delegate/recover decision, exact ordinal, mission, and unique scheduler state
 * must all agree before a due ticket is exposed.
 */
export const completionWakeTicketV1 = query({
  args: {
    jobId: v.id("jobs"),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    const job = await ctx.db.get(args.jobId);
    if (
      !job
      || typeof job.missionId !== "string"
      || !positiveSafeInteger(job.supervisorEpoch)
      || typeof job.supervisorDecisionKey !== "string"
      || job.supervisorDecisionKey.length < 1
      || job.supervisorDecisionKey.length > 160
      || !nonNegativeSafeInteger(job.supervisorJobOrdinal)
      || job.supervisorJobOrdinal >= MISSION_SUPERVISOR_HANDOFF_MAX_JOBS
    ) {
      return null;
    }

    const missionId = ctx.db.normalizeId("missions", job.missionId);
    if (!missionId) return null;

    const decisions = await ctx.db
      .query("missionSupervisorDecisions")
      .withIndex("by_key", (q) =>
        q.eq("decisionKey", job.supervisorDecisionKey!)
      )
      .take(2);
    if (decisions.length !== 1) return null;
    const decision = decisions[0];
    if (
      decision.protocolVersion !== 1
      || !["delegate", "recover"].includes(decision.kind)
      || String(decision.missionId) !== String(missionId)
      || decision.epoch !== job.supervisorEpoch
      || decision.decisionKey !== job.supervisorDecisionKey
      || decision.createdJobIds.length > MISSION_SUPERVISOR_HANDOFF_MAX_JOBS
      || job.supervisorJobOrdinal >= decision.createdJobIds.length
      || String(decision.createdJobIds[job.supervisorJobOrdinal])
        !== String(job._id)
    ) {
      return null;
    }

    const [mission, states] = await Promise.all([
      ctx.db.get(missionId),
      ctx.db
        .query("missionSupervisorState")
        .withIndex("by_mission", (q) => q.eq("missionId", missionId))
        .take(2),
    ]);
    if (
      !mission
      || mission.mode !== "supervised"
      || mission.status !== "running"
      || states.length !== 1
    ) {
      return null;
    }
    const state = states[0];
    if (
      state.protocolVersion !== 1
      || String(state.missionId) !== String(missionId)
      || !nonNegativeSafeInteger(state.leaseVersion)
      || !positiveSafeInteger(state.epoch)
      || !positiveSafeInteger(state.nextDecisionSequence)
      || !nonNegativeSafeInteger(state.inputRevision)
    ) {
      return null;
    }

    const now = Date.now();
    const due =
      (state.state === "ready" || state.state === "waiting")
        ? dueAt(state.nextTickAt, now)
        : state.state === "leased"
          ? dueAt(state.leaseUntil, now)
          : false;
    if (!due) return null;

    return {
      protocolVersion: 1 as const,
      missionId: state.missionId,
      expectedLeaseVersion: state.leaseVersion,
      expectedEpoch: state.epoch,
      expectedDecisionSequence: state.nextDecisionSequence,
      expectedInputRevision: state.inputRevision,
    };
  },
});
