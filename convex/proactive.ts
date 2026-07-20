import { internal } from "./_generated/api";
import { internalMutation, mutation } from "./_generated/server";
import { v } from "convex/values";
import { requireWorker } from "./controlAuth";
import { countGeneralFleetDemand, deriveProactiveSignals } from "./proactivePolicy";
import { runtimeJob } from "./controlPlane";
import { REFRESH_LEASE_MS, upsertAttentionWithContext } from "./contextProjection";

const PROACTIVE_STATE_KEY = "attention-signals";
const PROACTIVE_STATE_VERSION = 1;
const PROACTIVE_LEGACY_PAGE = 32;
const proactiveInternal = (internal as any).proactive;

async function reconcileState(ctx: any) {
  return await ctx.db
    .query("proactiveReconcileState")
    .withIndex("by_key", (q: any) => q.eq("key", PROACTIVE_STATE_KEY))
    .first();
}

function sameFingerprints(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((fingerprint) => right.includes(fingerprint));
}

export const reconcile = mutation({
  args: { now: v.number(), workerToken: v.string() },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const [blockedGoals, pendingJobs, dispatchingJobs, runningJobs, failedJobs, state] = await Promise.all([
      ctx.db
        .query("projectGoals")
        .withIndex("by_status_priority", (q: any) => q.eq("status", "blocked"))
        .order("desc")
        .take(30),
      ctx.db.query("jobRuntime").withIndex("by_status_priority", (q: any) => q.eq("status", "pending")).take(100),
      ctx.db.query("jobRuntime").withIndex("by_status_priority", (q: any) => q.eq("status", "dispatching")).take(100),
      ctx.db.query("jobRuntime").withIndex("by_status_priority", (q: any) => q.eq("status", "running")).take(100),
      ctx.db
        .query("jobRuntime")
        .withIndex("by_status_priority", (q: any) => q.eq("status", "error"))
        .order("desc")
        .take(30),
      reconcileState(ctx),
    ]);
    const projectedJobs = [...pendingJobs, ...dispatchingJobs, ...runningJobs, ...failedJobs].map(runtimeJob);
    const signals = deriveProactiveSignals({ goals: blockedGoals, jobs: projectedJobs, now: a.now });

    const missionIds = [...new Set(pendingJobs.map((job: any) => job.missionId).filter(Boolean))].slice(0, 100);
    const missionRows = await Promise.all(
      missionIds.map(async (rawId) => {
        const id = ctx.db.normalizeId("missions", String(rawId));
        return id
          ? await ctx.db.query("missionRuntime").withIndex("by_mission", (q: any) => q.eq("missionId", id)).first()
          : null;
      }),
    );
    const goalMissionIds = new Set(
      missionRows.filter((mission: any) => mission?.mode === "goal").map((mission: any) => String(mission.missionId)),
    );

    const previousFingerprints = state?.version === PROACTIVE_STATE_VERSION
      ? (state.activeFingerprints as string[])
      : [];
    const activeFingerprints = signals.map((signal) => signal.fingerprint);
    const tracked = [...new Set([...activeFingerprints, ...previousFingerprints])].slice(0, 16);
    const existingRows = await Promise.all(
      tracked.map((fingerprint) =>
        ctx.db
          .query("attentionItems")
          .withIndex("by_fingerprint", (q: any) => q.eq("fingerprint", fingerprint))
          .first(),
      ),
    );
    const priorByFingerprint = new Map(
      existingRows.filter(Boolean).map((item: any) => [item.fingerprint, item]),
    );
    const activeSet = new Set(activeFingerprints);
    const newInterruptions: string[] = [];
    let materialChanges = 0;

    for (const signal of signals) {
      const prior: any = priorByFingerprint.get(signal.fingerprint);
      const wasInactive = !prior || !["open", "working"].includes(prior.status);
      const result = await upsertAttentionWithContext(ctx, prior, { ...signal, status: "open" }, a.now);
      if (result.changed) materialChanges += 1;
      if (wasInactive && signal.severity === "critical" && signal.actionClass === "ask") {
        newInterruptions.push(signal.title);
      }
    }

    for (const fingerprint of previousFingerprints) {
      if (activeSet.has(fingerprint)) continue;
      const prior: any = priorByFingerprint.get(fingerprint);
      if (!prior || !["open", "working"].includes(prior.status)) continue;
      const result = await upsertAttentionWithContext(ctx, prior, { ...prior, status: "resolved" }, a.now);
      if (result.changed) materialChanges += 1;
    }

    const versionChanged = !state || state.version !== PROACTIVE_STATE_VERSION;
    const legacyComplete = !versionChanged && state.legacyComplete === true;
    const legacyCursor = versionChanged ? null : state.legacyCursor ?? null;
    const legacyLeaseHealthy = Boolean(
      !legacyComplete
      && !versionChanged
      && state?.legacyScheduledAt
      && a.now - state.legacyScheduledAt < REFRESH_LEASE_MS,
    );
    const needsLegacySchedule = !legacyComplete && !legacyLeaseHealthy;
    if (needsLegacySchedule) {
      await ctx.scheduler.runAfter(0, proactiveInternal.backfillLegacyAttention, {
        version: PROACTIVE_STATE_VERSION,
        cursor: legacyCursor,
      });
    }

    const stateChanged = versionChanged
      || !sameFingerprints(activeFingerprints, previousFingerprints)
      || needsLegacySchedule;
    if (stateChanged) {
      const next = {
        key: PROACTIVE_STATE_KEY,
        version: PROACTIVE_STATE_VERSION,
        activeFingerprints,
        legacyCursor: legacyCursor ?? undefined,
        legacyComplete,
        legacyScheduledAt: needsLegacySchedule ? a.now : state?.legacyScheduledAt,
        updatedAt: a.now,
      };
      if (state) await ctx.db.patch(state._id, next);
      else await ctx.db.insert("proactiveReconcileState", next);
    }

    return {
      signals: signals.length,
      materialChanges,
      newInterruptions,
      // Goal Mode has its own five-minute owner. Excluding those leases here
      // prevents the general ten-minute insight sweep from creating redundant
      // fleet reservations for the same goal transition.
      eligiblePending: countGeneralFleetDemand({ jobs: pendingJobs.map(runtimeJob), goalMissionIds, now: a.now }),
    };
  },
});

// One-time cleanup for proactive rows created before the singleton registry.
// Every invocation reads at most 32 rows; steady-state reconcile never scans
// attentionItems and resolves only the previously active bounded fingerprint set.
export const backfillLegacyAttention = internalMutation({
  args: { version: v.number(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, a) => {
    const state = await reconcileState(ctx);
    if (!state || state.legacyComplete) return { complete: true };
    if (
      a.version !== PROACTIVE_STATE_VERSION
      || a.cursor !== (state.legacyCursor ?? null)
    ) return { complete: false, reason: "superseded" };

    const page = await ctx.db
      .query("attentionItems")
      .withIndex("by_updatedAt")
      .order("asc")
      .paginate({
        cursor: a.cursor,
        numItems: PROACTIVE_LEGACY_PAGE,
        maximumRowsRead: PROACTIVE_LEGACY_PAGE,
      });
    const active = new Set(state.activeFingerprints as string[]);
    let resolved = 0;
    for (const row of page.page) {
      if (
        row.fingerprint.startsWith("proactive:")
        && !active.has(row.fingerprint)
        && ["open", "working"].includes(row.status)
      ) {
        const result = await upsertAttentionWithContext(ctx, row, { ...row, status: "resolved" });
        if (result.changed) resolved += 1;
      }
    }

    const now = Date.now();
    if (page.isDone) {
      await ctx.db.patch(state._id, {
        legacyCursor: undefined,
        legacyComplete: true,
        legacyScheduledAt: undefined,
        updatedAt: now,
      });
      return { complete: true, processed: page.page.length, resolved };
    }
    await ctx.scheduler.runAfter(100, proactiveInternal.backfillLegacyAttention, {
      version: PROACTIVE_STATE_VERSION,
      cursor: page.continueCursor,
    });
    await ctx.db.patch(state._id, {
      legacyCursor: page.continueCursor,
      legacyScheduledAt: now,
      updatedAt: now,
    });
    return { complete: false, processed: page.page.length, resolved };
  },
});
