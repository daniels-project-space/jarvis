import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { actorAuthArgs, requireActor, requireViewer, viewerAuthArgs } from "./controlAuth";
import { requestContextRefresh } from "./contextProjection";

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
    if (
      existing
      && existing.headline === a.headline
      && existing.detail === a.detail
      && JSON.stringify(existing.data ?? null) === JSON.stringify(a.data ?? null)
    ) return existing._id;
    const row = { domain: a.domain, headline: a.headline, detail: a.detail, data: a.data, updatedAt: Date.now() };
    const id = existing ? existing._id : await ctx.db.insert("businessState", row);
    if (existing) await ctx.db.patch(existing._id, row);
    await requestContextRefresh(ctx, ["business"]);
    return id;
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
