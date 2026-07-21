import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { actorAuthArgs, requireActor, requireViewer, viewerAuthArgs } from "./controlAuth";

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
    ...actorAuthArgs,
  },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const { authTokenHash: _authTokenHash, workerToken: _workerToken, ...input } = a;
    const existing = await ctx.db
      .query("attentionItems")
      .withIndex("by_fingerprint", (q: any) => q.eq("fingerprint", a.fingerprint))
      .first();
    const now = Date.now();
    const doc = {
      ...input,
      title: input.title.slice(0, 140),
      detail: input.detail.slice(0, 2000),
      impact: Math.max(0, Math.min(100, input.impact)),
      urgency: Math.max(0, Math.min(100, input.urgency)),
      confidence: Math.max(0, Math.min(1, input.confidence)),
      status: input.status ?? existing?.status ?? "open",
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
  args: { status: v.optional(v.string()), limit: v.optional(v.number()), ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    const limit = Math.min(a.limit ?? 20, 60);
    // The default is the active queue. Historical/resolved rows require an
    // explicit status so routine health and activity surfaces cannot revive
    // resolved work merely because it was updated recently.
    const status = a.status ?? "open";
    const rows = await ctx.db
      .query("attentionItems")
      .withIndex("by_status", (q: any) => q.eq("status", status))
      .order("desc")
      .take(limit);
    return rows.sort(
      (x: any, y: any) => y.impact * y.urgency * y.confidence - x.impact * x.urgency * x.confidence,
    );
  },
});

export const resolve = mutation({
  args: { id: v.id("attentionItems"), status: v.string(), ...actorAuthArgs },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    await ctx.db.patch(a.id, { status: a.status, updatedAt: Date.now() });
  },
});
