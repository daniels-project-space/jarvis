"use client";
// Always-on conversation: Silero VAD (via @ricky0123/vad-web) listens continuously,
// transcribes each utterance through Groq Whisper (/api/stt), and submits it. When
// JARVIS is speaking and Daniel talks, TTS is cut (barge-in). Half-duplex otherwise.
import { stopSpeaking, warm } from "./tts";

let vad: any = null;
let running = false;

// Silero emits 16 kHz mono Float32 — wrap it as a WAV for the STT endpoint.
function floatToWav(float32: Float32Array, sampleRate = 16000): Blob {
  const buffer = new ArrayBuffer(44 + float32.length * 2);
  const view = new DataView(buffer);
  const w = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  w(0, "RIFF");
  view.setUint32(4, 36 + float32.length * 2, true);
  w(8, "WAVE");
  w(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  w(36, "data");
  view.setUint32(40, float32.length * 2, true);
  let o = 44;
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    o += 2;
  }
  return new Blob([view], { type: "audio/wav" });
}

export function isLiveVoiceOn() {
  return running;
}

export async function startLiveVoice(opts: {
  onTranscript: (text: string) => void;
  onState: (s: "listening" | "thinking" | "off") => void;
  isSpeaking: () => boolean;
}) {
  if (running) return;
  await warm();
  const { MicVAD } = await import("@ricky0123/vad-web");
  vad = await MicVAD.new({
    // pin the onnxruntime wasm to 1.17.0 — newer builds OOM on iOS Safari
    onnxWASMBasePath: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.0/dist/",
    baseAssetPath: "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@latest/dist/",
    positiveSpeechThreshold: 0.6,
    onSpeechStart: () => {
      if (opts.isSpeaking()) stopSpeaking(); // barge-in
    },
    onSpeechEnd: async (audio: Float32Array) => {
      if (audio.length < 16000 * 0.4) return; // ignore < ~0.4s blips
      opts.onState("thinking");
      try {
        const wav = floatToWav(audio, 16000);
        const r = await fetch("/api/stt", {
          method: "POST",
          headers: { "content-type": "audio/wav" },
          body: wav,
        });
        const { text } = await r.json();
        if (text && text.trim().length > 1) opts.onTranscript(text.trim());
      } catch {
        /* ignore */
      }
      if (running) opts.onState("listening");
    },
  });
  vad.start();
  running = true;
  opts.onState("listening");
}

export function stopLiveVoice(onState?: (s: "off") => void) {
  try {
    vad?.pause?.();
    vad?.destroy?.();
  } catch {
    /* ignore */
  }
  vad = null;
  running = false;
  onState?.("off");
}
