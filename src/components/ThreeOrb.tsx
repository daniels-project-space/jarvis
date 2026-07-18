"use client";
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import * as THREE from "three";
import { advanceOrbPhase, frameDamping, orbCycleSeconds, type OrbMotionFrame, type OrbState } from "@/lib/orb-motion";

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

export default function ThreeOrb({
  state = "idle",
  energyRef,
  moodColor,
  motionRef,
  aside = false,
  reduceMotion = false,
}: {
  state?: OrbState;
  energyRef?: { current: number };
  moodColor?: string;
  motionRef?: MutableRefObject<OrbMotionFrame>;
  // true while an overlay owns the stage: the orb drifts into the free right
  // strip and shrinks — done in WORLD space inside the render loop (a CSS
  // transform on the full-bleed canvas got clipped by the stage bounds and
  // could stick until reload).
  aside?: boolean;
  reduceMotion?: boolean;
}) {
  const [webglUnavailable, setWebglUnavailable] = useState(false);
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

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let destroyed = false;
    const compact = window.matchMedia("(max-width: 767px)").matches;
    const reducedMotion = reduceMotion || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // This is a decorative surface, not a simulation benchmark. The former
    // 1,400-particle desktop mesh repeatedly monopolised the main thread while
    // JARVIS was trying to caption/speak. A denser shader cannot compensate
    // for dropped input frames, so keep a rich cloud inside a strict frame
    // budget instead.
    const N = reducedMotion ? 160 : compact ? 260 : 420;
    const CONNECTION_SAMPLE = reducedMotion ? 40 : compact ? 68 : 96;
    const W = () => mount.clientWidth || 1;
    const H = () => mount.clientHeight || 1;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: "high-performance" });
    } catch {
      // WebGL can be unavailable after a driver reset, inside a remote browser,
      // or on battery-constrained devices. The orb is decoration: it must never
      // be allowed to take the work surface down with it.
      queueMicrotask(() => {
        if (!destroyed) setWebglUnavailable(true);
      });
      const fallbackColor = new THREE.Color(moodRef.current ?? "#00ff88");
      const fallbackTarget = new THREE.Color(fallbackColor);
      const fallbackWhite = new THREE.Color(0xffffff);
      const fallbackAccent = new THREE.Color(fallbackColor).lerp(fallbackWhite, 0.34);
      let phase = motionRef?.current.phase ?? 0;
      let elapsedSeconds = motionRef?.current.elapsedSeconds ?? 0;
      let cycle = motionRef?.current.cycleSeconds ?? orbCycleSeconds("idle");
      let asideAmount = motionRef?.current.aside ?? 0;
      let previous = performance.now();
      let fallbackFrame = 0;
      const animateFallback = (now: number) => {
        if (destroyed) return;
        const delta = Math.min(0.25, Math.max(1 / 240, (now - previous) / 1000));
        previous = now;
        const currentState = stateRef.current;
        cycle += (orbCycleSeconds(currentState) - cycle) * frameDamping(2.2, delta);
        if (!reducedMotion) phase = advanceOrbPhase(phase, cycle, delta);
        elapsedSeconds += delta;
        asideAmount += ((asideRef.current && W() >= 768 ? 1 : 0) - asideAmount) * frameDamping(3.08, delta);
        fallbackTarget.set(moodRef.current ?? "#00ff88");
        if (currentState === "thinking") fallbackTarget.lerp(fallbackWhite, 0.3);
        else if (currentState === "speaking") fallbackTarget.lerp(fallbackWhite, 0.15);
        fallbackColor.lerp(fallbackTarget, frameDamping(1.8, delta));
        fallbackAccent.copy(fallbackColor).lerp(fallbackWhite, 0.34);
        if (motionRef) {
          motionRef.current.phase = phase;
          motionRef.current.elapsedSeconds = elapsedSeconds;
          motionRef.current.cycleSeconds = cycle;
          motionRef.current.color = `#${fallbackColor.getHexString()}`;
          motionRef.current.accent = `#${fallbackAccent.getHexString()}`;
          motionRef.current.intensity = currentState === "idle" ? 0.5 : 0.72;
          motionRef.current.aside = asideAmount;
        }
        fallbackFrame = requestAnimationFrame(animateFallback);
      };
      fallbackFrame = requestAnimationFrame(animateFallback);
      return () => {
        destroyed = true;
        cancelAnimationFrame(fallbackFrame);
      };
    }
    queueMicrotask(() => {
      if (!destroyed) setWebglUnavailable(false);
    });
    renderer.setPixelRatio(1);
    renderer.setSize(W(), H());
    renderer.setClearColor(0x000000, 0);
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, W() / H(), 1, 1000);
    camera.position.z = 80;

    // ── Particles ──
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(N * 3);
    const vel = new Float32Array(N * 3);
    const phase = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const r = Math.pow(Math.random(), 0.5) * 25;
      pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      pos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      pos[i * 3 + 2] = r * Math.cos(phi);
      phase[i] = Math.random() * 1000;
    }
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
    let targetBright = 0.6, currentBright = 0.6;
    let targetSize = 0.4, currentSize = 0.4;
    let lineAmount = 0, targetLineAmount = 0;
    const lineDistance = 8;
    let sharedPhase = motionRef?.current.phase ?? 0;
    let sharedElapsed = motionRef?.current.elapsedSeconds ?? 0;
    let currentCycle = motionRef?.current.cycleSeconds ?? orbCycleSeconds("idle");
    let cloudZ = 0, cloudZVel = 0;
    let smoothEnergy = 0;
    let asideAmt = motionRef?.current.aside ?? 0; // 0 = centre stage, 1 = tucked into the right strip
    let inViewport = true;
    let frameId = 0;
    let lastRenderedAt = 0;
    let lastConnectionAt = 0;

    const clock = new THREE.Clock();
    const moodBase = new THREE.Color(BASE);
    const targetColor = new THREE.Color(BASE);
    const targetAccent = new THREE.Color(BASE);
    const white = new THREE.Color(0xffffff);

    function animate(frameTime = 0) {
      if (destroyed) return;
      frameId = requestAnimationFrame(animate);
      if (document.hidden || !inViewport) return;
      const slowFrame = reducedMotion || stateRef.current === "idle";
      // Active states still get a smooth 48 fps, while an idle orb uses 30 fps
      // and reduced motion uses 12.5 fps. The browser remains responsive for
      // typing, captions and panel transitions in every case.
      if (frameTime - lastRenderedAt < (reducedMotion ? 80 : slowFrame ? 33 : 21)) return;
      lastRenderedAt = frameTime;
      const rawDelta = Math.max(1 / 240, clock.getDelta());
      // Particle physics caps recovery steps after a stalled frame; shared
      // phase uses the real visible-frame delta so ring/orb speed never varies
      // with display refresh rate or a briefly busy main thread.
      const delta = Math.min(0.05, rawDelta);
      const motionDelta = Math.min(0.25, rawDelta);
      const frameScale = delta * 60;
      sharedElapsed += motionDelta;
      const t = sharedElapsed;
      const st = stateRef.current;

      switch (st) {
        case "idle":
          targetRadius = 28; targetSpeed = 0.2; targetBright = 0.5; targetSize = 0.35;
          targetLineAmount = 0.15; targetElectronRate = 0; break;
        case "listening":
          targetRadius = 22; targetSpeed = 0.3; targetBright = 0.65; targetSize = 0.4;
          targetLineAmount = 0.4; targetElectronRate = 0; break;
        case "thinking":
          targetRadius = 16; targetSpeed = 0.5; targetBright = 0.7; targetSize = 0.3;
          targetLineAmount = 1.0; targetElectronRate = 0.015; break;
        case "speaking":
          targetRadius = 18; targetSpeed = 0.2; targetBright = 0.7; targetSize = 0.4;
          targetLineAmount = 0.8; targetElectronRate = 0; break;
      }

      const stateFollow = frameDamping(1.22, delta);
      currentRadius += (targetRadius - currentRadius) * stateFollow;
      currentSpeed += (targetSpeed - currentSpeed) * stateFollow;
      currentBright += (targetBright - currentBright) * stateFollow;
      currentSize += (targetSize - currentSize) * stateFollow;
      lineAmount += (targetLineAmount - lineAmount) * stateFollow;
      electronSpawnRate += (targetElectronRate - electronSpawnRate) * stateFollow;
      currentCycle += (orbCycleSeconds(st) - currentCycle) * frameDamping(2.2, motionDelta);
      sharedPhase = advanceOrbPhase(sharedPhase, currentCycle, motionDelta);

      // State changes already ease radius, speed, brightness and line density.
      // Rotation stays continuous so typing/speaking transitions cannot kick
      // the cloud into what looks like a random animation reset.
      const spinX = sharedPhase * 0.17;
      const spinY = sharedPhase;
      const spinZ = sharedPhase * 0.09;

      // our live voice-amplitude signal stands in for the upstream AnalyserNode
      const raw = Math.max(0, Math.min(1, energyRef?.current ?? 0));
      smoothEnergy += (raw - smoothEnergy) * frameDamping(17.25, delta);
      const bass = smoothEnergy;
      const mid = smoothEnergy * 0.8;

      let zTarget = Math.sin(t * 0.12) * 8;
      if (st === "thinking") zTarget = Math.sin(t * 0.3) * 15 + Math.sin(t * 0.9) * 6;
      else if (st === "speaking") zTarget = Math.sin(t * 0.15) * 6 - bass * 10;
      cloudZVel += (zTarget - cloudZ) * 0.008 * frameScale;
      cloudZVel *= Math.pow(0.94, frameScale);
      cloudZ += cloudZVel * frameScale;

      // glide toward/away from the side strip (desktop only — phones dim instead)
      const wantAside = asideRef.current && W() >= 768 ? 1 : 0;
      asideAmt += (wantAside - asideAmt) * frameDamping(3.08, delta);
      const halfW = Math.tan((45 * Math.PI) / 360) * 80 * (W() / H());
      // aside: hug the right edge as far as the panel sits on the left
      const offsetX = halfW * 0.66 * asideAmt;
      const shrink = 1 - 0.32 * asideAmt;
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
          const conn = activeConnections[Math.floor(Math.random() * activeConnections.length)];
          activeElectrons.push({
            sx: conn.x1, sy: conn.y1, sz: conn.z1,
            ex: conn.x2, ey: conn.y2, ez: conn.z2,
            t: 0,
            speed: 0.003 + Math.random() * 0.003,
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

      mat.opacity = currentBright + bass * 0.08;
      // Geometry already scales in aside mode. Scaling the point size as well
      // made the side-view core look half-sized twice.
      mat.size = currentSize + bass * 0.05;
      // mood-aware palette: the whole orb drifts slowly into the conversation's
      // colour and holds it; states tint from that base
      moodBase.set(moodRef.current ?? "#00ff88");
      targetColor.copy(moodBase);
      if (st === "thinking") targetColor.lerp(white, 0.3);
      else if (st === "speaking") targetColor.lerp(white, 0.15);
      targetAccent.copy(targetColor).lerp(white, 0.34);
      const colorFollow = frameDamping(1.8, delta);
      mat.color.lerp(targetColor, colorFollow);
      lineMat.color.lerp(targetAccent, colorFollow);
      electronMat.color.lerp(targetAccent, colorFollow);

      if (motionRef) {
        motionRef.current.phase = sharedPhase;
        motionRef.current.elapsedSeconds = sharedElapsed;
        motionRef.current.cycleSeconds = currentCycle;
        motionRef.current.color = `#${mat.color.getHexString()}`;
        motionRef.current.accent = `#${lineMat.color.getHexString()}`;
        motionRef.current.intensity = Math.min(1, currentBright + bass * 0.2);
        motionRef.current.aside = asideAmt;
      }

      // gentle, slow camera breathing — calmed right down so the orb sits
      // steady instead of drifting all over (worse when it's small and aside),
      // and the camera eases toward the orb's offset so it never looks flung
      // camera follows less than the orb's own shift, so the orb lands further
      // to the side; lookAt stays at y=0 so the lifted orb reads higher
      camera.position.x = Math.sin(t * 0.012) * 1.8 + offsetX * 0.44;
      camera.position.y = Math.cos(t * 0.018) * 1.1;
      camera.lookAt(offsetX * 0.44, 0, cloudZ * 0.2);
      renderer.render(scene, camera);
    }

    const onResize = () => {
      camera.aspect = W() / H();
      camera.updateProjectionMatrix();
      renderer.setSize(W(), H());
    };
    window.addEventListener("resize", onResize);
    const ro = new ResizeObserver(onResize);
    ro.observe(mount);
    const io = new IntersectionObserver(([entry]) => {
      inViewport = entry.isIntersecting;
    });
    io.observe(mount);
    frameId = requestAnimationFrame(animate);

    return () => {
      destroyed = true;
      cancelAnimationFrame(frameId);
      window.removeEventListener("resize", onResize);
      ro.disconnect();
      io.disconnect();
      renderer.dispose();
      geo.dispose();
      lineGeo.dispose();
      electronGeo.dispose();
      mat.dispose();
      lineMat.dispose();
      electronMat.dispose();
      if (renderer.domElement.parentElement === mount) mount.removeChild(renderer.domElement);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduceMotion]);

  return (
    <div ref={mountRef} className="relative h-full w-full">
      {webglUnavailable && (
        <div
          aria-label="JARVIS visual core"
          className={`absolute inset-0 grid place-items-center will-change-transform transition-transform duration-[760ms] ease-[cubic-bezier(0.22,1,0.36,1)] ${aside ? "translate-x-[32%]" : "translate-x-0"}`}
        >
          <div className={`relative h-[min(42vw,280px)] w-[min(42vw,280px)] min-h-36 min-w-36 rounded-full border border-emerald-300/25 bg-[radial-gradient(circle_at_42%_38%,rgba(110,255,196,0.32),rgba(0,255,136,0.1)_34%,rgba(0,255,136,0.02)_68%,transparent_72%)] shadow-[0_0_80px_rgba(0,255,136,0.16)] transition-transform duration-[760ms] ease-[cubic-bezier(0.22,1,0.36,1)] ${aside ? "scale-[0.68]" : "scale-100"}`}>
            <div className="absolute inset-[18%] rounded-full border border-emerald-200/20 shadow-[inset_0_0_45px_rgba(0,255,136,0.18)]" />
            <div className="absolute inset-[38%] rounded-full bg-emerald-300/35 blur-md" />
          </div>
        </div>
      )}
    </div>
  );
}
