import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const upsert = mutation({
  args: {
    fingerprint: v.string(),
    project: v.optional(v.string()),
    title: v.string(),
    detail: v.string(),
    evidence: v.optional(v.array(v.string())),
    severity: v.string(),
    impact: v.number(),
    urgency: v.number(),
    confidence: v.number(),
    actionClass: v.string(),
    status: v.optional(v.string()),
    jobId: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const existing = await ctx.db
      .query("attentionItems")
      .withIndex("by_fingerprint", (q: any) => q.eq("fingerprint", a.fingerprint))
      .first();
    const now = Date.now();
    const doc = {
      ...a,
      title: a.title.slice(0, 140),
      detail: a.detail.slice(0, 2000),
      impact: Math.max(0, Math.min(100, a.impact)),
      urgency: Math.max(0, Math.min(100, a.urgency)),
      confidence: Math.max(0, Math.min(1, a.confidence)),
      status: a.status ?? existing?.status ?? "open",
      updatedAt: now,
    };
    if (existing) {
      await ctx.db.patch(existing._id, doc);
      return existing._id;
    }
    return await ctx.db.insert("attentionItems", { ...doc, createdAt: now });
  },
});

export const list = query({
  args: { status: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, a) => {
    const limit = Math.min(a.limit ?? 20, 60);
    const rows = a.status
      ? await ctx.db
          .query("attentionItems")
          .withIndex("by_status", (q: any) => q.eq("status", a.status))
          .order("desc")
          .take(limit)
      : await ctx.db.query("attentionItems").withIndex("by_updatedAt").order("desc").take(limit);
    return rows.sort(
      (x: any, y: any) => y.impact * y.urgency * y.confidence - x.impact * x.urgency * x.confidence,
    );
  },
});

export const resolve = mutation({
  args: { id: v.id("attentionItems"), status: v.string() },
  handler: async (ctx, a) => {
    await ctx.db.patch(a.id, { status: a.status, updatedAt: Date.now() });
  },
});

