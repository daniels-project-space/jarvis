import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { requireWorker } from "./controlAuth";
import { deriveProactiveSignals } from "./proactivePolicy";

export const reconcile = mutation({
  args: { now: v.number(), workerToken: v.string() },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const [blockedGoals, pendingJobs, runningJobs, failedJobs, existingAttention] = await Promise.all([
      ctx.db
        .query("projectGoals")
        .withIndex("by_status_priority", (q: any) => q.eq("status", "blocked"))
        .order("desc")
        .take(30),
      ctx.db.query("jobs").withIndex("by_status", (q: any) => q.eq("status", "pending")).take(100),
      ctx.db.query("jobs").withIndex("by_status", (q: any) => q.eq("status", "running")).take(100),
      ctx.db
        .query("jobs")
        .withIndex("by_status", (q: any) => q.eq("status", "error"))
        .order("desc")
        .take(30),
      ctx.db.query("attentionItems").collect(),
    ]);
    const signals = deriveProactiveSignals({
      goals: blockedGoals,
      jobs: [...pendingJobs, ...runningJobs, ...failedJobs],
      now: a.now,
    });
    const priorByFingerprint = new Map(existingAttention.map((item: any) => [item.fingerprint, item]));
    const activeFingerprints = new Set(signals.map((signal) => signal.fingerprint));
    const newInterruptions: string[] = [];

    for (const signal of signals) {
      const prior: any = priorByFingerprint.get(signal.fingerprint);
      const item = { ...signal, status: "open", updatedAt: a.now };
      if (prior) await ctx.db.patch(prior._id, item);
      else {
        await ctx.db.insert("attentionItems", { ...item, createdAt: a.now });
        if (signal.severity === "critical" && signal.actionClass === "ask") newInterruptions.push(signal.title);
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
      eligiblePending: pendingJobs.filter((job: any) => (job.nextRunAt ?? job.createdAt) <= a.now).length,
    };
  },
});
