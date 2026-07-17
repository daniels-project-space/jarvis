import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { actorAuthArgs, requireActor, requireViewer, viewerAuthArgs } from "./controlAuth";

// Snapshot of each app's cloud-stack health, written by the stack-poller Trigger
// task and injected into the brain so JARVIS can answer "state of my apps".
export const upsert = mutation({
  args: {
    slug: v.string(),
    status: v.string(),
    summary: v.string(),
    data: v.optional(v.any()),
    ...actorAuthArgs,
  },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const ex = await ctx.db
      .query("projectState")
      .withIndex("by_slug", (q: any) => q.eq("slug", a.slug))
      .first();
    const doc = { slug: a.slug, status: a.status, summary: a.summary, data: a.data, updatedAt: Date.now() };
    if (ex) await ctx.db.patch(ex._id, doc);
    else await ctx.db.insert("projectState", doc);
  },
});

export const list = query({
  args: { ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    return (await ctx.db.query("projectState").collect()).sort((x: any, y: any) => x.slug.localeCompare(y.slug));
  },
});
