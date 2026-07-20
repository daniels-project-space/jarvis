import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireActor, requireViewer, viewerAuthArgs } from "./controlAuth";
import { patchJobWithRuntime } from "./controlPlane";

export const pending = query({
  args: { ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    return await ctx.db
      .query("approvals")
      .withIndex("by_status", (q: any) => q.eq("status", "pending"))
      .order("desc")
      .take(30);
  },
});

export const decide = mutation({
  args: {
    jobId: v.string(),
    decision: v.union(v.literal("approved"), v.literal("declined")),
    authTokenHash: v.optional(v.string()),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const approvals = await ctx.db
      .query("approvals")
      .withIndex("by_job", (q: any) => q.eq("jobId", a.jobId))
      .take(20);
    const approval = approvals.find((row) => row.status === "pending");
    const jobId = ctx.db.normalizeId("jobs", a.jobId);
    const job = jobId ? await ctx.db.get(jobId) : null;
    if (!approval || approval.status !== "pending" || !jobId || !job || job.status !== "awaiting_approval") return false;
    const missionId = job.missionId ? ctx.db.normalizeId("missions", job.missionId) : null;
    const mission = missionId ? await ctx.db.get(missionId) : null;
    const heldByGoal = mission?.mode === "goal" && mission.status !== "running";
    await ctx.db.patch(approval._id, { status: a.decision, resolvedAt: Date.now() });
    await patchJobWithRuntime(ctx, job, {
      approvalStatus: a.decision,
      status: a.decision === "approved" ? (heldByGoal ? "paused" : "pending") : "cancelled",
      completedAt: a.decision === "declined" ? Date.now() : undefined,
      progress: a.decision === "approved"
        ? heldByGoal ? "approved — held until Goal Mode resumes" : "approved — queued"
        : "declined by Daniel",
      stage: a.decision === "approved" ? (heldByGoal ? "paused" : "queued") : "cancelled",
      nextRunAt: a.decision === "approved" && !heldByGoal ? Date.now() : undefined,
    });
    await ctx.db.insert("workEvents", {
      jobId: a.jobId,
      missionId: job.missionId,
      agentId: job.agentId,
      type: "approval_decision",
      message: a.decision === "approved" ? "Daniel approved this work" : "Daniel declined this work",
      stage: a.decision === "approved" ? (heldByGoal ? "paused" : "queued") : "cancelled",
      createdAt: Date.now(),
    });
    return true;
  },
});
