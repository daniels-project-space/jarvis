import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const pending = query({
  args: {},
  handler: async (ctx) =>
    await ctx.db
      .query("approvals")
      .withIndex("by_status", (q: any) => q.eq("status", "pending"))
      .order("desc")
      .take(30),
});

export const decide = mutation({
  args: { jobId: v.string(), decision: v.union(v.literal("approved"), v.literal("declined")) },
  handler: async (ctx, a) => {
    const approval = await ctx.db
      .query("approvals")
      .withIndex("by_job", (q: any) => q.eq("jobId", a.jobId))
      .first();
    const jobId = ctx.db.normalizeId("jobs", a.jobId);
    const job = jobId ? await ctx.db.get(jobId) : null;
    if (!approval || approval.status !== "pending" || !jobId || !job || job.status !== "awaiting_approval") return false;
    await ctx.db.patch(approval._id, { status: a.decision, resolvedAt: Date.now() });
    await ctx.db.patch(jobId, {
      approvalStatus: a.decision,
      status: a.decision === "approved" ? "pending" : "cancelled",
      completedAt: a.decision === "declined" ? Date.now() : undefined,
      progress: a.decision === "approved" ? "approved — queued" : "declined by Daniel",
      stage: a.decision === "approved" ? "queued" : "cancelled",
    });
    await ctx.db.insert("workEvents", {
      jobId: a.jobId,
      type: "approval_decision",
      message: a.decision === "approved" ? "Daniel approved this work" : "Daniel declined this work",
      stage: a.decision === "approved" ? "queued" : "cancelled",
      createdAt: Date.now(),
    });
    return true;
  },
});
