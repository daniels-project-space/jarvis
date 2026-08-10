import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import {
  actorAuthArgs,
  dispatcherAuthArgs,
  ownerDispatcherAuthArgs,
  requireActor,
  requireAdmin,
  requireDispatcher,
  requireOwnerOrDispatcher,
  requireViewer,
  viewerAuthArgs,
} from "./controlAuth";

export const setPanel = mutation({
  args: { type: v.string(), value: v.string(), title: v.optional(v.string()), ...dispatcherAuthArgs },
  handler: async (ctx, a) => {
    await requireDispatcher(ctx, a);
    const ex = await ctx.db.query("ui").withIndex("by_key", (q: any) => q.eq("key", "panel")).first();
    const doc = { key: "panel", type: a.type, value: a.value, title: a.title, updatedAt: Date.now() };
    if (ex) await ctx.db.patch(ex._id, doc);
    else await ctx.db.insert("ui", doc);
  },
});

export const clearPanel = mutation({
  args: { ...actorAuthArgs },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const ex = await ctx.db.query("ui").withIndex("by_key", (q: any) => q.eq("key", "panel")).first();
    if (ex) await ctx.db.delete(ex._id);
  },
});

export const getPanel = query({
  args: { ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    return ctx.db.query("ui").withIndex("by_key", (q: any) => q.eq("key", "panel")).first();
  },
});

// One-shot action for the top-level app surrounding the cross-origin Jarvis
// embed. The iframe relays only fresh rows to its verified parent; main Jarvis
// clients ignore this channel. Keeping it separate from `panel` means a real
// host navigation can never be mistaken for a visual that merely looks open.
export const setHostAction = mutation({
  args: { value: v.string(), title: v.optional(v.string()), ...dispatcherAuthArgs },
  handler: async (ctx, a) => {
    await requireDispatcher(ctx, a);
    const ex = await ctx.db.query("ui").withIndex("by_key", (q) => q.eq("key", "hostAction")).first();
    const doc = {
      key: "hostAction",
      type: "host-action",
      value: a.value.slice(0, 6_000),
      title: a.title?.slice(0, 160),
      updatedAt: Date.now(),
    };
    if (ex) await ctx.db.patch(ex._id, doc);
    else await ctx.db.insert("ui", doc);
  },
});

export const getHostAction = query({
  args: { ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    return ctx.db.query("ui").withIndex("by_key", (q) => q.eq("key", "hostAction")).first();
  },
});

// Compatibility for clients left open across the removal of the ephemeral
// say channel. Convex subscriptions can outlive a Vercel client deployment,
// so keep the authenticated read contract until those clients have aged out.
export const getSay = query({
  args: { ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    return ctx.db.query("ui").withIndex("by_key", (q: any) => q.eq("key", "say")).first();
  },
});

// Global subscription agent selection. Trigger jobs read this before claiming
// work, so the choice follows Daniel across devices and affects every runner.
export const setAgentProvider = mutation({
  args: { provider: v.literal("codex"), ...actorAuthArgs },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const ex = await ctx.db.query("ui").withIndex("by_key", (q: any) => q.eq("key", "agentProvider")).first();
    // Jarvis's durable team is subscription-backed Codex. Keep the historical
    // argument for old clients, but never silently switch the execution plane
    // back to a metered provider.
    const doc = { key: "agentProvider", type: "provider", value: "codex", updatedAt: Date.now() };
    if (ex) await ctx.db.patch(ex._id, doc);
    else await ctx.db.insert("ui", doc);
  },
});

export const getAgentProvider = query({
  args: { ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    return "codex";
  },
});

// Separate from the durable Trigger/Codex execution plane above. This is the
// owner's persisted target for a future handover to the local VPS runner; it
// never promotes a browser/guest capability into worker authority.
export const setLocalCodingProvider = mutation({
  args: {
    provider: v.union(v.literal("codex"), v.literal("claude")),
    ...ownerDispatcherAuthArgs,
  },
  handler: async (ctx, a) => {
    await requireOwnerOrDispatcher(ctx, a);
    const existing = await ctx.db
      .query("ui")
      .withIndex(
        "by_key",
        // Convex's generated index callback is currently untyped in this module.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (q: any) => q.eq("key", "localCodingProvider"),
      )
      .first();
    const updatedAt = Date.now();
    const doc = {
      key: "localCodingProvider",
      type: "local-coding-provider",
      value: a.provider,
      updatedAt,
    };
    if (existing) await ctx.db.patch(existing._id, doc);
    else await ctx.db.insert("ui", doc);
    return {
      provider: a.provider,
      targetRuntime: a.provider === "claude" ? "vps_claude" : "vps_codex",
      updatedAt,
    };
  },
});

export const getLocalCodingProvider = query({
  args: { ...ownerDispatcherAuthArgs },
  handler: async (ctx, a) => {
    await requireOwnerOrDispatcher(ctx, a);
    const existing = await ctx.db
      .query("ui")
      .withIndex(
        "by_key",
        // Convex's generated index callback is currently untyped in this module.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (q: any) => q.eq("key", "localCodingProvider"),
      )
      .first();
    const provider = existing?.value === "claude" ? "claude" : "codex";
    return {
      provider,
      targetRuntime: provider === "claude" ? "vps_claude" : "vps_codex",
      updatedAt: existing?.updatedAt ?? 0,
    };
  },
});

// Voice election: exactly ONE open tab/device speaks assistant lines out loud
// (the one Daniel last interacted with, or the live-mode tab). Everyone else
// stays silent — this is what kills the "two voices" problem for good.
export const claimVoice = mutation({
  args: { client: v.string(), ...actorAuthArgs },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const ex = await ctx.db.query("ui").withIndex("by_key", (q: any) => q.eq("key", "voice")).first();
    const doc = { key: "voice", type: "voice", value: a.client, updatedAt: Date.now() };
    if (ex) await ctx.db.patch(ex._id, doc);
    else await ctx.db.insert("ui", doc);
  },
});

// Passive election for background speech (weaves, say-lines): first caller
// wins atomically; a fresh claim by another client is respected. User-action
// claims (typing, mic) keep using claimVoice, which always wins.
export const electVoice = mutation({
  args: { client: v.string(), ...actorAuthArgs },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const ex = await ctx.db.query("ui").withIndex("by_key", (q: any) => q.eq("key", "voice")).first();
    if (ex && ex.value !== a.client && Date.now() - ex.updatedAt <= 3 * 60 * 1000) return false;
    const doc = { key: "voice", type: "voice", value: a.client, updatedAt: Date.now() };
    if (ex) await ctx.db.patch(ex._id, doc);
    else await ctx.db.insert("ui", doc);
    return true;
  },
});

export const getVoice = query({
  args: { ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    return ctx.db.query("ui").withIndex("by_key", (q: any) => q.eq("key", "voice")).first();
  },
});

// Global live-mode lock: at most ONE live session across all of Daniel's
// devices, and while it's fresh no tab anywhere plays local TTS. The live
// voice is the only possible speaker — two voices become impossible.
export const setLiveOn = mutation({
  args: { client: v.string(), on: v.boolean(), ...actorAuthArgs },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
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

// The lock is a LEASE: a live client heartbeats every 20s and setLiveOn refuses
// takeover only while the held lock is <45s old. If a client dies abnormally
// (crash, mobile background-kill, dropped pagehide beacon) its release never
// fires and the row lingers with a stale updatedAt — a phantom lock that reads
// as "someone is live" to any consumer that forgets its own TTL gate. A lock
// past its lease is definitionally not held, so report it as none at the source
// rather than leaving a stale row to masquerade as a live session.
export const getLiveOn = query({
  args: { ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    const row = await ctx.db.query("ui").withIndex("by_key", (q: any) => q.eq("key", "liveOn")).first();
    if (!row || Date.now() - row.updatedAt >= 45_000) return null;
    return row;
  },
});

// Video remote control: the brain writes a command ("play" | "pause" | "close"),
// the client relays it into the YouTube iframe via the JS API. updatedAt is the
// nonce — the client acts once per fresh command.
export const setVideoCmd = mutation({
  args: { cmd: v.string(), ...actorAuthArgs },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const ex = await ctx.db.query("ui").withIndex("by_key", (q: any) => q.eq("key", "videoCmd")).first();
    const doc = { key: "videoCmd", type: "cmd", value: a.cmd, updatedAt: Date.now() };
    if (ex) await ctx.db.patch(ex._id, doc);
    else await ctx.db.insert("ui", doc);
  },
});

export const getVideoCmd = query({
  args: { ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    return ctx.db.query("ui").withIndex("by_key", (q: any) => q.eq("key", "videoCmd")).first();
  },
});

// Orb mood: the brain shifts the orb's colour to match the conversation's
// tone; the client lerps toward it slowly and falls back to green when stale.
export const setMood = mutation({
  args: { mood: v.string(), manual: v.optional(v.boolean()), ...actorAuthArgs },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const ex = await ctx.db.query("ui").withIndex("by_key", (q: any) => q.eq("key", "mood")).first();
    // Mood is alive but not a strobe: a genuine model shift holds ~45s before
    // the next. Daniel's MANUAL picks (options panel) always take instantly.
    if (!a.manual && ex && ex.value !== a.mood && a.mood !== "alert" && Date.now() - (ex.updatedAt ?? 0) < 45_000) return;
    const doc = { key: "mood", type: "mood", value: a.mood, title: a.manual ? "manual" : "auto", updatedAt: Date.now() };
    if (ex) await ctx.db.patch(ex._id, doc);
    else await ctx.db.insert("ui", doc);
  },
});
export const getMood = query({
  args: { ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    return ctx.db.query("ui").withIndex("by_key", (q: any) => q.eq("key", "mood")).first();
  },
});

// Daniel's current location (granted once, persisted) — so "near me" / place
// lookups work in both lanes and the brain knows where he is.
export const setLocation = mutation({
  args: { lat: v.number(), lng: v.number(), label: v.optional(v.string()), ...actorAuthArgs },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const ex = await ctx.db.query("ui").withIndex("by_key", (q: any) => q.eq("key", "location")).first();
    const doc = { key: "location", type: "location", value: `${a.lat},${a.lng}`, title: a.label, updatedAt: Date.now() };
    if (ex) await ctx.db.patch(ex._id, doc);
    else await ctx.db.insert("ui", doc);
  },
});
export const getLocation = query({
  args: { ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    return ctx.db.query("ui").withIndex("by_key", (q: any) => q.eq("key", "location")).first();
  },
});

// Chats: one active thread (UI + brain + agent weaves all follow it) plus a
// small registry so Daniel can hop back to earlier conversations.
export const setActiveThread = mutation({
  args: { thread: v.string(), title: v.optional(v.string()), ...actorAuthArgs },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
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
  args: { ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    const r = await ctx.db.query("ui").withIndex("by_key", (q: any) => q.eq("key", "activeThread")).first();
    return r?.value ?? "main";
  },
});

// Housekeeping: drop dead threads from the registry (test/empty chats).
export const pruneThreads = mutation({
  args: { ids: v.array(v.string()), authTokenHash: v.optional(v.string()) },
  handler: async (ctx, a) => {
    await requireAdmin(ctx, a.authTokenHash);
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
  args: { ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    const r = await ctx.db.query("ui").withIndex("by_key", (q: any) => q.eq("key", "threads")).first();
    try {
      return r ? JSON.parse(r.value) : [];
    } catch {
      return [];
    }
  },
});
