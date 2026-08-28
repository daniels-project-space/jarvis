import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { ConvexError, v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { CHAT_FILE_LIMITS, FILE_READY_STATUSES } from "../src/lib/chat-files";
import {
  FOREGROUND_OWNER_TOOL_NAMES,
  foregroundOwnerToolGrantForDirectRequest,
  isForegroundOwnerToolName,
  isToolBeltName,
  TOOL_BELTS,
} from "../src/lib/tool-belts";
import { stripAssistantApprovals } from "../src/lib/sanitize";
import {
  actorAuthArgs,
  conversationIdentity,
  conversationViewerIdentity,
  isAdminSession,
  requireActor,
  requireWorker,
  scopedConversationThread,
  viewerAuthArgs,
} from "./controlAuth";
import {
  isDeterministicFileFollowUp,
  isLikelyFileReference,
  requestedPrivateMediaKind,
  attachFileBadgesToMessages,
  linkFilesToMessage,
  messageFileManifests,
  namedThreadFileManifest,
  recentThreadFileManifest,
  safeChatAttachment,
  threadFileCatalog,
  validateReadyMessageFiles,
} from "./fileHelpers";
import { captureCurrentState } from "./currentState";

const HOST_CONTEXT_BLOCK =
  /\s*\[JARVIS_HOST_CONTEXT\][\s\S]*?\[\/JARVIS_HOST_CONTEXT\]\s*/g;
const visibleTurnText = (text: string) =>
  text
    .replace(HOST_CONTEXT_BLOCK, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
export const CHAT_TURN_STALE_MS = 45_000;
export const MAX_CHAT_TURN_ATTEMPTS = 3;
export const MAX_CHAT_RECOVERY_WAKES = 3;
export const CHAT_PENDING_EXPIRY_MS = 15 * 60_000;
// A warm Codex process retains its native thread. This snapshot is only for
// the occasional cold process, so cap it before it becomes an unbounded model
// prompt and slows down the very first reply after a handoff or restart.
export const FOREGROUND_HISTORY_MESSAGE_LIMIT = 12;
export const FOREGROUND_HISTORY_TEXT_LIMIT = 24_000;
export const FOREGROUND_HISTORY_TEXT_PER_MESSAGE_LIMIT = 4_000;
const RESEARCH_PREFETCH_BASIS_MAX_CHARS = 720;
const RESEARCH_PREFETCH_CONTEXT_MAX_CHARS = 3_600;
const RESEARCH_PREFETCH_MAX_LIFETIME_MS = 60_000;
const TERMINAL_RECOVERY_TEXT =
  "I couldn't complete that reply after several recovery attempts. Tap retry to try the request again.";
const FOREGROUND_STARTUP_FAILURE_TEXT =
  "Jarvis couldn't start this reply right now. Tap retry to try again.";
const CANCELLED_REPLY_TEXT = "Reply cancelled.";
const OWNER_TOOL_COMMITTED_REPLY_TEXT =
  "Reply cancelled. An already-started owner-authorized request may still finish; check its destination before retrying.";
const TURN_CANCELLATION_PREFIX = "foregroundTurnCancellation";
const GUEST_CHAT_BUCKET_CAPACITY = 3;
const GUEST_CHAT_REFILL_MS = 2 * 60_000;
const GUEST_CHAT_DAILY_LIMIT = 24;
const GUEST_CHAT_MAX_IN_FLIGHT = 2;

export const FOREGROUND_HISTORY_OMISSION_MARKER = "\n… [earlier history omitted] …\n";

function boundedForegroundHistoryText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  if (limit <= FOREGROUND_HISTORY_OMISSION_MARKER.length) return text.slice(-limit);
  const retained = limit - FOREGROUND_HISTORY_OMISSION_MARKER.length;
  const prefixLength = Math.ceil(retained * 0.7);
  const suffixLength = retained - prefixLength;
  return [
    text.slice(0, prefixLength),
    FOREGROUND_HISTORY_OMISSION_MARKER,
    suffixLength > 0 ? text.slice(-suffixLength) : "",
  ].join("");
}

export function boundedForegroundHistory(rows: Array<{ role: string; text: string }>) {
  let remaining = FOREGROUND_HISTORY_TEXT_LIMIT;
  const history: Array<{ role: string; text: string }> = [];
  // Preserve the newest anchors first, then restore chronological ordering for
  // the model. A long old answer therefore cannot crowd out the turn Daniel
  // is most likely following up on.
  for (let index = rows.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const row = rows[index];
    const text = boundedForegroundHistoryText(
      row.text,
      Math.min(FOREGROUND_HISTORY_TEXT_PER_MESSAGE_LIMIT, remaining),
    );
    history.unshift({ role: row.role, text });
    remaining -= text.length;
  }
  return history;
}

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

const FOREGROUND_OWNER_TOOL_GRANT_TTL_MS = 20 * 60_000;
const FOREGROUND_OWNER_TOOL_MAX_USES_PER_TURN = 48;
const BROWSER_ERRAND_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

async function deleteTurnPrefetch(ctx: { db: any }, messageId: string) {
  const rows = await ctx.db
    .query("chatTurnPrefetches")
    .withIndex("by_message", (q: any) => q.eq("messageId", messageId))
    .take(4);
  for (const row of rows) await ctx.db.delete(row._id);
}

async function deleteForegroundOwnerToolState(ctx: { db: any }, messageId: string) {
  const [grants, uses] = await Promise.all([
    ctx.db
      .query("chatTurnOwnerToolGrants")
      .withIndex("by_message", (q: any) => q.eq("messageId", messageId))
      .take(4),
    ctx.db
      .query("chatTurnOwnerToolUses")
      .withIndex("by_message", (q: any) => q.eq("messageId", messageId))
      .take(FOREGROUND_OWNER_TOOL_MAX_USES_PER_TURN + 1),
  ]);
  if (uses.length > FOREGROUND_OWNER_TOOL_MAX_USES_PER_TURN) {
    throw new Error("foreground owner tool receipt cleanup bound exceeded");
  }
  for (const row of grants) await ctx.db.delete(row._id);
  for (const row of uses) await ctx.db.delete(row._id);
}

async function hasCommittedForegroundOwnerToolRequest(
  ctx: { db: any },
  messageId: string,
): Promise<boolean> {
  const committed = await ctx.db
    .query("chatTurnOwnerToolUses")
    .withIndex("by_message", (q: any) => q.eq("messageId", messageId))
    .take(1);
  return committed.length > 0;
}

async function deleteTurnEphemera(ctx: { db: any }, messageId: string) {
  await deleteTurnPrefetch(ctx, messageId);
  await deleteForegroundOwnerToolState(ctx, messageId);
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
    Number(existing?.tokens ?? GUEST_CHAT_BUCKET_CAPACITY) +
      Math.max(0, now - Number(existing?.refilledAt ?? now)) /
        GUEST_CHAT_REFILL_MS,
  );
  const dailyCount = dayChanged ? 0 : Number(existing?.dailyCount ?? 0);
  const inFlight = Number(existing?.inFlight ?? 0);
  const retryAfterMs = Math.max(
    1_000,
    Math.ceil((1 - tokens) * GUEST_CHAT_REFILL_MS),
  );
  if (
    inFlight >= GUEST_CHAT_MAX_IN_FLIGHT ||
    tokens < 1 ||
    dailyCount >= GUEST_CHAT_DAILY_LIMIT
  ) {
    throw new ConvexError({
      code: "GUEST_CHAT_RATE_LIMITED",
      reason:
        inFlight >= GUEST_CHAT_MAX_IN_FLIGHT
          ? "too_many_active_turns"
          : dailyCount >= GUEST_CHAT_DAILY_LIMIT
            ? "daily_limit"
            : "token_bucket",
      retryAfterMs:
        dailyCount >= GUEST_CHAT_DAILY_LIMIT ? 60 * 60_000 : retryAfterMs,
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
  if (
    !user ||
    user.role !== "user" ||
    user.guestSlotReleased ||
    !user.threadId.startsWith("guest:")
  )
    return;
  const guestId = user.threadId.slice("guest:".length);
  const limit = await ctx.db
    .query("chatGuestLimits")
    .withIndex("by_guest", (q: any) => q.eq("guestId", guestId))
    .first();
  await ctx.db.patch(user._id, { guestSlotReleased: true });
  if (limit)
    await ctx.db.patch(limit._id, {
      inFlight: Math.max(0, Number(limit.inFlight ?? 0) - 1),
    });
}

async function reacquireGuestTurn(ctx: { db: any }, user: any) {
  if (!user?.guestSlotReleased || !user.threadId.startsWith("guest:")) return;
  const guestId = user.threadId.slice("guest:".length);
  const limit = await ctx.db
    .query("chatGuestLimits")
    .withIndex("by_guest", (q: any) => q.eq("guestId", guestId))
    .first();
  await ctx.db.patch(user._id, { guestSlotReleased: false });
  if (limit)
    await ctx.db.patch(limit._id, {
      inFlight: Number(limit.inFlight ?? 0) + 1,
    });
}

const sendMessageArgs = {
  threadId: v.optional(v.string()),
  text: v.string(),
  requestId: v.optional(v.string()),
  fileIds: v.optional(v.array(v.id("files"))),
  researchPrefetch: v.optional(
    v.object({
      basis: v.string(),
      context: v.string(),
      expiresAt: v.number(),
    }),
  ),
  ...actorAuthArgs,
};

type SendMessageArgs = {
  threadId?: string;
  text: string;
  requestId?: string;
  fileIds?: Id<"files">[];
  researchPrefetch?: { basis: string; context: string; expiresAt: number };
  authTokenHash?: string;
  workerToken?: string;
  guestId?: string;
};

async function admitMessage(
  ctx: MutationCtx,
  a: SendMessageArgs,
): Promise<Id<"chatMessages">> {
  const identity = await conversationIdentity(ctx, a);
  const threadId = scopedConversationThread(identity, a.threadId);
  const submittedText = a.text;
  const requestId = a.requestId?.slice(0, 120);
  if (requestId) {
    const prior = await ctx.db
      .query("chatMessages")
      .withIndex("by_request", (q: any) => q.eq("requestId", requestId))
      .first();
    if (prior?.role === "user") {
      if (prior.threadId !== threadId || prior.text !== submittedText) {
        throw new ConvexError({
          code: "CHAT_REQUEST_CONFLICT",
          message:
            "Chat request identity was reused with different text or thread",
        });
      }
      const requestedIds = (a.fileIds ?? []).map(String);
      const links =
        prior.hasLinkedFiles === false && requestedIds.length === 0
          ? []
          : await ctx.db
              .query("messageFiles")
              .withIndex("by_message", (q: any) => q.eq("messageId", prior._id))
              .take(9);
      const priorIds = links
        .sort((left: any, right: any) => left.position - right.position)
        .map((link: any) => String(link.fileId));
      if (
        priorIds.length !== requestedIds.length ||
        priorIds.some(
          (fileId: string, index: number) => fileId !== requestedIds[index],
        )
      ) {
        throw new ConvexError({
          code: "CHAT_REQUEST_CONFLICT",
          message: "Chat request identity was reused with different files",
        });
      }
      return prior._id;
    }
  }
  const files = await validateReadyMessageFiles(
    ctx,
    threadId,
    a.fileIds,
    false,
  );
  const session = await ensureSession(ctx, threadId);
  // Stable turn slots keep concurrent replies beside the user message that
  // caused them, even when a later fast turn finishes before an earlier one.
  const createdAt = Math.max(
    Date.now(),
    Number(session?.lastActiveAt ?? 0) + 2,
  );
  const prefetch = a.researchPrefetch;
  const validPrefetch = Boolean(
    prefetch &&
    prefetch.basis.length >= 24 &&
    prefetch.basis.length <= RESEARCH_PREFETCH_BASIS_MAX_CHARS &&
    prefetch.context.length >= 40 &&
    prefetch.context.length <= RESEARCH_PREFETCH_CONTEXT_MAX_CHARS &&
    prefetch.expiresAt > createdAt &&
    prefetch.expiresAt <= createdAt + RESEARCH_PREFETCH_MAX_LIFETIME_MS,
  );
  const id = await ctx.db.insert("chatMessages", {
    threadId,
    role: "user",
    text: submittedText,
    status: "pending",
    requestId,
    delivery: "foreground",
    attemptCount: 0,
    dispatchEpoch: 0,
    lastProgressAt: createdAt,
    hasLinkedFiles: files.length > 0,
    hasResearchPrefetch: validPrefetch,
    createdAt,
  });
  // This scope is minted only after conversationIdentity accepted the
  // authenticated owner and the submitted message starts with a direct,
  // unquoted Gmail/iCloud Calendar/browser-errand command. A browser command
  // additionally has to contain exactly one durable errand ID, persisted
  // below before the model can discover the run tool. No browser credential is
  // retained: later calls are separately bound to the active assistant claim
  // and a short receipt, and never rescan arbitrary conversation text.
  const ownerToolGrant = foregroundOwnerToolGrantForDirectRequest(submittedText);
  const ownerToolNames = ownerToolGrant.toolNames;
  if (
    ownerToolNames.length > 0
    && identity.kind === "owner"
    && await isAdminSession(ctx, a.authTokenHash)
  ) {
    await ctx.db.insert("chatTurnOwnerToolGrants", {
      messageId: id,
      threadId,
      toolNames: ownerToolNames,
      ...(ownerToolGrant.calendarAndHubTodo ? { calendarAndHubTodo: true } : {}),
      ...(ownerToolGrant.browserErrandId ? { browserErrandId: ownerToolGrant.browserErrandId } : {}),
      issuedAt: createdAt,
      expiresAt: createdAt + FOREGROUND_OWNER_TOOL_GRANT_TTL_MS,
    });
  }
  await captureCurrentState(ctx, {
    text: visibleTurnText(submittedText),
    messageId: String(id),
    observedAt: createdAt,
  });
  await linkFilesToMessage(ctx, id, threadId, files, createdAt);
  if (prefetch) {
    // Research is an optional latency optimization. A stale or drifted
    // envelope must never reject the authoritative user turn.
    if (validPrefetch) {
      await ctx.db.insert("chatTurnPrefetches", {
        messageId: id,
        threadId,
        basis: prefetch.basis,
        context: prefetch.context,
        expiresAt: prefetch.expiresAt,
        createdAt,
      });
    }
  }
  if (session) await ctx.db.patch(session._id, { lastActiveAt: createdAt });
  return id;
}

export const sendMessage = mutation({
  args: sendMessageArgs,
  handler: admitMessage,
});

export const sendMessageWithRunnerLease = mutation({
  args: sendMessageArgs,
  handler: async (ctx, a) => {
    const messageId = await admitMessage(ctx, a);
    const runner = await ctx.db
      .query("ui")
      .withIndex("by_key", (q: any) => q.eq("key", RUNNER_KEY))
      .first();
    return {
      messageId,
      warmRunner: Boolean(
        runner?.updatedAt && Date.now() - runner.updatedAt < 25_000,
      ),
    };
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
    return await attachFileBadgesToMessages(ctx, threadId, rows.reverse());
  },
});

export const HISTORY_PAGE_MAX = 20;

// Older rows are loaded only by the explicitly mounted history drawer. Clamp
// every cursor request server-side: pagination's numItems is advisory for a
// reactive query, while maximumRowsRead is the actual database read ceiling.
export const paginatedMessages = query({
  args: {
    threadId: v.optional(v.string()),
    paginationOpts: paginationOptsValidator,
    ...viewerAuthArgs,
  },
  handler: async (ctx, a) => {
    const identity = await conversationViewerIdentity(ctx, a);
    const threadId = scopedConversationThread(identity, a.threadId);
    const result = await ctx.db
      .query("chatMessages")
      .withIndex("by_thread", (q: any) => q.eq("threadId", threadId))
      .order("desc")
      .paginate({
        ...a.paginationOpts,
        numItems: Math.min(
          HISTORY_PAGE_MAX,
          Math.max(
            1,
            Math.floor(a.paginationOpts.numItems || HISTORY_PAGE_MAX),
          ),
        ),
        maximumRowsRead: HISTORY_PAGE_MAX,
        maximumBytesRead: 256 * 1024,
      });
    return {
      ...result,
      page: await attachFileBadgesToMessages(ctx, threadId, result.page),
    };
  },
});

// The Project Hub renders only the orb and live captions. It needs the current
// foreground turn, not a 100-row chat drawer, so keep that embedded realtime
// subscription deliberately lean while retaining enough rows for overlap.
export const listRecentMessages = query({
  args: { threadId: v.optional(v.string()), ...viewerAuthArgs },
  handler: async (ctx, a) => {
    const identity = await conversationViewerIdentity(ctx, a);
    const threadId = scopedConversationThread(identity, a.threadId);
    const rows = await ctx.db
      .query("chatMessages")
      .withIndex("by_thread", (q: any) => q.eq("threadId", threadId))
      .order("desc")
      .take(8);
    return await attachFileBadgesToMessages(ctx, threadId, rows.reverse());
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
    if (!user || user.role !== "user" || user.threadId !== threadId)
      return null;
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
        ? {
            _id: assistant._id,
            status: assistant.status,
            text: assistant.text,
            parentMessageId: user._id,
          }
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
      .withIndex("by_thread_status", (q: any) =>
        q.eq("threadId", threadId).eq("status", "pending"),
      )
      .first(),
    ctx.db
      .query("chatMessages")
      .withIndex("by_thread_status", (q: any) =>
        q.eq("threadId", threadId).eq("status", "streaming"),
      )
      .first(),
  ]);
  const stillWorking = Boolean(pending || streaming);
  await ctx.db.patch(session._id, {
    status: stillWorking ? "working" : "idle",
    lastActiveAt: Date.now(),
  });
}

async function recoverAssistant(ctx: { db: any }, assistant: any) {
  const parent = assistant.parentMessageId
    ? await ctx.db.get(assistant.parentMessageId)
    : null;
  const attempts = Number(parent?.attemptCount ?? assistant.attemptCount ?? 1);
  const ownerToolCommitted = parent?.role === "user"
    && await hasCommittedForegroundOwnerToolRequest(ctx, parent._id);
  await sealWorkerCancellationFence(ctx, assistant, `recovery:${Date.now()}`);
  if (ownerToolCommitted || !parent || parent.role !== "user" || attempts >= MAX_CHAT_TURN_ATTEMPTS) {
    await ctx.db.patch(assistant._id, {
      status: "error",
      text: ownerToolCommitted
        ? OWNER_TOOL_COMMITTED_REPLY_TEXT
        : assistant.text || TERMINAL_RECOVERY_TEXT,
      lastProgressAt: Date.now(),
    });
    if (parent?.role === "user") {
      await ctx.db.patch(parent._id, {
        status: "error",
        lastProgressAt: Date.now(),
      });
      await releaseGuestTurn(ctx, parent);
      await deleteTurnEphemera(ctx, parent._id);
    }
    await settleSession(ctx, assistant.threadId);
    return {
      status: "failed" as const,
      messageId: parent?._id ?? null,
      attemptCount: attempts,
      ownerToolCommitted,
    };
  }
  await ctx.db.patch(assistant._id, {
    status: "superseded",
    text: "",
    lastProgressAt: Date.now(),
  });
  await ctx.db.patch(parent._id, {
    status: "pending",
    lastProgressAt: Date.now(),
  });
  const session = await ensureSession(ctx, assistant.threadId);
  if (session)
    await ctx.db.patch(session._id, {
      status: "working",
      lastActiveAt: Date.now(),
    });
  return {
    status: "requeued" as const,
    messageId: parent._id,
    attemptCount: attempts,
  };
}

async function issueRecoveryWake(
  ctx: { db: any },
  user: any,
  status: "pending" | "requeued",
) {
  const dispatchEpoch = Number(user.dispatchEpoch ?? 0) + 1;
  if (dispatchEpoch > MAX_CHAT_RECOVERY_WAKES) {
    await ctx.db.patch(user._id, {
      status: "error",
      dispatchEpoch,
      lastProgressAt: Date.now(),
    });
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
    await deleteTurnEphemera(ctx, user._id);
    await settleSession(ctx, user.threadId);
    return {
      status: "failed" as const,
      attemptCount: Number(user.attemptCount ?? 0),
      dispatchEpoch,
    };
  }
  await reacquireGuestTurn(ctx, user);
  await ctx.db.patch(user._id, { dispatchEpoch, lastProgressAt: Date.now() });
  return {
    status,
    messageId: user._id,
    attemptCount: Number(user.attemptCount ?? 0),
    dispatchEpoch,
  };
}

async function expirePending(ctx: { db: any }, user: any) {
  const text =
    "This request expired while Jarvis was unavailable. Tap retry to send it again.";
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
  await deleteTurnEphemera(ctx, user._id);
  await settleSession(ctx, user.threadId);
}

// A Trigger task can fail before it has claimed its exact wake-up row (for
// example, while validating the subscription session). Settle only that still
// pending row: a concurrent worker claim wins this race and remains untouched.
export const failPendingStartup = mutation({
  args: {
    messageId: v.id("chatMessages"),
    threadId: v.string(),
    expectedDispatchEpoch: v.number(),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const user = await ctx.db.get(a.messageId);
    if (
      !user
      || user.role !== "user"
      || user.threadId !== a.threadId
      || user.status !== "pending"
      || !Number.isSafeInteger(a.expectedDispatchEpoch)
      || a.expectedDispatchEpoch < 0
      || Number(user.dispatchEpoch ?? 0) !== a.expectedDispatchEpoch
    ) return false;

    const assistant = await ctx.db
      .query("chatMessages")
      .withIndex("by_parent", (q: any) => q.eq("parentMessageId", user._id))
      .order("desc")
      .first();
    // A worker that won the claim will have inserted its streaming child. Do
    // not overwrite it merely because this wake-up lost a startup race.
    if (assistant) return false;

    const now = Date.now();
    await ctx.db.patch(user._id, { status: "error", lastProgressAt: now });
    await ctx.db.insert("chatMessages", {
      threadId: user.threadId,
      role: "assistant",
      text: FOREGROUND_STARTUP_FAILURE_TEXT,
      status: "error",
      parentMessageId: user._id,
      delivery: "foreground",
      attemptCount: Number(user.attemptCount ?? 0),
      dispatchEpoch: Number(user.dispatchEpoch ?? 0),
      lastProgressAt: now,
      createdAt: user.createdAt + 1,
    });
    await releaseGuestTurn(ctx, user);
    await deleteTurnEphemera(ctx, user._id);
    await settleSession(ctx, user.threadId);
    return true;
  },
});

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
      .withIndex("by_status_activity", (q: any) =>
        q.eq("status", "working").lt("lastActiveAt", cutoff),
      )
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
    if (!user || user.role !== "user" || user.threadId !== threadId)
      return { status: "missing" as const };
    const cancellation = await ctx.db
      .query("ui")
      .withIndex("by_key", (q) =>
        q.eq("key", cancellationReceiptKey(String(user._id))),
      )
      .first();
    if (cancellation) {
      return { status: "cancelled" as const, messageId: user._id };
    }
    if (user.status === "pending") {
      return await issueRecoveryWake(ctx, user, "pending");
    }
    const assistant = await ctx.db
      .query("chatMessages")
      .withIndex("by_parent", (q: any) => q.eq("parentMessageId", user._id))
      .order("desc")
      .first();
    if (!assistant)
      return {
        status:
          user.status === "done"
            ? ("completed" as const)
            : ("missing" as const),
      };
    if (assistant.status === "done") {
      // Recovery is also a delivery path. A browser can miss the reactive
      // transition while reconnecting, so return the finished assistant row
      // instead of merely saying that it exists.
      return {
        status: "completed" as const,
        assistant: {
          _id: assistant._id,
          role: assistant.role,
          text: assistant.text,
          status: assistant.status,
          model: assistant.model,
          delivery: assistant.delivery,
          parentMessageId: assistant.parentMessageId,
          createdAt: assistant.createdAt,
        },
      };
    }
    if (assistant.status === "streaming") {
      if (
        Date.now() - Number(assistant.lastProgressAt ?? assistant.createdAt) <
        CHAT_TURN_STALE_MS
      ) {
        return {
          status: "active" as const,
          attemptCount: Number(user.attemptCount ?? 1),
        };
      }
      const recovered = await recoverAssistant(ctx, assistant);
      if (recovered.status !== "requeued") return recovered;
      return await issueRecoveryWake(
        ctx,
        await ctx.db.get(user._id),
        "requeued",
      );
    }
    if (
      assistant.status === "error" &&
      Number(user.attemptCount ?? 0) < MAX_CHAT_TURN_ATTEMPTS
    ) {
      const recovered = await recoverAssistant(ctx, assistant);
      if (recovered.status !== "requeued") return recovered;
      return await issueRecoveryWake(
        ctx,
        await ctx.db.get(user._id),
        "requeued",
      );
    }
    return {
      status: "failed" as const,
      attemptCount: Number(user.attemptCount ?? 0),
    };
  },
});

const cancellationReceiptKey = (messageId: string) =>
  `${TURN_CANCELLATION_PREFIX}:receipt:${messageId}`;
const cancellationTokenFingerprint = (claimToken: string) => {
  let hash = 2_166_136_261;
  for (const char of claimToken.slice(0, 120)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
};
const workerCancellationKey = (assistantId: string, claimToken: string) =>
  `${TURN_CANCELLATION_PREFIX}:worker:${assistantId}:${cancellationTokenFingerprint(claimToken)}`;

async function sealWorkerCancellationFence(
  ctx: Pick<MutationCtx, "db">,
  assistant: Doc<"chatMessages"> | null | undefined,
  receipt: string,
) {
  if (!assistant?.claimToken) return;
  const key = workerCancellationKey(
    String(assistant._id),
    assistant.claimToken,
  );
  const existing = await ctx.db
    .query("ui")
    .withIndex("by_key", (q) => q.eq("key", key))
    .first();
  if (!existing) {
    await ctx.db.insert("ui", {
      key,
      type: "foreground-turn-cancellation-fence",
      value: receipt,
      updatedAt: Date.now(),
    });
  }
}

export const cancelTurn = mutation({
  args: {
    messageId: v.id("chatMessages"),
    threadId: v.optional(v.string()),
    ...actorAuthArgs,
  },
  handler: async (ctx, a) => {
    const identity = await conversationIdentity(ctx, a);
    const threadId = scopedConversationThread(identity, a.threadId);
    const user = await ctx.db.get(a.messageId);
    if (!user || user.role !== "user" || user.threadId !== threadId) {
      return { status: "missing" as const };
    }

    const assistant = await ctx.db
      .query("chatMessages")
      .withIndex("by_parent", (q) => q.eq("parentMessageId", user._id))
      .order("desc")
      .first();
    if (assistant?.status === "done") {
      await deleteTurnEphemera(ctx, user._id);
      return { status: "completed" as const };
    }

    // Redemption is an irrevocable external-action commit point. If it won a
    // race with this cancellation, we stop the reply but report truthfully
    // that the already-started provider request may still finish.
    const ownerToolCommitted = await hasCommittedForegroundOwnerToolRequest(ctx, user._id);
    const cancellationText = ownerToolCommitted
      ? OWNER_TOOL_COMMITTED_REPLY_TEXT
      : CANCELLED_REPLY_TEXT;

    const receiptKey = cancellationReceiptKey(String(user._id));
    const existingReceipt = await ctx.db
      .query("ui")
      .withIndex("by_key", (q) => q.eq("key", receiptKey))
      .first();
    if (existingReceipt) {
      await deleteTurnEphemera(ctx, user._id);
      return {
        status: "cancelled" as const,
        messageId: user._id,
        fenceReceipt: existingReceipt.value,
        ownerToolCommitted: ownerToolCommitted
          || assistant?.text === OWNER_TOOL_COMMITTED_REPLY_TEXT,
      };
    }

    const now = Date.now();
    const fenceReceipt = `${String(user._id)}:${Number(user.dispatchEpoch ?? 0)}:${now}`;
    await ctx.db.insert("ui", {
      key: receiptKey,
      type: "foreground-turn-cancellation-receipt",
      value: fenceReceipt,
      updatedAt: now,
    });

    // The worker-only tombstone is separate from the frequently heartbeated
    // message row. Its realtime query wakes exactly once when cancellation is
    // sealed, avoiding both polling and heartbeat-driven subscription churn.
    await sealWorkerCancellationFence(ctx, assistant, fenceReceipt);

    if (assistant?.status === "streaming") {
      await ctx.db.patch(assistant._id, {
        status: "error",
        text: cancellationText,
        lastProgressAt: now,
      });
    } else if (!assistant || assistant.status === "superseded") {
      await ctx.db.insert("chatMessages", {
        threadId,
        role: "assistant",
        text: cancellationText,
        status: "error",
        parentMessageId: user._id,
        delivery: "foreground",
        lastProgressAt: now,
        createdAt: now,
      });
    }
    if (user.status === "pending" || user.status === "done") {
      await ctx.db.patch(user._id, { status: "error", lastProgressAt: now });
    }
    await releaseGuestTurn(ctx, user);
    await deleteTurnEphemera(ctx, user._id);
    await settleSession(ctx, threadId);
    return {
      status: "cancelled" as const,
      messageId: user._id,
      fenceReceipt,
      ownerToolCommitted,
    };
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

async function claimPending(
  ctx: { db: any },
  pending: any,
  claimToken: string,
) {
  const attemptCount = Number(pending.attemptCount ?? 0) + 1;
  const now = Date.now();
  await ctx.db.patch(pending._id, {
    status: "done",
    attemptCount,
    lastProgressAt: now,
  });

  const session = await ctx.db
    .query("chatSessions")
    .withIndex("by_thread", (q: any) => q.eq("threadId", pending.threadId))
    .first();
  if (session)
    await ctx.db.patch(session._id, {
      status: "working",
      lastActiveAt: Date.now(),
    });

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
  const ownerToolGrant = await ctx.db
    .query("chatTurnOwnerToolGrants")
    .withIndex("by_message", (q: any) => q.eq("messageId", pending._id))
    .first();
  const liveOwnerToolGrant = Boolean(
    ownerToolGrant
      && ownerToolGrant.threadId === pending.threadId
      && ownerToolGrant.expiresAt > now
      && Array.isArray(ownerToolGrant.toolNames),
  );
  const browserErrandId = typeof ownerToolGrant?.browserErrandId === "string"
    && BROWSER_ERRAND_ID_RE.test(ownerToolGrant.browserErrandId)
    ? ownerToolGrant.browserErrandId
    : undefined;
  // Carry only the exact, admission-persisted scope into this active claim.
  // Model-generated wording and the remaining conversation never participate
  // in this decision.
  const ownerToolNames = liveOwnerToolGrant
    ? [...FOREGROUND_OWNER_TOOL_NAMES].filter((name) =>
      ownerToolGrant.toolNames.includes(name)
      && (name !== "browser_errand_run" || Boolean(browserErrandId)),
    )
    : [];
  const ownerToolAccess = ownerToolNames.length > 0;
  const ownerCalendarAndHubTodo = ownerToolNames.includes("icloud_calendar_create")
    && ownerToolGrant?.calendarAndHubTodo === true;

  const all = await ctx.db
    .query("chatMessages")
    .withIndex("by_thread", (q: any) => q.eq("threadId", pending.threadId))
    .order("desc")
    .take(40);
  const historyRows = all
    .filter(
      (m: any) =>
        m._id !== assistantId &&
        m._id !== pending._id &&
        m.status === "done" &&
        m.delivery !== "notification" &&
        m.createdAt < pending.createdAt,
    )
    .sort((a: any, b: any) => a.createdAt - b.createdAt)
    .slice(-FOREGROUND_HISTORY_MESSAGE_LIMIT)
    .map((m: any) => ({
      role: m.role,
      // Approval markers are bearer receipts. Keep the source row intact so
      // the owner can still redeem its dedicated card, but never put a live
      // receipt into another model turn's context.
      text: m.role === "user" ? visibleTurnText(m.text) : stripAssistantApprovals(m.text),
    }));
  const history = boundedForegroundHistory(historyRows);
  const prefetchRow =
    pending.hasResearchPrefetch === false
      ? null
      : await ctx.db
          .query("chatTurnPrefetches")
          .withIndex("by_message", (q: any) => q.eq("messageId", pending._id))
          .first();
  const researchPrefetch =
    prefetchRow && prefetchRow.expiresAt > now
      ? {
          basis: prefetchRow.basis,
          context: prefetchRow.context,
          expiresAt: prefetchRow.expiresAt,
        }
      : undefined;
  if (prefetchRow && !researchPrefetch) await ctx.db.delete(prefetchRow._id);
  // Attachment scope is intentionally the exact claimed user row. Thread
  // library files and files on any earlier/later message never enter this
  // turn implicitly.
  const messageAttachments =
    pending.hasLinkedFiles === false
      ? []
      : await messageFileManifests(ctx, pending._id, pending.text);
  const fileRelevant =
    messageAttachments.length > 0 || isLikelyFileReference(pending.text);
  const requestedMediaKind = requestedPrivateMediaKind(pending.text);
  const namedReference =
    !messageAttachments.length && fileRelevant
      ? await namedThreadFileManifest(ctx, pending.threadId, pending.text)
      : null;
  const recentFallback =
    !messageAttachments.length &&
    !namedReference &&
    isDeterministicFileFollowUp(pending.text)
      ? await recentThreadFileManifest(ctx, pending.threadId, requestedMediaKind)
      : null;
  const resolvedFallback = namedReference ?? recentFallback;
  if (resolvedFallback) {
    const file = await ctx.db.get(resolvedFallback.fileId);
    if (file && FILE_READY_STATUSES.has(String(file.status))) {
      // Persist deterministic named/recent resolution on the invoking turn
      // before any model/tool runs. Retries now see the same exact source,
      // history shows it, and creations can cite it durably.
      await linkFilesToMessage(
        ctx,
        pending._id,
        pending.threadId,
        [file],
        pending.createdAt,
      );
      await ctx.db.patch(pending._id, { hasLinkedFiles: true });
    }
  }
  const attachments = resolvedFallback
    ? (await messageFileManifests(ctx, pending._id, pending.text)).map(
        (file) => ({
          ...file,
          ...(file.fileId === resolvedFallback.fileId
            ? { selection: resolvedFallback.selection }
            : {}),
        }),
      )
    : messageAttachments;
  const fileCatalog =
    fileRelevant && !attachments.length && !requestedMediaKind
      ? await threadFileCatalog(ctx, pending.threadId)
      : [];

  return {
    threadId: pending.threadId,
    guest: pending.threadId.startsWith("guest:"),
    userText: pending.text,
    requestId: pending.requestId,
    userMessageId: pending._id,
    assistantId,
    claimToken,
    ownerToolAccess,
    ...(ownerToolAccess ? { ownerToolNames } : {}),
    ...(ownerCalendarAndHubTodo ? { ownerCalendarAndHubTodo: true } : {}),
    attemptCount,
    history,
    researchPrefetch,
    attachments,
    fileCatalog,
  };
}

// Immediate Trigger runs claim exactly the message that woke it. The one
// foreground lease then prevents duplicate workers from racing a shared drain.
export const claimMessage = mutation({
  args: {
    messageId: v.id("chatMessages"),
    claimToken: v.string(),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const pending = await ctx.db.get(a.messageId);
    if (!pending || pending.role !== "user" || pending.status !== "pending")
      return null;
    if (
      Date.now() - Number(pending.lastProgressAt ?? pending.createdAt) >=
      CHAT_PENDING_EXPIRY_MS
    ) {
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
      if (
        Date.now() - Number(pending.lastProgressAt ?? pending.createdAt) >=
        CHAT_PENDING_EXPIRY_MS
      ) {
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
    const row = await ctx.db
      .query("ui")
      .withIndex("by_key", (q: any) => q.eq("key", RUNNER_KEY))
      .first();
    const validHandoff = Boolean(
      a.takeoverFrom && row?.value === a.takeoverFrom,
    );
    if (
      row &&
      row.value !== a.runnerId &&
      !validHandoff &&
      Date.now() - row.updatedAt < RUNNER_LEASE_MS
    )
      return false;
    const doc = {
      key: RUNNER_KEY,
      type: "lease",
      value: a.runnerId,
      updatedAt: Date.now(),
    };
    if (row) await ctx.db.patch(row._id, doc);
    else await ctx.db.insert("ui", doc);
    if (a.activeMessageId && a.claimToken) {
      const active = await ctx.db.get(a.activeMessageId);
      if (
        active?.status === "streaming" &&
        active.claimToken === a.claimToken
      ) {
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
    const row = await ctx.db
      .query("ui")
      .withIndex("by_key", (q: any) => q.eq("key", RUNNER_KEY))
      .first();
    if (row?.value !== a.runnerId) {
      return { released: false, pendingMessageId: null, pendingThreadId: null, pendingDispatchEpoch: null };
    }
    // Lease retirement and the pending check must be one transaction. If a
    // message was admitted before this delete, the retiring worker launches a
    // replacement; if admission happens after it, Vercel observes no runner
    // and launches one itself. There is no warm-snapshot gap where neither acts.
    await ctx.db.delete(row._id);
    const pending = await ctx.db
      .query("chatMessages")
      .withIndex("by_status", (q: any) => q.eq("status", "pending"))
      .first();
    return {
      released: true,
      pendingMessageId: pending?._id ?? null,
      pendingThreadId: pending?.threadId ?? null,
      pendingDispatchEpoch: pending ? Number(pending.dispatchEpoch ?? 0) : null,
    };
  },
});

export const runnerLease = query({
  args: { ...actorAuthArgs },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const row = await ctx.db
      .query("ui")
      .withIndex("by_key", (q: any) => q.eq("key", RUNNER_KEY))
      .first();
    return row ? { runnerId: row.value, updatedAt: row.updatedAt } : null;
  },
});

export const runnerLeaseForWorker = query({
  args: { workerToken: v.optional(v.string()) },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const row = await ctx.db
      .query("ui")
      .withIndex("by_key", (q: any) => q.eq("key", RUNNER_KEY))
      .first();
    return row ? { runnerId: row.value, updatedAt: row.updatedAt } : null;
  },
});

export const turnCancellationForWorker = query({
  args: {
    messageId: v.id("chatMessages"),
    claimToken: v.string(),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const row = await ctx.db
      .query("ui")
      .withIndex("by_key", (q) =>
        q.eq("key", workerCancellationKey(String(a.messageId), a.claimToken)),
      )
      .first();
    return Boolean(row);
  },
});

type ForegroundOwnerToolLiveGrant = {
  toolNames: string[];
  browserErrandId?: string;
  calendarAndHubTodo?: true;
};

async function foregroundOwnerToolGrantForLiveClaim(
  ctx: { db: any },
  claim: { messageId: any; assistantId: any; claimToken: string },
): Promise<ForegroundOwnerToolLiveGrant> {
  const [message, assistant, grant, cancellation] = await Promise.all([
    ctx.db.get(claim.messageId),
    ctx.db.get(claim.assistantId),
    ctx.db
      .query("chatTurnOwnerToolGrants")
      .withIndex("by_message", (q: any) => q.eq("messageId", claim.messageId))
      .first(),
    ctx.db
      .query("ui")
      .withIndex("by_key", (q: any) => q.eq("key", cancellationReceiptKey(String(claim.messageId))))
      .first(),
  ]);
  const now = Date.now();
  if (
    !message || message.role !== "user"
    || !assistant || assistant.role !== "assistant"
    || assistant.status !== "streaming"
    || assistant.delivery !== "foreground"
    || assistant.parentMessageId !== message._id
    || assistant.threadId !== message.threadId
    || assistant.claimToken !== claim.claimToken
    || !grant || grant.messageId !== message._id
    || grant.threadId !== message.threadId
    || grant.expiresAt <= now
    || cancellation
  ) return { toolNames: [] };
  // This is the exact authenticated admission scope. Do not rescan the user
  // row here: the model, quoted text, or attachments must never expand it.
  // A legacy/generic browser grant is deliberately stripped: browser runs
  // require the owner-message ID that was persisted at admission.
  const browserErrandId = typeof grant.browserErrandId === "string"
    && BROWSER_ERRAND_ID_RE.test(grant.browserErrandId)
    ? grant.browserErrandId
    : undefined;
  const toolNames = [...FOREGROUND_OWNER_TOOL_NAMES].filter((name) =>
    Array.isArray(grant.toolNames)
    && grant.toolNames.includes(name)
    && (name !== "browser_errand_run" || Boolean(browserErrandId)),
  );
  return {
    toolNames,
    ...(toolNames.includes("icloud_calendar_create") && grant.calendarAndHubTodo === true
      ? { calendarAndHubTodo: true as const }
      : {}),
    ...(toolNames.includes("browser_errand_run") && browserErrandId ? { browserErrandId } : {}),
  };
}

// The Vercel foreground-owner endpoint is dispatch-authenticated, but this
// second worker-only fence is the authority: it ties every definition lookup
// to the current streaming assistant row and the exact claim token.
export const foregroundOwnerToolDefinitionsForWorker = query({
  args: {
    messageId: v.id("chatMessages"),
    assistantId: v.id("chatMessages"),
    claimToken: v.string(),
    belt: v.string(),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    if (!isToolBeltName(a.belt)) return { allowed: false, toolNames: [] as string[] };
    const grant = await foregroundOwnerToolGrantForLiveClaim(ctx, a);
    const toolNames = grant.toolNames.filter((name) => TOOL_BELTS[a.belt].has(name));
    return { allowed: toolNames.length > 0, toolNames };
  },
});

// One dynamic call ID can be redeemed at most once. This is deliberately a
// mutation rather than a query so a stale Trigger/Vercel retry cannot replay a
// Gmail draft or a Calendar proposal after the model has moved on.
export const redeemForegroundOwnerToolForWorker = mutation({
  args: {
    messageId: v.id("chatMessages"),
    assistantId: v.id("chatMessages"),
    claimToken: v.string(),
    callId: v.string(),
    toolName: v.string(),
    browserErrandId: v.optional(v.string()),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const toolName = a.toolName.trim();
    const callId = a.callId.trim();
    if (!isForegroundOwnerToolName(toolName) || !/^[A-Za-z0-9_.:-]{1,256}$/.test(callId)) {
      return { allowed: false };
    }
    const browserErrandId = a.browserErrandId?.trim();
    if (
      (toolName === "browser_errand_run" && (!browserErrandId || !BROWSER_ERRAND_ID_RE.test(browserErrandId)))
      || (toolName !== "browser_errand_run" && browserErrandId !== undefined)
    ) return { allowed: false };
    const grant = await foregroundOwnerToolGrantForLiveClaim(ctx, a);
    if (!grant.toolNames.includes(toolName)) return { allowed: false };
    if (toolName === "browser_errand_run" && grant.browserErrandId !== browserErrandId) {
      return { allowed: false };
    }
    const receiptKey = `${String(a.assistantId)}:${callId}`;
    const [existing, uses] = await Promise.all([
      ctx.db
        .query("chatTurnOwnerToolUses")
        .withIndex("by_receipt", (q: any) => q.eq("receiptKey", receiptKey))
        .first(),
      ctx.db
        .query("chatTurnOwnerToolUses")
        .withIndex("by_message", (q: any) => q.eq("messageId", a.messageId))
        .take(FOREGROUND_OWNER_TOOL_MAX_USES_PER_TURN + 1),
    ]);
    const browserRunAlreadyRedeemed = toolName === "browser_errand_run"
      && uses.some((use: any) => use.toolName === "browser_errand_run");
    if (existing || uses.length >= FOREGROUND_OWNER_TOOL_MAX_USES_PER_TURN || browserRunAlreadyRedeemed) {
      return { allowed: false };
    }
    // This insert is the irrevocable linearization point. Once it succeeds,
    // cancellation/recovery may retire the reply but cannot safely pretend a
    // provider request that starts immediately afterward did not happen.
    await ctx.db.insert("chatTurnOwnerToolUses", {
      receiptKey,
      messageId: a.messageId,
      assistantId: a.assistantId,
      callId,
      toolName,
      ...(browserErrandId ? { browserErrandId } : {}),
      committedAt: Date.now(),
    });
    return toolName === "browser_errand_run"
      ? { allowed: true, receiptKey }
      : { allowed: true };
  },
});

export const pendingSignal = query({
  args: { workerToken: v.optional(v.string()) },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const pending = await ctx.db
      .query("chatMessages")
      .withIndex("by_status", (q: any) => q.eq("status", "pending"))
      .first();
    return pending ? { messageId: pending._id, threadId: pending.threadId } : null;
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
    if (ex.status === "done")
      return (
        a.status === "done" &&
        (a.finalText === undefined || a.finalText === ex.text)
      );
    if (ex.status !== "streaming") return false;
    const patch: Record<string, unknown> = {
      status: a.status,
      lastProgressAt: Date.now(),
    };
    if (a.finalText !== undefined) patch.text = a.finalText;
    if (a.model) patch.model = a.model;
    await ctx.db.patch(a.messageId, patch);
    if (ex.parentMessageId) {
      const parent = await ctx.db.get(ex.parentMessageId);
      if (parent?.role === "user") {
        await ctx.db.patch(parent._id, {
          status: a.status,
          lastProgressAt: Date.now(),
        });
        await releaseGuestTurn(ctx, parent);
        await deleteTurnEphemera(ctx, parent._id);
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
  args: {
    threadId: v.string(),
    text: v.string(),
    workerToken: v.optional(v.string()),
  },
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
    downloadUrl: v.optional(v.string()),
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
      attachment: await safeChatAttachment(ctx, { type: a.type, value: a.value, title: a.title, downloadUrl: a.downloadUrl }),
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
      .withIndex("by_thread", (q: any) =>
        q.eq("threadId", a.threadId ?? "main"),
      )
      .collect();
    for (const r of rows) {
      const provenance = await ctx.db
        .query("messageFiles")
        .withIndex("by_message", (q: any) => q.eq("messageId", r._id))
        .take(CHAT_FILE_LIMITS.maxFilesPerMessage + 1);
      if (provenance.length > CHAT_FILE_LIMITS.maxFilesPerMessage) {
        throw new Error("message file cleanup bound exceeded");
      }
      for (const link of provenance) await ctx.db.delete(link._id);
      await deleteTurnEphemera(ctx, r._id);
      await ctx.db.delete(r._id);
    }
    return rows.length;
  },
});
