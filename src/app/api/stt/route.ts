import type { NextRequest } from "next/server";
import { getSecret } from "@/lib/vault";
import { STT_PROMPT } from "@/lib/sttvocab";
import {
  cleanSpeechTranscript,
  hasConfidentSpeechSegments,
  isMeaningfulSpeechTranscript,
  shouldIgnoreHandsFreeTranscript,
} from "@/lib/transcript";
import { controlActor } from "@/lib/request-auth";

// Daniel's authenticated self-hosted faster-whisper service is the only speech
// processor. Conversation intelligence remains in the Codex subscription worker.
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
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");
  return form;
}

type TranscriptionResult = { text: string; confidentSpeech: boolean };
type SttRuntimeConfig = {
  local: { endpoint: string; sharedSecret: string } | null;
};

let sttConfigCache: { value: SttRuntimeConfig; expiresAt: number } | null = null;

function localTranscriptionEndpoint(rawUrl: string): string | null {
  try {
    const base = new URL(rawUrl.trim());
    if (!/^https?:$/.test(base.protocol)) return null;
    const path = base.pathname.replace(/\/$/, "");
    if (!path.endsWith("/v1/audio/transcriptions")) base.pathname = `${path}/v1/audio/transcriptions`.replace(/^([^/])/, "/$1");
    return base.toString();
  } catch {
    return null;
  }
}

async function sttRuntimeConfig(): Promise<SttRuntimeConfig> {
  if (process.env.NODE_ENV !== "test" && sttConfigCache && sttConfigCache.expiresAt > Date.now()) return sttConfigCache.value;
  const configuredUrl = process.env.LOCAL_STT_URL?.trim()
    ? process.env.LOCAL_STT_URL.trim()
    : await getSecret("local-stt", "LOCAL_STT_URL").catch(() => "");
  const endpoint = localTranscriptionEndpoint(configuredUrl);
  const sharedSecret = endpoint
    ? process.env.LOCAL_STT_SHARED_SECRET?.trim()
      || await getSecret("local-stt", "LOCAL_STT_SHARED_SECRET").catch(() => "")
    : "";
  const value: SttRuntimeConfig = {
    // Never send private speech to an unauthenticated custom endpoint.
    local: endpoint && sharedSecret ? { endpoint, sharedSecret } : null,
  };
  if (process.env.NODE_ENV !== "test") sttConfigCache = { value, expiresAt: Date.now() + 5 * 60_000 };
  return value;
}

async function transcribe(
  endpoint: string,
  bearerToken: string,
  form: FormData,
  timeoutMs: number,
): Promise<TranscriptionResult | null> {
  try {
    const r = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearerToken}` },
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { text?: unknown; segments?: unknown };
    return {
      text: String(j.text ?? "").trim(),
      confidentSpeech: hasConfidentSpeechSegments(j.segments),
    };
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  if (!(await controlActor(req))) return Response.json({ error: "unauthorized" }, { status: 401 });
  const inBuf = Buffer.from(await req.arrayBuffer());
  if (inBuf.length < 2000) return new Response(JSON.stringify({ text: "" }), { status: 200 });
  const mime = (req.headers.get("content-type") ?? "audio/wav").split(";")[0];
  const ext = EXT[mime] ?? "wav";

  const config = await sttRuntimeConfig();
  if (!config.local) return new Response(JSON.stringify({ error: "local speech recognition is not configured" }), { status: 503 });
  const transcription = await transcribe(
    config.local.endpoint,
    config.local.sharedSecret,
    buildForm("turbo", inBuf, mime, ext),
    25_000,
  );
  if (transcription === null) return new Response(JSON.stringify({ error: "stt unavailable" }), { status: 502 });
  let text = transcription.confidentSpeech ? cleanSpeechTranscript(transcription.text) : "";

  if (req.headers.get("x-jarvis-continuous-live") === "1") {
    const numberHeader = (name: string) => {
      const value = Number(req.headers.get(name));
      return Number.isFinite(value) ? Math.max(0, value) : 0;
    };
    if (shouldIgnoreHandsFreeTranscript(text, {
      acceptedFrames: numberHeader("x-jarvis-voice-frames"),
      speechSpanMs: numberHeader("x-jarvis-speech-span-ms"),
      peakVoiceMargin: numberHeader("x-jarvis-peak-voice-margin"),
    })) text = "";
  }

  // Foreign-script junk on noise never reaches the brain (an English speaker's
  // real words are overwhelmingly Latin).
  const latin = (text.match(/[a-zA-Z0-9\s.,!?'"£$%()@:;/-]/g) ?? []).length;
  if (text && latin / text.length < 0.7) text = "";
  if (!isMeaningfulSpeechTranscript(text)) text = "";
  return new Response(JSON.stringify({ text }), {
    headers: { "content-type": "application/json", "x-jarvis-stt-provider": "local-faster-whisper" },
  });
}
