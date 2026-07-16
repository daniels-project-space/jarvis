import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

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
  },
  handler: async (ctx, a) =>
    await ctx.db.insert("workEvents", {
      ...a,
      message: a.message.slice(0, 1200),
      percent: a.percent === undefined ? undefined : Math.max(0, Math.min(100, a.percent)),
      createdAt: Date.now(),
    }),
});

export const forJob = query({
  args: { jobId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, a) =>
    await ctx.db
      .query("workEvents")
      .withIndex("by_job", (q: any) => q.eq("jobId", a.jobId))
      .order("desc")
      .take(Math.min(a.limit ?? 80, 200)),
});

