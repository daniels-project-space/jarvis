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

type Engine = {
  device: "webgpu" | "wasm";
  dtype: "fp32" | "q8";
  label: string;
};

type LoadedModel = { tts: KokoroTTS; engine: Engine };

const WASM_ENGINE: Engine = {
  device: "wasm",
  dtype: "q8",
  label: "kokoro-q8-wasm-george",
};

let forceWasm = false;
let modelPromise: Promise<LoadedModel> | null = null;

async function preferredEngine(): Promise<Engine> {
  if (forceWasm) return WASM_ENGINE;
  const gpu = (globalThis as typeof globalThis & {
    navigator?: {
      gpu?: {
        requestAdapter(options?: { powerPreference?: string }): Promise<{
          isFallbackAdapter?: boolean;
          info?: { vendor?: string; architecture?: string; device?: string };
        } | null>;
      };
    };
  }).navigator?.gpu;
  if (!gpu) return WASM_ENGINE;
  try {
    const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
    const description = `${adapter?.info?.vendor ?? ""} ${adapter?.info?.architecture ?? ""} ${adapter?.info?.device ?? ""}`;
    if (!adapter || adapter.isFallbackAdapter || /swiftshader|software|llvmpipe/i.test(description)) {
      return WASM_ENGINE;
    }
    // Transformers.js 3 recommends fp32 for WebGPU. This is the same Kokoro
    // model and George voice at higher precision, not a second/fallback voice.
    return {
      device: "webgpu",
      dtype: "fp32",
      label: "kokoro-fp32-webgpu-george",
    };
  } catch {
    return WASM_ENGINE;
  }
}

function loadModel(): Promise<LoadedModel> {
  if (!modelPromise) {
    modelPromise = (async () => {
      const selected = await preferredEngine();
      const create = async (engine: Engine) => ({
        tts: await KokoroTTS.from_pretrained(MODEL, {
          dtype: engine.dtype,
          device: engine.device,
          progress_callback: (progress: Progress) => {
            self.postMessage({
              type: "progress",
              status: progress.status ?? "loading",
              progress: typeof progress.progress === "number" ? progress.progress : null,
              file: progress.file ?? null,
            });
          },
        }),
        engine,
      });
      try {
        return await create(selected);
      } catch (error) {
        if (selected.device === "wasm") throw error;
        forceWasm = true;
        return create(WASM_ENGINE);
      }
    })().catch((error) => {
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
      const { engine } = await loadModel();
      self.postMessage({ type: "ready", engine: engine.label });
    } catch (error) {
      self.postMessage({ type: "error", id: null, message: String(error) });
    }
    return;
  }

  try {
    let loaded = await loadModel();
    let result: Awaited<ReturnType<KokoroTTS["generate"]>>;
    try {
      result = await loaded.tts.generate(request.text, {
        voice: VOICE,
        speed: request.speed,
      });
    } catch (error) {
      // A browser can advertise WebGPU and still reject a model operator only
      // when inference begins. Recover inside this same Kokoro worker using the
      // q8 CPU build, then publish the actual active engine to the UI.
      if (loaded.engine.device === "wasm") throw error;
      forceWasm = true;
      modelPromise = null;
      loaded = await loadModel();
      self.postMessage({ type: "ready", engine: loaded.engine.label });
      result = await loaded.tts.generate(request.text, {
        voice: VOICE,
        speed: request.speed,
      });
    }
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
