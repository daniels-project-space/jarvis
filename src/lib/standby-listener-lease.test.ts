import { describe, expect, it, vi } from "vitest";
import {
  createStandbyListenerLeaseFence,
  renewStandbyListenerLease,
  STANDBY_LISTENER_LOCAL_LEASE_MS,
  STANDBY_LISTENER_RENEWAL_DEADLINE_MS,
  STANDBY_LISTENER_RENEWAL_INTERVAL_MS,
  STANDBY_LISTENER_SERVER_LEASE_MS,
} from "./standby-listener-lease";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("standby listener lease fence", () => {
  it("keeps the browser fence safely inside the server lease", () => {
    expect(STANDBY_LISTENER_LOCAL_LEASE_MS).toBeLessThan(STANDBY_LISTENER_SERVER_LEASE_MS);
    expect(STANDBY_LISTENER_RENEWAL_DEADLINE_MS).toBeLessThan(STANDBY_LISTENER_RENEWAL_INTERVAL_MS);
  });

  it("expires exactly once unless a completed renewal extends it", () => {
    vi.useFakeTimers();
    try {
      const onExpiry = vi.fn();
      const fence = createStandbyListenerLeaseFence({ onExpiry, leaseMs: 100 });

      fence.renew();
      vi.advanceTimersByTime(80);
      fence.renew();
      vi.advanceTimersByTime(99);
      expect(onExpiry).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(onExpiry).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(500);
      expect(onExpiry).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears a local lease without allowing a stale timer to stop a newer owner", () => {
    vi.useFakeTimers();
    try {
      const onExpiry = vi.fn();
      const fence = createStandbyListenerLeaseFence({ onExpiry, leaseMs: 100 });

      fence.renew();
      fence.clear();
      vi.advanceTimersByTime(100);

      expect(onExpiry).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases exactly once when a renewal hangs and ignores its late success", async () => {
    vi.useFakeTimers();
    try {
      const remoteRenewal = deferred<boolean>();
      let ownsLease = true;
      const onRenewed = vi.fn();
      const onLost = vi.fn(() => {
        ownsLease = false;
      });

      const renewal = renewStandbyListenerLease({
        renewRemote: () => remoteRenewal.promise,
        stillOwnsLease: () => ownsLease,
        onRenewed,
        onLost,
      });

      await vi.advanceTimersByTimeAsync(STANDBY_LISTENER_RENEWAL_DEADLINE_MS);
      await expect(renewal).resolves.toBe(false);
      expect(onLost).toHaveBeenCalledTimes(1);
      expect(onRenewed).not.toHaveBeenCalled();

      remoteRenewal.resolve(true);
      await Promise.resolve();
      expect(onLost).toHaveBeenCalledTimes(1);
      expect(onRenewed).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
