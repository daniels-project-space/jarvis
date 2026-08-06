import { mutation, query } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import {
  actorAuthArgs,
  conversationIdentity,
  conversationViewerIdentity,
  requireActor,
  requireWorker,
  scopedConversationThread,
  viewerAuthArgs,
} from "./controlAuth";

const HOST_CONTEXT_BLOCK = /\s*\[JARVIS_HOST_CONTEXT\][\s\S]*?\[\/JARVIS_HOST_CONTEXT\]\s*/g;
const visibleTurnText = (text: string) => text.replace(HOST_CONTEXT_BLOCK, " ").replace(/\s{2,}/g, " ").trim();
export const CHAT_TURN_STALE_MS = 45_000;
export const MAX_CHAT_TURN_ATTEMPTS = 3;
export const MAX_CHAT_RECOVERY_WAKES = 3;
export const CHAT_PENDING_EXPIRY_MS = 15 * 60_000;
const TERMINAL_RECOVERY_TEXT =
  "I couldn't complete that reply after several recovery attempts. Tap retry to try the request again.";
const GUEST_CHAT_BUCKET_CAPACITY = 3;
const GUEST_CHAT_REFILL_MS = 2 * 60_000;
const GUEST_CHAT_DAILY_LIMIT = 24;
const GUEST_CHAT_MAX_IN_FLIGHT = 2;

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

const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);

async function admitGuestTurn(ctx: { db: any }, guestId: string, now: number) {
  const existing = await ctx.db
    .query("chatGuestLimits")
    .withIndex("by_guest", (q: any) => q.eq("guestId", guestId))
    .first();
  const day = utcDay(now);
  const dayChanged = existing?.day !== day;
  const tokens = Math.min(
    GUEST_CHAT_BUCKET_CAPACITY,
    Number(existing?.tokens ?? GUEST_CHAT_BUCKET_CAPACITY)
      + Math.max(0, now - Number(existing?.refilledAt ?? now)) / GUEST_CHAT_REFILL_MS,
  );
  const dailyCount = dayChanged ? 0 : Number(existing?.dailyCount ?? 0);
  const inFlight = Number(existing?.inFlight ?? 0);
  const retryAfterMs = Math.max(1_000, Math.ceil((1 - tokens) * GUEST_CHAT_REFILL_MS));
  if (inFlight >= GUEST_CHAT_MAX_IN_FLIGHT || tokens < 1 || dailyCount >= GUEST_CHAT_DAILY_LIMIT) {
    throw new ConvexError({
      code: "GUEST_CHAT_RATE_LIMITED",
      reason: inFlight >= GUEST_CHAT_MAX_IN_FLIGHT
        ? "too_many_active_turns"
        : dailyCount >= GUEST_CHAT_DAILY_LIMIT
          ? "daily_limit"
          : "token_bucket",
      retryAfterMs: dailyCount >= GUEST_CHAT_DAILY_LIMIT ? 60 * 60_000 : retryAfterMs,
    });
  }
  const next = {
    guestId,
    tokens: tokens - 1,
    refilledAt: now,
    day,
    dailyCount: dailyCount + 1,
    inFlight: inFlight + 1,
  };
  if (existing) await ctx.db.patch(existing._id, next);
  else await ctx.db.insert("chatGuestLimits", next);
}

async function releaseGuestTurn(ctx: { db: any }, user: any) {
  if (!user || user.role !== "user" || user.guestSlotReleased || !user.threadId.startsWith("guest:")) return;
  const guestId = user.threadId.slice("guest:".length);
  const limit = await ctx.db
    .query("chatGuestLimits")
    .withIndex("by_guest", (q: any) => q.eq("guestId", guestId))
    .first();
  await ctx.db.patch(user._id, { guestSlotReleased: true });
  if (limit) await ctx.db.patch(limit._id, { inFlight: Math.max(0, Number(limit.inFlight ?? 0) - 1) });
}

async function reacquireGuestTurn(ctx: { db: any }, user: any) {
  if (!user?.guestSlotReleased || !user.threadId.startsWith("guest:")) return;
  const guestId = user.threadId.slice("guest:".length);
  const limit = await ctx.db
    .query("chatGuestLimits")
    .withIndex("by_guest", (q: any) => q.eq("guestId", guestId))
    .first();
  await ctx.db.patch(user._id, { guestSlotReleased: false });
  if (limit) await ctx.db.patch(limit._id, { inFlight: Number(limit.inFlight ?? 0) + 1 });
}

export const sendMessage = mutation({
  args: {
    threadId: v.optional(v.string()),
    text: v.string(),
    requestId: v.optional(v.string()),
    ...actorAuthArgs,
  },
  handler: async (ctx, a) => {
    const identity = await conversationIdentity(ctx, a);
    const threadId = scopedConversationThread(identity, a.threadId);
    if (a.requestId) {
      const prior = await ctx.db
        .query("chatMessages")
        .withIndex("by_request", (q: any) => q.eq("requestId", a.requestId))
        .first();
      if (prior?.role === "user" && prior.threadId === threadId) return prior._id;
    }
    if (identity.kind === "guest") await admitGuestTurn(ctx, identity.guestId, Date.now());
    const session = await ensureSession(ctx, threadId);
    // Stable turn slots keep concurrent replies beside the user message that
    // caused them, even when a later fast turn finishes before an earlier one.
    const createdAt = Math.max(Date.now(), Number(session?.lastActiveAt ?? 0) + 2);
    const id = await ctx.db.insert("chatMessages", {
      threadId,
      role: "user",
      text: identity.kind === "guest" ? a.text.slice(0, 2_000) : a.text,
      status: "pending",
      requestId: a.requestId?.slice(0, 120),
      delivery: "foreground",
      attemptCount: 0,
      dispatchEpoch: 0,
      lastProgressAt: createdAt,
      guestSlotReleased: identity.kind === "guest" ? false : undefined,
      createdAt,
    });
    if (session) await ctx.db.patch(session._id, { lastActiveAt: createdAt });
    return id;
  },
});

export const listMessages = query({
  args: { threadId: v.optional(v.string()), ...viewerAuthArgs },
  handler: async (ctx, a) => {
    const identity = await conversationViewerIdentity(ctx, a);
    const threadId = scopedConversationThread(identity, a.threadId);
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
    const identity = await conversationViewerIdentity(ctx, a);
    return await ctx.db
      .query("chatMessages")
      .withIndex("by_thread", (q: any) => q.eq("threadId", scopedConversationThread(identity, a.threadId)))
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
    const identity = await conversationViewerIdentity(ctx, a);
    const rows = await ctx.db
      .query("chatMessages")
      .withIndex("by_thread", (q: any) => q.eq("threadId", scopedConversationThread(identity, a.threadId)))
      .order("desc")
      .take(8);
    return rows.reverse();
  },
});

export const sessionState = query({
  args: { threadId: v.optional(v.string()), ...viewerAuthArgs },
  handler: async (ctx, a) => {
    const identity = await conversationViewerIdentity(ctx, a);
    const threadId = scopedConversationThread(identity, a.threadId);
    return await ctx.db
      .query("chatSessions")
      .withIndex("by_thread", (q: any) => q.eq("threadId", threadId))
      .first();
  },
});

// Exact reactive status for the browser's active turn. It avoids both polling
// and losing recovery visibility when a busy thread pushes the parent outside
// the twenty-row conversation window.
export const turnStatus = query({
  args: {
    messageId: v.id("chatMessages"),
    threadId: v.optional(v.string()),
    ...viewerAuthArgs,
  },
  handler: async (ctx, a) => {
    const identity = await conversationViewerIdentity(ctx, a);
    const threadId = scopedConversationThread(identity, a.threadId);
    const user = await ctx.db.get(a.messageId);
    if (!user || user.role !== "user" || user.threadId !== threadId) return null;
    const assistant = await ctx.db
      .query("chatMessages")
      .withIndex("by_parent", (q: any) => q.eq("parentMessageId", user._id))
      .order("desc")
      .first();
    return {
      messageId: user._id,
      status: user.status,
      attemptCount: Number(user.attemptCount ?? 0),
      assistant: assistant
        ? { _id: assistant._id, status: assistant.status, text: assistant.text, parentMessageId: user._id }
        : null,
    };
  },
});

async function settleSession(ctx: { db: any }, threadId: string) {
  const session = await ctx.db
    .query("chatSessions")
    .withIndex("by_thread", (q: any) => q.eq("threadId", threadId))
    .first();
  if (!session) return;
  const [pending, streaming] = await Promise.all([
    ctx.db
      .query("chatMessages")
      .withIndex("by_thread_status", (q: any) => q.eq("threadId", threadId).eq("status", "pending"))
      .first(),
    ctx.db
      .query("chatMessages")
      .withIndex("by_thread_status", (q: any) => q.eq("threadId", threadId).eq("status", "streaming"))
      .first(),
  ]);
  const stillWorking = Boolean(pending || streaming);
  await ctx.db.patch(session._id, {
    status: stillWorking ? "working" : "idle",
    lastActiveAt: Date.now(),
  });
}

async function recoverAssistant(ctx: { db: any }, assistant: any) {
  const parent = assistant.parentMessageId ? await ctx.db.get(assistant.parentMessageId) : null;
  const attempts = Number(parent?.attemptCount ?? assistant.attemptCount ?? 1);
  if (!parent || parent.role !== "user" || attempts >= MAX_CHAT_TURN_ATTEMPTS) {
    await ctx.db.patch(assistant._id, {
      status: "error",
      text: assistant.text || TERMINAL_RECOVERY_TEXT,
      lastProgressAt: Date.now(),
    });
    if (parent?.role === "user") {
      await ctx.db.patch(parent._id, { status: "error", lastProgressAt: Date.now() });
      await releaseGuestTurn(ctx, parent);
    }
    await settleSession(ctx, assistant.threadId);
    return { status: "failed" as const, messageId: parent?._id ?? null, attemptCount: attempts };
  }
  await ctx.db.patch(assistant._id, {
    status: "superseded",
    text: "",
    lastProgressAt: Date.now(),
  });
  await ctx.db.patch(parent._id, { status: "pending", lastProgressAt: Date.now() });
  const session = await ensureSession(ctx, assistant.threadId);
  if (session) await ctx.db.patch(session._id, { status: "working", lastActiveAt: Date.now() });
  return { status: "requeued" as const, messageId: parent._id, attemptCount: attempts };
}

async function issueRecoveryWake(
  ctx: { db: any },
  user: any,
  status: "pending" | "requeued",
) {
  const dispatchEpoch = Number(user.dispatchEpoch ?? 0) + 1;
  if (dispatchEpoch > MAX_CHAT_RECOVERY_WAKES) {
    await ctx.db.patch(user._id, { status: "error", dispatchEpoch, lastProgressAt: Date.now() });
    await ctx.db.insert("chatMessages", {
      threadId: user.threadId,
      role: "assistant",
      text: TERMINAL_RECOVERY_TEXT,
      status: "error",
      parentMessageId: user._id,
      delivery: "foreground",
      attemptCount: Number(user.attemptCount ?? 0),
      dispatchEpoch,
      lastProgressAt: Date.now(),
      createdAt: user.createdAt + 1,
    });
    await releaseGuestTurn(ctx, user);
    await settleSession(ctx, user.threadId);
    return { status: "failed" as const, attemptCount: Number(user.attemptCount ?? 0), dispatchEpoch };
  }
  await reacquireGuestTurn(ctx, user);
  await ctx.db.patch(user._id, { dispatchEpoch, lastProgressAt: Date.now() });
  return { status, messageId: user._id, attemptCount: Number(user.attemptCount ?? 0), dispatchEpoch };
}

async function expirePending(ctx: { db: any }, user: any) {
  const text = "This request expired while Jarvis was unavailable. Tap retry to send it again.";
  await ctx.db.patch(user._id, { status: "error", lastProgressAt: Date.now() });
  await ctx.db.insert("chatMessages", {
    threadId: user.threadId,
    role: "assistant",
    text,
    status: "error",
    parentMessageId: user._id,
    delivery: "foreground",
    attemptCount: Number(user.attemptCount ?? 0),
    dispatchEpoch: Number(user.dispatchEpoch ?? 0),
    lastProgressAt: Date.now(),
    createdAt: user.createdAt + 1,
  });
  await releaseGuestTurn(ctx, user);
  await settleSession(ctx, user.threadId);
}

// A killed route cannot strand a claimed turn. Fresh heartbeats fence active
// work; only genuinely stale attempts are requeued, and retries are bounded.
export const reapStuck = mutation({
  args: { workerToken: v.optional(v.string()) },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const rows = await ctx.db
      .query("chatMessages")
      .withIndex("by_status", (q: any) => q.eq("status", "streaming"))
      .take(100);
    let requeued = 0;
    let failed = 0;
    let sessionsSettled = 0;
    const cutoff = Date.now() - CHAT_TURN_STALE_MS;
    for (const r of rows) {
      if (Number(r.lastProgressAt ?? r.createdAt) < cutoff) {
        const result = await recoverAssistant(ctx, r);
        if (result.status === "requeued") requeued += 1;
        else failed += 1;
      }
    }
    const staleSessions = await ctx.db
      .query("chatSessions")
      .withIndex("by_status_activity", (q: any) => q.eq("status", "working").lt("lastActiveAt", cutoff))
      .take(100);
    for (const session of staleSessions) {
      await settleSession(ctx, session.threadId);
      sessionsSettled += 1;
    }
    return { requeued, failed, sessionsSettled };
  },
});

// Browser recovery is a single event-driven request, never a polling loop. It
// can wake pending work and can reclaim only an attempt whose heartbeat died.
export const requestRecovery = mutation({
  args: {
    messageId: v.id("chatMessages"),
    threadId: v.optional(v.string()),
    ...actorAuthArgs,
  },
  handler: async (ctx, a) => {
    const identity = await conversationIdentity(ctx, a);
    const threadId = scopedConversationThread(identity, a.threadId);
    const user = await ctx.db.get(a.messageId);
    if (!user || user.role !== "user" || user.threadId !== threadId) return { status: "missing" as const };
    if (user.status === "pending") {
      return await issueRecoveryWake(ctx, user, "pending");
    }
    const assistant = await ctx.db
      .query("chatMessages")
      .withIndex("by_parent", (q: any) => q.eq("parentMessageId", user._id))
      .order("desc")
      .first();
    if (!assistant) return { status: user.status === "done" ? "completed" as const : "missing" as const };
    if (assistant.status === "done") return { status: "completed" as const };
    if (assistant.status === "streaming") {
      if (Date.now() - Number(assistant.lastProgressAt ?? assistant.createdAt) < CHAT_TURN_STALE_MS) {
        return { status: "active" as const, attemptCount: Number(user.attemptCount ?? 1) };
      }
      const recovered = await recoverAssistant(ctx, assistant);
      if (recovered.status !== "requeued") return recovered;
      return await issueRecoveryWake(ctx, await ctx.db.get(user._id), "requeued");
    }
    if (assistant.status === "error" && Number(user.attemptCount ?? 0) < MAX_CHAT_TURN_ATTEMPTS) {
      const recovered = await recoverAssistant(ctx, assistant);
      if (recovered.status !== "requeued") return recovered;
      return await issueRecoveryWake(ctx, await ctx.db.get(user._id), "requeued");
    }
    return { status: "failed" as const, attemptCount: Number(user.attemptCount ?? 0) };
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
    const identity = await conversationIdentity(ctx, a);
    await ctx.db.insert("chatMessages", {
      threadId: scopedConversationThread(identity, a.threadId),
      role: a.role,
      text: a.text,
      status: "done",
      model: a.model,
      delivery: "foreground",
      createdAt: Date.now(),
    });
  },
});

async function claimPending(ctx: { db: any }, pending: any, claimToken: string) {
    const attemptCount = Number(pending.attemptCount ?? 0) + 1;
    const now = Date.now();
    await ctx.db.patch(pending._id, { status: "done", attemptCount, lastProgressAt: now });

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
      attemptCount,
      claimToken,
      lastProgressAt: now,
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
      guest: pending.threadId.startsWith("guest:"),
      userText: pending.text,
      assistantId,
      claimToken,
      attemptCount,
      history,
    };
}

// Immediate Trigger runs claim exactly the message that woke it. The one
// foreground lease then prevents duplicate workers from racing a shared drain.
export const claimMessage = mutation({
  args: { messageId: v.id("chatMessages"), claimToken: v.string(), workerToken: v.optional(v.string()) },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const pending = await ctx.db.get(a.messageId);
    if (!pending || pending.role !== "user" || pending.status !== "pending") return null;
    if (Date.now() - Number(pending.lastProgressAt ?? pending.createdAt) >= CHAT_PENDING_EXPIRY_MS) {
      await expirePending(ctx, pending);
      return null;
    }
    return await claimPending(ctx, pending, a.claimToken);
  },
});

// Recovery-only FIFO claim for a lost Trigger wake-up.
export const claimNext = mutation({
  args: { claimToken: v.string(), workerToken: v.optional(v.string()) },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const pendingRows = await ctx.db
      .query("chatMessages")
      .withIndex("by_status", (q: any) => q.eq("status", "pending"))
      .take(100);
    for (const pending of pendingRows) {
      if (Date.now() - Number(pending.lastProgressAt ?? pending.createdAt) >= CHAT_PENDING_EXPIRY_MS) {
        await expirePending(ctx, pending);
        continue;
      }
      return await claimPending(ctx, pending, a.claimToken);
    }
    return null;
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
    activeMessageId: v.optional(v.id("chatMessages")),
    claimToken: v.optional(v.string()),
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
    if (a.activeMessageId && a.claimToken) {
      const active = await ctx.db.get(a.activeMessageId);
      if (active?.status === "streaming" && active.claimToken === a.claimToken) {
        await ctx.db.patch(active._id, { lastProgressAt: Date.now() });
      }
    }
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
    claimToken: v.string(),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const m = await ctx.db.get(a.messageId);
    if (!m || m.role !== "assistant" || m.status !== "streaming") return false;
    if (m.claimToken !== a.claimToken) return false;
    if (a.revision <= (m.streamRevision ?? 0)) return false;
    await ctx.db.patch(a.messageId, {
      text: a.text,
      streamRevision: a.revision,
      lastProgressAt: Date.now(),
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
    claimToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    // Transport ambiguity guard: if a finalize APPLIED but its HTTP response
    // was lost, the route's catch used to wipe the delivered answer and
    // requeue — Daniel then heard a second, reworded reply minutes later.
    const ex = await ctx.db.get(a.messageId);
    if (!ex || ex.role !== "assistant") return false;
    if (ex.claimToken && a.claimToken !== ex.claimToken) return false;
    if (ex.status === "done") return a.status === "done" && (a.finalText === undefined || a.finalText === ex.text);
    if (ex.status !== "streaming") return false;
    const patch: Record<string, unknown> = { status: a.status, lastProgressAt: Date.now() };
    if (a.finalText !== undefined) patch.text = a.finalText;
    if (a.model) patch.model = a.model;
    await ctx.db.patch(a.messageId, patch);
    if (ex.parentMessageId) {
      const parent = await ctx.db.get(ex.parentMessageId);
      if (parent?.role === "user") {
        await ctx.db.patch(parent._id, { status: a.status, lastProgressAt: Date.now() });
        await releaseGuestTurn(ctx, parent);
      }
    }
    await settleSession(ctx, a.threadId);
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
