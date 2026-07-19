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

// Mission events are intentionally a read model. Pause and resume entries are
// written by Goal Mode control and remain in chronological order here; this
// query neither advances work nor acknowledges any outbox.
export const forMission = query({
  args: { missionId: v.string(), limit: v.optional(v.number()), ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    const rows = await ctx.db
      .query("workEvents")
      .withIndex("by_mission", (q: any) => q.eq("missionId", a.missionId))
      .order("desc")
      .take(Math.min(Math.max(a.limit ?? 80, 1), 200));
    // Do not expose arbitrary event payloads to the panel. The durable event
    // fields are enough to audit stage changes, including pause and resume.
    // Fetch the newest bounded slice, then restore chronological display order
    // so a multi-day mission cannot hide its latest pause behind old events.
    return rows.reverse().map((event: any) => ({
      _id: event._id,
      jobId: event.jobId ?? null,
      agentId: event.agentId ?? null,
      type: event.type,
      message: event.message,
      stage: event.stage ?? null,
      percent: event.percent ?? null,
      createdAt: event.createdAt,
    }));
  },
});
