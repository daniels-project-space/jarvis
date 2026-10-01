import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForWork, type WorkSignal } from "./wait-for-work";
afterEach(() => vi.useRealTimers());
describe("event-driven idle wait", () => {
  it("stays asleep without polling and wakes immediately on real work", async () => {
    const abort = new AbortController();
    let observe!: (value: WorkSignal) => void;
    const unsubscribe = vi.fn();
    let finished = false;
    const waiting = waitForWork(callback => { observe = callback; return unsubscribe; }, abort.signal).then(() => { finished = true; });
    observe({ ready: false });
    await Promise.resolve();
    expect(finished).toBe(false);
    observe({ ready: true });
    await waiting;
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
  it("sleeps until a future deadline and cancels its timer on shutdown", async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const unsubscribe = vi.fn();
    const waiting = waitForWork(observe => {
      observe({ ready: false, nextAt: Date.now() + 3600_000 });
      return unsubscribe;
    }, abort.signal);
    expect(vi.getTimerCount()).toBe(1);
    abort.abort();
    await waiting;
    expect(vi.getTimerCount()).toBe(0);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
