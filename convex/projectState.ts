import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { actorAuthArgs, requireActor, requireViewer, viewerAuthArgs } from "./controlAuth";
import { requestContextRefresh } from "./contextProjection";

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
    if (
      ex
      && ex.status === a.status
      && ex.summary === a.summary
      && JSON.stringify(ex.data ?? null) === JSON.stringify(a.data ?? null)
    ) return ex._id;
    const doc = { slug: a.slug, status: a.status, summary: a.summary, data: a.data, updatedAt: Date.now() };
    const id = ex ? ex._id : await ctx.db.insert("projectState", doc);
    if (ex) await ctx.db.patch(ex._id, doc);
    await requestContextRefresh(ctx, ["projects"]);
    return id;
  },
});

// One bounded batch replaces a Vercel poller's N mutations. Unchanged provider
// snapshots do not rewrite rows, so reactive clients and Convex storage only
// wake when project truth actually changes.
export const sync = mutation({
  args: {
    projects: v.array(v.object({ slug: v.string(), status: v.string(), summary: v.string(), data: v.optional(v.any()) })),
    ...actorAuthArgs,
  },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const inputs = a.projects.slice(0, 80);
    const current = await Promise.all(
      inputs.map((input) =>
        ctx.db
          .query("projectState")
          .withIndex("by_slug", (q: any) => q.eq("slug", input.slug.slice(0, 80)))
          .first(),
      ),
    );
    const bySlug = new Map(current.filter(Boolean).map((row: any) => [row.slug, row]));
    const changed: string[] = [];
    for (const input of inputs) {
      const row = bySlug.get(input.slug);
      const doc = {
        slug: input.slug.slice(0, 80),
        status: input.status.slice(0, 40),
        summary: input.summary.slice(0, 800),
        data: input.data,
      };
      if (row && row.status === doc.status && row.summary === doc.summary && JSON.stringify(row.data ?? null) === JSON.stringify(doc.data ?? null)) continue;
      const next = { ...doc, updatedAt: Date.now() };
      if (row) await ctx.db.patch(row._id, next);
      else await ctx.db.insert("projectState", next);
      changed.push(doc.slug);
    }
    if (changed.length) await requestContextRefresh(ctx, ["projects"]);
    return { changed, total: a.projects.length };
  },
});

export const list = query({
  args: { ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    return (await ctx.db.query("projectState").collect()).sort((x: any, y: any) => x.slug.localeCompare(y.slug));
  },
});
