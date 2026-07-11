import type { NextRequest } from "next/server";

// Speech-to-text via Groq Whisper (whisper-large-v3-turbo) — fast, uniform on
// iOS + desktop. Accepts whatever container MediaRecorder produced (webm/mp4/wav).
export const runtime = "nodejs";
export const maxDuration = 30;

const EXT: Record<string, string> = {
  "audio/webm": "webm",
  "audio/mp4": "mp4",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
};

export async function POST(req: NextRequest) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return new Response(JSON.stringify({ error: "no groq key" }), { status: 500 });
  const inBuf = Buffer.from(await req.arrayBuffer());
  if (inBuf.length < 2000) return new Response(JSON.stringify({ text: "" }), { status: 200 });
  const mime = (req.headers.get("content-type") ?? "audio/wav").split(";")[0];
  const ext = EXT[mime] ?? "wav";

  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(inBuf)], { type: mime }), `speech.${ext}`);
  form.append("model", "whisper-large-v3-turbo");
  form.append("language", "en");
  form.append("temperature", "0");
  form.append("prompt", "Daniel, a British English speaker, talking to his assistant.");
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
  let text = String(j.text ?? "").trim();
  // Whisper hallucinates foreign-script junk on noise — an English speaker's
  // real words are overwhelmingly Latin. Drop garbage instead of sending it.
  const latin = (text.match(/[a-zA-Z0-9\s.,!?'"£$%()@:;/-]/g) ?? []).length;
  if (text && latin / text.length < 0.7) text = "";
  return new Response(JSON.stringify({ text }), {
    headers: { "content-type": "application/json" },
  });
}
