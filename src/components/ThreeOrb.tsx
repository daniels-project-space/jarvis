"use client";
import { useEffect, useRef } from "react";
import * as THREE from "three";

// Particle-network orb — adapted from ethanplusai/jarvis (frontend/src/orb.ts),
// free for personal use: https://github.com/ethanplusai/jarvis
// Floating particles with line connections between nearby ones; lines fade with
// state, transition tumble on state change, speaking pulls particles denser,
// electrons travel the connections while thinking.
// Adapted here: container-sized + transparent background, driven by energyRef
// (0..1 voice amplitude) instead of an AnalyserNode, JARVIS green palette.
// The previous orb is preserved as ThreeOrbClassic.tsx (header ◍ toggle).

type OrbState = "idle" | "listening" | "thinking" | "speaking";

const BASE = 0x00ff88; // Daniel's green — do not revert
const THINK = 0x6effc4;
const SPEAK = 0x3cf0a4;

export default function ThreeOrb({
  state = "idle",
  energyRef,
  moodColor,
  aside = false,
}: {
  state?: OrbState;
  energyRef?: { current: number };
  moodColor?: string;
  // true while an overlay owns the stage: the orb drifts into the free right
  // strip and shrinks — done in WORLD space inside the render loop (a CSS
  // transform on the full-bleed canvas got clipped by the stage bounds and
  // could stick until reload).
  aside?: boolean;
}) {
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
    const N = 2000;
    const W = () => mount.clientWidth || 1;
    const H = () => mount.clientHeight || 1;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
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
    const MAX_LINES = 8000;
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
    let spinX = 0, spinY = 0, spinZ = 0;
    let transitionEnergy = 0;
    let lastState: OrbState = "idle";
    let cloudZ = 0, cloudZVel = 0;
    let smoothEnergy = 0;
    let asideAmt = 0; // 0 = centre stage, 1 = tucked into the right strip

    const clock = new THREE.Clock();

    function animate() {
      if (destroyed) return;
      requestAnimationFrame(animate);
      const t = clock.getElapsedTime();
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

      currentRadius += (targetRadius - currentRadius) * 0.02;
      currentSpeed += (targetSpeed - currentSpeed) * 0.02;
      currentBright += (targetBright - currentBright) * 0.02;
      currentSize += (targetSize - currentSize) * 0.02;
      lineAmount += (targetLineAmount - lineAmount) * 0.02;
      electronSpawnRate += (targetElectronRate - electronSpawnRate) * 0.02;

      if (st !== lastState) { transitionEnergy = 1.0; lastState = st; }
      transitionEnergy *= 0.985;
      if (transitionEnergy > 0.05) {
        spinX += transitionEnergy * 0.012 * Math.sin(t * 1.7);
        spinY += transitionEnergy * 0.015;
        spinZ += transitionEnergy * 0.008 * Math.cos(t * 1.3);
      }

      // our live voice-amplitude signal stands in for the upstream AnalyserNode
      const raw = Math.max(0, Math.min(1, energyRef?.current ?? 0));
      smoothEnergy += (raw - smoothEnergy) * 0.25;
      const bass = smoothEnergy;
      const mid = smoothEnergy * 0.8;

      let zTarget = Math.sin(t * 0.12) * 8;
      if (st === "thinking") zTarget = Math.sin(t * 0.3) * 15 + Math.sin(t * 0.9) * 6;
      else if (st === "speaking") zTarget = Math.sin(t * 0.15) * 6 - bass * 10;
      cloudZVel += (zTarget - cloudZ) * 0.008;
      cloudZVel *= 0.94;
      cloudZ += cloudZVel;

      // glide toward/away from the side strip (desktop only — phones dim instead)
      const wantAside = asideRef.current && W() >= 768 ? 1 : 0;
      asideAmt += (wantAside - asideAmt) * 0.045;
      const halfW = Math.tan((45 * Math.PI) / 360) * 80 * (W() / H());
      const offsetX = halfW * 0.72 * asideAmt;
      const shrink = 1 - 0.5 * asideAmt;

      points.rotation.set(spinX, spinY, spinZ);
      points.position.set(offsetX, 0, cloudZ);
      points.scale.setScalar(shrink);
      lines.rotation.set(spinX, spinY, spinZ);
      lines.position.set(offsetX, 0, cloudZ);
      lines.scale.setScalar(shrink);

      const p = geo.getAttribute("position") as THREE.BufferAttribute;
      const a = p.array as Float32Array;
      for (let i = 0; i < N; i++) {
        const i3 = i * 3;
        const x = a[i3], y = a[i3 + 1], z = a[i3 + 2];
        const px = phase[i];
        vel[i3] += Math.sin(t * 0.05 + px) * 0.001 * currentSpeed;
        vel[i3 + 1] += Math.cos(t * 0.06 + px * 1.3) * 0.001 * currentSpeed;
        vel[i3 + 2] += Math.sin(t * 0.055 + px * 0.7) * 0.001 * currentSpeed;
        vel[i3] += Math.sin(t * 0.02 + px * 2.1 + y * 0.1) * 0.0008 * currentSpeed;
        vel[i3 + 1] += Math.cos(t * 0.025 + px * 1.7 + z * 0.1) * 0.0008 * currentSpeed;
        vel[i3 + 2] += Math.sin(t * 0.022 + px * 0.9 + x * 0.1) * 0.0008 * currentSpeed;
        const dist = Math.sqrt(x * x + y * y + z * z) || 0.01;
        const pull = Math.max(0, dist - currentRadius) * 0.002 + 0.0003;
        vel[i3] -= (x / dist) * pull;
        vel[i3 + 1] -= (y / dist) * pull;
        vel[i3 + 2] -= (z / dist) * pull;
        if (bass > 0.05) {
          vel[i3] += (x / dist) * bass * 0.02;
          vel[i3 + 1] += (y / dist) * bass * 0.02;
          vel[i3 + 2] += (z / dist) * bass * 0.02;
        }
        if (st === "speaking" && mid > 0.1) {
          const pulse = Math.sin(t * 8 + px);
          vel[i3] += (x / dist) * mid * 0.012 * pulse;
          vel[i3 + 1] += (y / dist) * mid * 0.012 * pulse;
        }
        vel[i3] *= 0.992; vel[i3 + 1] *= 0.992; vel[i3 + 2] *= 0.992;
        a[i3] += vel[i3]; a[i3 + 1] += vel[i3 + 1]; a[i3 + 2] += vel[i3 + 2];
      }
      p.needsUpdate = true;

      if (lineAmount > 0.01) {
        const lp = lineGeo.getAttribute("position") as THREE.BufferAttribute;
        const la = lp.array as Float32Array;
        let lineCount = 0;
        const maxDist = lineDistance * (1 + bass * 0.5);
        const maxDistSq = maxDist * maxDist;
        const step = Math.max(1, Math.floor(N / 600));
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
      } else {
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
        el.t += el.speed;
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
      electrons.position.set(offsetX, 0, cloudZ);
      electrons.scale.setScalar(shrink);

      mat.opacity = currentBright + bass * 0.08;
      mat.size = (currentSize + bass * 0.05) * shrink;
      // mood-aware palette: the whole orb drifts slowly into the conversation's
      // colour and holds it; states tint from that base
      const moodBase = new THREE.Color(moodRef.current ?? "#00ff88");
      const target =
        st === "thinking" ? moodBase.clone().lerp(new THREE.Color("#ffffff"), 0.3)
        : st === "speaking" ? moodBase.clone().lerp(new THREE.Color("#ffffff"), 0.15)
        : moodBase;
      mat.color.lerp(target, 0.0018);
      lineMat.color.lerp(target, 0.0018);

      camera.position.x = Math.sin(t * 0.02) * 5;
      camera.position.y = Math.cos(t * 0.03) * 3;
      camera.lookAt(0, 0, cloudZ * 0.2);
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
    animate();

    return () => {
      destroyed = true;
      window.removeEventListener("resize", onResize);
      ro.disconnect();
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
  }, []);

  return <div ref={mountRef} className="h-full w-full" />;
}
