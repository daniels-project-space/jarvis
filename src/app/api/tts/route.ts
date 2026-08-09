import type { NextRequest } from "next/server";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { isSameOriginRequest } from "@/lib/control-session";
import { controlActor } from "@/lib/request-auth";
import { JARVIS_TTS_ENGINE, JARVIS_TTS_VOICE } from "@/lib/tts-config";

export const runtime = "nodejs";
export const maxDuration = 15;

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

function speechPitch(value: unknown): string {
  const pitch = Math.min(5, Math.max(1, Number(value) || 3));
  return `+${Math.round(pitch)}Hz`;
}

async function authorized(req: NextRequest): Promise<boolean> {
  return isSameOriginRequest(req) && Boolean(await controlActor(req));
}

export async function GET(req: NextRequest) {
  if (!(await authorized(req))) return Response.json({ error: "unauthorized" }, { status: 401 });
  return new Response(null, {
    status: 204,
    headers: {
      "cache-control": "private, no-store",
      "x-jarvis-tts-engine": JARVIS_TTS_ENGINE,
      "x-jarvis-tts-voice": JARVIS_TTS_VOICE,
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

  // There is intentionally one production voice identity and one free,
  // streamed cloud engine. A failed request surfaces as a 502; it never waits
  // for a second engine or replays the phrase through a fallback chain.
  const tts = new MsEdgeTTS();
  try {
    await tts.setMetadata(JARVIS_TTS_VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(escapeSpeechXml(text), {
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
          tts.close();
          controller.close();
        };
        const fail = (error: Error) => {
          if (closed) return;
          closed = true;
          tts.close();
          controller.error(error);
        };
        audioStream.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
        audioStream.once("end", finish);
        audioStream.once("error", fail);
        req.signal.addEventListener("abort", () => {
          audioStream.destroy();
          finish();
        }, { once: true });
      },
      cancel() {
        closed = true;
        audioStream.destroy();
        tts.close();
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "audio/mpeg",
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "x-jarvis-tts-engine": JARVIS_TTS_ENGINE,
        "x-jarvis-tts-voice": JARVIS_TTS_VOICE,
      },
    });
  } catch (error) {
    tts.close();
    return Response.json(
      { error: String(error).replace(/\s+/g, " ").slice(0, 180) },
      { status: 502, headers: { "cache-control": "private, no-store" } },
    );
  }
}
