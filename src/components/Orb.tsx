"use client";
import { useEffect, useRef } from "react";

// Reactive arc-reactor orb — idle breathe, lively pulse while speaking.
export default function Orb({
  speaking,
  energyRef,
}: {
  speaking: boolean;
  energyRef?: { current: number };
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const speakingRef = useRef(speaking);
  useEffect(() => {
    speakingRef.current = speaking;
  }, [speaking]);

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext("2d")!;
    let raf = 0;
    let t = 0;
    let energy = 0;

    function resize() {
      const p = canvas.parentElement!;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = p.clientWidth * dpr;
      canvas.height = p.clientHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    window.addEventListener("resize", resize);

    function draw() {
      t += 0.016;
      const p = canvas.parentElement!;
      const w = p.clientWidth;
      const h = p.clientHeight;
      const cx = w / 2;
      const cy = h / 2;
      const R = Math.min(w, h) * 0.24;
      const hue = 130;

      const ext = energyRef?.current ?? 0;
      const target =
        ext > 0.03
          ? Math.min(1, ext)
          : speakingRef.current
            ? 0.45 + 0.45 * Math.abs(Math.sin(t * 8.7) * Math.sin(t * 5.1))
            : 0.14 + 0.06 * Math.sin(t * 1.2);
      energy += (target - energy) * (ext > 0.03 ? 0.4 : 0.15);

      ctx.clearRect(0, 0, w, h);

      // outer glow
      const glow = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * (2.4 + energy));
      glow.addColorStop(0, `hsla(${hue},90%,60%,${0.3 + 0.4 * energy})`);
      glow.addColorStop(1, `hsla(${hue},90%,50%,0)`);
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, w, h);

      // rotating arcs
      for (let i = 0; i < 3; i++) {
        const rr = R * (1.25 + i * 0.3) * (1 + energy * 0.12);
        const start = t * (0.4 + i * 0.35) + i;
        ctx.beginPath();
        ctx.arc(cx, cy, rr, start, start + Math.PI * (1.05 + 0.25 * i));
        ctx.strokeStyle = `hsla(${hue - i * 12},90%,${62 - i * 8}%,${0.55 - i * 0.13})`;
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // core
      const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * (1 + energy * 0.5));
      core.addColorStop(0, `hsla(${hue},100%,88%,0.95)`);
      core.addColorStop(0.5, `hsla(${hue},95%,55%,0.85)`);
      core.addColorStop(1, `hsla(${hue},90%,40%,0)`);
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(cx, cy, R * (1 + energy * 0.55), 0, Math.PI * 2);
      ctx.fill();

      raf = requestAnimationFrame(draw);
    }
    draw();
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return <canvas ref={ref} className="h-full w-full" />;
}
