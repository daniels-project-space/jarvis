import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// Timed reminders: "remind me at 7pm to call mum" → push + spoken weave when
// due. The agent-runner cron (*/2) sweeps `due` and delivers.
export const add = mutation({
  args: { text: v.string(), at: v.number() },
  handler: async (ctx, a) => {
    return await ctx.db.insert("reminders", {
      text: a.text.slice(0, 300),
      at: a.at,
      status: "pending",
      createdAt: Date.now(),
    });
  },
});

export const due = mutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("reminders")
      .withIndex("by_status", (q: any) => q.eq("status", "pending"))
      .collect();
    const now = Date.now();
    const fire = rows.filter((r: any) => r.at <= now);
    // claim atomically so a second sweep never double-delivers
    for (const r of fire) await ctx.db.patch(r._id, { status: "delivering" });
    return fire.map((r: any) => ({ _id: r._id, text: r.text, at: r.at }));
  },
});

export const complete = mutation({
  args: { id: v.id("reminders") },
  handler: async (ctx, a) => {
    await ctx.db.patch(a.id, { status: "done" });
  },
});

export const cancel = mutation({
  args: { match: v.string() },
  handler: async (ctx, a) => {
    const rows = await ctx.db
      .query("reminders")
      .withIndex("by_status", (q: any) => q.eq("status", "pending"))
      .collect();
    const m = a.match.toLowerCase();
    const hit = rows.find((r: any) => r.text.toLowerCase().includes(m));
    if (!hit) return false;
    await ctx.db.patch(hit._id, { status: "cancelled" });
    return hit.text;
  },
});

export const upcoming = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("reminders")
      .withIndex("by_status", (q: any) => q.eq("status", "pending"))
      .collect();
    return rows.sort((x: any, y: any) => x.at - y.at).slice(0, 20);
  },
});
