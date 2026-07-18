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

const CYCLES: Record<OrbState, number> = {
  idle: 28,
  listening: 20,
  thinking: 10,
  speaking: 16,
};

// The reactor ring is deliberately a little slower than the particle core and
// travels in the opposite direction. Keeping this derived from the cumulative
// shared phase means state changes remain continuous (including while an
// overlay eases the orb aside) instead of restarting a separate animation.
const RING_COUNTER_ROTATION = -0.72;

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

export function counterRotateOrbRing(orbPhase: number): number {
  return orbPhase * RING_COUNTER_ROTATION;
}

export function frameDamping(responsePerSecond: number, deltaSeconds: number): number {
  return 1 - Math.exp(-Math.max(0, responsePerSecond) * Math.max(0, deltaSeconds));
}
