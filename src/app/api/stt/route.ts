import type { NextRequest } from "next/server";

// Speech-to-text via Groq Whisper (whisper-large-v3-turbo) — fast, uniform on
// iOS + desktop (the iOS Web Speech API is unreliable). Client posts a WAV blob.
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return new Response(JSON.stringify({ error: "no groq key" }), { status: 500 });
  const inBuf = Buffer.from(await req.arrayBuffer());
  if (inBuf.length < 2000) return new Response(JSON.stringify({ text: "" }), { status: 200 });

  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(inBuf)], { type: "audio/wav" }), "speech.wav");
  form.append("model", "whisper-large-v3-turbo");
  form.append("language", "en");
  form.append("response_format", "json");

  const r = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!r.ok) {
    return new Response(JSON.stringify({ error: `groq ${r.status}` }), { status: 502 });
  }
  const j: any = await r.json();
  return new Response(JSON.stringify({ text: (j.text ?? "").trim() }), {
    headers: { "content-type": "application/json" },
  });
}
