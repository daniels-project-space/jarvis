// Shared protocol caps live outside the supervisor mutation module so bounded
// authority helpers can enforce the same limits without a dependency cycle.
export const MISSION_SUPERVISOR_MAX_RECOVERY_GENERATION = 4;
export const MISSION_SUPERVISOR_MAX_AUTONOMOUS_RECOVERIES = 2;
