export type ForegroundLease = { updatedAt?: number } | null;

export type ForegroundLeaseWaitOptions = {
  runnerId: string;
  timeoutMs: number;
  leaseMs: number;
  touch: (runnerId: string) => Promise<boolean>;
  subscribe: (listener: (lease: ForegroundLease) => void, onError: () => void) => () => void;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
};

/**
 * Wait for a single Convex lease release (or its one stale deadline). This is
 * deliberately subscription-driven: a failed claim never creates a poll loop.
 */
export function waitForForegroundLease(options: ForegroundLeaseWaitOptions): Promise<boolean> {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  return new Promise((resolve) => {
    let settled = false;
    let claimInFlight = false;
    let retryQueued = false;
    let staleTimer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe = () => {};
    const clearStaleTimer = () => {
      if (staleTimer) clearTimer(staleTimer);
      staleTimer = null;
    };
    const finish = (owned: boolean) => {
      if (settled) return;
      settled = true;
      clearStaleTimer();
      clearTimer(timeout);
      unsubscribe();
      resolve(owned);
    };
    const tryClaim = () => {
      if (settled) return;
      if (claimInFlight) {
        retryQueued = true;
        return;
      }
      claimInFlight = true;
      void Promise.resolve()
        .then(() => options.touch(options.runnerId))
        .then((owned) => { if (owned) finish(true); })
        .catch(() => undefined)
        .finally(() => {
          claimInFlight = false;
          if (!settled && retryQueued) {
            retryQueued = false;
            tryClaim();
          }
        });
    };
    const observe = (lease: ForegroundLease) => {
      if (settled) return;
      clearStaleTimer();
      const age = lease?.updatedAt === undefined ? options.leaseMs : now() - lease.updatedAt;
      if (!lease || age >= options.leaseMs) {
        tryClaim();
        return;
      }
      staleTimer = setTimer(tryClaim, Math.max(1, options.leaseMs - age + 25));
    };
    const timeout = setTimer(() => finish(false), options.timeoutMs);
    let subscribing = true;
    let observedSynchronously = false;
    const registeredUnsubscribe = options.subscribe((lease) => {
      if (subscribing) observedSynchronously = true;
      observe(lease);
    }, () => finish(false));
    subscribing = false;
    unsubscribe = registeredUnsubscribe;
    // Some realtime clients synchronously invoke their initial subscription.
    if (settled) unsubscribe();
    else if (!observedSynchronously) tryClaim();
  });
}
