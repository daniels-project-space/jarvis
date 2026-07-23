// Codex 0.144.5 proactively refreshes managed ChatGPT access tokens once they
// are within five minutes of expiry. Consumer homes deliberately contain a
// non-refreshing sentinel, so every process must finish before this boundary.
export const PINNED_CODEX_INTERNAL_REFRESH_GUARD_MS = 5 * 60_000;
// Clock skew, scheduler jitter and the final auth-file read must not consume
// the pinned CLI's five-minute internal refresh window. Every direct consumer
// request includes at least this additional minute.
export const CODEX_INTERNAL_REFRESH_SAFETY_MS = 60_000;
export const CODEX_CONSUMER_REFRESH_GUARD_MS =
  PINNED_CODEX_INTERNAL_REFRESH_GUARD_MS + CODEX_INTERNAL_REFRESH_SAFETY_MS;

// These bounds cover CLI preflight/process initialization and controller-side
// result verification/delivery around one durable specialist segment.
export const CODEX_CONSUMER_STARTUP_RESERVE_MS = 2 * 60_000;
// Supervisor review (90s) and the final spoken weave (60s) can run
// sequentially, so two minutes is not a complete finalization bound.
export const CODEX_CONSUMER_FINALIZATION_RESERVE_MS = 3 * 60_000;
export const MAX_BACKGROUND_CODEX_SEGMENT_MS = 25 * 60_000;
export const MEMORY_CODEX_EXECUTION_RESERVE_MS = 90_000;

export function backgroundSubscriptionValidityMs(segmentMs: number): number {
  if (!Number.isSafeInteger(segmentMs) || segmentMs < 1) {
    throw new Error("invalid Codex segment validity window");
  }
  return CODEX_CONSUMER_REFRESH_GUARD_MS
    + CODEX_CONSUMER_STARTUP_RESERVE_MS
    + segmentMs
    + CODEX_CONSUMER_FINALIZATION_RESERVE_MS;
}

export const DEFAULT_SUBSCRIPTION_VALIDITY_MS = backgroundSubscriptionValidityMs(
  MAX_BACKGROUND_CODEX_SEGMENT_MS,
);

export const MEMORY_SUBSCRIPTION_VALIDITY_MS = backgroundSubscriptionValidityMs(
  MEMORY_CODEX_EXECUTION_RESERVE_MS,
);
