import type { NextRequest } from "next/server";
import { reportIncident } from "@/lib/context";
import { getSecret } from "@/lib/vault";

// Server TTS for the text lane (live mode speaks natively via OpenAI Realtime).
// Primary: ElevenLabs flash v2.5 (~150ms, properly human). Fallback: Kokoro on
// Replicate. Strips markup before synthesis.
export const runtime = "nodejs";
export const maxDuration = 60;

const KOKORO = "f559560eb822dc509045f3921a1921234918b91739db4bf3daab2169b71c7a13";
// "Daniel" — deep, collected British male. Swap via ELEVENLABS_VOICE_ID.
const EL_VOICE = process.env.ELEVENLABS_VOICE_ID || "onwK4e9ZLuTAKqWW03F9";

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

async function elevenlabs(text: string): Promise<Response | null> {
  const key = process.env.ELEVENLABS_API_KEY ?? (await getSecret("elevenlabs", "ELEVENLABS_API_KEY").catch(() => ""));
  if (!key) return null;
  const r = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${EL_VOICE}/stream?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({
        text,
        model_id: "eleven_flash_v2_5",
        voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.25 },
      }),
    },
  );
  if (!r.ok || !r.body) return null;
  return new Response(r.body, {
    headers: { "content-type": "audio/mpeg", "cache-control": "public, max-age=86400" },
  });
}

async function kokoro(text: string): Promise<Response | null> {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) return null;
  try {
    const pred = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "wait" },
      body: JSON.stringify({ version: KOKORO, input: { text, voice: "bm_george", speed: 0.95 } }),
    });
    const j: any = await pred.json().catch(() => ({}));
    const url = typeof j.output === "string" ? j.output : Array.isArray(j.output) ? j.output[0] : null;
    if (!url) return null;
    const buf = await (await fetch(url)).arrayBuffer();
    return new Response(buf, {
      headers: { "content-type": "audio/wav", "cache-control": "public, max-age=86400" },
    });
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

  const res = (await elevenlabs(clean)) ?? (await kokoro(clean));
  if (!res) {
    await reportIncident("api/tts", "tts:all-providers-failed", "Both ElevenLabs and Kokoro TTS failed to produce audio.");
    return new Response(JSON.stringify({ error: "tts failed" }), { status: 502 });
  }
  return res;
}
