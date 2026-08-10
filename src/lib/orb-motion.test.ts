import { describe, expect, it } from "vitest";
import {
  MAX_ORB_PHYSICS_SECONDS,
  MAX_ORB_RESUME_SECONDS,
  advanceOrbMotionFrame,
  advanceOrbPhase,
  createOrbMotionFrame,
  createOrbParticleField,
  deriveOrbVisual,
  frameDamping,
  orbCycleSeconds,
  sampleOrbTimestamp,
} from "./orb-motion";

describe("shared orb motion", () => {
  it("accelerates for active states while keeping one cycle for orb and ring", () => {
    expect(orbCycleSeconds("thinking")).toBeLessThan(orbCycleSeconds("listening"));
    expect(orbCycleSeconds("listening")).toBeLessThan(orbCycleSeconds("idle"));
    expect(createOrbMotionFrame().cycleSeconds).toBe(orbCycleSeconds("idle"));
  });

  it("uses frame-rate-independent damping", () => {
    const oneSecondAt60 = 1 - Math.pow(1 - frameDamping(2, 1 / 60), 60);
    expect(oneSecondAt60).toBeCloseTo(frameDamping(2, 1), 8);
  });

  it("keeps phase and elapsed time continuous instead of resetting each cycle", () => {
    const frame = createOrbMotionFrame();
    expect(frame.elapsedSeconds).toBe(0);
    expect(advanceOrbPhase(Math.PI * 2 - 0.01, 10, 1)).toBeGreaterThan(Math.PI * 2);
  });

  it("initializes the same visually rich particle field after every restart", () => {
    const first = createOrbParticleField(420);
    const replay = createOrbParticleField(420);
    const otherSeed = createOrbParticleField(420, 123);

    expect([...replay.positions]).toEqual([...first.positions]);
    expect([...replay.phases]).toEqual([...first.phases]);
    expect([...otherSeed.positions.slice(0, 12)]).not.toEqual([...first.positions.slice(0, 12)]);
    expect(new Set(first.phases).size).toBe(420);
    for (let index = 0; index < 420; index++) {
      const x = first.positions[index * 3];
      const y = first.positions[index * 3 + 1];
      const z = first.positions[index * 3 + 2];
      expect(Math.hypot(x, y, z)).toBeLessThanOrEqual(25.00001);
    }
  });

  it("keeps elapsed phase continuous through state changes and a bounded long resume", () => {
    let timestamp = 1_000;
    let frame = createOrbMotionFrame();
    const ordinary = sampleOrbTimestamp(timestamp, 1_100);
    timestamp = ordinary.timestampMs;
    frame = advanceOrbMotionFrame(frame, {
      state: "idle", motionSeconds: ordinary.motionSeconds, easingSeconds: ordinary.physicsSeconds, aside: false,
    });
    const idlePhase = frame.phase;

    const changed = sampleOrbTimestamp(timestamp, 1_200);
    timestamp = changed.timestampMs;
    frame = advanceOrbMotionFrame(frame, {
      state: "thinking", motionSeconds: changed.motionSeconds, easingSeconds: changed.physicsSeconds, aside: true,
    });
    expect(frame.phase).toBeGreaterThan(idlePhase);
    expect(frame.cycleSeconds).toBeLessThan(orbCycleSeconds("idle"));
    expect(frame.cycleSeconds).toBeGreaterThan(orbCycleSeconds("thinking"));
    expect(frame.aside).toBeGreaterThan(0);
    expect(frame.aside).toBeLessThan(1);

    const beforeResume = frame;
    const resumed = sampleOrbTimestamp(timestamp, timestamp + 60_000);
    frame = advanceOrbMotionFrame(frame, {
      state: "speaking", motionSeconds: resumed.motionSeconds, easingSeconds: resumed.physicsSeconds, aside: true,
    });
    expect(resumed.motionSeconds).toBe(MAX_ORB_RESUME_SECONDS);
    expect(resumed.physicsSeconds).toBe(MAX_ORB_PHYSICS_SECONDS);
    expect(frame.elapsedSeconds - beforeResume.elapsedSeconds).toBeCloseTo(MAX_ORB_RESUME_SECONDS, 10);
    expect(frame.phase).toBeGreaterThan(beforeResume.phase);
    expect(frame.phase - beforeResume.phase).toBeLessThan(Math.PI / 2);
    expect(frame.aside).toBeGreaterThan(beforeResume.aside);
    expect(frame.aside).toBeLessThan(1);
  });

  it("derives ring, WebGL axes, and fallback transform and colour from one unwrapped frame", () => {
    const before = createOrbMotionFrame("#123456");
    before.phase = Math.PI * 2 - 0.001;
    before.aside = 1;
    before.accent = "#abcdef";
    before.intensity = 0.73;
    const after = { ...before, phase: advanceOrbPhase(before.phase, 10, 0.01) };
    const first = deriveOrbVisual(before);
    const second = deriveOrbVisual(after);

    expect(second.rotation).toBeGreaterThan(Math.PI * 2);
    expect(second.rotationX).toBeGreaterThan(first.rotationX);
    expect(second.rotationZ).toBeGreaterThan(first.rotationZ);
    expect(second).toMatchObject({
      translateXPercent: 24,
      scale: 0.88,
      color: "#123456",
      accent: "#abcdef",
      intensity: 0.73,
    });
  });

  it("freezes only rotation when reduced motion changes without resetting shared elapsed state", () => {
    const frame = { ...createOrbMotionFrame(), phase: 4.2, elapsedSeconds: 12 };
    const reduced = advanceOrbMotionFrame(frame, {
      state: "listening", motionSeconds: 0.1, easingSeconds: 0.05, aside: false, reduceMotion: true,
    });
    expect(reduced.phase).toBe(4.2);
    expect(reduced.elapsedSeconds).toBe(12.1);
    expect(deriveOrbVisual(reduced, true).rotation).toBe(0);
    expect(deriveOrbVisual(reduced, true)).toMatchObject({ translateXPercent: 0, scale: 1 });
  });
});
