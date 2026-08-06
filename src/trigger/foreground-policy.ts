import { subscriptionValidityForExecutionMs } from "./subscription-validity";

// Foreground conversation has one authoritative warm owner. Durable
// research/coding belongs to the independent agent fleet; a slow background
// run must never inherit or monopolise Daniel's foreground voice lane.
export const FOREGROUND_QUEUE = "jarvis-foreground";
export const FOREGROUND_CONCURRENCY = 1;
export const FOREGROUND_TURN_TIMEOUT_MS = 150_000;
// Trigger v4 accepts a numeric duration in seconds. Four hours keeps one
// authenticated Codex app-server and its thread map alive through a normal
// active day, while retaining a finite cancellation/recovery boundary.
export const FOREGROUND_MAX_DURATION_SECONDS = 4 * 60 * 60;
// Do not claim unless a worst-case foreground turn can still be streamed and
// finalized before this runner voluntarily hands over. This is intentionally
// larger than the model timeout: context and durable delivery are included.
export const FOREGROUND_ADMISSION_RESERVE_MS = FOREGROUND_TURN_TIMEOUT_MS + 20_000;
// A replacement snapshot is requested early enough to complete the bounded
// CLI preflight and app-server initialization while the current process can
// still admit one complete turn. Consumers never rely on the access token's
// final minutes for either startup or model execution.
export const FOREGROUND_SESSION_STARTUP_RESERVE_MS = 2 * 60_000;
// A turn is admitted only while the token covers the complete delivery bound
// and remains outside Codex 0.144.5's internal refresh window throughout it.
export const FOREGROUND_TURN_VALIDITY_RESERVE_MS =
  subscriptionValidityForExecutionMs(FOREGROUND_ADMISSION_RESERVE_MS);
export const FOREGROUND_SESSION_RENEWAL_RESERVE_MS =
  subscriptionValidityForExecutionMs(
    FOREGROUND_ADMISSION_RESERVE_MS + FOREGROUND_SESSION_STARTUP_RESERVE_MS,
  );
// A successor starts and initializes during this bounded overlap, but cannot
// take the Convex lease until the owner releases it.
export const FOREGROUND_HANDOFF_OVERLAP_MS = 10 * 60_000;
// Leave headroom below Trigger's hard max for cleanup and lease release.
export const FOREGROUND_PROCESS_EXIT_RESERVE_MS = 60_000;
export const FOREGROUND_RUNNER_LEASE_MS = 25_000;
// Keep the authenticated process warm only across an active conversation.
// Event-driven wakes start the next session; an idle four-hour worker was
// effectively permanent Trigger compute with no user-visible benefit.
export const FOREGROUND_IDLE_TIMEOUT_MS = 8 * 60_000;
// A successor spends the handoff overlap waiting before it owns its full
// lifetime. Both alternating task lanes therefore receive the same complete
// owner budget plus overlap and cleanup headroom.
export const FOREGROUND_LANE_MAX_DURATION_SECONDS = FOREGROUND_MAX_DURATION_SECONDS
  + Math.ceil((FOREGROUND_HANDOFF_OVERLAP_MS + FOREGROUND_RUNNER_LEASE_MS + FOREGROUND_PROCESS_EXIT_RESERVE_MS) / 1_000);

/** A claim is safe only when its full execution-and-delivery reserve remains. */
export const canClaimForegroundTurn = (remainingMs: number) =>
  remainingMs >= FOREGROUND_ADMISSION_RESERVE_MS;

export type ForegroundTurnPayload = {
  messageId?: string;
  threadId?: string;
  source?: string;
};
