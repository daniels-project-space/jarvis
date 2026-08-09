import type { BrowserPermission } from "./permissions";

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
  delayMs = 450,
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
