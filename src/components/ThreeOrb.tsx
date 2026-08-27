"use client";
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import * as THREE from "three";
import {
  advanceOrbMotionFrame,
  createOrbMotionFrame,
  createOrbParticleField,
  createSeededRandom,
  deriveOrbVisual,
  frameDamping,
  sampleOrbTimestamp,
  type OrbMotionFrame,
  type OrbState,
} from "@/lib/orb-motion";
import { OrbRuntimeController, safeOrbSize } from "@/lib/orb-runtime";

// Particle-network orb — adapted from ethanplusai/jarvis (frontend/src/orb.ts),
// free for personal use: https://github.com/ethanplusai/jarvis
// Floating particles with line connections between nearby ones; lines fade with
// state, speaking pulls particles denser,
// electrons travel the connections while thinking.
// Adapted here: container-sized + transparent background, driven by energyRef
// (0..1 voice amplitude) instead of an AnalyserNode, JARVIS green palette.
// This is the only orb renderer; the superseded canvas/classic experiments
// were removed so no second animation system can fight this clock.

const BASE = 0x00ff88; // Daniel's green — do not revert
const FALLBACK_PARTICLES = Array.from({ length: 72 }, (_, index) => {
  const angle = index * 2.399963;
  const radius = 5 + Math.sqrt(index / 72) * 40;
  return {
    x: 50 + Math.cos(angle) * radius,
    y: 50 + Math.sin(angle) * radius * 0.9,
    r: index % 9 === 0 ? 1.1 : index % 4 === 0 ? 0.75 : 0.48,
  };
});
const FALLBACK_LINKS = FALLBACK_PARTICLES.flatMap((point, index) => {
  const next = FALLBACK_PARTICLES[index + 1];
  const cross = index % 4 === 0 ? FALLBACK_PARTICLES[index + 7] : undefined;
  return [next && { from: point, to: next }, cross && { from: point, to: cross }].filter(Boolean) as {
    from: (typeof FALLBACK_PARTICLES)[number];
    to: (typeof FALLBACK_PARTICLES)[number];
  }[];
});

export default function ThreeOrb({
  state = "idle",
  energyRef,
  mood = "calm",
  moodColor,
  motionRef,
  aside = false,
  reduceMotion = false,
  forceFallback = false,
}: {
  state?: OrbState;
  energyRef?: { current: number };
  mood?: string;
  moodColor?: string;
  motionRef?: MutableRefObject<OrbMotionFrame>;
  // true while an overlay owns the stage: the orb drifts into the free right
  // strip and shrinks — done in WORLD space inside the render loop (a CSS
  // transform on the full-bleed canvas got clipped by the stage bounds and
  // could stick until reload).
  aside?: boolean;
  reduceMotion?: boolean;
  // Useful for constrained remote/embedded surfaces that deliberately choose
  // the lightweight SVG core instead of attempting a WebGL context.
  forceFallback?: boolean;
}) {
  const [webglUnavailable, setWebglUnavailable] = useState(false);
  const fallbackContainerRef = useRef<HTMLDivElement>(null);
  const fallbackSvgRef = useRef<SVGSVGElement>(null);
  const fallbackFirstStopRef = useRef<SVGStopElement>(null);
  const fallbackMiddleStopRef = useRef<SVGStopElement>(null);
  const fallbackLastStopRef = useRef<SVGStopElement>(null);
  const fallbackLinksRef = useRef<SVGGElement>(null);
  const fallbackParticlesRef = useRef<SVGGElement>(null);
  const moodRef = useRef<string | undefined>(moodColor);
  useEffect(() => {
    moodRef.current = moodColor;
  }, [moodColor]);
  const asideRef = useRef(aside);
  useEffect(() => {
    asideRef.current = aside;
  }, [aside]);
  const mountRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<OrbState>(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  const reduceMotionRef = useRef(reduceMotion);
  useEffect(() => {
    reduceMotionRef.current = reduceMotion;
  }, [reduceMotion]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let destroyed = false;
    const compact = window.matchMedia("(max-width: 767px)").matches;
    const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const reducedMotion = () => reduceMotionRef.current || reducedMotionQuery.matches;
    // This is a decorative surface, not a simulation benchmark. The former
    // 1,400-particle desktop mesh repeatedly monopolised the main thread while
    // JARVIS was trying to caption/speak. A denser shader cannot compensate
    // for dropped input frames, so keep a rich cloud inside a strict frame
    // budget instead.
    const N = reducedMotion() ? 160 : compact ? 260 : 420;
    const CONNECTION_SAMPLE = reducedMotion() ? 40 : compact ? 68 : 96;
    const size = () => safeOrbSize(mount.clientWidth, mount.clientHeight);
    const W = () => size().width;
    const H = () => size().height;
    const runtime = new OrbRuntimeController(
      (callback) => window.requestAnimationFrame(callback),
      (handle) => window.cancelAnimationFrame(handle),
      (mode) => queueMicrotask(() => {
        if (!destroyed) setWebglUnavailable(mode !== "webgl");
      }),
    );
    let motionFrame = { ...(motionRef?.current ?? createOrbMotionFrame(moodRef.current)) };
    let previousTimestamp = performance.now();
    let smoothEnergy = 0;
    let lastRenderedAt = 0;

    const paintFallback = () => {
      const visual = deriveOrbVisual(motionFrame, reducedMotion());
      if (fallbackContainerRef.current) {
        fallbackContainerRef.current.style.transform = `translateX(${visual.translateXPercent}%)`;
        fallbackContainerRef.current.style.opacity = String(0.52 + visual.intensity * 0.48);
      }
      if (fallbackSvgRef.current) {
        fallbackSvgRef.current.style.transform = `rotate(${visual.rotation}rad) scale(${visual.scale})`;
        fallbackSvgRef.current.style.color = visual.color;
        fallbackSvgRef.current.style.filter = `drop-shadow(0 0 ${12 + visual.intensity * 12}px ${visual.color}66)`;
      }
      fallbackFirstStopRef.current?.setAttribute("stop-color", visual.color);
      fallbackMiddleStopRef.current?.setAttribute("stop-color", visual.accent);
      fallbackLastStopRef.current?.setAttribute("stop-color", visual.color);
      fallbackLinksRef.current?.setAttribute("stroke-opacity", String(0.12 + visual.intensity * 0.18));
      fallbackParticlesRef.current?.setAttribute("fill-opacity", String(0.55 + visual.intensity * 0.4));
    };

    const stepMotion = (timestamp: number) => {
      const timing = sampleOrbTimestamp(previousTimestamp, timestamp);
      previousTimestamp = timing.timestampMs;
      const rawEnergy = Math.max(0, Math.min(1, energyRef?.current ?? 0));
      smoothEnergy += (rawEnergy - smoothEnergy) * frameDamping(17.25, timing.physicsSeconds);
      motionFrame = advanceOrbMotionFrame(motionFrame, {
        state: stateRef.current,
        motionSeconds: timing.motionSeconds,
        easingSeconds: timing.physicsSeconds,
        moodColor: moodRef.current,
        aside: asideRef.current && W() >= 768,
        energy: smoothEnergy,
        reduceMotion: reducedMotion(),
      });
      if (motionRef) Object.assign(motionRef.current, motionFrame);
      if (runtime.mode !== "webgl") paintFallback();
      return { timing, visual: deriveOrbVisual(motionFrame, reducedMotion()), energy: smoothEnergy };
    };

    const startFallback = () => {
      runtime.useFallback();
      runtime.start((timestamp) => {
        if (document.hidden) return;
        const slowFrame = reducedMotion() || stateRef.current === "idle";
        if (timestamp - lastRenderedAt < (reducedMotion() ? 80 : slowFrame ? 33 : 21)) return;
        lastRenderedAt = timestamp;
        stepMotion(timestamp);
      });
    };

    if (forceFallback) {
      startFallback();
      return () => {
        destroyed = true;
        runtime.dispose();
      };
    }
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: "high-performance" });
    } catch {
      // WebGL can be unavailable after a driver reset, inside a remote browser,
      // or on battery-constrained devices. The orb is decoration: it must never
      // be allowed to take the work surface down with it.
      startFallback();
      return () => {
        destroyed = true;
        runtime.dispose();
      };
    }
    queueMicrotask(() => {
      if (!destroyed) setWebglUnavailable(false);
    });
    renderer.setPixelRatio(1);
    renderer.setSize(W(), H());
    renderer.setClearColor(0x000000, 0);
    runtime.mountCanvas(mount, renderer.domElement);
    const onContextLost = (event: Event) => {
      event.preventDefault();
      runtime.useFallback();
    };
    const onContextRestored = () => {
      runtime.contextRestored();
    };
    runtime.listen(renderer.domElement, "webglcontextlost", onContextLost);
    runtime.listen(renderer.domElement, "webglcontextrestored", onContextRestored);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, W() / H(), 1, 1000);
    camera.position.z = 80;

    // ── Particles ──
    const geo = new THREE.BufferGeometry();
    const field = createOrbParticleField(N);
    const pos = field.positions;
    const vel = new Float32Array(N * 3);
    const phase = field.phases;
    const electronRandom = createSeededRandom(0x454c4543);
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color: BASE, size: 0.4, transparent: true, opacity: 0.6,
      sizeAttenuation: true, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const points = new THREE.Points(geo, mat);
    scene.add(points);

    // ── Connection lines ──
    const MAX_LINES = compact ? 420 : 700;
    const linePos = new Float32Array(MAX_LINES * 6);
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute("position", new THREE.BufferAttribute(linePos, 3));
    lineGeo.setDrawRange(0, 0);
    const lineMat = new THREE.LineBasicMaterial({
      color: BASE, transparent: true, opacity: 0.0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const lines = new THREE.LineSegments(lineGeo, lineMat);
    scene.add(lines);

    // ── Electrons — bright dots travelling along connections while thinking ──
    const MAX_ELECTRONS = 200;
    const electronGeo = new THREE.BufferGeometry();
    const electronPos = new Float32Array(MAX_ELECTRONS * 3);
    electronGeo.setAttribute("position", new THREE.BufferAttribute(electronPos, 3));
    electronGeo.setDrawRange(0, 0);
    const electronMat = new THREE.PointsMaterial({
      color: 0xffffff, size: 0.8, transparent: true, opacity: 1.0,
      sizeAttenuation: true, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const electrons = new THREE.Points(electronGeo, electronMat);
    scene.add(electrons);

    type Electron = { sx: number; sy: number; sz: number; ex: number; ey: number; ez: number; t: number; speed: number };
    const activeElectrons: Electron[] = [];
    let electronSpawnRate = 0;
    let targetElectronRate = 0;
    let lastElectronSpawn = 0;
    let activeConnections: { x1: number; y1: number; z1: number; x2: number; y2: number; z2: number }[] = [];

    // ── State ──
    let targetRadius = 25, currentRadius = 25;
    let targetSpeed = 0.3, currentSpeed = 0.3;
    let targetSize = 0.4, currentSize = 0.4;
    let lineAmount = 0, targetLineAmount = 0;
    const lineDistance = 8;
    let cloudZ = 0, cloudZVel = 0;
    let inViewport = true;
    let lastConnectionAt = 0;

    function animate(frameTime = 0) {
      if (destroyed) return;
      if (document.hidden || !inViewport) return;
      const slowFrame = reducedMotion() || stateRef.current === "idle";
      // Active states still get a smooth 48 fps, while an idle orb uses 30 fps
      // and reduced motion uses 12.5 fps. The browser remains responsive for
      // typing, captions and panel transitions in every case.
      if (frameTime - lastRenderedAt < (reducedMotion() ? 80 : slowFrame ? 33 : 21)) return;
      lastRenderedAt = frameTime;
      const { timing, visual, energy: bass } = stepMotion(frameTime);
      // Context loss uses this same timestamp authority and publisher, but
      // never touches invalid WebGL resources. During restoration the fallback
      // remains visible until the first successful renderer frame below.
      if (runtime.mode === "fallback") return;
      const delta = timing.physicsSeconds;
      const frameScale = delta * 60;
      const t = motionFrame.elapsedSeconds;
      const st = stateRef.current;

      switch (st) {
        case "idle":
          targetRadius = 28; targetSpeed = 0.2; targetSize = 0.35;
          targetLineAmount = 0.15; targetElectronRate = 0; break;
        case "listening":
          targetRadius = 22; targetSpeed = 0.3; targetSize = 0.4;
          targetLineAmount = 0.4; targetElectronRate = 0; break;
        case "thinking":
          targetRadius = 16; targetSpeed = 0.5; targetSize = 0.3;
          targetLineAmount = 1.0; targetElectronRate = 0.015; break;
        case "speaking":
          targetRadius = 18; targetSpeed = 0.2; targetSize = 0.4;
          targetLineAmount = 0.8; targetElectronRate = 0; break;
      }

      const stateFollow = frameDamping(1.22, delta);
      currentRadius += (targetRadius - currentRadius) * stateFollow;
      currentSpeed += (targetSpeed - currentSpeed) * stateFollow;
      currentSize += (targetSize - currentSize) * stateFollow;
      lineAmount += (targetLineAmount - lineAmount) * stateFollow;
      electronSpawnRate += (targetElectronRate - electronSpawnRate) * stateFollow;

      // State changes already ease radius, speed, brightness and line density.
      // Rotation stays continuous so typing/speaking transitions cannot kick
      // the cloud into what looks like a random animation reset.
      const spinX = visual.rotationX;
      const spinY = visual.rotation;
      const spinZ = visual.rotationZ;

      // our live voice-amplitude signal stands in for the upstream AnalyserNode
      const mid = bass * 0.8;

      let zTarget = Math.sin(t * 0.12) * 8;
      if (st === "thinking") zTarget = Math.sin(t * 0.3) * 15 + Math.sin(t * 0.9) * 6;
      else if (st === "speaking") zTarget = Math.sin(t * 0.15) * 6 - bass * 10;
      cloudZVel += (zTarget - cloudZ) * 0.008 * frameScale;
      cloudZVel *= Math.pow(0.94, frameScale);
      cloudZ += cloudZVel * frameScale;

      // glide toward/away from the side strip (desktop only — phones dim instead)
      const halfW = Math.tan((45 * Math.PI) / 360) * 80 * (W() / H());
      // aside: hug the right edge as far as the panel sits on the left
      const offsetX = halfW * 0.66 * motionFrame.aside;
      const shrink = visual.scale;
      // sit a touch higher so the bottom chat bar isn't crowding it
      const liftY = 3.2;

      points.rotation.set(spinX, spinY, spinZ);
      points.position.set(offsetX, liftY, cloudZ);
      points.scale.setScalar(shrink);
      lines.rotation.set(spinX, spinY, spinZ);
      lines.position.set(offsetX, liftY, cloudZ);
      lines.scale.setScalar(shrink);

      const p = geo.getAttribute("position") as THREE.BufferAttribute;
      const a = p.array as Float32Array;
      for (let i = 0; i < N; i++) {
        const i3 = i * 3;
        const x = a[i3], y = a[i3 + 1], z = a[i3 + 2];
        const px = phase[i];
        vel[i3] += Math.sin(t * 0.05 + px) * 0.001 * currentSpeed * frameScale;
        vel[i3 + 1] += Math.cos(t * 0.06 + px * 1.3) * 0.001 * currentSpeed * frameScale;
        vel[i3 + 2] += Math.sin(t * 0.055 + px * 0.7) * 0.001 * currentSpeed * frameScale;
        vel[i3] += Math.sin(t * 0.02 + px * 2.1 + y * 0.1) * 0.0008 * currentSpeed * frameScale;
        vel[i3 + 1] += Math.cos(t * 0.025 + px * 1.7 + z * 0.1) * 0.0008 * currentSpeed * frameScale;
        vel[i3 + 2] += Math.sin(t * 0.022 + px * 0.9 + x * 0.1) * 0.0008 * currentSpeed * frameScale;
        const dist = Math.sqrt(x * x + y * y + z * z) || 0.01;
        const pull = Math.max(0, dist - currentRadius) * 0.002 + 0.0003;
        vel[i3] -= (x / dist) * pull * frameScale;
        vel[i3 + 1] -= (y / dist) * pull * frameScale;
        vel[i3 + 2] -= (z / dist) * pull * frameScale;
        if (bass > 0.05) {
          vel[i3] += (x / dist) * bass * 0.02 * frameScale;
          vel[i3 + 1] += (y / dist) * bass * 0.02 * frameScale;
          vel[i3 + 2] += (z / dist) * bass * 0.02 * frameScale;
        }
        if (st === "speaking" && mid > 0.1) {
          const pulse = Math.sin(t * 8 + px);
          vel[i3] += (x / dist) * mid * 0.012 * pulse * frameScale;
          vel[i3 + 1] += (y / dist) * mid * 0.012 * pulse * frameScale;
        }
        const drag = Math.pow(0.992, frameScale);
        vel[i3] *= drag; vel[i3 + 1] *= drag; vel[i3 + 2] *= drag;
        a[i3] += vel[i3] * frameScale; a[i3 + 1] += vel[i3 + 1] * frameScale; a[i3 + 2] += vel[i3 + 2] * frameScale;
      }
      p.needsUpdate = true;

      // Neighbour discovery is the expensive part of the visual. It need not
      // run every visual frame: holding it for 50ms is imperceptible but avoids
      // rebuilding a line mesh during every text/caption update.
      if (lineAmount > 0.01 && frameTime - lastConnectionAt >= 50) {
        lastConnectionAt = frameTime;
        const lp = lineGeo.getAttribute("position") as THREE.BufferAttribute;
        const la = lp.array as Float32Array;
        let lineCount = 0;
        const maxDist = lineDistance * (1 + bass * 0.5);
        const maxDistSq = maxDist * maxDist;
        // Bound the quadratic neighbour scan. Points remain rich, while the
        // connection mesh samples a stable subset per device class.
        const step = Math.max(1, Math.ceil(N / CONNECTION_SAMPLE));
        for (let i = 0; i < N && lineCount < MAX_LINES; i += step) {
          const i3 = i * 3;
          const x1 = a[i3], y1 = a[i3 + 1], z1 = a[i3 + 2];
          for (let j = i + step; j < N && lineCount < MAX_LINES; j += step) {
            const j3 = j * 3;
            const dx = a[j3] - x1, dy = a[j3 + 1] - y1, dz = a[j3 + 2] - z1;
            if (dx * dx + dy * dy + dz * dz < maxDistSq) {
              const idx = lineCount * 6;
              la[idx] = x1; la[idx + 1] = y1; la[idx + 2] = z1;
              la[idx + 3] = a[j3]; la[idx + 4] = a[j3 + 1]; la[idx + 5] = a[j3 + 2];
              lineCount++;
            }
          }
        }
        lineGeo.setDrawRange(0, lineCount * 2);
        lp.needsUpdate = true;
        lineMat.opacity = lineAmount * 0.12;
        activeConnections = [];
        for (let c = 0; c < Math.min(lineCount, 500); c++) {
          const ci = c * 6;
          activeConnections.push({
            x1: la[ci], y1: la[ci + 1], z1: la[ci + 2],
            x2: la[ci + 3], y2: la[ci + 4], z2: la[ci + 5],
          });
        }
      } else if (lineAmount <= 0.01) {
        lineGeo.setDrawRange(0, 0);
        activeConnections = [];
      }

      if (activeConnections.length > 0 && electronSpawnRate > 0.005) {
        if (activeElectrons.length < 3 && t - lastElectronSpawn > 1.0) {
          const conn = activeConnections[Math.floor(electronRandom() * activeConnections.length)];
          activeElectrons.push({
            sx: conn.x1, sy: conn.y1, sz: conn.z1,
            ex: conn.x2, ey: conn.y2, ez: conn.z2,
            t: 0,
            speed: 0.003 + electronRandom() * 0.003,
          });
          lastElectronSpawn = t;
        }
      }
      const ep = electronGeo.getAttribute("position") as THREE.BufferAttribute;
      const ea = ep.array as Float32Array;
      let aliveCount = 0;
      for (let e = activeElectrons.length - 1; e >= 0; e--) {
        const el = activeElectrons[e];
        el.t += el.speed * frameScale;
        if (el.t >= 1) {
          activeElectrons.splice(e, 1);
          continue;
        }
        const ei = aliveCount * 3;
        ea[ei] = el.sx + (el.ex - el.sx) * el.t;
        ea[ei + 1] = el.sy + (el.ey - el.sy) * el.t;
        ea[ei + 2] = el.sz + (el.ez - el.sz) * el.t;
        aliveCount++;
      }
      electronGeo.setDrawRange(0, aliveCount);
      ep.needsUpdate = true;
      electrons.rotation.set(spinX, spinY, spinZ);
      electrons.position.set(offsetX, liftY, cloudZ);
      electrons.scale.setScalar(shrink);

      mat.opacity = visual.intensity;
      // Geometry already scales in aside mode. Scaling the point size as well
      // made the side-view core look half-sized twice.
      mat.size = currentSize + bass * 0.05;
      mat.color.set(visual.color);
      lineMat.color.set(visual.accent);
      electronMat.color.set(visual.accent);

      // gentle, slow camera breathing — calmed right down so the orb sits
      // steady instead of drifting all over (worse when it's small and aside),
      // and the camera eases toward the orb's offset so it never looks flung
      // camera follows less than the orb's own shift, so the orb lands further
      // to the side; lookAt stays at y=0 so the lifted orb reads higher
      camera.position.x = Math.sin(t * 0.012) * 1.8 + offsetX * 0.44;
      camera.position.y = Math.cos(t * 0.018) * 1.1;
      camera.lookAt(offsetX * 0.44, 0, cloudZ * 0.2);
      renderer.render(scene, camera);
      runtime.webglFrameReady();
    }

    const onResize = () => {
      const next = size();
      camera.aspect = next.aspect;
      camera.updateProjectionMatrix();
      renderer.setSize(next.width, next.height);
    };
    runtime.listen(window, "resize", onResize);
    const ro = new ResizeObserver(onResize);
    ro.observe(mount);
    runtime.addCleanup(() => ro.disconnect());
    const io = new IntersectionObserver(([entry]) => {
      inViewport = entry.isIntersecting;
    });
    io.observe(mount);
    runtime.addCleanup(() => io.disconnect());
    runtime.addCleanup(() => {
      renderer.dispose();
      geo.dispose();
      lineGeo.dispose();
      electronGeo.dispose();
      mat.dispose();
      lineMat.dispose();
      electronMat.dispose();
    });
    onResize();
    runtime.start(animate);

    return () => {
      destroyed = true;
      runtime.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={mountRef}
      role="img"
      aria-label={`JARVIS visual core, ${mood} mood`}
      data-jarvis-orb
      data-orb-mood={mood}
      className="relative h-full w-full"
    >
      {webglUnavailable && (
        <div
          ref={fallbackContainerRef}
          aria-hidden="true"
          className="absolute inset-0 grid place-items-center will-change-transform"
        >
          <svg
            ref={fallbackSvgRef}
            viewBox="0 0 100 100"
            className="h-[min(54vw,360px)] w-[min(54vw,360px)] min-h-44 min-w-44 overflow-visible will-change-transform"
            style={{ color: moodColor ?? "#00ff88", filter: `drop-shadow(0 0 18px ${moodColor ?? "#00ff88"}55)`, transformBox: "fill-box", transformOrigin: "center" }}
          >
            <defs>
              <radialGradient id="jarvis-orb-fallback-gradient" cx="50%" cy="45%" r="58%">
                <stop ref={fallbackFirstStopRef} offset="0" stopColor="#8affc5" />
                <stop ref={fallbackMiddleStopRef} offset="0.52" stopColor="#00ff88" />
                <stop ref={fallbackLastStopRef} offset="1" stopColor="#00ff88" stopOpacity="0.48" />
              </radialGradient>
            </defs>
            <g ref={fallbackLinksRef} stroke="url(#jarvis-orb-fallback-gradient)" strokeWidth="0.18" strokeOpacity="0.2">
              {FALLBACK_LINKS.map((link, index) => (
                <line key={index} x1={link.from.x} y1={link.from.y} x2={link.to.x} y2={link.to.y} />
              ))}
            </g>
            <g ref={fallbackParticlesRef} fill="url(#jarvis-orb-fallback-gradient)">
              {FALLBACK_PARTICLES.map((particle, index) => (
                <circle key={index} cx={particle.x} cy={particle.y} r={particle.r} opacity={0.42 + (index % 5) * 0.1} />
              ))}
            </g>
          </svg>
        </div>
      )}
    </div>
  );
}
