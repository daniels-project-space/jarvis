import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import schema from "./schema";
import { CHAT_PENDING_EXPIRY_MS, CHAT_TURN_STALE_MS, MAX_CHAT_RECOVERY_WAKES, MAX_CHAT_TURN_ATTEMPTS } from "./chatQueue";

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>;
  }
}

const modules = import.meta.glob("./**/*.ts");
const WORKER = "chat-queue-test-worker";

beforeEach(() => {
  process.env.JARVIS_WORKER_TOKEN = WORKER;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-06T12:00:00Z"));
});

afterEach(() => {
  delete process.env.JARVIS_WORKER_TOKEN;
  vi.useRealTimers();
});

async function createTurn(t: ReturnType<typeof convexTest>, requestId: string) {
  return await t.mutation(api.chatQueue.sendMessage, {
    threadId: "main",
    text: `turn ${requestId}`,
    requestId,
    workerToken: WORKER,
  });
}

describe("durable foreground chat recovery", () => {
  it("keeps a heartbeating attempt active and requeues only after its progress expires", async () => {
    const t = convexTest(schema, modules);
    const userId = await createTurn(t, "stale-fence");
    const first = await t.mutation(api.chatQueue.claimMessage, {
      messageId: userId,
      claimToken: "claim-1",
      workerToken: WORKER,
    });
    expect(first?.attemptCount).toBe(1);

    vi.advanceTimersByTime(CHAT_TURN_STALE_MS - 1);
    expect(await t.mutation(api.chatQueue.requestRecovery, {
      messageId: userId,
      threadId: "main",
      workerToken: WORKER,
    })).toMatchObject({ status: "active", attemptCount: 1 });

    await t.mutation(api.chatQueue.touchRunner, {
      runnerId: "runner-1",
      activeMessageId: first!.assistantId,
      claimToken: "claim-1",
      workerToken: WORKER,
    });
    vi.advanceTimersByTime(CHAT_TURN_STALE_MS - 1);
    expect(await t.mutation(api.chatQueue.requestRecovery, {
      messageId: userId,
      threadId: "main",
      workerToken: WORKER,
    })).toMatchObject({ status: "active" });

    vi.advanceTimersByTime(2);
    expect(await t.mutation(api.chatQueue.requestRecovery, {
      messageId: userId,
      threadId: "main",
      workerToken: WORKER,
    })).toMatchObject({ status: "requeued", attemptCount: 1 });

    expect(await t.mutation(api.chatQueue.updateStream, {
      messageId: first!.assistantId,
      claimToken: "claim-1",
      text: "late output",
      revision: 1,
      workerToken: WORKER,
    })).toBe(false);
    expect(await t.mutation(api.chatQueue.finalize, {
      messageId: first!.assistantId,
      threadId: "main",
      claimToken: "claim-1",
      status: "done",
      finalText: "late final",
      workerToken: WORKER,
    })).toBe(false);

    const second = await t.mutation(api.chatQueue.claimMessage, {
      messageId: userId,
      claimToken: "claim-2",
      workerToken: WORKER,
    });
    expect(second?.attemptCount).toBe(2);
    expect(await t.mutation(api.chatQueue.finalize, {
      messageId: second!.assistantId,
      threadId: "main",
      claimToken: "claim-2",
      status: "done",
      finalText: "recovered answer",
      workerToken: WORKER,
    })).toBe(true);

    const rows = await t.query(api.chatQueue.listMessages, { threadId: "main", workerToken: WORKER });
    expect(rows.filter((row) => row.role === "assistant").map((row) => [row.status, row.text])).toEqual([
      ["superseded", ""],
      ["done", "recovered answer"],
    ]);
  });

  it("ends visibly after the bounded attempt budget instead of losing the turn", async () => {
    const t = convexTest(schema, modules);
    const userId = await createTurn(t, "bounded-recovery");

    for (let attempt = 1; attempt <= MAX_CHAT_TURN_ATTEMPTS; attempt += 1) {
      const claim = await t.mutation(api.chatQueue.claimMessage, {
        messageId: userId,
        claimToken: `claim-${attempt}`,
        workerToken: WORKER,
      });
      expect(claim?.attemptCount).toBe(attempt);
      vi.advanceTimersByTime(CHAT_TURN_STALE_MS + 1);
      const recovery = await t.mutation(api.chatQueue.requestRecovery, {
        messageId: userId,
        threadId: "main",
        workerToken: WORKER,
      });
      expect(recovery.status).toBe(attempt < MAX_CHAT_TURN_ATTEMPTS ? "requeued" : "failed");
    }

    const rows = await t.query(api.chatQueue.listMessages, { threadId: "main", workerToken: WORKER });
    const visibleFailure = [...rows].reverse().find((row) => row.role === "assistant" && row.status === "error");
    expect(visibleFailure?.text).toMatch(/recovery attempts/i);
    expect(rows.find((row) => row._id === userId)?.status).toBe("error");
  });

  it("uses monotonic bounded wake identities when infrastructure fails before claim", async () => {
    const t = convexTest(schema, modules);
    const userId = await createTurn(t, "preclaim-recovery");

    for (let epoch = 1; epoch <= MAX_CHAT_RECOVERY_WAKES; epoch += 1) {
      expect(await t.mutation(api.chatQueue.requestRecovery, {
        messageId: userId,
        threadId: "main",
        workerToken: WORKER,
      })).toMatchObject({ status: "pending", dispatchEpoch: epoch, attemptCount: 0 });
    }
    expect(await t.mutation(api.chatQueue.requestRecovery, {
      messageId: userId,
      threadId: "main",
      workerToken: WORKER,
    })).toMatchObject({ status: "failed", dispatchEpoch: MAX_CHAT_RECOVERY_WAKES + 1 });

    const rows = await t.query(api.chatQueue.listMessages, { threadId: "main", workerToken: WORKER });
    expect(rows.find((row) => row._id === userId)?.status).toBe("error");
    expect(rows.some((row) => row.parentMessageId === userId && row.status === "error" && /recovery/i.test(row.text))).toBe(true);
  });

  it("expires outage-era backlog without spending a model call or replying days late", async () => {
    const t = convexTest(schema, modules);
    const staleId = await createTurn(t, "stale-pending");
    vi.advanceTimersByTime(CHAT_PENDING_EXPIRY_MS + 10);
    const freshId = await createTurn(t, "fresh-pending");

    const claim = await t.mutation(api.chatQueue.claimNext, {
      claimToken: "fresh-claim",
      workerToken: WORKER,
    });
    expect(claim?.userText).toBe("turn fresh-pending");

    const rows = await t.query(api.chatQueue.listMessages, { threadId: "main", workerToken: WORKER });
    expect(rows.find((row) => row._id === staleId)?.status).toBe("error");
    expect(rows.some((row) => row.parentMessageId === staleId && /expired/i.test(row.text))).toBe(true);
    expect(rows.find((row) => row._id === freshId)?.status).toBe("done");
  });
});

describe("guest foreground cost boundary", () => {
  it("deduplicates retries and transactionally caps active guest turns", async () => {
    const t = convexTest(schema, modules);
    const guestId = "g".repeat(32);
    const first = await t.mutation(api.chatQueue.sendMessage, {
      text: "first",
      requestId: "guest-first",
      guestId,
    });
    expect(await t.mutation(api.chatQueue.sendMessage, {
      text: "same request",
      requestId: "guest-first",
      guestId,
    })).toBe(first);
    await t.mutation(api.chatQueue.sendMessage, {
      text: "second",
      requestId: "guest-second",
      guestId,
    });

    await expect(t.mutation(api.chatQueue.sendMessage, {
      text: "third",
      requestId: "guest-third",
      guestId,
    })).rejects.toThrow(/GUEST_CHAT_RATE_LIMITED|too_many_active_turns/);

    const claim = await t.mutation(api.chatQueue.claimMessage, {
      messageId: first,
      claimToken: "guest-claim",
      workerToken: WORKER,
    });
    await t.mutation(api.chatQueue.finalize, {
      messageId: claim!.assistantId,
      threadId: `guest:${guestId}`,
      claimToken: "guest-claim",
      status: "done",
      finalText: "done",
      workerToken: WORKER,
    });

    await expect(t.mutation(api.chatQueue.sendMessage, {
      text: "third",
      requestId: "guest-third",
      guestId,
    })).resolves.toBeTruthy();
  });
});

describe("chat session reconciliation", () => {
  it("keeps a session working while another exact turn remains pending", async () => {
    const t = convexTest(schema, modules);
    const firstId = await createTurn(t, "settle-first");
    const first = await t.mutation(api.chatQueue.claimMessage, {
      messageId: firstId,
      claimToken: "settle-claim",
      workerToken: WORKER,
    });
    await createTurn(t, "settle-second");
    await t.mutation(api.chatQueue.finalize, {
      messageId: first!.assistantId,
      threadId: "main",
      claimToken: "settle-claim",
      status: "done",
      finalText: "first complete",
      workerToken: WORKER,
    });

    const status = await t.run(async (ctx) => (await ctx.db
      .query("chatSessions")
      .withIndex("by_thread", (q) => q.eq("threadId", "main"))
      .first())?.status);
    expect(status).toBe("working");
  });

  it("repairs a stale working projection when no durable turn is active", async () => {
    const t = convexTest(schema, modules);
    await createTurn(t, "stale-session");
    await t.run(async (ctx) => {
      const user = await ctx.db
        .query("chatMessages")
        .withIndex("by_request", (q) => q.eq("requestId", "stale-session"))
        .first();
      if (user) await ctx.db.patch(user._id, { status: "done" });
      const session = await ctx.db
        .query("chatSessions")
        .withIndex("by_thread", (q) => q.eq("threadId", "main"))
        .first();
      if (session) await ctx.db.patch(session._id, {
        status: "working",
        lastActiveAt: Date.now() - CHAT_TURN_STALE_MS - 1,
      });
    });

    const result = await t.mutation(api.chatQueue.reapStuck, { workerToken: WORKER });
    expect(result.sessionsSettled).toBe(1);
    const status = await t.run(async (ctx) => (await ctx.db
      .query("chatSessions")
      .withIndex("by_thread", (q) => q.eq("threadId", "main"))
      .first())?.status);
    expect(status).toBe("idle");
  });
});
