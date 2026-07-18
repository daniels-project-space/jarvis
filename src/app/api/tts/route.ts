import type { NextRequest } from "next/server";
import { EdgeTTS } from "@andresaya/edge-tts";

export const runtime = "nodejs";
export const preferredRegion = "lhr1";
export const maxDuration = 20;

const VOICE = "en-GB-RyanNeural";

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const text = String(url.searchParams.get("text") ?? "").replace(/\s+/g, " ").trim().slice(0, 700);
  const speed = Math.min(1.16, Math.max(0.9, Number(url.searchParams.get("speed")) || 1.04));
  if (!text) return Response.json({ error: "text is required" }, { status: 400 });

  const tts = new EdgeTTS();
  const iterator = tts.synthesizeStream(text, VOICE, {
    rate: `${Math.round((speed - 1) * 100)}%`,
    pitch: "-2Hz",
    volume: "0%",
    outputFormat: "audio-24khz-48kbitrate-mono-mp3",
  })[Symbol.asyncIterator]();

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await iterator.next();
        if (result.done) controller.close();
        else controller.enqueue(result.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "audio/mpeg",
      "cache-control": "private, no-store, max-age=0",
      "x-content-type-options": "nosniff",
      "x-jarvis-voice": "neural-ryan-stream",
    },
  });
}

export async function POST() {
  return Response.json({ error: "Use the streaming speech route." }, { status: 405 });
}
