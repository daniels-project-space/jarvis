import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// Price watches: JARVIS re-checks a product's cheapest price on a schedule and
// pings Daniel when it drops below his target (or drops meaningfully). The
// agent-runner cron drives the re-checks.
export const add = mutation({
  args: { query: v.string(), targetGbp: v.optional(v.number()), lastGbp: v.optional(v.number()) },
  handler: async (ctx, a) => {
    return await ctx.db.insert("watches", {
      query: a.query.slice(0, 160),
      targetGbp: a.targetGbp,
      lastGbp: a.lastGbp,
      status: "active",
      checkedAt: Date.now(),
      createdAt: Date.now(),
    });
  },
});

// Watches due for a re-check (every ~3h), oldest first, a few per sweep.
export const due = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("watches")
      .withIndex("by_status", (q: any) => q.eq("status", "active"))
      .collect();
    const cutoff = Date.now() - 3 * 3600_000;
    return rows.filter((r: any) => (r.checkedAt ?? 0) < cutoff).sort((x: any, y: any) => (x.checkedAt ?? 0) - (y.checkedAt ?? 0)).slice(0, 3);
  },
});

export const record = mutation({
  args: { id: v.id("watches"), lastGbp: v.number() },
  handler: async (ctx, a) => {
    await ctx.db.patch(a.id, { lastGbp: a.lastGbp, checkedAt: Date.now() });
  },
});

export const touch = mutation({
  args: { id: v.id("watches") },
  handler: async (ctx, a) => {
    await ctx.db.patch(a.id, { checkedAt: Date.now() });
  },
});

export const cancel = mutation({
  args: { match: v.string() },
  handler: async (ctx, a) => {
    const rows = await ctx.db
      .query("watches")
      .withIndex("by_status", (q: any) => q.eq("status", "active"))
      .collect();
    const m = a.match.toLowerCase();
    const hit = rows.find((r: any) => r.query.toLowerCase().includes(m));
    if (!hit) return false;
    await ctx.db.patch(hit._id, { status: "cancelled" });
    return hit.query;
  },
});

export const list = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("watches")
      .withIndex("by_status", (q: any) => q.eq("status", "active"))
      .collect();
    return rows.sort((x: any, y: any) => y.createdAt - x.createdAt).slice(0, 20);
  },
});
