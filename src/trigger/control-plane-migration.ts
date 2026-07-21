export const CONTROL_PLANE_MIGRATION_STEPS_PER_TICK = 40;

export type ControlPlaneMigrationStep = {
  phase?: "jobs" | "missions" | "complete";
  complete?: boolean;
};

/** v1 completion is intentionally irrelevant to the independent v2 cursor. */
export function projectionReadMode(v2?: { jobsComplete?: boolean } | null) {
  return v2?.jobsComplete ? "indexed" : "compatibility";
}

/**
 * Drain many small Convex transactions without ever putting two pagination
 * calls in one transaction. The Trigger supervisor remains time/work bounded;
 * an unfinished cursor is picked up by the next minute tick or overlapping
 * supervisor, with Convex's migration row serialising cursor advancement.
 */
export async function drainControlPlaneMigration(
  advance: () => Promise<ControlPlaneMigrationStep>,
  maxSteps = CONTROL_PLANE_MIGRATION_STEPS_PER_TICK,
) {
  const limit = Math.max(1, Math.min(CONTROL_PLANE_MIGRATION_STEPS_PER_TICK, Math.floor(maxSteps)));
  let last: ControlPlaneMigrationStep | null = null;
  let steps = 0;
  while (steps < limit) {
    last = await advance();
    steps += 1;
    if (last?.complete === true) break;
  }
  return {
    steps,
    complete: last?.complete === true,
    phase: last?.phase ?? null,
  };
}
