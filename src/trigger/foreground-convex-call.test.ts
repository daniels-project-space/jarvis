import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  callForegroundConvex,
  ForegroundConvexCallDeadlineError,
  settleAmbiguousForegroundFinalize,
} from "./foreground-convex-call";

describe("foreground Convex call deadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("aborts a lost response instead of allowing an active-runner heartbeat to mask it indefinitely", async () => {
    const fetcher = vi.fn((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }),
    );
    const pending = callForegroundConvex(
      "https://convex.example",
      "worker-test-token",
      "mutation",
      "chatQueue:finalize",
      { messageId: "message-1" },
      { fetcher: fetcher as typeof fetch, timeoutMs: 1_000 },
    );
    const timedOut = expect(pending).rejects
      .toThrow("Convex mutation chatQueue:finalize exceeded its foreground call deadline");

    await vi.advanceTimersByTimeAsync(1_000);

    await timedOut;
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("retries an exact finalize payload after a deadline instead of replacing it with an error", async () => {
    const finalize = vi.fn()
      .mockRejectedValueOnce(new ForegroundConvexCallDeadlineError("mutation", "chatQueue:finalize"))
      .mockResolvedValueOnce(true);

    await expect(settleAmbiguousForegroundFinalize(finalize)).resolves.toBe("finalized");
    expect(finalize).toHaveBeenCalledTimes(2);
  });

  it("leaves a second timeout ambiguous rather than attempting a terminal error", async () => {
    const finalize = vi.fn().mockRejectedValue(
      new ForegroundConvexCallDeadlineError("mutation", "chatQueue:finalize"),
    );

    await expect(settleAmbiguousForegroundFinalize(finalize)).resolves.toBe("ambiguous");
    expect(finalize).toHaveBeenCalledTimes(2);
  });

  it("does not call a fenced rejection a delivered completion", async () => {
    const finalize = vi.fn().mockResolvedValue(false);

    await expect(settleAmbiguousForegroundFinalize(finalize)).resolves.toBe("ambiguous");
    expect(finalize).toHaveBeenCalledOnce();
  });
});
