/// <reference lib="webworker" />

import { KokoroTTS } from "kokoro-js";

const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
const VOICE = "bm_george";

type Request =
  | { type: "warm" }
  | { type: "synthesize"; id: number; text: string; speed: number };

type Progress = {
  status?: string;
  progress?: number;
  file?: string;
};

let modelPromise: Promise<KokoroTTS> | null = null;

function loadModel(): Promise<KokoroTTS> {
  if (!modelPromise) {
    modelPromise = KokoroTTS.from_pretrained(MODEL, {
      dtype: "q8",
      device: "wasm",
      progress_callback: (progress: Progress) => {
        self.postMessage({
          type: "progress",
          status: progress.status ?? "loading",
          progress: typeof progress.progress === "number" ? progress.progress : null,
          file: progress.file ?? null,
        });
      },
    }).catch((error) => {
      modelPromise = null;
      throw error;
    });
  }
  return modelPromise;
}

self.onmessage = async (event: MessageEvent<Request>) => {
  const request = event.data;
  if (request.type === "warm") {
    try {
      await loadModel();
      self.postMessage({ type: "ready" });
    } catch (error) {
      self.postMessage({ type: "error", id: null, message: String(error) });
    }
    return;
  }

  try {
    const tts = await loadModel();
    const result = await tts.generate(request.text, {
      voice: VOICE,
      speed: request.speed,
    });
    const audio = result.audio instanceof Float32Array
      ? result.audio
      : new Float32Array(result.audio);
    self.postMessage(
      {
        type: "audio",
        id: request.id,
        sampleRate: result.sampling_rate,
        audio: audio.buffer,
      },
      [audio.buffer],
    );
  } catch (error) {
    self.postMessage({ type: "error", id: request.id, message: String(error) });
  }
};

