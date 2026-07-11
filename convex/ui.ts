import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const setPanel = mutation({
  args: { type: v.string(), value: v.string(), title: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const ex = await ctx.db.query("ui").withIndex("by_key", (q: any) => q.eq("key", "panel")).first();
    const doc = { key: "panel", type: a.type, value: a.value, title: a.title, updatedAt: Date.now() };
    if (ex) await ctx.db.patch(ex._id, doc);
    else await ctx.db.insert("ui", doc);
  },
});

export const clearPanel = mutation({
  args: {},
  handler: async (ctx) => {
    const ex = await ctx.db.query("ui").withIndex("by_key", (q: any) => q.eq("key", "panel")).first();
    if (ex) await ctx.db.delete(ex._id);
  },
});

export const getPanel = query({
  args: {},
  handler: async (ctx) => ctx.db.query("ui").withIndex("by_key", (q: any) => q.eq("key", "panel")).first(),
});

// Voice election: exactly ONE open tab/device speaks assistant lines out loud
// (the one Daniel last interacted with, or the live-mode tab). Everyone else
// stays silent — this is what kills the "two voices" problem for good.
export const claimVoice = mutation({
  args: { client: v.string() },
  handler: async (ctx, a) => {
    const ex = await ctx.db.query("ui").withIndex("by_key", (q: any) => q.eq("key", "voice")).first();
    const doc = { key: "voice", type: "voice", value: a.client, updatedAt: Date.now() };
    if (ex) await ctx.db.patch(ex._id, doc);
    else await ctx.db.insert("ui", doc);
  },
});

export const getVoice = query({
  args: {},
  handler: async (ctx) => ctx.db.query("ui").withIndex("by_key", (q: any) => q.eq("key", "voice")).first(),
});

// Global live-mode lock: at most ONE live session across all of Daniel's
// devices, and while it's fresh no tab anywhere plays local TTS. The live
// voice is the only possible speaker — two voices become impossible.
export const setLiveOn = mutation({
  args: { client: v.string(), on: v.boolean() },
  handler: async (ctx, a) => {
    const ex = await ctx.db.query("ui").withIndex("by_key", (q: any) => q.eq("key", "liveOn")).first();
    if (!a.on) {
      if (ex && ex.value === a.client) await ctx.db.delete(ex._id);
      return true;
    }
    // refuse a second live session while another client's lock is fresh
    if (ex && ex.value !== a.client && Date.now() - ex.updatedAt < 45_000) return false;
    const doc = { key: "liveOn", type: "flag", value: a.client, updatedAt: Date.now() };
    if (ex) await ctx.db.patch(ex._id, doc);
    else await ctx.db.insert("ui", doc);
    return true;
  },
});

export const getLiveOn = query({
  args: {},
  handler: async (ctx) => ctx.db.query("ui").withIndex("by_key", (q: any) => q.eq("key", "liveOn")).first(),
});
