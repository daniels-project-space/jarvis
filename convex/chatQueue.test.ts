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
  it("folds the warm-runner receipt into admission and marks empty side tables", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.chatQueue.touchRunner, {
      runnerId: "warm-runner",
      workerToken: WORKER,
    });
    const admission = await t.mutation(api.chatQueue.sendMessageWithRunnerLease, {
      threadId: "main",
      text: "plain text turn",
      requestId: "combined-admission",
      workerToken: WORKER,
    });

    expect(admission).toMatchObject({ warmRunner: true });
    const messageId = admission.messageId;
    const rows = await t.query(api.chatQueue.listMessages, { threadId: "main", workerToken: WORKER });
    expect(rows.find((row) => row._id === messageId)).toMatchObject({
      hasLinkedFiles: false,
      hasResearchPrefetch: false,
    });
  });

  it("atomically transfers a pending turn when a warm runner retires", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.chatQueue.touchRunner, {
      runnerId: "retiring-runner",
      workerToken: WORKER,
    });
    const messageId = await t.mutation(api.chatQueue.sendMessage, {
      threadId: "main",
      text: "arrived on the final realtime boundary",
      requestId: "runner-retirement-race",
      workerToken: WORKER,
    });

    await expect(t.mutation(api.chatQueue.releaseRunner, {
      runnerId: "retiring-runner",
      workerToken: WORKER,
    })).resolves.toEqual({
      released: true,
      pendingMessageId: messageId,
      pendingThreadId: "main",
      pendingDispatchEpoch: 0,
    });
    await expect(t.query(api.chatQueue.runnerLeaseForWorker, {
      workerToken: WORKER,
    })).resolves.toBeNull();
  });

  it("settles an unclaimed startup failure without waiting for the recovery sweep", async () => {
    const t = convexTest(schema, modules);
    const userId = await createTurn(t, "startup-failure");

    expect(await t.mutation(api.chatQueue.failPendingStartup, {
      messageId: userId,
      threadId: "main",
      expectedDispatchEpoch: 0,
      workerToken: WORKER,
    })).toBe(true);

    expect(await t.mutation(api.chatQueue.failPendingStartup, {
      messageId: userId,
      threadId: "main",
      expectedDispatchEpoch: 0,
      workerToken: WORKER,
    })).toBe(false);

    const rows = await t.query(api.chatQueue.listMessages, { threadId: "main", workerToken: WORKER });
    expect(rows.find((row) => row._id === userId)?.status).toBe("error");
    expect(rows.find((row) => row.parentMessageId === userId)).toMatchObject({
      role: "assistant",
      status: "error",
      text: expect.stringMatching(/couldn't start/i),
    });
  });

  it("does not overwrite a turn that another worker has already claimed", async () => {
    const t = convexTest(schema, modules);
    const userId = await createTurn(t, "startup-race");
    const claim = await t.mutation(api.chatQueue.claimMessage, {
      messageId: userId,
      claimToken: "startup-race-claim",
      workerToken: WORKER,
    });

    expect(await t.mutation(api.chatQueue.failPendingStartup, {
      messageId: userId,
      threadId: "main",
      expectedDispatchEpoch: 0,
      workerToken: WORKER,
    })).toBe(false);

    const rows = await t.query(api.chatQueue.listMessages, { threadId: "main", workerToken: WORKER });
    expect(rows.find((row) => row._id === claim?.assistantId)).toMatchObject({
      status: "streaming",
      claimToken: "startup-race-claim",
    });
  });

  it("does not settle a newer recovery epoch from an older failed wake-up", async () => {
    const t = convexTest(schema, modules);
    const userId = await createTurn(t, "startup-epoch-race");
    await expect(t.mutation(api.chatQueue.requestRecovery, {
      messageId: userId,
      threadId: "main",
      workerToken: WORKER,
    })).resolves.toMatchObject({ status: "pending", dispatchEpoch: 1 });

    expect(await t.mutation(api.chatQueue.failPendingStartup, {
      messageId: userId,
      threadId: "main",
      expectedDispatchEpoch: 0,
      workerToken: WORKER,
    })).toBe(false);

    const rows = await t.query(api.chatQueue.listMessages, { threadId: "main", workerToken: WORKER });
    expect(rows.find((row) => row._id === userId)).toMatchObject({ status: "pending", dispatchEpoch: 1 });
    expect(rows.some((row) => row.parentMessageId === userId)).toBe(false);
  });

  it("returns the completed assistant payload so reconnect recovery can deliver it", async () => {
    const t = convexTest(schema, modules);
    const userId = await createTurn(t, "completed-delivery");
    const claim = await t.mutation(api.chatQueue.claimMessage, {
      messageId: userId,
      claimToken: "completed-claim",
      workerToken: WORKER,
    });
    expect(await t.mutation(api.chatQueue.finalize, {
      messageId: claim!.assistantId,
      threadId: "main",
      claimToken: "completed-claim",
      status: "done",
      finalText: "delivered after reconnect",
      model: "test-model",
      workerToken: WORKER,
    })).toBe(true);

    expect(await t.mutation(api.chatQueue.requestRecovery, {
      messageId: userId,
      threadId: "main",
      workerToken: WORKER,
    })).toMatchObject({
      status: "completed",
      assistant: {
        _id: claim!.assistantId,
        role: "assistant",
        status: "done",
        text: "delivered after reconnect",
        model: "test-model",
        delivery: "foreground",
        parentMessageId: userId,
      },
    });
  });

  it("keeps owner approval receipts out of later model history", async () => {
    const t = convexTest(schema, modules);
    const firstUserId = await createTurn(t, "approval-history-source");
    const firstClaim = await t.mutation(api.chatQueue.claimMessage, {
      messageId: firstUserId,
      claimToken: "approval-history-source-claim",
      workerToken: WORKER,
    });
    const gmailReceipt = `${"a".repeat(64)}.${"b".repeat(43)}`;
    const calendarReceipt = `${"c".repeat(64)}.${"d".repeat(43)}`;
    await expect(t.mutation(api.chatQueue.finalize, {
      messageId: firstClaim!.assistantId,
      threadId: "main",
      claimToken: "approval-history-source-claim",
      status: "done",
      finalText: [
        "Your draft is ready.",
        `[jarvis-gmail-send-approval:${gmailReceipt}]`,
        `[JARVIS_GOOGLE_CALENDAR_APPROVAL:${calendarReceipt}]`,
      ].join("\n"),
      workerToken: WORKER,
    })).resolves.toBe(true);

    const nextUserId = await createTurn(t, "approval-history-next");
    await t.run(async (ctx) => {
      const source = await ctx.db.get(firstClaim!.assistantId);
      if (!source) throw new Error("source assistant turn was not stored");
      await ctx.db.patch(nextUserId, { createdAt: source.createdAt + 1 });
    });
    const nextClaim = await t.mutation(api.chatQueue.claimMessage, {
      messageId: nextUserId,
      claimToken: "approval-history-next-claim",
      workerToken: WORKER,
    });

    expect(nextClaim?.history).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "assistant", text: "Your draft is ready." }),
    ]));
    expect(JSON.stringify(nextClaim?.history)).not.toContain(gmailReceipt);
    expect(JSON.stringify(nextClaim?.history)).not.toContain(calendarReceipt);
  });

  it("seals an authoritative cancellation fence before retry and rejects every late worker write", async () => {
    const t = convexTest(schema, modules);
    const userId = await createTurn(t, "cancel-fence");
    const claim = await t.mutation(api.chatQueue.claimMessage, {
      messageId: userId,
      claimToken: "cancelled-claim",
      workerToken: WORKER,
    });
    expect(claim).not.toBeNull();
    expect(await t.mutation(api.chatQueue.updateStream, {
      messageId: claim!.assistantId,
      claimToken: "cancelled-claim",
      text: "partial answer",
      revision: 1,
      workerToken: WORKER,
    })).toBe(true);

    const cancellation = await t.mutation(api.chatQueue.cancelTurn, {
      messageId: userId,
      threadId: "main",
      workerToken: WORKER,
    });
    expect(cancellation).toMatchObject({ status: "cancelled", messageId: userId });
    expect(cancellation.status === "cancelled" ? cancellation.fenceReceipt : "").toMatch(/^.+:\d+:\d+$/);
    expect(await t.query(api.chatQueue.turnCancellationForWorker, {
      messageId: claim!.assistantId,
      claimToken: "cancelled-claim",
      workerToken: WORKER,
    })).toBe(true);
    expect(await t.mutation(api.chatQueue.cancelTurn, {
      messageId: userId,
      threadId: "main",
      workerToken: WORKER,
    })).toEqual(cancellation);
    expect(await t.mutation(api.chatQueue.requestRecovery, {
      messageId: userId,
      threadId: "main",
      workerToken: WORKER,
    })).toMatchObject({ status: "cancelled", messageId: userId });

    const cancelledRows = await t.query(api.chatQueue.listMessages, {
      threadId: "main",
      workerToken: WORKER,
    });
    const cancelledAssistant = cancelledRows.find((row) => row._id === claim!.assistantId)!;
    expect(cancelledAssistant).toMatchObject({
      status: "error",
      text: "Reply cancelled.",
      delivery: "foreground",
    });
    expect(cancelledRows.find((row) => row._id === userId)?.status).toBe("error");

    vi.advanceTimersByTime(10_000);
    await t.mutation(api.chatQueue.touchRunner, {
      runnerId: "late-runner",
      activeMessageId: claim!.assistantId,
      claimToken: "cancelled-claim",
      workerToken: WORKER,
    });
    expect(await t.mutation(api.chatQueue.updateStream, {
      messageId: claim!.assistantId,
      claimToken: "cancelled-claim",
      text: "late output",
      revision: 2,
      workerToken: WORKER,
    })).toBe(false);
    expect(await t.mutation(api.chatQueue.finalize, {
      messageId: claim!.assistantId,
      threadId: "main",
      claimToken: "cancelled-claim",
      status: "done",
      finalText: "late final",
      model: "late model",
      workerToken: WORKER,
    })).toBe(false);
    expect(await t.mutation(api.chatQueue.claimMessage, {
      messageId: userId,
      claimToken: "late-reclaim",
      workerToken: WORKER,
    })).toBeNull();

    const fencedRows = await t.query(api.chatQueue.listMessages, {
      threadId: "main",
      workerToken: WORKER,
    });
    const fencedAssistant = fencedRows.find((row) => row._id === claim!.assistantId)!;
    expect(fencedAssistant).toMatchObject({
      status: "error",
      text: "Reply cancelled.",
      delivery: "foreground",
      lastProgressAt: cancelledAssistant.lastProgressAt,
    });
    expect(fencedAssistant.model).toBe(cancelledAssistant.model);
  });

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
    expect(await t.query(api.chatQueue.turnCancellationForWorker, {
      messageId: first!.assistantId,
      claimToken: "claim-1",
      workerToken: WORKER,
    })).toBe(true);

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

  it("returns the exact pending thread so scheduled recovery stays owner-scoped", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.mutation(api.chatQueue.sendMessage, {
      threadId: "travel",
      text: "recover this exact thread",
      requestId: "scheduled-thread-scope",
      workerToken: WORKER,
    });

    const pending = await t.query(api.chatQueue.pendingSignal, { workerToken: WORKER });
    expect(pending).toEqual({ messageId: userId, threadId: "travel" });
    expect(await t.mutation(api.chatQueue.requestRecovery, {
      messageId: pending!.messageId,
      threadId: pending!.threadId,
      workerToken: WORKER,
    })).toMatchObject({
      status: "pending",
      messageId: userId,
      dispatchEpoch: 1,
    });
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

describe("owner-only foreground boundary", () => {
  it("rejects every legacy guest credential before creating a turn", async () => {
    const t = convexTest(schema, modules);
    const guestId = "g".repeat(32);
    await expect(t.mutation(api.chatQueue.sendMessage, {
      text: "first",
      requestId: "guest-first",
      guestId,
    })).rejects.toThrow(/Authentication required/);
    expect(await t.run(async (ctx) => await ctx.db.query("chatMessages").collect())).toEqual([]);
  });
});

describe("same-transaction current state", () => {
  it("captures the real Sevilla utterance once and lets a newer city supersede it", async () => {
    const t = convexTest(schema, modules);
    const sevilla = {
      threadId: "main",
      text: "I'm in Sevilla right now, can you show me a map with some attractions in the city?",
      requestId: "current-city-sevilla",
      workerToken: WORKER,
    };
    const first = await t.mutation(api.chatQueue.sendMessage, sevilla);
    expect(await t.mutation(api.chatQueue.sendMessage, sevilla)).toBe(first);
    expect(await t.run(async (ctx) => await ctx.db.query("currentState").collect())).toEqual([
      expect.objectContaining({ key: "profile.current_location", value: "Sevilla", sourceMessageId: String(first) }),
    ]);

    vi.advanceTimersByTime(60_000);
    await t.mutation(api.chatQueue.sendMessage, {
      threadId: "main",
      text: "I'm currently in London.",
      requestId: "current-city-london",
      workerToken: WORKER,
    });
    const states = await t.run(async (ctx) => await ctx.db.query("currentState").collect());
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ key: "profile.current_location", value: "London" });
  });
});

describe("speculative research sidecar", () => {
  it("normalizes long request identities before both insert and retry lookup", async () => {
    const t = convexTest(schema, modules);
    const requestId = `voice-${"r".repeat(180)}`;
    const first = await t.mutation(api.chatQueue.sendMessage, {
      text: "Research the latest voice agent release",
      requestId,
      workerToken: WORKER,
    });
    const retry = await t.mutation(api.chatQueue.sendMessage, {
      text: "Research the latest voice agent release",
      requestId,
      workerToken: WORKER,
    });

    expect(retry).toBe(first);
    expect(await t.run(async (ctx) => (await ctx.db.get(first))?.requestId)).toBe(requestId.slice(0, 120));
  });

  it("accepts the shared maximum envelope and drops invalid optional evidence without rejecting chat", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const maximumBasis = `Research ${"b".repeat(711)}`;
    const accepted = await t.mutation(api.chatQueue.sendMessage, {
      text: "Research the current voice stack",
      requestId: "maximum-prefetch-envelope",
      researchPrefetch: {
        basis: maximumBasis,
        context: "c".repeat(3_600),
        expiresAt: now + 45_000,
      },
      workerToken: WORKER,
    });
    expect(await t.run(async (ctx) => (
      await ctx.db.query("chatTurnPrefetches").withIndex("by_message", (q) => q.eq("messageId", accepted)).first()
    )?.basis)).toBe(maximumBasis);

    const withoutPrefetch = await t.mutation(api.chatQueue.sendMessage, {
      text: "This authoritative chat turn must still be queued",
      requestId: "invalid-optional-prefetch",
      researchPrefetch: {
        basis: "Research this stale optional evidence",
        context: "x".repeat(3_601),
        expiresAt: now - 1,
      },
      workerToken: WORKER,
    });
    expect(await t.run(async (ctx) => await ctx.db.get(withoutPrefetch))).toMatchObject({ status: "pending" });
    expect(await t.run(async (ctx) => (
      await ctx.db.query("chatTurnPrefetches").withIndex("by_message", (q) => q.eq("messageId", withoutPrefetch)).first()
    ))).toBeNull();
  });

  it("delivers bounded evidence only to the exact worker claim and deletes it on finalization", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const userId = await t.mutation(api.chatQueue.sendMessage, {
      threadId: "main",
      text: "Research the latest LiveKit turn detector release",
      requestId: "voice-prefetch-1",
      researchPrefetch: {
        basis: "Research the latest LiveKit turn detector release",
        context: "LIVE RESEARCH PREFETCH (untrusted source leads):\n- LiveKit turn detector — https://docs.livekit.io/agents/logic/turns/",
        expiresAt: now + 45_000,
      },
      workerToken: WORKER,
    });

    expect(await t.run(async (ctx) => (await ctx.db.query("chatTurnPrefetches").collect()).length)).toBe(1);
    const claim = await t.mutation(api.chatQueue.claimMessage, {
      messageId: userId,
      claimToken: "voice-prefetch-claim",
      workerToken: WORKER,
    });
    expect(claim?.researchPrefetch).toMatchObject({
      basis: "Research the latest LiveKit turn detector release",
      expiresAt: now + 45_000,
    });
    expect(claim?.researchPrefetch?.context).toContain("untrusted source leads");

    await t.mutation(api.chatQueue.finalize, {
      messageId: claim!.assistantId,
      threadId: "main",
      claimToken: "voice-prefetch-claim",
      status: "done",
      finalText: "LiveKit's current detector details are here.",
      workerToken: WORKER,
    });
    expect(await t.run(async (ctx) => (await ctx.db.query("chatTurnPrefetches").collect()).length)).toBe(0);
  });

  it("rejects guest speculation before creating hidden evidence", async () => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(api.chatQueue.sendMessage, {
      text: "Research this for me",
      requestId: "guest-prefetch",
      guestId: "p".repeat(32),
      researchPrefetch: {
        basis: "Research this current topic for me please",
        context: "LIVE RESEARCH PREFETCH (untrusted source leads): enough bounded context",
        expiresAt: Date.now() + 45_000,
      },
    })).rejects.toThrow(/Authentication required/);
    expect(await t.run(async (ctx) => (await ctx.db.query("chatTurnPrefetches").collect()).length)).toBe(0);
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

describe("chat history deletion", () => {
  it("deletes bounded message provenance without deleting reusable source files", async () => {
    const t = convexTest(schema, modules);
    const messageId = await createTurn(t, "clear-file-provenance");
    const otherMessageId = await t.mutation(api.chatQueue.sendMessage, {
      threadId: "other-thread",
      text: "keep me",
      requestId: "keep-file-provenance",
      workerToken: WORKER,
    });
    const fileId = await t.run(async (ctx) => {
      const now = Date.now();
      const id = await ctx.db.insert("files", {
        originalName: "evidence.txt",
        relativePath: "evidence.txt",
        mimeType: "text/plain",
        sizeBytes: 8,
        expectedSha256: "a".repeat(64),
        r2Key: "owners/daniel/files/test/v1/original",
        status: "ready",
        ingestVersion: 1,
        ingestAttempt: 1,
        searchText: "evidence",
        libraryVisible: true,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("messageFiles", {
        messageId,
        threadId: "main",
        fileId: id,
        position: 0,
        createdAt: now,
      });
      await ctx.db.insert("messageFiles", {
        messageId: otherMessageId,
        threadId: "other-thread",
        fileId: id,
        position: 0,
        createdAt: now,
      });
      return id;
    });

    expect(await t.mutation(api.chatQueue.clearThread, {
      threadId: "main",
      workerToken: WORKER,
    })).toBe(1);

    const durable = await t.run(async (ctx) => ({
      file: await ctx.db.get(fileId),
      clearedMessage: await ctx.db.get(messageId),
      keptMessage: await ctx.db.get(otherMessageId),
      clearedLinks: await ctx.db
        .query("messageFiles")
        .withIndex("by_message", (q) => q.eq("messageId", messageId))
        .collect(),
      keptLinks: await ctx.db
        .query("messageFiles")
        .withIndex("by_message", (q) => q.eq("messageId", otherMessageId))
        .collect(),
    }));
    expect(durable.file?._id).toBe(fileId);
    expect(durable.clearedMessage).toBeNull();
    expect(durable.keptMessage?._id).toBe(otherMessageId);
    expect(durable.clearedLinks).toHaveLength(0);
    expect(durable.keptLinks).toHaveLength(1);
  });
});

describe("legacy creation media cards", () => {
  it("rewrites a legacy card to authenticated routes for every history reader", async () => {
    const t = convexTest(schema, modules);
    const legacyUrl = "https://pub-901f8094a6f04b32a784dc06cf3ebbc3.r2.dev/creations/2026-08/card.png";
    const legacyDownloadUrl = "https://pub-901f8094a6f04b32a784dc06cf3ebbc3.r2.dev/creations/2026-08/card.pdf";
    const ids = await t.run(async (ctx) => ({
      image: await ctx.db.insert("creations", {
        kind: "image",
        title: "Historic card",
        url: legacyUrl,
        thumb: legacyUrl,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
      pdf: await ctx.db.insert("creations", {
        kind: "pdf",
        title: "Historic card PDF",
        thumb: legacyDownloadUrl,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    }));
    await t.mutation(api.chatQueue.postCard, {
      threadId: "legacy-cards",
      type: "image",
      value: legacyUrl,
      title: "Historic card",
      downloadUrl: legacyDownloadUrl,
      workerToken: WORKER,
    });
    const privateKey = "owners/daniel/creations/f47ac10b-58cc-4372-a567-0e02b2c3d479/asset";
    await t.run((ctx) => ctx.db.insert("chatMessages", {
      threadId: "legacy-cards",
      role: "assistant",
      text: `Historic card ${legacyUrl} ${privateKey}`,
      status: "done",
      delivery: "foreground",
      attachment: {
        type: "image",
        value: `${legacyUrl}?download=1`,
        title: "Historic raw card",
        downloadUrl: `${legacyDownloadUrl}#download`,
      },
      createdAt: Date.now() + 1,
    }));

    const [listed, recent, paginated, stored] = await Promise.all([
      t.query(api.chatQueue.listMessages, { threadId: "legacy-cards", workerToken: WORKER }),
      t.query(api.chatQueue.listRecentMessages, { threadId: "legacy-cards", workerToken: WORKER }),
      t.query(api.chatQueue.paginatedMessages, {
        threadId: "legacy-cards",
        paginationOpts: { cursor: null, numItems: 20 },
        workerToken: WORKER,
      }),
      t.run((ctx) => ctx.db.query("chatMessages").withIndex("by_thread", (q) => q.eq("threadId", "legacy-cards")).collect()),
    ]);
    const mediaUrl = `/api/creation-media?id=${encodeURIComponent(String(ids.image))}&variant=asset`;
    const downloadUrl = `/api/creation-download?id=${encodeURIComponent(String(ids.pdf))}`;
    const cards = [
      listed.find((row) => row.attachment?.title === "Historic raw card"),
      recent.find((row) => row.attachment?.title === "Historic raw card"),
      paginated.page.find((row) => row.attachment?.title === "Historic raw card"),
      stored.find((row) => row.attachment?.title === "Historic card"),
    ];

    for (const card of cards) {
      expect(card?.attachment).toMatchObject({ value: mediaUrl, downloadUrl });
      expect(JSON.stringify(card)).not.toContain(legacyUrl);
      expect(JSON.stringify(card)).not.toContain(legacyDownloadUrl);
    }
    const visibleHistory = JSON.stringify({ listed, recent, paginated });
    expect(visibleHistory).not.toContain(legacyUrl);
    expect(visibleHistory).not.toContain(legacyDownloadUrl);
    expect(visibleHistory).not.toContain(privateKey);
  });

  it("returns an inert notice when a legacy card has no matching creation", async () => {
    const t = convexTest(schema, modules);
    const legacyUrl = "https://pub-901f8094a6f04b32a784dc06cf3ebbc3.r2.dev/creations/2026-08/missing.png";
    await t.mutation(api.chatQueue.postCard, {
      threadId: "legacy-orphan",
      type: "image",
      value: legacyUrl,
      title: "Missing historic card",
      workerToken: WORKER,
    });

    const [card] = await t.query(api.chatQueue.listMessages, { threadId: "legacy-orphan", workerToken: WORKER });

    expect(card?.attachment).toMatchObject({ type: "markdown", title: "Missing historic card" });
    expect(JSON.stringify(card)).not.toContain(legacyUrl);
  });

  it("removes an unmatched legacy download without replacing a safe card value", async () => {
    const t = convexTest(schema, modules);
    const legacyUrl = "https://pub-901f8094a6f04b32a784dc06cf3ebbc3.r2.dev/creations/2026-08/missing.pdf";
    const safeUrl = "https://example.com/preview.png";
    await t.run((ctx) => ctx.db.insert("chatMessages", {
      threadId: "legacy-download-only",
      role: "assistant",
      text: "Saved card",
      status: "done",
      attachment: { type: "image", value: safeUrl, downloadUrl: legacyUrl },
      createdAt: Date.now(),
    }));

    const [card] = await t.query(api.chatQueue.listMessages, { threadId: "legacy-download-only", workerToken: WORKER });

    expect(card?.attachment).toMatchObject({ type: "image", value: safeUrl });
    expect(card?.attachment?.downloadUrl).toBeUndefined();
    expect(JSON.stringify(card)).not.toContain(legacyUrl);
  });
});
