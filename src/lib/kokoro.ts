"use client";
// Open-source TTS: Kokoro-82M (Apache-2.0) fully in-browser via kokoro-js.
// $0, no API, en-GB male "butler" voice, drives the orb from audio amplitude.

let ttsPromise: Promise<any> | null = null;
let audioCtx: AudioContext | null = null;

async function getTTS() {
  if (!ttsPromise) {
    const { KokoroTTS } = await import("kokoro-js");
    const device = typeof navigator !== "undefined" && (navigator as any).gpu ? "webgpu" : "wasm";
    ttsPromise = KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
      dtype: "q8",
      device,
    }).catch((e: unknown) => {
      ttsPromise = null;
      throw e;
    });
  }
  return ttsPromise;
}

// Call on a user gesture (send/mic) to satisfy autoplay + pre-warm the model.
export async function warm() {
  try {
    if (!audioCtx) audioCtx = new AudioContext();
    await audioCtx.resume();
    void getTTS();
  } catch {
    /* ignore */
  }
}

// Speak `text`, driving onEnergy(0..1) from live amplitude. Resolves when done.
export async function speak(
  text: string,
  onEnergy: (e: number) => void,
  onStart?: () => void,
  onEnd?: () => void,
): Promise<void> {
  try {
    const tts = await getTTS();
    const audio = await tts.generate(text.slice(0, 800), { voice: "bm_george" });
    const arr = await audio.toBlob().arrayBuffer();
    if (!audioCtx) audioCtx = new AudioContext();
    await audioCtx.resume();
    const decoded = await audioCtx.decodeAudioData(arr);
    const src = audioCtx.createBufferSource();
    src.buffer = decoded;
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);
    analyser.connect(audioCtx.destination);
    const data = new Uint8Array(analyser.frequencyBinCount);
    let playing = true;
    const tick = () => {
      if (!playing) return;
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const v of data) {
        const n = (v - 128) / 128;
        sum += n * n;
      }
      onEnergy(Math.min(1, Math.sqrt(sum / data.length) * 3));
      requestAnimationFrame(tick);
    };
    src.onended = () => {
      playing = false;
      onEnergy(0);
      onEnd?.();
    };
    onStart?.();
    src.start();
    tick();
  } catch (e) {
    console.error("kokoro speak failed", e);
    onEnergy(0);
    onEnd?.();
  }
}
