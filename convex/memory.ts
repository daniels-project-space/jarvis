import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { actorAuthArgs, requireActor, requireViewer, requireWorker, viewerAuthArgs } from "./controlAuth";
import { safeMemoryNote } from "../src/lib/memory-safety";
import { memoryConfidence, memoryDedupeKey } from "../src/lib/memory-governance";

const SOURCE_MESSAGE_ID = /^[A-Za-z0-9_-]{1,180}$/;
const OBSIDIAN_RECONCILIATION_KEY = "obsidian-memory-vault-v1";
const OBSIDIAN_RECONCILIATION_PAGE_SIZE = 30;

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

/**
 * Begin (or resume) one bounded snapshot of canonical memory for the
 * Git-backed Obsidian mirror. Trigger advances it only after Git has accepted
 * the matching page, so a retry can repeat a page but cannot skip one.
 */
export const beginObsidianReconciliation = mutation({
  args: { workerToken: v.optional(v.string()) },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const existing = await ctx.db
      .query("memoryVaultReconciliations")
      .withIndex("by_key", (q) => q.eq("key", OBSIDIAN_RECONCILIATION_KEY))
      .first();
    if (existing && !existing.complete) {
      return {
        cycle: existing.cycle,
        cutoffAt: existing.cutoffAt,
        ...(existing.cursor ? { cursor: existing.cursor } : {}),
      };
    }

    const cutoffAt = Date.now();
    if (existing) {
      const cycle = existing.cycle + 1;
      await ctx.db.patch(existing._id, { cycle, cutoffAt, cursor: undefined, complete: false, updatedAt: cutoffAt });
      return { cycle, cutoffAt };
    } else {
      await ctx.db.insert("memoryVaultReconciliations", {
        key: OBSIDIAN_RECONCILIATION_KEY,
        cycle: 1,
        cutoffAt,
        complete: false,
        updatedAt: cutoffAt,
      });
      return { cycle: 1, cutoffAt };
    }
  },
});

/** Read exactly the currently claimed reconciliation page. */
export const obsidianReconciliationPage = query({
  args: {
    cycle: v.number(),
    cutoffAt: v.number(),
    cursor: v.optional(v.string()),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const state = await ctx.db
      .query("memoryVaultReconciliations")
      .withIndex("by_key", (q) => q.eq("key", OBSIDIAN_RECONCILIATION_KEY))
      .first();
    if (
      !state ||
      state.complete ||
      state.cycle !== a.cycle ||
      state.cutoffAt !== a.cutoffAt ||
      (state.cursor ?? undefined) !== (a.cursor ?? undefined)
    ) {
      throw new Error("Obsidian reconciliation page is stale");
    }

    // The cutoff freezes this cycle's view. A row revised after it is handled
    // in the following cycle instead of being lost behind a moving cursor.
    const page = await ctx.db
      .query("memory")
      .withIndex("by_updatedAt", (q) => q.lte("updatedAt", state.cutoffAt))
      .order("asc")
      .paginate({
        cursor: a.cursor ?? null,
        numItems: OBSIDIAN_RECONCILIATION_PAGE_SIZE,
        maximumRowsRead: OBSIDIAN_RECONCILIATION_PAGE_SIZE,
      });
    return {
      items: page.page
        .filter((row) => activeMemory(row, Date.now()))
        .map(({ kind, title, body, tags }) => ({ kind, title, body, tags })),
      isDone: page.isDone,
      ...(!page.isDone ? { continueCursor: page.continueCursor } : {}),
    };
  },
});

/** Advance only the page that was actually claimed; successful retries are idempotent. */
export const advanceObsidianReconciliation = mutation({
  args: {
    cycle: v.number(),
    cutoffAt: v.number(),
    fromCursor: v.optional(v.string()),
    continueCursor: v.optional(v.string()),
    complete: v.boolean(),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    if (a.complete && a.continueCursor) throw new Error("Completed reconciliation cannot retain a cursor");
    if (!a.complete && !a.continueCursor) throw new Error("Incomplete reconciliation requires a cursor");
    const state = await ctx.db
      .query("memoryVaultReconciliations")
      .withIndex("by_key", (q) => q.eq("key", OBSIDIAN_RECONCILIATION_KEY))
      .first();
    if (!state || state.cycle !== a.cycle || state.cutoffAt !== a.cutoffAt) {
      throw new Error("Obsidian reconciliation checkpoint is stale");
    }

    const currentCursor = state.cursor ?? undefined;
    const nextCursor = a.complete ? undefined : a.continueCursor;
    if (state.complete === a.complete && currentCursor === nextCursor) {
      return { ok: true, idempotent: true, complete: state.complete };
    }
    if (state.complete || currentCursor !== (a.fromCursor ?? undefined)) {
      throw new Error("Obsidian reconciliation checkpoint is stale");
    }
    await ctx.db.patch(state._id, {
      cursor: nextCursor,
      complete: a.complete,
      updatedAt: Date.now(),
    });
    return { ok: true, idempotent: false, complete: a.complete };
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

/** Owner-visible command-palette projection; storage/provenance fields stay server-side. */
export const quickSearch = query({
  args: { q: v.string(), limit: v.optional(v.number()), ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    const lim = Math.max(1, Math.min(a.limit ?? 8, 12));
    const needle = a.q.trim().slice(0, 120);
    if (needle.length < 2) return [];
    const take = Math.min(lim * 2, 24);
    const [titleRows, bodyRows] = await Promise.all([
      ctx.db.query("memory").withSearchIndex("search_title", (q) => q.search("title", needle)).take(take),
      ctx.db.query("memory").withSearchIndex("search_body", (q) => q.search("body", needle)).take(take),
    ]);
    const rows = [...new Map([...titleRows, ...bodyRows].map((row) => [row._id, row])).values()];
    return rows
      .filter((row) => activeMemory(row, Date.now()))
      .slice(0, lim)
      .map(({ _id, title, body, kind, tags }) => ({ _id, title, body, kind, tags }));
  },
});
