import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { actorAuthArgs, requireActor, requireViewer, viewerAuthArgs } from "./controlAuth";
import { safeMemoryNote } from "../src/lib/memory-safety";
import { memoryConfidence, memoryDedupeKey } from "../src/lib/memory-governance";

const SOURCE_MESSAGE_ID = /^[A-Za-z0-9_-]{1,180}$/;

function activeMemory(row: { expiresAt?: number }, now: number): boolean {
  return row.expiresAt === undefined || row.expiresAt > now;
}

// Write a memory row. Full/long bodies live in R2 (r2Key); this row is the
// reactive index + a short/distilled body for quick recall.
export const write = mutation({
  args: {
    kind: v.string(), // "daily" | "knowledge" | "weekly" | "fact" | "project"
    title: v.string(),
    body: v.string(),
    tags: v.optional(v.array(v.string())),
    r2Key: v.optional(v.string()),
    confidence: v.optional(v.number()),
    sourceMessageId: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
    ...actorAuthArgs,
  },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const note = safeMemoryNote(a.title, a.body);
    if (!note) throw new Error("Memory rejected by secret-safety policy");
    const now = Date.now();
    const kind = a.kind.slice(0, 40).toLocaleLowerCase("en-US");
    const dedupeKey = memoryDedupeKey(kind, note.title);
    const sourceMessageId = a.sourceMessageId && SOURCE_MESSAGE_ID.test(a.sourceMessageId)
      ? a.sourceMessageId
      : undefined;
    if (a.sourceMessageId && !sourceMessageId) throw new Error("Memory source message id is invalid");
    if (a.expiresAt !== undefined && (!Number.isFinite(a.expiresAt) || a.expiresAt <= now || a.expiresAt > now + 10 * 365 * 24 * 60 * 60 * 1_000)) {
      throw new Error("Memory expiration is invalid");
    }
    const confidence = memoryConfidence(a.confidence, 0.7);
    const common = {
      kind,
      title: note.title.slice(0, 180),
      body: note.body.slice(0, 4_000),
      tags: (a.tags ?? []).slice(0, 12).map((tag) => tag.slice(0, 48)),
      r2Key: a.r2Key?.slice(0, 300),
      dedupeKey: dedupeKey ?? undefined,
      confidence,
      expiresAt: a.expiresAt,
      updatedAt: now,
      lastConfirmedAt: now,
    };
    const existing = dedupeKey
      ? await ctx.db.query("memory").withIndex("by_dedupeKey", (q) => q.eq("dedupeKey", dedupeKey)).first()
      : null;
    if (existing) {
      const sourceMessageIds = [...new Set([...(existing.sourceMessageIds ?? []), ...(sourceMessageId ? [sourceMessageId] : [])])].slice(-8);
      await ctx.db.patch(existing._id, {
        ...common,
        sourceMessageIds: sourceMessageIds.length ? sourceMessageIds : undefined,
        revision: Math.max(1, Number(existing.revision ?? 1) + 1),
      });
      return existing._id;
    }
    return await ctx.db.insert("memory", {
      ...common,
      sourceMessageIds: sourceMessageId ? [sourceMessageId] : undefined,
      revision: 1,
      createdAt: now,
    });
  },
});

export const recent = query({
  args: { kind: v.optional(v.string()), limit: v.optional(v.number()), ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    const lim = Math.max(1, Math.min(a.limit ?? 20, 30));
    const now = Date.now();
    if (a.kind) {
      const kind = a.kind;
      const rows = await ctx.db
        .query("memory")
        .withIndex("by_kind", (q) => q.eq("kind", kind))
        .order("desc")
        .take(Math.min(lim * 3, 90));
      return rows.filter((row) => activeMemory(row, now)).slice(0, lim);
    }
    const rows = await ctx.db.query("memory").withIndex("by_createdAt").order("desc").take(Math.min(lim * 3, 90));
    return rows.filter((row) => activeMemory(row, now)).slice(0, lim);
  },
});

// Indexed lexical search: the previous implementation read the latest 400
// rows on every conversation turn, which was the dominant avoidable Convex IO.
export const search = query({
  args: { q: v.string(), limit: v.optional(v.number()), ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    const lim = Math.max(1, Math.min(a.limit ?? 20, 30));
    const needle = a.q.trim().slice(0, 240);
    if (!needle) return [];
    const rows = await ctx.db
      .query("memory")
      .withSearchIndex("search_body", (q) => q.search("body", needle))
      .take(Math.min(lim * 3, 90));
    return rows.filter((row) => activeMemory(row, Date.now())).slice(0, lim);
  },
});
