import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  abortForegroundLeaseWork,
  waitForForegroundLease,
  type ForegroundLease,
} from "./foreground-lease";

const LEASE_MS = 1_000;
const TIMEOUT_MS = 5_000;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function waiter(
  touch: (runnerId: string) => Promise<boolean>,
  listeners: Set<(lease: ForegroundLease) => void>,
  onUnsubscribe = vi.fn(),
) {
  return waitForForegroundLease({
    runnerId: crypto.randomUUID(),
    timeoutMs: TIMEOUT_MS,
    leaseMs: LEASE_MS,
    touch,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); onUnsubscribe(); };
    },
  });
}

describe("foreground handoff lease", () => {
  it("cancels idle admission and the active turn together on ownership loss", () => {
    const lease = new AbortController();
    const activeTurn = new AbortController();
    const reason = new Error("replacement owns the lease");

    abortForegroundLeaseWork(lease, activeTurn, reason);

    expect(lease.signal.aborted).toBe(true);
    expect(lease.signal.reason).toBe(reason);
    expect(activeTurn.signal.aborted).toBe(true);
    expect(activeTurn.signal.reason).toBe(reason);
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
  });
  afterEach(() => vi.useRealTimers());

  it("does not take an active owner", async () => {
    const listeners = new Set<(lease: ForegroundLease) => void>();
    const touch = vi.fn(async () => false);
    const pending = waiter(touch, listeners);
    for (const listener of listeners) listener({ updatedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(LEASE_MS - 1);
    expect(touch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(touch).toHaveBeenCalledTimes(2); // initial attempt + one stale deadline
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    await expect(pending).resolves.toBe(false);
  });

  it("lets a release elect exactly one successor", async () => {
    const listeners = new Set<(lease: ForegroundLease) => void>();
    let owner = "active";
    const touch = vi.fn(async (runnerId: string) => {
      if (owner) return false;
      owner = runnerId;
      return true;
    });
    const first = waiter(touch, listeners);
    const second = waiter(touch, listeners);
    for (const listener of listeners) listener({ updatedAt: Date.now() });
    owner = "";
    for (const listener of [...listeners]) listener(null);
    await vi.runAllTicks();
    const results = await Promise.all([
      first,
      vi.advanceTimersByTimeAsync(TIMEOUT_MS).then(() => second),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(owner).not.toBe("");
  });

  it("lets exactly one successor claim at the single stale deadline", async () => {
    const listeners = new Set<(lease: ForegroundLease) => void>();
    let owner = "active";
    const touch = vi.fn(async (runnerId: string) => {
      if (owner && owner !== "stale") return false;
      if (owner === "stale") owner = runnerId;
      return owner === runnerId;
    });
    const first = waiter(touch, listeners);
    const second = waiter(touch, listeners);
    for (const listener of listeners) listener({ updatedAt: Date.now() - LEASE_MS + 1 });
    owner = "stale";
    await vi.advanceTimersByTimeAsync(30);
    const one = await Promise.race([first, second]);
    expect(one).toBe(true);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    const all = await Promise.all([first, second]);
    expect(all.filter(Boolean)).toHaveLength(1);
  });

  it("cleans its subscription and timers on timeout", async () => {
    const listeners = new Set<(lease: ForegroundLease) => void>();
    const unsubscribed = vi.fn();
    const touch = vi.fn(async () => false);
    const pending = waiter(touch, listeners, unsubscribed);
    for (const listener of listeners) listener({ updatedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    await expect(pending).resolves.toBe(false);
    expect(unsubscribed).toHaveBeenCalledTimes(1);
    expect(listeners).toHaveLength(0);
    const attempts = touch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10 * LEASE_MS);
    expect(touch).toHaveBeenCalledTimes(attempts);
  });

  it("does not turn a failed stale claim into a recurring poll", async () => {
    const listeners = new Set<(lease: ForegroundLease) => void>();
    const touch = vi.fn(async () => false);
    const pending = waiter(touch, listeners);
    for (const listener of listeners) listener({ updatedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(LEASE_MS + 25);
    expect(touch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(LEASE_MS * 2);
    expect(touch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    await expect(pending).resolves.toBe(false);
  });

  it("makes exactly one claim for a synchronous missing initial snapshot", async () => {
    const first = deferred<boolean>();
    const touch = vi.fn().mockReturnValue(first.promise);
    const pending = waitForForegroundLease({
      runnerId: crypto.randomUUID(),
      timeoutMs: TIMEOUT_MS,
      leaseMs: LEASE_MS,
      touch,
      subscribe: (listener) => {
        listener(null);
        return () => {};
      },
    });

    await vi.runAllTicks();
    expect(touch).toHaveBeenCalledTimes(1);

    first.resolve(true);
    await expect(pending).resolves.toBe(true);
    expect(touch).toHaveBeenCalledTimes(1);
  });

  it("coalesces an eligible notification received while a claim is in flight", async () => {
    const first = deferred<boolean>();
    const second = deferred<boolean>();
    const listeners = new Set<(lease: ForegroundLease) => void>();
    let activeTouches = 0;
    let maxActiveTouches = 0;
    const touch = vi.fn(() => {
      activeTouches += 1;
      maxActiveTouches = Math.max(maxActiveTouches, activeTouches);
      const next = touch.mock.calls.length === 1 ? first.promise : second.promise;
      return next.finally(() => { activeTouches -= 1; });
    });
    const pending = waitForForegroundLease({
      runnerId: crypto.randomUUID(),
      timeoutMs: TIMEOUT_MS,
      leaseMs: LEASE_MS,
      touch,
      subscribe: (listener) => {
        listeners.add(listener);
        listener(null);
        return () => { listeners.delete(listener); };
      },
    });

    await vi.runAllTicks();
    expect(touch).toHaveBeenCalledTimes(1);

    for (const listener of listeners) listener(null);
    await vi.runAllTicks();
    expect(touch).toHaveBeenCalledTimes(1);

    first.resolve(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(touch).toHaveBeenCalledTimes(2);
    expect(maxActiveTouches).toBe(1);

    second.resolve(true);
    await expect(pending).resolves.toBe(true);
  });

  it("waits for the stale deadline after a synchronous active snapshot", async () => {
    const touch = vi.fn(async () => true);
    const pending = waitForForegroundLease({
      runnerId: crypto.randomUUID(),
      timeoutMs: TIMEOUT_MS,
      leaseMs: LEASE_MS,
      touch,
      subscribe: (listener) => {
        listener({ updatedAt: Date.now() });
        return () => {};
      },
    });

    await vi.runAllTicks();
    expect(touch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(LEASE_MS + 24);
    expect(touch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe(true);
    expect(touch).toHaveBeenCalledTimes(1);
  });
});
