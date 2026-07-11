import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// Cloud chat transport for the subscription brain. UI calls sendMessage +
// subscribes to listMessages; the Trigger dispatcher calls claimNext /
// appendChunk / finalize over the HTTP API. Public (personal, single-user).

async function ensureSession(ctx: { db: any }, threadId: string) {
  const existing = await ctx.db
    .query("chatSessions")
    .withIndex("by_thread", (q: any) => q.eq("threadId", threadId))
    .first();
  if (existing) return existing;
  const id = await ctx.db.insert("chatSessions", {
    threadId,
    status: "idle",
    lastActiveAt: Date.now(),
  });
  return await ctx.db.get(id);
}

export const sendMessage = mutation({
  args: { threadId: v.optional(v.string()), text: v.string() },
  handler: async (ctx, a) => {
    const threadId = a.threadId ?? "main";
    await ensureSession(ctx, threadId);
    return await ctx.db.insert("chatMessages", {
      threadId,
      role: "user",
      text: a.text,
      status: "pending",
      createdAt: Date.now(),
    });
  },
});

export const listMessages = query({
  args: { threadId: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const threadId = a.threadId ?? "main";
    const rows = await ctx.db
      .query("chatMessages")
      .withIndex("by_thread", (q: any) => q.eq("threadId", threadId))
      .collect();
    return rows.sort((x: any, y: any) => x.createdAt - y.createdAt);
  },
});

export const sessionState = query({
  args: { threadId: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const threadId = a.threadId ?? "main";
    return await ctx.db
      .query("chatSessions")
      .withIndex("by_thread", (q: any) => q.eq("threadId", threadId))
      .first();
  },
});

// Fast-lane turn: the /api/chat route (Groq reflex brain) handles the turn
// itself, so the user row is inserted already-done (the cron dispatcher only
// claims "pending" rows) and a streaming assistant row is opened for it.
export const openTurn = mutation({
  args: { threadId: v.optional(v.string()), userText: v.string() },
  handler: async (ctx, a) => {
    const threadId = a.threadId ?? "main";
    await ensureSession(ctx, threadId);
    const all = await ctx.db
      .query("chatMessages")
      .withIndex("by_thread", (q: any) => q.eq("threadId", threadId))
      .collect();
    const history = all
      .filter((m: any) => m.status === "done" && m.text)
      .sort((x: any, y: any) => x.createdAt - y.createdAt)
      .slice(-16)
      .map((m: any) => ({ role: m.role, text: m.text }));
    await ctx.db.insert("chatMessages", {
      threadId,
      role: "user",
      text: a.userText,
      status: "done",
      createdAt: Date.now(),
    });
    const assistantId = await ctx.db.insert("chatMessages", {
      threadId,
      role: "assistant",
      text: "",
      status: "streaming",
      createdAt: Date.now(),
    });
    return { assistantId, history };
  },
});

// Mirror a finished live-voice exchange into history (both sides already spoken).
export const logTurn = mutation({
  args: { threadId: v.optional(v.string()), role: v.string(), text: v.string(), model: v.optional(v.string()) },
  handler: async (ctx, a) => {
    await ctx.db.insert("chatMessages", {
      threadId: a.threadId ?? "main",
      role: a.role,
      text: a.text,
      status: "done",
      model: a.model,
      createdAt: Date.now(),
    });
  },
});

export const claimNext = mutation({
  args: {},
  handler: async (ctx) => {
    const pending = await ctx.db
      .query("chatMessages")
      .withIndex("by_status", (q: any) => q.eq("status", "pending"))
      .first();
    if (!pending) return null;
    await ctx.db.patch(pending._id, { status: "done" });

    const session = await ctx.db
      .query("chatSessions")
      .withIndex("by_thread", (q: any) => q.eq("threadId", pending.threadId))
      .first();
    if (session) await ctx.db.patch(session._id, { status: "working", lastActiveAt: Date.now() });

    const assistantId = await ctx.db.insert("chatMessages", {
      threadId: pending.threadId,
      role: "assistant",
      text: "",
      status: "streaming",
      createdAt: Date.now(),
    });

    const all = await ctx.db
      .query("chatMessages")
      .withIndex("by_thread", (q: any) => q.eq("threadId", pending.threadId))
      .collect();
    const history = all
      .filter((m: any) => m._id !== assistantId && m._id !== pending._id && m.status === "done")
      .sort((a: any, b: any) => a.createdAt - b.createdAt)
      .slice(-12)
      .map((m: any) => ({ role: m.role, text: m.text }));

    return {
      threadId: pending.threadId,
      userText: pending.text,
      assistantId,
      claudeSessionId: session?.claudeSessionId ?? null,
      history,
    };
  },
});

export const appendChunk = mutation({
  args: { messageId: v.id("chatMessages"), chunk: v.string() },
  handler: async (ctx, a) => {
    const m = await ctx.db.get(a.messageId);
    if (!m) return;
    await ctx.db.patch(a.messageId, { text: (m.text ?? "") + a.chunk });
  },
});

export const finalize = mutation({
  args: {
    messageId: v.id("chatMessages"),
    threadId: v.string(),
    status: v.union(v.literal("done"), v.literal("error")),
    finalText: v.optional(v.string()),
    claudeSessionId: v.optional(v.string()),
    model: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const patch: Record<string, unknown> = { status: a.status };
    if (a.finalText !== undefined) patch.text = a.finalText;
    if (a.model) patch.model = a.model;
    await ctx.db.patch(a.messageId, patch);
    const s = await ctx.db
      .query("chatSessions")
      .withIndex("by_thread", (q: any) => q.eq("threadId", a.threadId))
      .first();
    if (s) {
      const sp: Record<string, unknown> = { status: "idle", lastActiveAt: Date.now() };
      if (a.claudeSessionId) sp.claudeSessionId = a.claudeSessionId;
      await ctx.db.patch(s._id, sp);
    }
  },
});

// Post an assistant message directly (used by the agent-runner to report back).
export const postAssistant = mutation({
  args: { threadId: v.string(), text: v.string() },
  handler: async (ctx, a) => {
    await ctx.db.insert("chatMessages", {
      threadId: a.threadId,
      role: "assistant",
      text: a.text,
      status: "done",
      createdAt: Date.now(),
    });
  },
});

// Drop a persistent media card into the stream (everything shown stays findable).
export const postCard = mutation({
  args: {
    threadId: v.optional(v.string()),
    type: v.string(),
    value: v.string(),
    title: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    await ctx.db.insert("chatMessages", {
      threadId: a.threadId ?? "main",
      role: "assistant",
      text: "",
      status: "done",
      attachment: { type: a.type, value: a.value, title: a.title },
      createdAt: Date.now(),
    });
  },
});

// Wipe a thread (fresh start after maintenance/testing).
export const clearThread = mutation({
  args: { threadId: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const rows = await ctx.db
      .query("chatMessages")
      .withIndex("by_thread", (q: any) => q.eq("threadId", a.threadId ?? "main"))
      .collect();
    for (const r of rows) await ctx.db.delete(r._id);
    return rows.length;
  },
});
