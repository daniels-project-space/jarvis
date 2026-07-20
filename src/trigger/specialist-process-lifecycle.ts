export type SpecialistStopState = {
  timedOut: boolean;
  stopped: "paused" | "cancelled" | null;
};

type ManagedChild = {
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal: NodeJS.Signals): boolean;
};

export type SpecialistExit = SpecialistStopState & {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
};

/**
 * A release controller may not load provider authority merely because it sent
 * a signal to a specialist. Only ChildProcess `close` proves that the outer
 * namespace process and all of its stdio handles are gone; unshare's PID-1
 * teardown then guarantees no detached model child survived to overlap the
 * trusted controller phase.
 */
export function createSpecialistExitBarrier(child: ManagedChild): {
  exited: Promise<SpecialistExit>;
  requestStop: (state: SpecialistStopState, forceAfterMs?: number) => void;
} {
  let requested: SpecialistStopState = { timedOut: false, stopped: null };
  let stopRequested = false;
  let processError: Error | undefined;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

  const exited = new Promise<SpecialistExit>((resolve) => {
    child.once("error", (error) => {
      // Node emits `close` after a spawn error too. Keep waiting for that
      // terminal event instead of weakening the credential handoff barrier.
      processError = error;
    });
    child.once("close", (code, signal) => {
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve({ ...requested, code, signal, error: processError });
    });
  });

  const requestStop = (state: SpecialistStopState, forceAfterMs = 0) => {
    if (stopRequested) return;
    stopRequested = true;
    requested = state;
    try {
      child.kill(forceAfterMs > 0 ? "SIGTERM" : "SIGKILL");
    } catch {
      // A concurrent natural exit still has to produce `close` before release.
    }
    if (forceAfterMs > 0) {
      forceKillTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already closed */ }
      }, forceAfterMs);
      forceKillTimer.unref?.();
    }
  };

  return { exited, requestStop };
}
