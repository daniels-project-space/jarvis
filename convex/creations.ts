import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// JARVIS's atelier — everything he makes (mind maps, charts, images, PDFs,
// docs) is saved here so nothing he creates is ever lost. The UI lists it
// reactively; tools upsert while he works.

export const list = query({
  args: { kind: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, a) => {
    const limit = Math.min(a.limit ?? 40, 100);
    const rows = a.kind
      ? await ctx.db
          .query("creations")
          .withIndex("by_kind", (q: any) => q.eq("kind", a.kind))
          .order("desc")
          .take(limit)
      : await ctx.db
          .query("creations")
          .withIndex("by_updatedAt")
          .order("desc")
          .take(limit);
    return rows;
  },
});

export const get = query({
  args: { id: v.id("creations") },
  handler: async (ctx, a) => ctx.db.get(a.id),
});

// Find the most recently touched creation (optionally by kind/title match) —
// lets the brain say "add X to the mind map" without tracking ids.
export const latest = query({
  args: { kind: v.optional(v.string()), titleMatch: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const rows = await ctx.db.query("creations").withIndex("by_updatedAt").order("desc").take(50);
    const t = (a.titleMatch ?? "").toLowerCase();
    return (
      rows.find(
        (r: any) => (!a.kind || r.kind === a.kind) && (!t || r.title.toLowerCase().includes(t)),
      ) ?? null
    );
  },
});

export const create = mutation({
  args: {
    kind: v.string(),
    title: v.string(),
    data: v.optional(v.string()),
    url: v.optional(v.string()),
    thumb: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    return await ctx.db.insert("creations", {
      kind: a.kind,
      title: a.title.slice(0, 120),
      data: a.data,
      url: a.url,
      thumb: a.thumb,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  },
});

export const update = mutation({
  args: {
    id: v.id("creations"),
    title: v.optional(v.string()),
    data: v.optional(v.string()),
    url: v.optional(v.string()),
    thumb: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (a.title !== undefined) patch.title = a.title.slice(0, 120);
    if (a.data !== undefined) patch.data = a.data;
    if (a.url !== undefined) patch.url = a.url;
    if (a.thumb !== undefined) patch.thumb = a.thumb;
    await ctx.db.patch(a.id, patch);
    return a.id;
  },
});

export const remove = mutation({
  args: { id: v.id("creations") },
  handler: async (ctx, a) => {
    await ctx.db.delete(a.id);
  },
});
