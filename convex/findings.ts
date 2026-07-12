import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// Agent findings queue: runner adds, brain weaves into conversation, panel shows detail.

export const add = mutation({
  args: { source: v.string(), spoken: v.string(), detail: v.string() },
  handler: async (ctx, a) => {
    return await ctx.db.insert("findings", {
      source: a.source.slice(0, 300),
      spoken: a.spoken.slice(0, 500),
      detail: a.detail.slice(0, 8000),
      status: "fresh",
      createdAt: Date.now(),
    });
  },
});

export const fresh = query({
  args: {},
  handler: async (ctx) =>
    await ctx.db
      .query("findings")
      .withIndex("by_status", (q: any) => q.eq("status", "fresh"))
      .collect(),
});

export const recent = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, a) => {
    const rows = await ctx.db.query("findings").collect();
    return rows.sort((x: any, y: any) => y.createdAt - x.createdAt).slice(0, a.limit ?? 6);
  },
});

export const get = query({
  args: { id: v.id("findings") },
  handler: async (ctx, a) => ctx.db.get(a.id),
});

// Card intelligence cache: /api/distill screens each finding once (worth
// showing at all?) and stores the short bullet breakdown.
export const distill = mutation({
  args: { id: v.id("findings"), bullets: v.array(v.string()), important: v.boolean() },
  handler: async (ctx, a) => {
    await ctx.db.patch(a.id, { bullets: a.bullets, important: a.important });
  },
});

export const markWoven = mutation({
  args: { ids: v.array(v.id("findings")) },
  handler: async (ctx, a) => {
    for (const id of a.ids) await ctx.db.patch(id, { status: "woven" });
  },
});
