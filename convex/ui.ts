import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const setPanel = mutation({
  args: { type: v.string(), value: v.string(), title: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const ex = await ctx.db.query("ui").withIndex("by_key", (q: any) => q.eq("key", "panel")).first();
    const doc = { key: "panel", type: a.type, value: a.value, title: a.title, updatedAt: Date.now() };
    if (ex) await ctx.db.patch(ex._id, doc);
    else await ctx.db.insert("ui", doc);
  },
});

export const clearPanel = mutation({
  args: {},
  handler: async (ctx) => {
    const ex = await ctx.db.query("ui").withIndex("by_key", (q: any) => q.eq("key", "panel")).first();
    if (ex) await ctx.db.delete(ex._id);
  },
});

export const getPanel = query({
  args: {},
  handler: async (ctx) => ctx.db.query("ui").withIndex("by_key", (q: any) => q.eq("key", "panel")).first(),
});
