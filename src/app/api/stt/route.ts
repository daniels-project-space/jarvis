import type { NextRequest } from "next/server";
import { getSecret } from "@/lib/vault";
import { STT_PROMPT } from "@/lib/sttvocab";

// Speech-to-text, accuracy-first: OpenAI gpt-4o-transcribe (much better word
// recognition, vocabulary-primed) with Groq whisper-large-v3-turbo as the fast
// fallback when OpenAI is slow or down. Accepts whatever container
// MediaRecorder produced (webm/mp4/wav).
export const runtime = "nodejs";
export const maxDuration = 30;

const EXT: Record<string, string> = {
  "audio/webm": "webm",
  "audio/mp4": "mp4",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
};

function buildForm(model: string, buf: Buffer, mime: string, ext: string): FormData {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(buf)], { type: mime }), `speech.${ext}`);
  form.append("model", model);
  form.append("language", "en");
  form.append("temperature", "0");
  form.append("prompt", STT_PROMPT);
  form.append("response_format", "json");
  return form;
}

async function transcribe(url: string, key: string, form: FormData, timeoutMs: number): Promise<string | null> {
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return null;
    const j: any = await r.json();
    return String(j.text ?? "").trim();
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  const inBuf = Buffer.from(await req.arrayBuffer());
  if (inBuf.length < 2000) return new Response(JSON.stringify({ text: "" }), { status: 200 });
  const mime = (req.headers.get("content-type") ?? "audio/wav").split(";")[0];
  const ext = EXT[mime] ?? "wav";

  const [openaiKey, groqKey] = await Promise.all([
    Promise.resolve(process.env.OPENAI_API_KEY ?? "").then((k) => k || getSecret("openai", "OPENAI_API_KEY").catch(() => "")),
    Promise.resolve(process.env.GROQ_API_KEY ?? "").then((k) => k || getSecret("groq", "GROQ_API_KEY").catch(() => "")),
  ]);

  let text: string | null = null;
  if (openaiKey)
    text = await transcribe(
      "https://api.openai.com/v1/audio/transcriptions",
      openaiKey,
      buildForm("gpt-4o-transcribe", inBuf, mime, ext),
      8000,
    );
  if (text === null && groqKey)
    text = await transcribe(
      "https://api.groq.com/openai/v1/audio/transcriptions",
      groqKey,
      buildForm("whisper-large-v3-turbo", inBuf, mime, ext),
      10000,
    );
  if (text === null) return new Response(JSON.stringify({ error: "stt unavailable" }), { status: 502 });

  // Foreign-script junk on noise never reaches the brain (an English speaker's
  // real words are overwhelmingly Latin).
  const latin = (text.match(/[a-zA-Z0-9\s.,!?'"£$%()@:;/-]/g) ?? []).length;
  if (text && latin / text.length < 0.7) text = "";
  return new Response(JSON.stringify({ text }), {
    headers: { "content-type": "application/json" },
  });
}
