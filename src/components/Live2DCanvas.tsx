"use client";
import { useEffect, useRef } from "react";
import { Application, Ticker } from "pixi.js";
import { Live2DModel } from "pixi-live2d-display-lipsyncpatch";

// The fork drives its own updates via the shared ticker.
Live2DModel.registerTicker(Ticker);

export default function Live2DCanvas({ speakUrl }: { speakUrl?: string | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const modelRef = useRef<any>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const parent = canvas.parentElement!;
    const app = new Application({
      view: canvas,
      backgroundAlpha: 0,
      antialias: true,
      resizeTo: parent,
      autoDensity: true,
    });
    let model: any = null;
    let destroyed = false;

    function layout() {
      if (!model) return;
      const iw = model.internalModel.width;
      const ih = model.internalModel.height;
      const s = Math.min(parent.clientWidth / iw, parent.clientHeight / ih) * 1.35;
      model.scale.set(s);
      model.anchor.set(0.5, 1);
      model.x = parent.clientWidth / 2;
      model.y = parent.clientHeight;
    }

    Live2DModel.from("/models/hiyori/Hiyori.model3.json")
      .then((m: any) => {
        if (destroyed) {
          m.destroy();
          return;
        }
        model = m;
        modelRef.current = m;
        app.stage.addChild(m);
        layout();
      })
      .catch((e: unknown) => console.error("Live2D load failed", e));

    window.addEventListener("resize", layout);
    return () => {
      destroyed = true;
      window.removeEventListener("resize", layout);
      app.destroy(true, { children: true });
    };
  }, []);

  useEffect(() => {
    if (speakUrl && modelRef.current) {
      try {
        modelRef.current.speak(speakUrl, { crossOrigin: "anonymous" });
      } catch (e) {
        console.error("speak failed", e);
      }
    }
  }, [speakUrl]);

  return <canvas ref={canvasRef} className="h-full w-full" />;
}
