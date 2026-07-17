export type OrbState = "idle" | "listening" | "thinking" | "speaking";

export type OrbMotionFrame = {
  phase: number;
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

export function orbCycleSeconds(state: OrbState): number {
  return CYCLES[state];
}

export function createOrbMotionFrame(color = "#00ff88"): OrbMotionFrame {
  return {
    phase: 0,
    cycleSeconds: CYCLES.idle,
    color,
    accent: "#8affc5",
    intensity: 0.5,
    aside: 0,
  };
}

export function frameDamping(responsePerSecond: number, deltaSeconds: number): number {
  return 1 - Math.exp(-Math.max(0, responsePerSecond) * Math.max(0, deltaSeconds));
}
