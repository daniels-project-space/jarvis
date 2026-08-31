import type { NextRequest } from "next/server";
import { getSecret } from "@/lib/vault";
import { STT_PROMPT } from "@/lib/sttvocab";
import {
  cleanSpeechTranscript,
  hasConfidentSpeechSegments,
  hasStrongClientSpeechEvidence,
  isMeaningfulSpeechTranscript,
  shouldIgnoreHandsFreeTranscript,
} from "@/lib/transcript";
import { controlActor } from "@/lib/request-auth";

// Daniel's authenticated self-hosted faster-whisper service is the primary speech
// processor. Groq Whisper is a bounded fallback when that private worker is down;
// conversation intelligence remains in the Codex subscription worker.
export const runtime = "nodejs";
export const maxDuration = 30;

const GROQ_STT_ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions";
const LOCAL_STT_TIMEOUT_MS = 3_500;
const GROQ_STT_TIMEOUT_MS = 12_000;
const LOCAL_STT_CIRCUIT_OPEN_MS = 30_000;

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
  groqKey: string | null;
};

let sttConfigCache: { value: SttRuntimeConfig; expiresAt: number } | null = null;
let localSttCircuit: { endpoint: string; openUntil: number } | null = null;

function shouldAttemptLocalStt(endpoint: string, now = Date.now()): boolean {
  if (!localSttCircuit) return true;
  if (localSttCircuit.endpoint !== endpoint || localSttCircuit.openUntil <= now) {
    localSttCircuit = null;
    return true;
  }
  return false;
}

function markLocalSttFailure(endpoint: string, now = Date.now()) {
  localSttCircuit = { endpoint, openUntil: now + LOCAL_STT_CIRCUIT_OPEN_MS };
}

function markLocalSttHealthy(endpoint: string) {
  if (localSttCircuit?.endpoint === endpoint) localSttCircuit = null;
}

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
  const [configuredUrl, sharedSecret, groqKey] = await Promise.all([
    process.env.LOCAL_STT_URL?.trim()
      ? Promise.resolve(process.env.LOCAL_STT_URL.trim())
      : getSecret("local-stt", "LOCAL_STT_URL").catch(() => ""),
    process.env.LOCAL_STT_SHARED_SECRET?.trim()
      ? Promise.resolve(process.env.LOCAL_STT_SHARED_SECRET.trim())
      : getSecret("local-stt", "LOCAL_STT_SHARED_SECRET").catch(() => ""),
    process.env.GROQ_API_KEY?.trim()
      ? Promise.resolve(process.env.GROQ_API_KEY.trim())
      : getSecret("groq", "GROQ_API_KEY").catch(() => ""),
  ]);
  const endpoint = localTranscriptionEndpoint(configuredUrl);
  const value: SttRuntimeConfig = {
    // Never send private speech to an unauthenticated custom endpoint.
    local: endpoint && sharedSecret ? { endpoint, sharedSecret } : null,
    groqKey: groqKey || null,
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
    if (typeof j.text !== "string") return null;
    return {
      text: j.text.trim(),
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
  let transcription: TranscriptionResult | null = null;
  let provider: "local-faster-whisper" | "groq-whisper" | null = null;

  if (config.local && shouldAttemptLocalStt(config.local.endpoint)) {
    transcription = await transcribe(
      config.local.endpoint,
      config.local.sharedSecret,
      buildForm("turbo", inBuf, mime, ext),
      LOCAL_STT_TIMEOUT_MS,
    );
    if (transcription) {
      provider = "local-faster-whisper";
      markLocalSttHealthy(config.local.endpoint);
    } else {
      // Avoid paying the same local timeout on every utterance while a warm
      // serverless instance can already prove that this worker is unhealthy.
      markLocalSttFailure(config.local.endpoint);
    }
  }

  if (transcription === null && config.groqKey) {
    transcription = await transcribe(
      GROQ_STT_ENDPOINT,
      config.groqKey,
      buildForm("whisper-large-v3-turbo", inBuf, mime, ext),
      GROQ_STT_TIMEOUT_MS,
    );
    if (transcription) provider = "groq-whisper";
  }

  if (transcription === null || provider === null) {
    const retryable = Boolean(config.local || config.groqKey);
    return Response.json({
      error: "stt unavailable",
      code: "STT_PROVIDERS_UNAVAILABLE",
      retryable,
      providers: {
        local: config.local ? "unavailable" : "not_configured",
        groq: config.groqKey ? "unavailable" : "not_configured",
      },
    }, { status: retryable ? 502 : 503 });
  }
  const continuousLive = req.headers.get("x-jarvis-continuous-live") === "1";
  const numberHeader = (name: string) => {
    const value = Number(req.headers.get(name));
    return Number.isFinite(value) ? Math.max(0, value) : 0;
  };
  const clientSpeechEvidence = continuousLive ? {
    acceptedFrames: numberHeader("x-jarvis-voice-frames"),
    speechSpanMs: numberHeader("x-jarvis-speech-span-ms"),
    peakVoiceMargin: numberHeader("x-jarvis-peak-voice-margin"),
  } : null;
  // A strong browser VAD signal may corroborate a useful private transcript
  // that narrowly missed Whisper's segment threshold. Silence/untrusted file
  // uploads still require the original server-side segment confidence.
  let text = transcription.confidentSpeech || hasStrongClientSpeechEvidence(clientSpeechEvidence)
    ? cleanSpeechTranscript(transcription.text)
    : "";

  if (continuousLive && shouldIgnoreHandsFreeTranscript(text, clientSpeechEvidence)) text = "";

  // Foreign-script junk on noise never reaches the brain (an English speaker's
  // real words are overwhelmingly Latin).
  const latin = (text.match(/[a-zA-Z0-9\s.,!?'"£$%()@:;/-]/g) ?? []).length;
  if (text && latin / text.length < 0.7) text = "";
  if (!isMeaningfulSpeechTranscript(text)) text = "";
  return new Response(JSON.stringify({ text }), {
    headers: { "content-type": "application/json", "x-jarvis-stt-provider": provider },
  });
}
