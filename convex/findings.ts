import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { actorAuthArgs, requireActor, requireViewer, viewerAuthArgs } from "./controlAuth";
import { requestContextRefresh } from "./contextProjection";

// Agent findings queue: runner adds, brain weaves into conversation, panel shows detail.

export const add = mutation({
  args: { source: v.string(), spoken: v.string(), detail: v.string(), ...actorAuthArgs },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const id = await ctx.db.insert("findings", {
      source: a.source.slice(0, 300),
      spoken: a.spoken.slice(0, 500),
      detail: a.detail.slice(0, 8000),
      status: "fresh",
      createdAt: Date.now(),
    });
    await requestContextRefresh(ctx, ["work"]);
    return id;
  },
});

export const fresh = query({
  args: { ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    return (
    await ctx.db
      .query("findings")
      .withIndex("by_status", (q: any) => q.eq("status", "fresh"))
      .order("desc")
      .take(20)
    );
  },
});

export const recent = query({
  args: { limit: v.optional(v.number()), ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    return await ctx.db
      .query("findings")
      .withIndex("by_createdAt")
      .order("desc")
      .take(Math.min(a.limit ?? 6, 50));
  },
});

export const get = query({
  args: { id: v.id("findings"), ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    return ctx.db.get(a.id);
  },
});

// Deterministic card cache: /api/distill screens each already-reviewed Codex
// finding once and stores the short bullet breakdown without another model.
export const distill = mutation({
  args: { id: v.id("findings"), bullets: v.array(v.string()), important: v.boolean(), ...actorAuthArgs },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    await ctx.db.patch(a.id, { bullets: a.bullets, important: a.important });
  },
});

export const markWoven = mutation({
  args: { ids: v.array(v.id("findings")), ...actorAuthArgs },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    let changed = 0;
    for (const id of a.ids.slice(0, 50)) {
      const row = await ctx.db.get(id);
      if (!row || row.status === "woven") continue;
      await ctx.db.patch(id, { status: "woven" });
      changed += 1;
    }
    if (changed) await requestContextRefresh(ctx, ["work"]);
  },
});
