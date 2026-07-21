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

export type OrbTimestampStep = {
  timestampMs: number;
  motionSeconds: number;
  physicsSeconds: number;
};

export type OrbVisualFrame = {
  aside: number;
  rotation: number;
  rotationX: number;
  rotationZ: number;
  translateXPercent: number;
  scale: number;
  color: string;
  accent: string;
  intensity: number;
};

const CYCLES: Record<OrbState, number> = {
  idle: 28,
  listening: 20,
  thinking: 10,
  speaking: 16,
};

const INTENSITIES: Record<OrbState, number> = {
  idle: 0.5,
  listening: 0.65,
  thinking: 0.7,
  speaking: 0.7,
};

// A resumed tab catches up by at most this much visible time. That preserves
// monotonic wall-clock phase for ordinary skipped frames while preventing a
// suspended tab from jumping several revolutions on its first restored frame.
export const MAX_ORB_RESUME_SECONDS = 0.75;
export const MAX_ORB_PHYSICS_SECONDS = 0.05;
export const ORB_PARTICLE_SEED = 0x4a415256;

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

export function sampleOrbTimestamp(previousTimestampMs: number, timestampMs: number): OrbTimestampStep {
  const monotonicTimestamp = Math.max(previousTimestampMs, timestampMs);
  const wallSeconds = Math.max(0, (monotonicTimestamp - previousTimestampMs) / 1000);
  const motionSeconds = Math.min(MAX_ORB_RESUME_SECONDS, wallSeconds);
  return {
    timestampMs: monotonicTimestamp,
    motionSeconds,
    physicsSeconds: Math.min(MAX_ORB_PHYSICS_SECONDS, motionSeconds),
  };
}

function parseHex(color: string): [number, number, number] {
  const normalized = /^#[0-9a-f]{6}$/i.test(color) ? color.slice(1) : "00ff88";
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
  ];
}

function mixHex(from: string, to: string, amount: number): string {
  const a = parseHex(from);
  const b = parseHex(to);
  const t = Math.max(0, Math.min(1, amount));
  const channel = (index: number) => Math.round(a[index] + (b[index] - a[index]) * t).toString(16).padStart(2, "0");
  return `#${channel(0)}${channel(1)}${channel(2)}`;
}

export function advanceOrbMotionFrame(
  frame: OrbMotionFrame,
  {
    state,
    motionSeconds,
    easingSeconds,
    moodColor = "#00ff88",
    aside,
    energy = 0,
    reduceMotion = false,
  }: {
    state: OrbState;
    motionSeconds: number;
    easingSeconds: number;
    moodColor?: string;
    aside: boolean;
    energy?: number;
    reduceMotion?: boolean;
  },
): OrbMotionFrame {
  const cycleSeconds = frame.cycleSeconds
    + (orbCycleSeconds(state) - frame.cycleSeconds) * frameDamping(2.2, easingSeconds);
  const targetColor = mixHex(
    moodColor,
    "#ffffff",
    state === "thinking" ? 0.3 : state === "speaking" ? 0.15 : 0,
  );
  const color = mixHex(frame.color, targetColor, frameDamping(1.8, easingSeconds));
  const targetIntensity = Math.min(1, INTENSITIES[state] + Math.max(0, Math.min(1, energy)) * 0.2);
  return {
    phase: reduceMotion ? frame.phase : advanceOrbPhase(frame.phase, cycleSeconds, motionSeconds),
    elapsedSeconds: frame.elapsedSeconds + Math.max(0, motionSeconds),
    cycleSeconds,
    color,
    accent: mixHex(color, "#ffffff", 0.34),
    intensity: frame.intensity + (targetIntensity - frame.intensity) * frameDamping(1.22, easingSeconds),
    aside: frame.aside + ((aside ? 1 : 0) - frame.aside) * frameDamping(3.08, easingSeconds),
  };
}

// Ring, WebGL cloud and reliability fallback all derive from this frame. No
// consumer owns a speed, wrap, colour transition, or aside animation itself.
export function deriveOrbVisual(frame: OrbMotionFrame, reduceMotion = false): OrbVisualFrame {
  return {
    aside: frame.aside,
    rotation: reduceMotion ? 0 : frame.phase,
    rotationX: reduceMotion ? 0 : frame.phase * 0.17,
    rotationZ: reduceMotion ? 0 : frame.phase * 0.09,
    translateXPercent: 32 * frame.aside,
    scale: 1 - 0.22 * frame.aside,
    color: frame.color,
    accent: frame.accent,
    intensity: frame.intensity,
  };
}

export function createSeededRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let mixed = value;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

export function createOrbParticleField(count: number, seed = ORB_PARTICLE_SEED): {
  positions: Float32Array;
  phases: Float32Array;
} {
  const random = createSeededRandom(seed);
  const positions = new Float32Array(Math.max(0, count) * 3);
  const phases = new Float32Array(Math.max(0, count));
  for (let index = 0; index < count; index++) {
    const theta = random() * Math.PI * 2;
    const phi = Math.acos(2 * random() - 1);
    const radius = Math.sqrt(random()) * 25;
    positions[index * 3] = radius * Math.sin(phi) * Math.cos(theta);
    positions[index * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
    positions[index * 3 + 2] = radius * Math.cos(phi);
    phases[index] = random() * 1000;
  }
  return { positions, phases };
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
