import type { NextRequest } from "next/server";

// Server-side TTS: Kokoro-82M fp32 (open model) via Replicate. Runs espeak-ng
// phonemization in a real Linux env — fixes the iOS-Safari WASM garbling that
// made in-browser kokoro-js speak gibberish. Returns clean WAV to the client.
export const runtime = "nodejs";
export const maxDuration = 60;

const VERSION = "f559560eb822dc509045f3921a1921234918b91739db4bf3daab2169b71c7a13";

// Strip everything a human wouldn't say aloud, so the voice never reads markup.
function stripForSpeech(t: string): string {
  return t
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(
      /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2705}\u{26A0}]/gu,
      "",
    )
    .replace(/[#*_`>~|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function POST(req: NextRequest) {
  let text = "";
  try {
    ({ text } = await req.json());
  } catch {
    return new Response("bad request", { status: 400 });
  }
  const clean = stripForSpeech(String(text || "")).slice(0, 1500);
  if (!clean) return new Response("empty", { status: 400 });
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) return new Response("no token", { status: 500 });

  const pred = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "wait",
    },
    body: JSON.stringify({ version: VERSION, input: { text: clean, voice: "bm_george", speed: 0.93 } }),
  });
  const j: any = await pred.json().catch(() => ({}));
  const url = typeof j.output === "string" ? j.output : Array.isArray(j.output) ? j.output[0] : null;
  if (!url) return new Response(JSON.stringify({ error: j.error ?? "no audio" }), { status: 502 });

  const audio = await fetch(url);
  const buf = await audio.arrayBuffer();
  return new Response(buf, {
    headers: { "content-type": "audio/wav", "cache-control": "public, max-age=86400" },
  });
}
