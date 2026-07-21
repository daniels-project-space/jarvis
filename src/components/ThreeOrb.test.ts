import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createOrbMotionFrame, deriveOrbVisual } from "../lib/orb-motion";

const orbSource = readFileSync(new URL("./ThreeOrb.tsx", import.meta.url), "utf8");
const jarvisSource = readFileSync(new URL("./JarvisUI.tsx", import.meta.url), "utf8");

describe("particle orb source contracts", () => {
  it("owns one WebGL renderer/canvas mount and no deprecated or independent clocks", () => {
    expect(orbSource.match(/new THREE\.WebGLRenderer/g)).toHaveLength(1);
    expect(orbSource.match(/runtime\.mountCanvas/g)).toHaveLength(1);
    expect(orbSource).not.toContain("THREE.Clock");
    expect(orbSource).not.toContain("Math.random");
    expect(orbSource).not.toContain("animate-spin");
    expect(orbSource).not.toContain("animationDuration");
    expect(orbSource).not.toContain("<canvas");
    expect(orbSource.match(/requestAnimationFrame/g)).toHaveLength(1);
    expect(orbSource.match(/Object\.assign\(motionRef\.current/g)).toHaveLength(1);
    expect(orbSource.match(/useState\(/g)).toHaveLength(1);
  });

  it("keeps its renderer effect independent of state, mood, aside, captions, panels, and progress", () => {
    const rendererEffect = orbSource.slice(
      orbSource.indexOf("useEffect(() => {\n    const mount = mountRef.current"),
      orbSource.indexOf("  }, []);", orbSource.indexOf("useEffect(() => {\n    const mount = mountRef.current")) + 9,
    );
    expect(rendererEffect).toMatch(/\}, \[\]\);$/);
    expect(rendererEffect).not.toMatch(/\}, \[(?:state|moodColor|aside|caption|panel|progress|reduceMotion)/);
    expect(jarvisSource).not.toMatch(/<ThreeOrb[^>]*key=/);
    expect(jarvisSource).toContain("motionRef={orbMotionRef}");
  });

  it("routes construction failure and context loss/restoration through one exclusive runtime", () => {
    expect(orbSource).toContain("runtime.useFallback();");
    expect(orbSource).toContain("runtime.contextRestored();");
    expect(orbSource).toContain("runtime.webglFrameReady();");
    expect(orbSource).toContain('if (runtime.mode === "fallback") return;');
    expect(orbSource).toContain("runtime.dispose();");
    expect(orbSource).toContain("safeOrbSize(mount.clientWidth, mount.clientHeight)");
    expect(orbSource).toContain("reduceMotionRef.current = reduceMotion");
  });

  it("uses the same visual derivation for the ring and particle fallback", () => {
    expect(orbSource).toContain("deriveOrbVisual(motionFrame");
    expect(jarvisSource).toContain("deriveOrbVisual(motion, reduceMotion)");
    expect(jarvisSource).not.toContain("32 * motion.aside");
    expect(orbSource).not.toContain("orbCycleSeconds");
    expect(orbSource).not.toContain("advanceOrbPhase");
  });
});

describe("orb side-mode layout contracts", () => {
  it("keeps a substantial desktop core wholly inside the right strip at 1440x1000", () => {
    const frame = createOrbMotionFrame();
    frame.aside = 1;
    const visual = deriveOrbVisual(frame);
    const viewportWidth = 1440;
    const diameter = 360 * visual.scale;
    const center = viewportWidth / 2 + viewportWidth * visual.translateXPercent / 100;
    const rightStripStart = viewportWidth * 0.62;

    expect(diameter).toBeCloseTo(280.8, 5);
    expect(center - diameter / 2).toBeGreaterThan(rightStripStart);
    expect(center + diameter / 2).toBeLessThan(viewportWidth);
    expect(jarvisSource).toContain('"top-[70%] hidden md:flex md:left-[62%] md:right-0"');
  });

  it("retains the existing mobile hide/non-aside collision policy at 390x844", () => {
    const mobile = deriveOrbVisual(createOrbMotionFrame());
    expect(mobile.translateXPercent).toBe(0);
    expect(mobile.scale).toBe(1);
    expect(orbSource).toContain("asideRef.current && W() >= 768");
    expect(jarvisSource).toContain("pointer-events-none opacity-0 md:opacity-100");
  });
});
