import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireActor, requireAdmin, requireViewer, requireWorker, viewerAuthArgs } from "./controlAuth";

// Cloud chat transport for the subscription brain. UI calls sendMessage +
// subscribes to listMessages; the Trigger dispatcher calls claimNext /
// appendChunk / finalize over the HTTP API. Daniel and Trigger authenticate
// through separate capabilities; no public caller can manufacture work/history.

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
  args: { threadId: v.optional(v.string()), text: v.string(), authTokenHash: v.optional(v.string()) },
  handler: async (ctx, a) => {
    await requireAdmin(ctx, a.authTokenHash);
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
  args: { threadId: v.optional(v.string()), ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    const threadId = a.threadId ?? "main";
    const rows = await ctx.db
      .query("chatMessages")
      .withIndex("by_thread", (q: any) => q.eq("threadId", threadId))
      .collect();
    return rows.sort((x: any, y: any) => x.createdAt - y.createdAt);
  },
});

export const sessionState = query({
  args: { threadId: v.optional(v.string()), ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
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
  args: { threadId: v.optional(v.string()), userText: v.string(), authTokenHash: v.optional(v.string()) },
  handler: async (ctx, a) => {
    await requireAdmin(ctx, a.authTokenHash);
    const threadId = a.threadId ?? "main";
    await ensureSession(ctx, threadId);
    const all = await ctx.db
      .query("chatMessages")
      .withIndex("by_thread", (q: any) => q.eq("threadId", threadId))
      .collect();
    const history = all
      .filter((m: any) => m.status === "done" && (m.text || m.attachment))
      .sort((x: any, y: any) => x.createdAt - y.createdAt)
      .slice(-16)
      .map((m: any) => ({
        role: m.role,
        // cards surface as context so "that video from earlier" resolves
        text: m.text || (m.attachment ? `[showed on screen: ${m.attachment.title ?? m.attachment.type}]` : ""),
      }));
    const userId = await ctx.db.insert("chatMessages", {
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
    return { assistantId, userId, history };
  },
});

// Fast-lane failure path: flip the ORIGINAL user row back to pending so the
// cron dispatcher answers it. Re-inserting the text (the old fallback) showed
// Daniel his own message twice — this keeps exactly one user bubble.
export const requeueUser = mutation({
  args: { userId: v.id("chatMessages"), authTokenHash: v.optional(v.string()) },
  handler: async (ctx, a) => {
    await requireAdmin(ctx, a.authTokenHash);
    const m = await ctx.db.get(a.userId);
    if (!m || m.role !== "user") return;
    // Already answered (finalize applied but its response got lost in transit)?
    // Requeueing would produce a duplicate reply from the cron lane.
    const rows = await ctx.db
      .query("chatMessages")
      .withIndex("by_thread", (q: any) => q.eq("threadId", m.threadId))
      .collect();
    const answered = rows.some(
      (r: any) => r.role === "assistant" && r.status === "done" && r.text && r.createdAt >= m.createdAt,
    );
    if (!answered) await ctx.db.patch(a.userId, { status: "pending" });
  },
});

// Assistant rows stuck "streaming" (a route killed mid-run) freeze the UI's
// busy state forever. Sweep them into hidden error rows.
export const reapStuck = mutation({
  args: { workerToken: v.optional(v.string()) },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const rows = await ctx.db
      .query("chatMessages")
      .withIndex("by_status", (q: any) => q.eq("status", "streaming"))
      .collect();
    let n = 0;
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (const r of rows) {
      if (r.createdAt < cutoff) {
        await ctx.db.patch(r._id, { status: "error", text: "" });
        n++;
      }
    }
    return n;
  },
});

// Mirror a finished live-voice exchange into history (both sides already spoken).
export const logTurn = mutation({
  args: {
    threadId: v.optional(v.string()),
    role: v.string(),
    text: v.string(),
    model: v.optional(v.string()),
    authTokenHash: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    await requireAdmin(ctx, a.authTokenHash);
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
  args: { workerToken: v.optional(v.string()) },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
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
  args: { messageId: v.id("chatMessages"), chunk: v.string(), workerToken: v.optional(v.string()) },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
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
    authTokenHash: v.optional(v.string()),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    // Transport ambiguity guard: if a finalize APPLIED but its HTTP response
    // was lost, the route's catch used to wipe the delivered answer and
    // requeue — Daniel then heard a second, reworded reply minutes later.
    const ex = await ctx.db.get(a.messageId);
    if (ex?.status === "done" && a.status === "error") return;
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
  args: { threadId: v.string(), text: v.string(), workerToken: v.optional(v.string()) },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
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
    authTokenHash: v.optional(v.string()),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
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
  args: { threadId: v.optional(v.string()), authTokenHash: v.optional(v.string()) },
  handler: async (ctx, a) => {
    await requireAdmin(ctx, a.authTokenHash);
    const rows = await ctx.db
      .query("chatMessages")
      .withIndex("by_thread", (q: any) => q.eq("threadId", a.threadId ?? "main"))
      .collect();
    for (const r of rows) await ctx.db.delete(r._id);
    return rows.length;
  },
});
