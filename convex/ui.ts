import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import {
  actorAuthArgs,
  dispatcherAuthArgs,
  requireActor,
  requireAdmin,
  requireDispatcher,
  requireViewer,
  viewerAuthArgs,
} from "./controlAuth";
import { safeChatAttachment } from "./fileHelpers";

async function safePanel(ctx: { db: any }, row: any) {
  if (!row) return null;
  const attachment = await safeChatAttachment(ctx, {
    type: row.type,
    value: row.value,
    title: row.title,
  });
  return { ...row, type: attachment.type, value: attachment.value, title: attachment.title };
}

export const setPanel = mutation({
  args: { type: v.string(), value: v.string(), title: v.optional(v.string()), ...dispatcherAuthArgs },
  handler: async (ctx, a) => {
    await requireDispatcher(ctx, a);
    const ex = await ctx.db.query("ui").withIndex("by_key", (q: any) => q.eq("key", "panel")).first();
    const attachment = await safeChatAttachment(ctx, { type: a.type, value: a.value, title: a.title });
    const doc = { key: "panel", type: attachment.type, value: attachment.value, title: attachment.title, updatedAt: Date.now() };
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
    return await safePanel(ctx, await ctx.db.query("ui").withIndex("by_key", (q: any) => q.eq("key", "panel")).first());
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
  args: {
    client: v.string(),
    on: v.boolean(),
    liveLeaseId: v.optional(v.string()),
    liveLeaseSequence: v.optional(v.number()),
    ...actorAuthArgs,
  },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const ex = await ctx.db.query("ui").withIndex("by_key", (q: any) => q.eq("key", "liveOn")).first();
    const liveLeaseSequence = a.liveLeaseSequence;
    if (!a.on) {
      // A delayed stop from an older start must never erase a newer session
      // from the same tab. Legacy callers without a fenced lease safely no-op.
      if (
        ex
        && ex.value === a.client
        && ex.liveLeaseId === a.liveLeaseId
        && ex.liveLeaseSequence === a.liveLeaseSequence
      ) await ctx.db.delete(ex._id);
      return true;
    }
    if (
      !a.liveLeaseId
      || typeof liveLeaseSequence !== "number"
      || !Number.isSafeInteger(liveLeaseSequence)
      || liveLeaseSequence <= 0
    ) return false;
    // refuse a second live session while another client's lock is fresh
    if (ex && ex.value !== a.client && Date.now() - ex.updatedAt < 45_000) return false;
    const freshSameClient = ex && ex.value === a.client && Date.now() - ex.updatedAt < 45_000;
    if (
      freshSameClient
      && Number.isSafeInteger(ex.liveLeaseSequence)
      && (
        ex.liveLeaseSequence! > liveLeaseSequence
        || (
          ex.liveLeaseSequence === liveLeaseSequence
          && ex.liveLeaseId !== a.liveLeaseId
        )
      )
    ) return false;
    const doc = {
      key: "liveOn",
      type: "flag",
      value: a.client,
      liveLeaseId: a.liveLeaseId,
      liveLeaseSequence,
      updatedAt: Date.now(),
    };
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

// Passive wake recognition has a separate, short-lived lease from live voice.
// A single browser microphone listener is enough to hear "Hey Jarvis"; letting
// every open tab and embedded host run SpeechRecognition creates duplicate
// commands before the live-mode lock has a chance to engage.
const STANDBY_LISTENER_KEY = "standbyListener";
const STANDBY_LISTENER_LEASE_MS = 25_000;
const STANDBY_LISTENER_RELEASED_TYPE = "voice-standby-released";

export const setStandbyListener = mutation({
  args: {
    client: v.string(),
    on: v.boolean(),
    standbyLeaseId: v.optional(v.string()),
    standbyLeaseSequence: v.optional(v.number()),
    ...actorAuthArgs,
  },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const standbyLeaseId = a.standbyLeaseId;
    const standbyLeaseSequence = a.standbyLeaseSequence;
    if (
      !standbyLeaseId
      || typeof standbyLeaseSequence !== "number"
      || !Number.isSafeInteger(standbyLeaseSequence)
      || standbyLeaseSequence <= 0
    ) return false;
    const ex = await ctx.db.query("ui")
      .withIndex("by_key", (q: any) => q.eq("key", STANDBY_LISTENER_KEY))
      .first();
    const revoked = await ctx.db.query("standbyListenerRevocations")
      .withIndex("by_leaseId", (q) => q.eq("leaseId", standbyLeaseId))
      .first();
    const sameLease = !!ex
      && ex.value === a.client
      && ex.standbyLeaseId === standbyLeaseId
      && ex.standbyLeaseSequence === standbyLeaseSequence;
    const now = Date.now();
    if (!a.on) {
      // A client-side timeout cannot cancel its already-issued mutation. Keep
      // an immutable per-lease revocation, in addition to the singleton row,
      // so a delayed claim stays blocked even after other tabs have claimed
      // and released the active listener row.
      if (!revoked) await ctx.db.insert("standbyListenerRevocations", {
        leaseId: standbyLeaseId,
        client: a.client,
        sequence: standbyLeaseSequence,
        releasedAt: now,
      });
      if (!ex || sameLease) {
        const tombstone = {
          key: STANDBY_LISTENER_KEY,
          type: STANDBY_LISTENER_RELEASED_TYPE,
          value: a.client,
          standbyLeaseId,
          standbyLeaseSequence,
          updatedAt: now,
        };
        if (ex) await ctx.db.patch(ex._id, tombstone);
        else await ctx.db.insert("ui", tombstone);
      }
      return true;
    }
    if (revoked) return false;
    const activeLease = ex?.type === "voice-standby"
      && now - ex.updatedAt < STANDBY_LISTENER_LEASE_MS;
    // A caller may renew only the exact lease token that is currently active.
    // This keeps duplicate tabs from sharing a copied session identity.
    if (activeLease) {
      if (!sameLease) return false;
      await ctx.db.patch(ex!._id, { updatedAt: now });
      return true;
    }
    // Preserve the newest released/expired generation for this document. It
    // fences reordered "on" mutations from an earlier local lease.
    if (
      ex
      && ex.value === a.client
      && Number.isSafeInteger(ex.standbyLeaseSequence)
      && ex.standbyLeaseSequence! >= standbyLeaseSequence
    ) return false;
    const doc = {
      key: STANDBY_LISTENER_KEY,
      type: "voice-standby",
      value: a.client,
      standbyLeaseId,
      standbyLeaseSequence,
      updatedAt: now,
    };
    if (ex) await ctx.db.patch(ex._id, doc);
    else await ctx.db.insert("ui", doc);
    return true;
  },
});

export const getStandbyListener = query({
  args: { ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    const row = await ctx.db.query("ui")
      .withIndex("by_key", (q: any) => q.eq("key", STANDBY_LISTENER_KEY))
      .first();
    if (
      !row
      || row.type !== "voice-standby"
      || Date.now() - row.updatedAt >= STANDBY_LISTENER_LEASE_MS
    ) return null;
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
    if (!Number.isFinite(a.lat) || !Number.isFinite(a.lng) || Math.abs(a.lat) > 90 || Math.abs(a.lng) > 180) {
      throw new Error("Location coordinates are out of range");
    }
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
