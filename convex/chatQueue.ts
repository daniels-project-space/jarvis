import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { actorAuthArgs, requireActor, requireViewer, requireWorker, viewerAuthArgs } from "./controlAuth";

const HOST_CONTEXT_BLOCK = /\s*\[JARVIS_HOST_CONTEXT\][\s\S]*?\[\/JARVIS_HOST_CONTEXT\]\s*/g;
const visibleTurnText = (text: string) => text.replace(HOST_CONTEXT_BLOCK, " ").replace(/\s{2,}/g, " ").trim();

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
  args: {
    threadId: v.optional(v.string()),
    text: v.string(),
    requestId: v.optional(v.string()),
    ...actorAuthArgs,
  },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const threadId = a.threadId ?? "main";
    if (a.requestId) {
      const prior = await ctx.db
        .query("chatMessages")
        .withIndex("by_request", (q: any) => q.eq("requestId", a.requestId))
        .first();
      if (prior?.role === "user" && prior.threadId === threadId) return prior._id;
    }
    const session = await ensureSession(ctx, threadId);
    // Stable turn slots keep concurrent replies beside the user message that
    // caused them, even when a later fast turn finishes before an earlier one.
    const createdAt = Math.max(Date.now(), Number(session?.lastActiveAt ?? 0) + 2);
    const id = await ctx.db.insert("chatMessages", {
      threadId,
      role: "user",
      text: a.text,
      status: "pending",
      requestId: a.requestId?.slice(0, 120),
      delivery: "foreground",
      createdAt,
    });
    if (session) await ctx.db.patch(session._id, { lastActiveAt: createdAt });
    return id;
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
      .order("desc")
      // The always-mounted foreground surface needs only the newest visible
      // turns. A streamed token therefore re-reads at most twenty rows.
      .take(20);
    return rows.reverse();
  },
});

export const HISTORY_PAGE_MAX = 20;

// Older rows are loaded only by the explicitly mounted history drawer. Clamp
// every cursor request server-side: pagination's numItems is advisory for a
// reactive query, while maximumRowsRead is the actual database read ceiling.
export const paginatedMessages = query({
  args: { threadId: v.optional(v.string()), paginationOpts: paginationOptsValidator, ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    return await ctx.db
      .query("chatMessages")
      .withIndex("by_thread", (q: any) => q.eq("threadId", a.threadId ?? "main"))
      .order("desc")
      .paginate({
        ...a.paginationOpts,
        numItems: Math.min(HISTORY_PAGE_MAX, Math.max(1, Math.floor(a.paginationOpts.numItems || HISTORY_PAGE_MAX))),
        maximumRowsRead: HISTORY_PAGE_MAX,
        maximumBytesRead: 256 * 1024,
      });
  },
});

// The Project Hub renders only the orb and live captions. It needs the current
// foreground turn, not a 100-row chat drawer, so keep that embedded realtime
// subscription deliberately lean while retaining enough rows for overlap.
export const listRecentMessages = query({
  args: { threadId: v.optional(v.string()), ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    const rows = await ctx.db
      .query("chatMessages")
      .withIndex("by_thread", (q: any) => q.eq("threadId", a.threadId ?? "main"))
      .order("desc")
      .take(8);
    return rows.reverse();
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

// Assistant rows stuck "streaming" (a route killed mid-run) freeze the UI's
// busy state forever. Sweep them into hidden error rows.
export const reapStuck = mutation({
  args: { workerToken: v.optional(v.string()) },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const rows = await ctx.db
      .query("chatMessages")
      .withIndex("by_status", (q: any) => q.eq("status", "streaming"))
      .take(100);
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
    ...actorAuthArgs,
  },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    await ctx.db.insert("chatMessages", {
      threadId: a.threadId ?? "main",
      role: a.role,
      text: a.text,
      status: "done",
      model: a.model,
      delivery: "foreground",
      createdAt: Date.now(),
    });
  },
});

async function claimPending(ctx: { db: any }, pending: any) {
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
      parentMessageId: pending._id,
      delivery: "foreground",
      streamRevision: 0,
      createdAt: pending.createdAt + 1,
    });

    const all = await ctx.db
      .query("chatMessages")
      .withIndex("by_thread", (q: any) => q.eq("threadId", pending.threadId))
      .order("desc")
      .take(40);
    const history = all
      .filter(
        (m: any) =>
          m._id !== assistantId &&
          m._id !== pending._id &&
          m.status === "done" &&
          m.delivery !== "notification" &&
          m.createdAt < pending.createdAt,
      )
      .sort((a: any, b: any) => a.createdAt - b.createdAt)
      .slice(-12)
      .map((m: any) => ({ role: m.role, text: m.role === "user" ? visibleTurnText(m.text) : m.text }));

    return {
      threadId: pending.threadId,
      userText: pending.text,
      assistantId,
      history,
    };
}

// Immediate Trigger runs claim exactly the message that woke it. The one
// foreground lease then prevents duplicate workers from racing a shared drain.
export const claimMessage = mutation({
  args: { messageId: v.id("chatMessages"), workerToken: v.optional(v.string()) },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const pending = await ctx.db.get(a.messageId);
    if (!pending || pending.role !== "user" || pending.status !== "pending") return null;
    return await claimPending(ctx, pending);
  },
});

// Recovery-only FIFO claim for a lost Trigger wake-up.
export const claimNext = mutation({
  args: { workerToken: v.optional(v.string()) },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const pending = await ctx.db
      .query("chatMessages")
      .withIndex("by_status", (q: any) => q.eq("status", "pending"))
      .first();
    if (!pending) return null;
    return await claimPending(ctx, pending);
  },
});

// A single warm-runner lease lets /api/chat avoid launching a cold container
// for every follow-up. The pending signal is subscribed over Convex's realtime
// channel, so an idle warm runner consumes no high-frequency polling reads.
const RUNNER_KEY = "foregroundRunner";
const RUNNER_LEASE_MS = 25_000;

export const touchRunner = mutation({
  args: {
    runnerId: v.string(),
    takeoverFrom: v.optional(v.string()),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const row = await ctx.db.query("ui").withIndex("by_key", (q: any) => q.eq("key", RUNNER_KEY)).first();
    const validHandoff = Boolean(a.takeoverFrom && row?.value === a.takeoverFrom);
    if (row && row.value !== a.runnerId && !validHandoff && Date.now() - row.updatedAt < RUNNER_LEASE_MS) return false;
    const doc = { key: RUNNER_KEY, type: "lease", value: a.runnerId, updatedAt: Date.now() };
    if (row) await ctx.db.patch(row._id, doc);
    else await ctx.db.insert("ui", doc);
    return true;
  },
});

export const releaseRunner = mutation({
  args: { runnerId: v.string(), workerToken: v.optional(v.string()) },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const row = await ctx.db.query("ui").withIndex("by_key", (q: any) => q.eq("key", RUNNER_KEY)).first();
    if (row?.value === a.runnerId) await ctx.db.delete(row._id);
  },
});

export const runnerLease = query({
  args: { ...actorAuthArgs },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const row = await ctx.db.query("ui").withIndex("by_key", (q: any) => q.eq("key", RUNNER_KEY)).first();
    return row ? { runnerId: row.value, updatedAt: row.updatedAt } : null;
  },
});

export const runnerLeaseForWorker = query({
  args: { workerToken: v.optional(v.string()) },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const row = await ctx.db.query("ui").withIndex("by_key", (q: any) => q.eq("key", RUNNER_KEY)).first();
    return row ? { runnerId: row.value, updatedAt: row.updatedAt } : null;
  },
});

export const pendingSignal = query({
  args: { workerToken: v.optional(v.string()) },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const pending = await ctx.db.query("chatMessages").withIndex("by_status", (q: any) => q.eq("status", "pending")).first();
    return pending?._id ?? null;
  },
});

export const updateStream = mutation({
  args: {
    messageId: v.id("chatMessages"),
    text: v.string(),
    revision: v.number(),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const m = await ctx.db.get(a.messageId);
    if (!m || m.role !== "assistant" || m.status !== "streaming") return false;
    if (a.revision <= (m.streamRevision ?? 0)) return false;
    await ctx.db.patch(a.messageId, {
      text: a.text,
      streamRevision: a.revision,
    });
    return true;
  },
});

export const finalize = mutation({
  args: {
    messageId: v.id("chatMessages"),
    threadId: v.string(),
    status: v.union(v.literal("done"), v.literal("error")),
    finalText: v.optional(v.string()),
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
    if (!ex || ex.role !== "assistant") return false;
    if (ex.status === "done") return a.status === "done" && (a.finalText === undefined || a.finalText === ex.text);
    if (ex.status !== "streaming") return false;
    const patch: Record<string, unknown> = { status: a.status };
    if (a.finalText !== undefined) patch.text = a.finalText;
    if (a.model) patch.model = a.model;
    await ctx.db.patch(a.messageId, patch);
    const s = await ctx.db
      .query("chatSessions")
      .withIndex("by_thread", (q: any) => q.eq("threadId", a.threadId))
      .first();
    if (s) {
      const otherTurns = await ctx.db
        .query("chatMessages")
        .withIndex("by_thread", (q: any) => q.eq("threadId", a.threadId))
        .order("desc")
        .take(32);
      const stillWorking = otherTurns.some((row: any) => row._id !== a.messageId && row.status === "streaming");
      const sp: Record<string, unknown> = { status: stillWorking ? "working" : "idle", lastActiveAt: Date.now() };
      await ctx.db.patch(s._id, sp);
    }
    return true;
  },
});

// Background work reports through a distinct delivery class. These rows remain
// visible/findable, but the browser must never confuse one with the foreground
// answer to Daniel's current turn or speak it minutes later.
export const postAssistant = mutation({
  args: { threadId: v.string(), text: v.string(), workerToken: v.optional(v.string()) },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    await ctx.db.insert("chatMessages", {
      threadId: a.threadId,
      role: "assistant",
      text: a.text,
      status: "done",
      delivery: "notification",
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
      delivery: "foreground",
      attachment: { type: a.type, value: a.value, title: a.title },
      createdAt: Date.now(),
    });
  },
});

// Wipe a thread (fresh start after maintenance/testing).
export const clearThread = mutation({
  args: { threadId: v.optional(v.string()), ...actorAuthArgs },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const rows = await ctx.db
      .query("chatMessages")
      .withIndex("by_thread", (q: any) => q.eq("threadId", a.threadId ?? "main"))
      .collect();
    for (const r of rows) await ctx.db.delete(r._id);
    return rows.length;
  },
});
