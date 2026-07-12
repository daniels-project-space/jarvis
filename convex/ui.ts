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

// Video remote control: the brain writes a command ("play" | "pause" | "close"),
// the client relays it into the YouTube iframe via the JS API. updatedAt is the
// nonce — the client acts once per fresh command.
export const setVideoCmd = mutation({
  args: { cmd: v.string() },
  handler: async (ctx, a) => {
    const ex = await ctx.db.query("ui").withIndex("by_key", (q: any) => q.eq("key", "videoCmd")).first();
    const doc = { key: "videoCmd", type: "cmd", value: a.cmd, updatedAt: Date.now() };
    if (ex) await ctx.db.patch(ex._id, doc);
    else await ctx.db.insert("ui", doc);
  },
});

export const getVideoCmd = query({
  args: {},
  handler: async (ctx) => ctx.db.query("ui").withIndex("by_key", (q: any) => q.eq("key", "videoCmd")).first(),
});

// Orb mood: the brain shifts the orb's colour to match the conversation's
// tone; the client lerps toward it slowly and falls back to green when stale.
export const setMood = mutation({
  args: { mood: v.string() },
  handler: async (ctx, a) => {
    const ex = await ctx.db.query("ui").withIndex("by_key", (q: any) => q.eq("key", "mood")).first();
    const doc = { key: "mood", type: "mood", value: a.mood, updatedAt: Date.now() };
    if (ex) await ctx.db.patch(ex._id, doc);
    else await ctx.db.insert("ui", doc);
  },
});
export const getMood = query({
  args: {},
  handler: async (ctx) => ctx.db.query("ui").withIndex("by_key", (q: any) => q.eq("key", "mood")).first(),
});

// Chats: one active thread (UI + brain + agent weaves all follow it) plus a
// small registry so Daniel can hop back to earlier conversations.
export const setActiveThread = mutation({
  args: { thread: v.string(), title: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const cur = await ctx.db.query("ui").withIndex("by_key", (q: any) => q.eq("key", "activeThread")).first();
    const doc = { key: "activeThread", type: "thread", value: a.thread, updatedAt: Date.now() };
    if (cur) await ctx.db.patch(cur._id, doc);
    else await ctx.db.insert("ui", doc);
    const reg = await ctx.db.query("ui").withIndex("by_key", (q: any) => q.eq("key", "threads")).first();
    let list: { id: string; title: string; at: number }[] = [];
    try {
      list = reg ? JSON.parse(reg.value) : [];
    } catch {
      list = [];
    }
    if (!list.find((t) => t.id === a.thread))
      list.unshift({ id: a.thread, title: a.title ?? new Date().toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }), at: Date.now() });
    const doc2 = { key: "threads", type: "thread", value: JSON.stringify(list.slice(0, 12)), updatedAt: Date.now() };
    if (reg) await ctx.db.patch(reg._id, doc2);
    else await ctx.db.insert("ui", doc2);
  },
});

export const getActiveThread = query({
  args: {},
  handler: async (ctx) => {
    const r = await ctx.db.query("ui").withIndex("by_key", (q: any) => q.eq("key", "activeThread")).first();
    return r?.value ?? "main";
  },
});

// Housekeeping: drop dead threads from the registry (test/empty chats).
export const pruneThreads = mutation({
  args: { ids: v.array(v.string()) },
  handler: async (ctx, a) => {
    const reg = await ctx.db.query("ui").withIndex("by_key", (q: any) => q.eq("key", "threads")).first();
    if (!reg) return 0;
    let list: { id: string }[] = [];
    try {
      list = JSON.parse(reg.value);
    } catch {
      return 0;
    }
    const keep = list.filter((t) => !a.ids.includes(t.id));
    await ctx.db.patch(reg._id, { value: JSON.stringify(keep), updatedAt: Date.now() });
    return list.length - keep.length;
  },
});

export const getThreads = query({
  args: {},
  handler: async (ctx) => {
    const r = await ctx.db.query("ui").withIndex("by_key", (q: any) => q.eq("key", "threads")).first();
    try {
      return r ? JSON.parse(r.value) : [];
    } catch {
      return [];
    }
  },
});
