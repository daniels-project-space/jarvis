import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const enqueue = mutation({
  args: {
    task: v.string(),
    repo: v.optional(v.string()),
    readonly: v.optional(v.boolean()),
    model: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    return await ctx.db.insert("jobs", {
      task: a.task,
      repo: a.repo,
      readonly: a.readonly,
      model: a.model,
      status: "pending",
      createdAt: Date.now(),
    });
  },
});

export const claimNext = mutation({
  args: {},
  handler: async (ctx) => {
    const j = await ctx.db
      .query("jobs")
      .withIndex("by_status", (q: any) => q.eq("status", "pending"))
      .first();
    if (!j) return null;
    await ctx.db.patch(j._id, { status: "running", startedAt: Date.now() });
    return {
      jobId: j._id,
      task: j.task,
      repo: j.repo ?? null,
      readonly: j.readonly ?? false,
      model: j.model ?? null,
    };
  },
});

export const finalize = mutation({
  args: { jobId: v.id("jobs"), status: v.string(), result: v.optional(v.string()) },
  handler: async (ctx, a) => {
    await ctx.db.patch(a.jobId, { status: a.status, result: a.result });
  },
});

export const list = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, a) => {
    const all = await ctx.db.query("jobs").collect();
    return all.sort((x: any, y: any) => y.createdAt - x.createdAt).slice(0, a.limit ?? 20);
  },
});

// Live activity line the agent-runner streams as it works.
export const updateProgress = mutation({
  args: { jobId: v.id("jobs"), progress: v.string() },
  handler: async (ctx, a) => {
    await ctx.db.patch(a.jobId, { progress: a.progress.slice(0, 400) });
  },
});

// Currently-running / queued agents — drives the pills + progress bars + live view.
export const active = query({
  args: {},
  handler: async (ctx) => {
    const pending = await ctx.db
      .query("jobs")
      .withIndex("by_status", (q: any) => q.eq("status", "pending"))
      .collect();
    const running = await ctx.db
      .query("jobs")
      .withIndex("by_status", (q: any) => q.eq("status", "running"))
      .collect();
    return [...running, ...pending]
      .sort((a: any, b: any) => a.createdAt - b.createdAt)
      .map((j: any) => ({
        _id: j._id,
        task: j.task,
        repo: j.repo ?? null,
        model: j.model ?? null,
        status: j.status,
        progress: j.progress ?? "",
        startedAt: j.startedAt ?? j.createdAt,
      }));
  },
});
