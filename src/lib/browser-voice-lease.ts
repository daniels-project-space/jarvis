/**
 * The Browser Locks API is the only browser primitive that gives us atomic,
 * origin-wide ownership across tabs and same-origin iframes. Do not replace
 * this with localStorage or BroadcastChannel: both can elect split-brain
 * owners, which is unacceptable for a microphone.
 */
export const BROWSER_LIVE_MIC_LOCK = "jarvis/live-microphone/v1";

export type BrowserVoiceLease = {
  /** Idempotently releases the lock and waits for its callback to unwind. */
  release: () => Promise<void>;
  /** Settles once the Browser Locks request has fully unwound. */
  released: Promise<void>;
};

export type BrowserVoiceLeaseResult =
  | { status: "acquired"; lease: BrowserVoiceLease }
  | { status: "busy" | "cancelled" | "unsupported" }
  | { status: "failed"; error: unknown };

/** A deliberately small, injectable view of LockManager for deterministic tests. */
export type BrowserVoiceLockManager = {
  request: (
    name: string,
    options: { mode: "exclusive"; ifAvailable: true },
    callback: (lock: unknown | null) => void | Promise<void>,
  ) => Promise<unknown>;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function browserLockManager(): BrowserVoiceLockManager | null {
  if (typeof navigator === "undefined" || !navigator.locks) return null;
  return navigator.locks as unknown as BrowserVoiceLockManager;
}

/**
 * Attempts to hold the one live-microphone lock for this origin. Unsupported
 * contexts deliberately fail closed: a weaker best-effort coordination scheme
 * would let two Jarvis documents open capture at once.
 */
export async function tryAcquireBrowserVoiceLease({
  isStillWanted = () => true,
  locks = browserLockManager(),
}: {
  isStillWanted?: () => boolean;
  locks?: BrowserVoiceLockManager | null;
} = {}): Promise<BrowserVoiceLeaseResult> {
  if (!locks) return { status: "unsupported" };
  if (!isStillWanted()) return { status: "cancelled" };

  const outcome = deferred<BrowserVoiceLeaseResult>();
  const requestFinished = deferred<void>();
  let outcomeSettled = false;
  let released = false;
  let releaseHold!: () => void;
  const hold = new Promise<void>((resolve) => {
    releaseHold = resolve;
  });

  const settle = (value: BrowserVoiceLeaseResult) => {
    if (outcomeSettled) return;
    outcomeSettled = true;
    outcome.resolve(value);
  };

  const release = async () => {
    if (!released) {
      released = true;
      releaseHold();
    }
    await requestFinished.promise;
  };

  try {
    const request = locks.request(
      BROWSER_LIVE_MIC_LOCK,
      { mode: "exclusive", ifAvailable: true },
      async (lock) => {
        if (!lock) {
          settle({ status: "busy" });
          return;
        }
        if (!isStillWanted()) {
          settle({ status: "cancelled" });
          return;
        }
        settle({ status: "acquired", lease: { release, released: requestFinished.promise } });
        await hold;
      },
    );
    void request.then(
      () => requestFinished.resolve(),
      (error) => {
        requestFinished.resolve();
        settle({ status: "failed", error });
      },
    );
  } catch (error) {
    requestFinished.resolve();
    settle({ status: "failed", error });
  }

  return outcome.promise;
}
