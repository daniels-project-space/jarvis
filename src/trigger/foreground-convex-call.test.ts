import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callForegroundConvex } from "./foreground-convex-call";

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
});
