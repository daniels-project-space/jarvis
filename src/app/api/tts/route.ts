import type { NextRequest } from "next/server";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { isSameOriginRequest } from "@/lib/control-session";
import { controlActor } from "@/lib/request-auth";
import {
  EDGE_TTS_ENGINE,
  EDGE_TTS_VOICE,
  SELF_HOSTED_TTS_ENGINE,
  SELF_HOSTED_TTS_VOICE,
} from "@/lib/tts-config";
import { getSecret } from "@/lib/vault";

export const runtime = "nodejs";
export const maxDuration = 15;

const CONFIG_CACHE_MS = 5 * 60_000;
const SELF_HOSTED_CONNECT_TIMEOUT_MS = 5_000;
const EDGE_CLIENT_POOL_MAX = 2;

type TtsConfig =
  | { kind: "edge"; engine: typeof EDGE_TTS_ENGINE; voice: typeof EDGE_TTS_VOICE }
  | { kind: "self-hosted"; engine: typeof SELF_HOSTED_TTS_ENGINE; voice: typeof SELF_HOSTED_TTS_VOICE; url: string; apiKey: string };

let cachedSelfHostedConfig: { value: Extract<TtsConfig, { kind: "self-hosted" }> | null; expiresAt: number } | null = null;
const idleEdgeClients: MsEdgeTTS[] = [];
let edgeWarmPromise: Promise<void> | null = null;

async function acquireEdgeClient(): Promise<MsEdgeTTS> {
  const client = idleEdgeClients.pop() ?? new MsEdgeTTS();
  try {
    // setMetadata is also the package's connection health check: it is a
    // no-op on a live socket and reconnects a frozen/stale serverless socket.
    await client.setMetadata(EDGE_TTS_VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    return client;
  } catch (error) {
    client.close();
    throw error;
  }
}

function releaseEdgeClient(client: MsEdgeTTS, reusable: boolean) {
  if (!reusable || idleEdgeClients.length >= EDGE_CLIENT_POOL_MAX) {
    client.close();
    return;
  }
  idleEdgeClients.push(client);
}

async function warmEdgeClient(): Promise<void> {
  if (idleEdgeClients.length > 0) return;
  if (!edgeWarmPromise) {
    edgeWarmPromise = (async () => {
      const client = await acquireEdgeClient();
      releaseEdgeClient(client, true);
    })().finally(() => { edgeWarmPromise = null; });
  }
  await edgeWarmPromise;
}

function escapeSpeechXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function speechRate(value: unknown): string {
  const speed = Math.min(1.12, Math.max(0.96, Number(value) || 1.06));
  const percent = Math.round((speed - 1) * 100);
  return `${percent >= 0 ? "+" : ""}${percent}%`;
}

function selfHostedSpeed(value: unknown): number {
  return Math.min(1.12, Math.max(0.96, Number(value) || 1.06));
}

function speechPitch(value: unknown): string {
  const pitch = Math.min(5, Math.max(1, Number(value) || 3));
  return `+${Math.round(pitch)}Hz`;
}

async function authorized(req: NextRequest): Promise<boolean> {
  return isSameOriginRequest(req) && Boolean(await controlActor(req));
}

function selfHostedSpeechEndpoint(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    const local = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    if (url.protocol !== "https:" && !local) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    const path = url.pathname.replace(/\/$/, "");
    url.pathname = path.endsWith("/v1/audio/speech")
      ? path
      : `${path}/v1/audio/speech`.replace(/^([^/])/, "/$1");
    return url.toString();
  } catch {
    return null;
  }
}

async function selfHostedConfig(): Promise<Extract<TtsConfig, { kind: "self-hosted" }> | null> {
  if (cachedSelfHostedConfig && cachedSelfHostedConfig.expiresAt > Date.now()) return cachedSelfHostedConfig.value;
  const [configuredUrl, apiKey] = await Promise.all([
    process.env.SELF_HOSTED_TTS_URL?.trim()
      ? Promise.resolve(process.env.SELF_HOSTED_TTS_URL.trim())
      : getSecret("streaming-tts", "SELF_HOSTED_TTS_URL").catch(() => ""),
    process.env.SELF_HOSTED_TTS_API_KEY?.trim()
      ? Promise.resolve(process.env.SELF_HOSTED_TTS_API_KEY.trim())
      : getSecret("streaming-tts", "SELF_HOSTED_TTS_API_KEY").catch(() => ""),
  ]);
  const url = selfHostedSpeechEndpoint(configuredUrl);
  const value = url && apiKey
    ? { kind: "self-hosted" as const, engine: SELF_HOSTED_TTS_ENGINE, voice: SELF_HOSTED_TTS_VOICE, url, apiKey }
    : null;
  if (process.env.NODE_ENV !== "test") cachedSelfHostedConfig = { value, expiresAt: Date.now() + CONFIG_CACHE_MS };
  return value;
}

async function ttsConfig(): Promise<TtsConfig | null> {
  if (process.env.JARVIS_SELF_HOSTED_TTS === "1") return await selfHostedConfig();
  return { kind: "edge", engine: EDGE_TTS_ENGINE, voice: EDGE_TTS_VOICE };
}

function speechHeaders(config: TtsConfig): HeadersInit {
  return {
    "content-type": "audio/mpeg",
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "x-jarvis-tts-engine": config.engine,
    "x-jarvis-tts-voice": config.voice,
  };
}

async function selfHostedSpeech(config: Extract<TtsConfig, { kind: "self-hosted" }>, text: string, speed: unknown, clientSignal: AbortSignal): Promise<Response> {
  const upstream = new AbortController();
  const abortUpstream = () => upstream.abort();
  const timeout = setTimeout(abortUpstream, SELF_HOSTED_CONNECT_TIMEOUT_MS);
  clientSignal.addEventListener("abort", abortUpstream, { once: true });
  let response: Response;
  try {
    // This bound protects connection / first-byte latency only. Once the
    // upstream has returned an audio stream it is allowed to finish normally.
    response = await fetch(config.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: "kokoro",
        input: text,
        voice: config.voice,
        response_format: "mp3",
        speed: selfHostedSpeed(speed),
        stream_format: "audio",
      }),
      signal: upstream.signal,
      cache: "no-store",
    });
  } finally {
    clearTimeout(timeout);
    clientSignal.removeEventListener("abort", abortUpstream);
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!response.ok || !response.body || !(contentType.startsWith("audio/mpeg") || contentType.startsWith("audio/mp3"))) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("self-hosted speech unavailable");
  }
  return new Response(response.body, { headers: speechHeaders(config) });
}

export async function GET(req: NextRequest) {
  if (!(await authorized(req))) return Response.json({ error: "unauthorized" }, { status: 401 });
  const config = await ttsConfig();
  if (!config) return Response.json({ error: "self-hosted speech is unavailable" }, { status: 503 });
  // The browser calls this while voice is armed and again as a turn starts.
  // Reuse that gesture-time request to open the free Edge speech socket before
  // model text arrives; POST then sends SSML over the already-live connection.
  if (config.kind === "edge") await warmEdgeClient().catch(() => undefined);
  return new Response(null, {
    status: 204,
    headers: {
      "cache-control": "private, no-store",
      "x-jarvis-tts-engine": config.engine,
      "x-jarvis-tts-voice": config.voice,
    },
  });
}

export async function POST(req: NextRequest) {
  if (!(await authorized(req))) return Response.json({ error: "unauthorized" }, { status: 401 });

  const payload = await req.json().catch(() => null) as { text?: unknown; speed?: unknown; pitchHz?: unknown } | null;
  const text = String(payload?.text ?? "").trim();
  if (!text || text.length > 800) {
    return Response.json({ error: "Speech text must contain 1–800 characters" }, { status: 400 });
  }

  const config = await ttsConfig();
  if (!config) return Response.json({ error: "self-hosted speech is unavailable" }, { status: 503 });

  // One selected engine, no cross-provider retry. Explicit self-hosted mode
  // fails closed rather than quietly sending speech to Edge.
  if (config.kind === "self-hosted") {
    try {
      return await selfHostedSpeech(config, text, payload?.speed, req.signal);
    } catch {
      return Response.json({ error: "self-hosted speech is unavailable" }, { status: 502, headers: { "cache-control": "private, no-store" } });
    }
  }

  let tts: MsEdgeTTS | null = null;
  let releaseTts: ((reusable: boolean) => void) | null = null;
  try {
    tts = await acquireEdgeClient();
    const client = tts;
    let released = false;
    releaseTts = (reusable) => {
      if (released) return;
      released = true;
      releaseEdgeClient(client, reusable);
    };
    const { audioStream } = client.toStream(escapeSpeechXml(text), {
      rate: speechRate(payload?.speed),
      pitch: speechPitch(payload?.pitchHz),
      volume: 100,
    });
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const finish = () => {
          if (closed) return;
          closed = true;
          releaseTts?.(true);
          controller.close();
        };
        const fail = (error: Error) => {
          if (closed) return;
          closed = true;
          releaseTts?.(false);
          controller.error(error);
        };
        audioStream.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
        audioStream.once("end", finish);
        audioStream.once("error", fail);
        req.signal.addEventListener("abort", () => {
          audioStream.destroy();
          if (closed) return;
          closed = true;
          releaseTts?.(false);
          try { controller.close(); } catch { /* cancelled response */ }
        }, { once: true });
      },
      cancel() {
        if (closed) return;
        closed = true;
        audioStream.destroy();
        releaseTts?.(false);
      },
    });
    return new Response(stream, { headers: speechHeaders(config) });
  } catch (error) {
    releaseTts?.(false);
    return Response.json(
      { error: String(error).replace(/\s+/g, " ").slice(0, 180) },
      { status: 502, headers: { "cache-control": "private, no-store" } },
    );
  }
}
