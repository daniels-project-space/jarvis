import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { actorAuthArgs, requireActor, requireWorker } from "./controlAuth";

export const saveSub = mutation({
  args: { endpoint: v.string(), keys: v.object({ p256dh: v.string(), auth: v.string() }), ...actorAuthArgs },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const ex = await ctx.db
      .query("pushSubs")
      .withIndex("by_endpoint", (q: any) => q.eq("endpoint", a.endpoint))
      .first();
    if (ex) return ex._id;
    return await ctx.db.insert("pushSubs", { endpoint: a.endpoint, keys: a.keys, createdAt: Date.now() });
  },
});

export const listSubs = query({
  args: { workerToken: v.optional(v.string()) },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    return (await ctx.db.query("pushSubs").collect()).map((s: any) => ({ endpoint: s.endpoint, keys: s.keys }));
  },
});

export const deleteSub = mutation({
  args: { endpoint: v.string(), ...actorAuthArgs },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const ex = await ctx.db
      .query("pushSubs")
      .withIndex("by_endpoint", (q: any) => q.eq("endpoint", a.endpoint))
      .first();
    if (ex) await ctx.db.delete(ex._id);
  },
});
