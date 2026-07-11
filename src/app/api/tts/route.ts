import type { NextRequest } from "next/server";

// Server-side TTS. Primary = Chatterbox (Resemble AI, MIT open-weight) — the more
// human/advanced voice. Fallback = Kokoro-82M (open, Apache) for speed/resilience.
// Both run server-side (no iOS WASM garbling) and strip markup before synthesis.
export const runtime = "nodejs";
export const maxDuration = 60;

const CHATTERBOX = "1b8422bc49635c20d0a84e387ed20879c0dd09254ecdb4e75dc4bec10ff94e97";
const KOKORO = "f559560eb822dc509045f3921a1921234918b91739db4bf3daab2169b71c7a13";

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

async function render(version: string, input: Record<string, unknown>, token: string): Promise<ArrayBuffer | null> {
  try {
    const pred = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "wait" },
      body: JSON.stringify({ version, input }),
    });
    const j: any = await pred.json().catch(() => ({}));
    const url = typeof j.output === "string" ? j.output : Array.isArray(j.output) ? j.output[0] : null;
    if (!url) return null;
    return await (await fetch(url)).arrayBuffer();
  } catch {
    return null;
  }
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

  // Chatterbox first (more human), Kokoro as the fast/reliable fallback.
  let buf = await render(CHATTERBOX, { prompt: clean, temperature: 0.7 }, token);
  if (!buf) buf = await render(KOKORO, { text: clean, voice: "bm_george", speed: 0.95 }, token);
  if (!buf) return new Response(JSON.stringify({ error: "tts failed" }), { status: 502 });

  return new Response(buf, {
    headers: { "content-type": "audio/wav", "cache-control": "public, max-age=86400" },
  });
}
