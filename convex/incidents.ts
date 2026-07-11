import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// Self-healing incident ledger. report() dedups by signature (48h window):
// an existing open/dispatched incident just bumps count; a recently-resolved
// one reopens WITH its attempt history so repeated failures escalate to
// Daniel instead of looping repair agents forever.

const WINDOW_MS = 48 * 60 * 60 * 1000;

export const report = mutation({
  args: {
    source: v.string(),
    signature: v.string(),
    message: v.string(),
    app: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const sig = a.signature.slice(0, 200);
    const existing = await ctx.db
      .query("incidents")
      .withIndex("by_signature", (q: any) => q.eq("signature", sig))
      .collect();
    const now = Date.now();
    const recent = existing
      .filter((i: any) => now - i.updatedAt < WINDOW_MS)
      .sort((x: any, y: any) => y.updatedAt - x.updatedAt)[0];
    if (recent) {
      const patch: Record<string, unknown> = {
        count: recent.count + 1,
        updatedAt: now,
        message: a.message.slice(0, 1500),
      };
      // recurrence after a "fix" = the fix didn't hold — reopen with history
      if (recent.status === "resolved") patch.status = "open";
      await ctx.db.patch(recent._id, patch);
      return recent._id;
    }
    return await ctx.db.insert("incidents", {
      source: a.source,
      app: a.app,
      signature: sig,
      message: a.message.slice(0, 1500),
      count: 1,
      status: "open",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    });
  },
});

// Healer claim: open incidents become dispatched (attempts+1); ones that
// already burned their attempts escalate to needs-daniel instead.
export const claimForRepair = mutation({
  args: { limit: v.optional(v.number()), maxAttempts: v.optional(v.number()) },
  handler: async (ctx, a) => {
    const open = await ctx.db
      .query("incidents")
      .withIndex("by_status", (q: any) => q.eq("status", "open"))
      .collect();
    const claims: any[] = [];
    const escalations: any[] = [];
    const max = a.maxAttempts ?? 2;
    for (const inc of open.sort((x: any, y: any) => x.updatedAt - y.updatedAt)) {
      if (inc.attempts >= max) {
        await ctx.db.patch(inc._id, { status: "needs-daniel", updatedAt: Date.now() });
        escalations.push({ id: inc._id, signature: inc.signature, message: inc.message, attempts: inc.attempts });
        continue;
      }
      if (claims.length >= (a.limit ?? 2)) continue;
      await ctx.db.patch(inc._id, { status: "dispatched", attempts: inc.attempts + 1, updatedAt: Date.now() });
      claims.push({
        id: inc._id,
        source: inc.source,
        app: inc.app ?? null,
        signature: inc.signature,
        message: inc.message,
        count: inc.count,
        attempts: inc.attempts + 1,
      });
    }
    return { claims, escalations };
  },
});

export const setStatus = mutation({
  args: { id: v.id("incidents"), status: v.string() },
  handler: async (ctx, a) => {
    await ctx.db.patch(a.id, { status: a.status, updatedAt: Date.now() });
  },
});

export const list = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, a) => {
    const rows = await ctx.db.query("incidents").collect();
    return rows.sort((x: any, y: any) => y.updatedAt - x.updatedAt).slice(0, a.limit ?? 10);
  },
});
