import type { BrowserPermission } from "./permissions";

export type LiveVoiceLeaseStart<T> =
  | { status: "ready"; microphone: T }
  | { status: "not-owned" }
  | { status: "cancelled" }
  | { status: "failed"; stage: "lease" | "microphone"; error: unknown };

/**
 * A live start begins before its lazy browser-voice module is guaranteed to
 * be available. Keep a failed import from leaving the caller's pending-start
 * fence set forever, but never let an old failed start clean up a replacement.
 */
export async function loadLiveVoiceStartupDependency<T>({
  load,
  isStillCurrent,
  onFailure,
}: {
  load: () => Promise<T>;
  isStillCurrent: () => boolean;
  onFailure: () => void;
}): Promise<T | null> {
  try {
    return await load();
  } catch {
    if (isStillCurrent()) onFailure();
    return null;
  }
}

/** Share one in-flight live start; a second force-start must not supersede it. */
export function coalesceLiveVoiceStart<T>(
  current: Promise<T> | null,
  start: () => Promise<T>,
): Promise<T> {
  return current ?? start();
}

/**
 * Fence microphone startup behind a shared live-voice lease. Browser documents
 * cannot share their in-memory getUserMedia promise, so this ordering is the
 * only boundary that prevents a main page and an embedded surface from opening
 * capture simultaneously.
 */
export async function startLiveWithLease<T>(args: {
  acquireLiveLease: () => Promise<boolean>;
  openMicrophone: () => Promise<T>;
  releaseLiveLease: () => Promise<void> | void;
  isStillWanted?: () => boolean;
  // A pending browser prompt can be shared by a replacement live start. The
  // cancelled caller must not close a stream that the newer start has adopted.
  shouldCloseCancelledMicrophone?: () => boolean;
  closeMicrophone?: (microphone: T) => Promise<void> | void;
}): Promise<LiveVoiceLeaseStart<T>> {
  const isStillWanted = args.isStillWanted ?? (() => true);
  const release = async () => {
    try {
      await args.releaseLiveLease();
    } catch {
      // A best-effort release must not turn a stopped/cancelled start into an
      // uncaught client error. The lease TTL is the final recovery backstop.
    }
  };

  if (!isStillWanted()) return { status: "cancelled" };

  let owned: boolean;
  try {
    owned = await args.acquireLiveLease();
  } catch (error) {
    return { status: "failed", stage: "lease", error };
  }
  if (!owned) return { status: "not-owned" };

  if (!isStillWanted()) {
    await release();
    return { status: "cancelled" };
  }

  let microphone: T;
  try {
    microphone = await args.openMicrophone();
  } catch (error) {
    await release();
    return { status: "failed", stage: "microphone", error };
  }

  if (!isStillWanted()) {
    if (args.shouldCloseCancelledMicrophone?.() !== false) {
      try {
        await args.closeMicrophone?.(microphone);
      } catch {
        // The ownership release still matters if a browser refuses a late close.
      }
    }
    await release();
    return { status: "cancelled" };
  }

  return { status: "ready", microphone };
}

export function shouldAutoStartLiveVoice(args: {
  embedded: boolean;
  visible: boolean;
  liveDefault: boolean;
  permission: BrowserPermission;
  attempted: boolean;
  manuallyStopped: boolean;
}): boolean {
  return !args.embedded
    && args.visible
    && args.liveDefault
    && !args.attempted
    && !args.manuallyStopped
    && (args.permission === "granted" || args.permission === "prompt");
}

export function liveVoiceRetryDelay(attempt: number): number | null {
  if (!Number.isFinite(attempt) || attempt < 1 || attempt > 4) return null;
  return Math.min(12_000, 1_500 * (2 ** (attempt - 1)));
}

export function scheduleAutoLiveBootstrap(
  attempt: () => void | Promise<void>,
  setAttempted: (attempted: boolean) => void,
  // Enough time for hydration to attach the stop/retry handlers, without
  // making a remembered microphone grant feel like an idle half-second.
  delayMs = 150,
): () => void {
  let cancelled = false;
  setAttempted(true);
  const timer = globalThis.setTimeout(() => {
    if (!cancelled) void attempt();
  }, delayMs);
  return () => {
    cancelled = true;
    globalThis.clearTimeout(timer);
    setAttempted(false);
  };
}

export function speechServiceRetryDelay(attempt: number, requestedDelayMs = 0): number {
  const boundedAttempt = Math.max(1, Math.min(6, Math.floor(attempt) || 1));
  const exponential = Math.min(30_000, 2_000 * (2 ** (boundedAttempt - 1)));
  return Math.max(exponential, Math.min(30_000, Math.max(0, requestedDelayMs)));
}
