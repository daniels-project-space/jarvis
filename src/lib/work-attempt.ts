/**
 * Progress is a causal advance, never merely proof that a process is alive.
 * Keeping this policy pure lets the Convex authority and its regressions agree
 * on the exact watchdog boundary.
 */
export function isMeaningfulWorkProgress(input: {
  currentStage?: string | null;
  currentPercent?: number | null;
  currentProgress?: string | null;
  nextStage?: string | null;
  nextPercent?: number | null;
  nextProgress: string;
}): boolean {
  const currentPercent = Number(input.currentPercent ?? 0);
  const nextPercent = Number(input.nextPercent ?? currentPercent);
  if (input.nextStage !== undefined && input.nextStage !== input.currentStage) return true;
  if (nextPercent > currentPercent) return true;
  // A worker may publish evidence before it can honestly advance its percent;
  // require stage/percent context so repeated liveness text cannot evade stall.
  return input.nextProgress.trim() !== String(input.currentProgress ?? "").trim()
    && Boolean(input.nextStage || input.nextPercent !== undefined);
}

export function hasAttemptBudget(attempt: number, maxAttempts: number): boolean {
  return Math.max(1, Math.floor(attempt)) <= Math.max(1, Math.floor(maxAttempts));
}
