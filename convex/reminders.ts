import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { actorAuthArgs, requireActor, requireViewer, viewerAuthArgs } from "./controlAuth";

// Timed reminders: "remind me at 7pm to call mum" → push + spoken weave when
// due. The agent-runner cron (*/2) sweeps `due` and delivers.
export const add = mutation({
  args: { text: v.string(), at: v.number(), sourceKey: v.optional(v.string()), originThreadId: v.optional(v.string()), ...actorAuthArgs },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const sourceKey = a.sourceKey?.trim();
    if (sourceKey && !/^[a-f0-9]{64}$/.test(sourceKey)) throw new Error("Reminder source key is invalid");
    // Automated travel and booking flows can retry after an interrupted web or
    // calendar handoff. Re-use the same pending reminder rather than creating
    // a second push/spoken alert, and refresh its timing if Gmail changed it.
    if (sourceKey) {
      const existing = await ctx.db
        .query("reminders")
        .withIndex("by_sourceKey", (q: any) => q.eq("sourceKey", sourceKey))
        .unique();
      if (existing) {
        if (existing.status === "pending") {
          await ctx.db.patch(existing._id, {
            text: a.text.slice(0, 300),
            at: a.at,
            originThreadId: a.originThreadId,
          });
        }
        return existing._id;
      }
    }
    return await ctx.db.insert("reminders", {
      text: a.text.slice(0, 300),
      at: a.at,
      status: "pending",
      sourceKey,
      originThreadId: a.originThreadId,
      deliveryAttempts: 0,
      createdAt: Date.now(),
    });
  },
});

export const due = mutation({
  args: { ...actorAuthArgs },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const pending = await ctx.db
      .query("reminders")
      .withIndex("by_status", (q: any) => q.eq("status", "pending").lte("at", Date.now()))
      .take(50);
    const delivering = await ctx.db
      .query("reminders")
      .withIndex("by_status", (q: any) => q.eq("status", "delivering"))
      .take(50);
    const now = Date.now();
    const stale = delivering.filter((row: any) => (row.deliverStartedAt ?? 0) < now - 5 * 60_000);
    const fire = [...pending, ...stale].slice(0, 50);
    // Claim atomically. A Trigger container dying after this point is recovered
    // after the lease, rather than leaving the reminder stuck forever.
    for (const row of fire)
      await ctx.db.patch(row._id, {
        status: "delivering",
        deliverStartedAt: now,
        deliveryAttempts: (row.deliveryAttempts ?? 0) + 1,
      });
    return fire.map((row: any) => ({ _id: row._id, text: row.text, at: row.at, originThreadId: row.originThreadId }));
  },
});

export const complete = mutation({
  args: { id: v.id("reminders"), ...actorAuthArgs },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    await ctx.db.patch(a.id, { status: "done" });
  },
});

export const cancel = mutation({
  args: { match: v.string(), ...actorAuthArgs },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const rows = await ctx.db
      .query("reminders")
      .withIndex("by_status", (q: any) => q.eq("status", "pending"))
      .order("asc")
      .take(100);
    const m = a.match.toLowerCase();
    const hit = rows.find((r: any) => r.text.toLowerCase().includes(m));
    if (!hit) return false;
    await ctx.db.patch(hit._id, { status: "cancelled" });
    return hit.text;
  },
});

export const upcoming = query({
  args: { ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    const rows = await ctx.db
      .query("reminders")
      .withIndex("by_status", (q: any) => q.eq("status", "pending"))
      .order("asc")
      .take(20);
    return rows;
  },
});
