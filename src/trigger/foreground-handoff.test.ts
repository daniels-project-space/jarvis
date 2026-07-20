import { describe, expect, it, vi } from "vitest";
import { isLegacyRunnerClaimValidationError, WarmHandoffController } from "./foreground-handoff";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("warm foreground handoff", () => {
  it("keeps the predecessor draining until a ready successor atomically takes over", async () => {
    const ready = deferred();
    const claimedBy = new Map<string, string>();
    const pending: string[] = [];
    let leaseOwner = "old";
    let oldDraining = true;

    const claim = (runnerId: string) => {
      if (runnerId !== leaseOwner) return null;
      const messageId = pending.shift();
      if (!messageId || claimedBy.has(messageId)) return null;
      claimedBy.set(messageId, runnerId);
      return messageId;
    };

    const controller = new WarmHandoffController({
      runnerId: "old",
      payload: () => ({ source: "warm-handoff", handoffFrom: "old", handoffConversations: [] }),
      launch: async () => {
        await ready.promise;
        // This models chatQueue:touchRunner's compare-and-swap takeover.
        if (leaseOwner !== "old") return false;
        leaseOwner = "new";
        controller.observeRunner(leaseOwner);
        return true;
      },
      onTakeover: () => { oldDraining = false; },
    });

    const launching = controller.start();
    pending.push("during-prewarm");
    expect(oldDraining && claim("old")).toBe("during-prewarm");
    expect(claimedBy.get("during-prewarm")).toBe("old");

    ready.resolve();
    await expect(launching).resolves.toBe(true);
    expect(controller.state.takenOver).toBe(true);
    expect(oldDraining).toBe(false);
    expect(leaseOwner).toBe("new");

    pending.push("at-takeover");
    expect(claim("old")).toBeNull();
    expect(claim("new")).toBe("at-takeover");
    expect([...claimedBy.entries()]).toEqual([
      ["during-prewarm", "old"],
      ["at-takeover", "new"],
    ]);
  });

  it("retries failed or unready launches finitely and stops on lease observation", async () => {
    const timers: Array<{ callback: () => void; delayMs: number; cancelled: boolean }> = [];
    const launch = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    const onTakeover = vi.fn();
    const controller = new WarmHandoffController({
      runnerId: "old",
      payload: () => ({ handoffFrom: "old" }),
      launch,
      onTakeover,
      maxAttempts: 3,
      failureRetryDelayMs: 5,
      retryDelayMs: 20,
      schedule: (callback, delayMs) => {
        const timer = { callback, delayMs, cancelled: false };
        timers.push(timer);
        return timer as unknown as ReturnType<typeof setTimeout>;
      },
      cancel: (handle) => {
        (handle as unknown as { cancelled: boolean }).cancelled = true;
      },
    });

    await expect(controller.start()).resolves.toBe(false);
    expect(timers[0].delayMs).toBe(5);
    timers[0].callback();
    await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(timers).toHaveLength(2));
    expect(timers[1].delayMs).toBe(20);
    expect(controller.observeRunner("old")).toBe(false);
    expect(controller.observeRunner("new")).toBe(true);
    expect(onTakeover).toHaveBeenCalledOnce();
    expect(timers[1].cancelled).toBe(true);
    timers[1].callback();
    await Promise.resolve();
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it("keeps handoff payloads compatible in both rolling directions", () => {
    const currentPayload = {
      source: "warm-handoff",
      handoffFrom: "old",
      handoffConversations: [{ conversationId: "main", modelTier: "luna", history: [] }],
    };
    const legacyWorker = (payload: { source?: string; handoffFrom?: string }) => ({
      source: payload.source,
      handoffFrom: payload.handoffFrom,
    });
    expect(legacyWorker(currentPayload)).toEqual({ source: "warm-handoff", handoffFrom: "old" });

    const legacyPayload: {
      source: string;
      handoffFrom: string;
      handoffConversations?: typeof currentPayload.handoffConversations;
    } = { source: "warm-handoff", handoffFrom: "old" };
    expect(legacyPayload.handoffConversations ?? []).toEqual([]);
    expect(isLegacyRunnerClaimValidationError(
      new Error("ArgumentValidationError: Object contains extra field `runnerId`"),
    )).toBe(true);
    expect(isLegacyRunnerClaimValidationError(new Error("fetch failed after commit"))).toBe(false);
  });
});
