import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { requireWorker } from "./controlAuth";
import { countGeneralFleetDemand, deriveProactiveSignals } from "./proactivePolicy";
import { runtimeJob } from "./controlPlane";

export const PROACTIVE_ATTENTION_MAX = 24;
export const PROACTIVE_AUTHORITY_MIGRATION_PAGE = 12;
const PROACTIVE_AUTHORITY = "proactive";
const PROACTIVE_AUTHORITY_MIGRATION = "proactive-attention-authority-v1";

export async function migrateProactiveAttentionAuthority(ctx: any) {
  let state = await ctx.db.query("attentionAuthorityMigrations")
    .withIndex("by_key", (q: any) => q.eq("key", PROACTIVE_AUTHORITY_MIGRATION)).first();
  if (!state) {
    const id = await ctx.db.insert("attentionAuthorityMigrations", {
      key: PROACTIVE_AUTHORITY_MIGRATION, complete: false, scanned: 0, repaired: 0, updatedAt: Date.now(),
    });
    state = await ctx.db.get(id);
  }
  if (state.complete) return { scanned: 0, repaired: 0, complete: true };
  const page = await ctx.db.query("attentionItems").withIndex("by_updatedAt").order("asc").paginate({
    cursor: state.cursor ?? null,
    numItems: PROACTIVE_AUTHORITY_MIGRATION_PAGE,
    maximumRowsRead: PROACTIVE_AUTHORITY_MIGRATION_PAGE,
  });
  let repaired = 0;
  for (const row of page.page) {
    if (!row.authority && row.fingerprint.startsWith("proactive:")) {
      await ctx.db.patch(row._id, { authority: PROACTIVE_AUTHORITY });
      repaired += 1;
    }
  }
  await ctx.db.patch(state._id, {
    cursor: page.isDone ? undefined : page.continueCursor,
    complete: page.isDone,
    scanned: Number(state.scanned ?? 0) + page.page.length,
    repaired: Number(state.repaired ?? 0) + repaired,
    updatedAt: Date.now(),
  });
  return { scanned: page.page.length, repaired, complete: page.isDone };
}

export const reconcile = mutation({
  args: { now: v.number(), workerToken: v.string() },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const authorityMigration = await migrateProactiveAttentionAuthority(ctx);
    const [blockedGoals, pendingJobs, dispatchingJobs, runningJobs, failedJobs, existingAttention] = await Promise.all([
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
      ctx.db.query("attentionItems")
        .withIndex("by_authority_status", (q: any) => q.eq("authority", PROACTIVE_AUTHORITY).eq("status", "open"))
        .take(PROACTIVE_ATTENTION_MAX),
    ]);
    const projectedJobs = [...pendingJobs, ...dispatchingJobs, ...runningJobs, ...failedJobs].map(runtimeJob);
    const signals = deriveProactiveSignals({
      goals: blockedGoals,
      jobs: projectedJobs,
      now: a.now,
    });
    const missionIds = [...new Set(pendingJobs.map((job: any) => job.missionId).filter(Boolean))];
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
    const priorByFingerprint = new Map(existingAttention.map((item: any) => [item.fingerprint, item]));
    const activeFingerprints = new Set(signals.map((signal) => signal.fingerprint));
    const newInterruptions: string[] = [];

    for (const signal of signals) {
      const prior: any = priorByFingerprint.get(signal.fingerprint);
      const item = { ...signal, authority: PROACTIVE_AUTHORITY, status: "open", updatedAt: a.now };
      if (prior) await ctx.db.patch(prior._id, item);
      else {
        const legacy = await ctx.db.query("attentionItems")
          .withIndex("by_fingerprint", (q: any) => q.eq("fingerprint", signal.fingerprint)).first();
        if (legacy) await ctx.db.patch(legacy._id, item);
        else {
          await ctx.db.insert("attentionItems", { ...item, createdAt: a.now });
          if (signal.severity === "critical" && signal.actionClass === "ask") newInterruptions.push(signal.title);
        }
      }
    }

    for (const item of existingAttention) {
      if (
        item.fingerprint.startsWith("proactive:") &&
        !activeFingerprints.has(item.fingerprint) &&
        item.status !== "resolved"
      ) {
        await ctx.db.patch(item._id, { status: "resolved", updatedAt: a.now });
      }
    }

    return {
      signals: signals.length,
      newInterruptions,
      // Goal Mode has its own five-minute owner. Excluding those leases here
      // prevents the general ten-minute insight sweep from creating redundant
      // fleet reservations for the same goal transition.
      eligiblePending: countGeneralFleetDemand({ jobs: pendingJobs.map(runtimeJob), goalMissionIds, now: a.now }),
      authorityMigration,
    };
  },
});
