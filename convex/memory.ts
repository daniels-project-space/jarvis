import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { actorAuthArgs, requireActor, requireViewer, viewerAuthArgs } from "./controlAuth";
import { safeMemoryNote } from "../src/lib/memory-safety";

// Write a memory row. Full/long bodies live in R2 (r2Key); this row is the
// reactive index + a short/distilled body for quick recall.
export const write = mutation({
  args: {
    kind: v.string(), // "daily" | "knowledge" | "weekly" | "fact" | "project"
    title: v.string(),
    body: v.string(),
    tags: v.optional(v.array(v.string())),
    r2Key: v.optional(v.string()),
    ...actorAuthArgs,
  },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const note = safeMemoryNote(a.title, a.body);
    if (!note) throw new Error("Memory rejected by secret-safety policy");
    const now = Date.now();
    return await ctx.db.insert("memory", {
      kind: a.kind.slice(0, 40),
      title: note.title.slice(0, 180),
      body: note.body.slice(0, 4_000),
      tags: (a.tags ?? []).slice(0, 12).map((tag) => tag.slice(0, 48)),
      r2Key: a.r2Key?.slice(0, 300),
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const recent = query({
  args: { kind: v.optional(v.string()), limit: v.optional(v.number()), ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    const lim = a.limit ?? 20;
    if (a.kind) {
      const kind = a.kind;
      return await ctx.db
        .query("memory")
        .withIndex("by_kind", (q) => q.eq("kind", kind))
        .order("desc")
        .take(lim);
    }
    return await ctx.db.query("memory").withIndex("by_createdAt").order("desc").take(lim);
  },
});

// Indexed lexical search: the previous implementation read the latest 400
// rows on every conversation turn, which was the dominant avoidable Convex IO.
export const search = query({
  args: { q: v.string(), limit: v.optional(v.number()), ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    const lim = a.limit ?? 20;
    const needle = a.q.trim().slice(0, 240);
    if (!needle) return [];
    return await ctx.db
      .query("memory")
      .withSearchIndex("search_body", (q) => q.search("body", needle))
      .take(Math.min(lim, 30));
  },
});
