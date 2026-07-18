export type OrbState = "idle" | "listening" | "thinking" | "speaking";

export type OrbMotionFrame = {
  phase: number;
  elapsedSeconds: number;
  cycleSeconds: number;
  color: string;
  accent: string;
  intensity: number;
  aside: number;
};

// The reactor ring is DOM/SVG while the particle core is WebGL. Keep their
// stage target in one coordinate system: fractions of the stage dimensions,
// with positive y pointing down as it does in CSS.
export const ORB_ASIDE_X = 0.32;
export const ORB_STAGE_Y = -0.045;

export function orbScreenTarget(asideAmount: number): { x: number; y: number } {
  const aside = Math.max(0, Math.min(1, asideAmount));
  return { x: ORB_ASIDE_X * aside, y: ORB_STAGE_Y };
}

const CYCLES: Record<OrbState, number> = {
  idle: 28,
  listening: 20,
  thinking: 10,
  speaking: 16,
};

export function orbCycleSeconds(state: OrbState): number {
  return CYCLES[state];
}

export function createOrbMotionFrame(color = "#00ff88"): OrbMotionFrame {
  return {
    phase: 0,
    elapsedSeconds: 0,
    cycleSeconds: CYCLES.idle,
    color,
    accent: "#8affc5",
    intensity: 0.5,
    aside: 0,
  };
}

// Keep phase cumulative. Wrapping it at 2π is only safe for axes rotating at
// exactly the same rate; the orb intentionally uses slower secondary axes, so
// wrapping made those axes snap backwards once per cycle.
export function advanceOrbPhase(phase: number, cycleSeconds: number, deltaSeconds: number): number {
  return phase + (Math.PI * 2 * Math.max(0, deltaSeconds)) / Math.max(1, cycleSeconds);
}

export function frameDamping(responsePerSecond: number, deltaSeconds: number): number {
  return 1 - Math.exp(-Math.max(0, responsePerSecond) * Math.max(0, deltaSeconds));
}
