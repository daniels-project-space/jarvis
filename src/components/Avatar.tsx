"use client";
import dynamic from "next/dynamic";

// WebGL/Live2D is client-only — ssr:false is mandatory (touches window/WebGL).
const Live2DCanvas = dynamic(() => import("./Live2DCanvas"), { ssr: false });

export default function Avatar({ speakUrl }: { speakUrl?: string | null }) {
  return <Live2DCanvas speakUrl={speakUrl} />;
}
