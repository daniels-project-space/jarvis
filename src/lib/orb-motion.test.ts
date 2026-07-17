import { describe, expect, it } from "vitest";
import { advanceOrbPhase, createOrbMotionFrame, frameDamping, orbCycleSeconds } from "./orb-motion";

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
});
