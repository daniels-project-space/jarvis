"use client";
import { useEffect, useRef } from "react";

// Trillion-style audio-reactive wireframe orb (Three.js): an icosahedron that
// breathes/deforms with the voice amplitude and shifts colour by state.
type State = "idle" | "listening" | "thinking" | "speaking";

const STATE_HUE: Record<State, number> = {
  idle: 0.5, // cyan
  listening: 0.33, // green
  thinking: 0.11, // amber
  speaking: 0.42, // emerald
};

export default function ThreeOrb({
  state = "idle",
  energyRef,
}: {
  state?: State;
  energyRef?: { current: number };
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<State>(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    const mount = mountRef.current!;
    let raf = 0;
    let disposed = false;
    let cleanup = () => {};

    (async () => {
      const THREE = await import("three");
      if (disposed) return;

      const w = () => mount.clientWidth || 1;
      const h = () => mount.clientHeight || 1;
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(w(), h());
      mount.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(50, w() / h(), 0.1, 100);
      camera.position.z = 3.4;

      const geo = new THREE.IcosahedronGeometry(1, 6);
      const basePos = (geo.attributes.position.array as Float32Array).slice();
      const wire = new THREE.MeshBasicMaterial({ wireframe: true, transparent: true, opacity: 0.55 });
      const mesh = new THREE.Mesh(geo, wire);
      scene.add(mesh);

      // glowing inner core
      const coreGeo = new THREE.SphereGeometry(0.55, 32, 32);
      const coreMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.4 });
      const core = new THREE.Mesh(coreGeo, coreMat);
      scene.add(core);

      // outer point cloud sparkle
      const starGeo = new THREE.BufferGeometry();
      const starN = 240;
      const starArr = new Float32Array(starN * 3);
      for (let i = 0; i < starN; i++) {
        const r = 1.9 + Math.random() * 1.4;
        const th = Math.random() * Math.PI * 2;
        const ph = Math.acos(2 * Math.random() - 1);
        starArr[i * 3] = r * Math.sin(ph) * Math.cos(th);
        starArr[i * 3 + 1] = r * Math.sin(ph) * Math.sin(th);
        starArr[i * 3 + 2] = r * Math.cos(ph);
      }
      starGeo.setAttribute("position", new THREE.BufferAttribute(starArr, 3));
      const starMat = new THREE.PointsMaterial({ size: 0.02, transparent: true, opacity: 0.5 });
      const stars = new THREE.Points(starGeo, starMat);
      scene.add(stars);

      const col = new THREE.Color();
      let energy = 0;
      let hue = STATE_HUE[stateRef.current];
      let t = 0;
      const pos = geo.attributes.position;

      const onResize = () => {
        renderer.setSize(w(), h());
        camera.aspect = w() / h();
        camera.updateProjectionMatrix();
      };
      window.addEventListener("resize", onResize);

      const animate = () => {
        t += 0.016;
        const ext = energyRef?.current ?? 0;
        const targetE = ext > 0.03 ? Math.min(1, ext) : 0.08 + 0.05 * Math.sin(t * 1.3);
        energy += (targetE - energy) * (ext > 0.03 ? 0.4 : 0.12);

        // deform vertices along normal from base positions
        const amp = 0.12 + energy * 0.5;
        for (let i = 0; i < pos.count; i++) {
          const bx = basePos[i * 3];
          const by = basePos[i * 3 + 1];
          const bz = basePos[i * 3 + 2];
          const n =
            Math.sin(bx * 3 + t * 1.7) * Math.sin(by * 3 + t * 1.3) * Math.sin(bz * 3 + t * 1.1);
          const s = 1 + n * amp * 0.35;
          pos.setXYZ(i, bx * s, by * s, bz * s);
        }
        pos.needsUpdate = true;

        // colour toward state hue
        const targetHue = STATE_HUE[stateRef.current];
        hue += (targetHue - hue) * 0.06;
        col.setHSL(hue, 0.9, 0.55 + energy * 0.2);
        wire.color.copy(col);
        coreMat.color.copy(col);
        coreMat.opacity = 0.28 + energy * 0.45;
        core.scale.setScalar(1 + energy * 0.5);
        starMat.color.copy(col);

        mesh.rotation.y += 0.0025;
        mesh.rotation.x += 0.0012;
        stars.rotation.y -= 0.0008;

        renderer.render(scene, camera);
        raf = requestAnimationFrame(animate);
      };
      animate();

      cleanup = () => {
        cancelAnimationFrame(raf);
        window.removeEventListener("resize", onResize);
        renderer.dispose();
        geo.dispose();
        wire.dispose();
        coreGeo.dispose();
        coreMat.dispose();
        starGeo.dispose();
        starMat.dispose();
        if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
      };
    })();

    return () => {
      disposed = true;
      cleanup();
    };
  }, []);

  return <div ref={mountRef} className="h-full w-full" />;
}
