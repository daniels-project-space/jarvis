import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { actorAuthArgs, requireActor, requireViewer, viewerAuthArgs } from "./controlAuth";

export const append = mutation({
  args: {
    jobId: v.optional(v.string()),
    missionId: v.optional(v.string()),
    agentId: v.optional(v.string()),
    type: v.string(),
    message: v.string(),
    stage: v.optional(v.string()),
    percent: v.optional(v.number()),
    data: v.optional(v.any()),
    ...actorAuthArgs,
  },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    return await ctx.db.insert("workEvents", {
      jobId: a.jobId,
      missionId: a.missionId,
      agentId: a.agentId,
      type: a.type,
      message: a.message.slice(0, 1200),
      stage: a.stage,
      percent: a.percent === undefined ? undefined : Math.max(0, Math.min(100, a.percent)),
      data: a.data,
      createdAt: Date.now(),
    });
  },
});

export const forJob = query({
  args: { jobId: v.string(), limit: v.optional(v.number()), ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    return await ctx.db
      .query("workEvents")
      .withIndex("by_job", (q: any) => q.eq("jobId", a.jobId))
      .order("desc")
      .take(Math.min(a.limit ?? 80, 200));
  },
});
