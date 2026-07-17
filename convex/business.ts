import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { actorAuthArgs, requireActor, requireViewer, viewerAuthArgs } from "./controlAuth";

// Per-domain live business snapshots (rentals, youtube, music, wealth, ads).
export const upsert = mutation({
  args: {
    domain: v.string(),
    headline: v.string(),
    detail: v.optional(v.string()),
    data: v.optional(v.any()),
    ...actorAuthArgs,
  },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const existing = await ctx.db
      .query("businessState")
      .withIndex("by_domain", (q: any) => q.eq("domain", a.domain))
      .first();
    const row = { domain: a.domain, headline: a.headline, detail: a.detail, data: a.data, updatedAt: Date.now() };
    if (existing) await ctx.db.patch(existing._id, row);
    else await ctx.db.insert("businessState", row);
  },
});

export const list = query({
  args: { ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    const all = await ctx.db.query("businessState").collect();
    return all.sort((a: any, b: any) => a.domain.localeCompare(b.domain));
  },
});

export const get = query({
  args: { domain: v.string(), ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    return await ctx.db
      .query("businessState")
      .withIndex("by_domain", (q: any) => q.eq("domain", a.domain))
      .first();
  },
});

// Proactive insights the engine generates.
export const addInsight = mutation({
  args: { domain: v.string(), text: v.string(), severity: v.string(), ...actorAuthArgs },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    return await ctx.db.insert("insights", { domain: a.domain, text: a.text, severity: a.severity, surfaced: false, createdAt: Date.now() });
  },
});

export const recentInsights = query({
  args: { limit: v.optional(v.number()), ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    const all = await ctx.db.query("insights").withIndex("by_surfaced").order("desc").collect();
    return all.slice(0, a.limit ?? 20);
  },
});

export const unsurfacedInsights = query({
  args: { ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    return await ctx.db
      .query("insights")
      .withIndex("by_surfaced", (q: any) => q.eq("surfaced", false))
      .collect();
  },
});

export const markSurfaced = mutation({
  args: { id: v.id("insights"), ...actorAuthArgs },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    await ctx.db.patch(a.id, { surfaced: true });
  },
});
