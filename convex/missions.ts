import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// Orchestration layer: a mission is a decomposed goal running as a fleet of
// parallel agent jobs. The runner calls checkComplete after every job — the
// LAST one to land flips the mission to "synthesizing" exactly once, and the
// runner then merges all results into a single report.

export const create = mutation({
  args: { goal: v.string(), agentCount: v.number() },
  handler: async (ctx, a) => {
    return await ctx.db.insert("missions", {
      goal: a.goal.slice(0, 500),
      status: "running",
      agentCount: a.agentCount,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  },
});

export const get = query({
  args: { id: v.id("missions") },
  handler: async (ctx, a) => ctx.db.get(a.id),
});

// Missions still in flight (or just finished) + their jobs, for the fleet view.
export const active = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("missions").withIndex("by_status").order("desc").take(12);
    const live = rows.filter(
      (m: any) => m.status === "running" || m.status === "synthesizing" || Date.now() - m.updatedAt < 10 * 60 * 1000,
    );
    const out = [];
    for (const m of live) {
      const jobs = await ctx.db
        .query("jobs")
        .withIndex("by_mission", (q: any) => q.eq("missionId", m._id))
        .collect();
      out.push({
        _id: m._id,
        goal: m.goal,
        status: m.status,
        agentCount: m.agentCount,
        summary: m.summary ?? null,
        updatedAt: m.updatedAt,
        jobs: jobs.map((j: any) => ({
          _id: j._id,
          label: j.label ?? j.task.slice(0, 50),
          status: j.status,
          progress: j.progress ?? "",
          model: j.model ?? null,
        })),
      });
    }
    return out;
  },
});

// Atomically claim the synthesis step: returns the finished jobs ONLY for the
// single caller that flips running → synthesizing (no double reports).
export const checkComplete = mutation({
  args: { id: v.id("missions") },
  handler: async (ctx, a) => {
    const m = await ctx.db.get(a.id);
    if (!m || m.status !== "running") return null;
    const jobs = await ctx.db
      .query("jobs")
      .withIndex("by_mission", (q: any) => q.eq("missionId", a.id))
      .collect();
    if (jobs.length === 0) return null;
    const unfinished = jobs.filter((j: any) => j.status === "pending" || j.status === "running");
    if (unfinished.length > 0) return null;
    await ctx.db.patch(a.id, { status: "synthesizing", updatedAt: Date.now() });
    return {
      goal: m.goal,
      results: jobs.map((j: any) => ({
        label: j.label ?? j.task.slice(0, 60),
        status: j.status,
        result: (j.result ?? "").slice(0, 6000),
      })),
    };
  },
});

export const finish = mutation({
  args: { id: v.id("missions"), summary: v.string(), failed: v.optional(v.boolean()) },
  handler: async (ctx, a) => {
    await ctx.db.patch(a.id, {
      status: a.failed ? "failed" : "done",
      summary: a.summary.slice(0, 4000),
      updatedAt: Date.now(),
    });
  },
});
