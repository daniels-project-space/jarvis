import type { ForegroundLane } from "./foreground-lanes";

export type ForegroundTurnTiming = {
  claimMs: number;
  contextMs: number;
  codexAckMs?: number;
  firstDeltaMs?: number;
  firstConvexPaintMs?: number;
  completionMs: number;
  finalizeMs: number;
  deliveredMs: number;
};

export type ForegroundTiming = {
  turns: ForegroundTurnTiming[];
  runnerAgeMs: number;
  lane: ForegroundLane;
};

const MAX_FOREGROUND_TIMING_TURNS = 12;

/**
 * Keeps realtime run metadata bounded and limited to delivery timings.
 */
export function buildForegroundTiming(
  turns: readonly ForegroundTurnTiming[],
  runnerAgeMs: number,
  lane: ForegroundLane,
): ForegroundTiming {
  return {
    turns: turns.slice(-MAX_FOREGROUND_TIMING_TURNS).map((turn) => ({ ...turn })),
    runnerAgeMs,
    lane,
  };
}
