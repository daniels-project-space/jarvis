import * as ort from "onnxruntime-web/webgpu";
import { phonemize } from "phonemizer";

type WorkerRequest =
  | { id: number; type: "warm" }
  | { id: number; type: "generate"; text: string; speed: number };

type WorkerResponse =
  | { id: number; type: "ready" }
  | { id: number; type: "audio"; blob: Blob }
  | { id: number; type: "error"; message: string };

const MODEL_ROOT = "https://huggingface.co/onnx-community/kitten-tts-nano-0.1-ONNX/resolve/main";
const MODEL_URL = `${MODEL_ROOT}/onnx/model_quantized.onnx`;
const TOKENIZER_URL = `${MODEL_ROOT}/tokenizer.json`;
// Jasper is the expressive male voice recommended by KittenTTS and is the one
// stable Jarvis identity. There is deliberately no per-device voice selector.
const VOICE_URL = `${MODEL_ROOT}/voices/expr-voice-2-m.bin`;
const SAMPLE_RATE = 24_000;

type Engine = {
  session: ort.InferenceSession;
  wasmSession: ort.InferenceSession | null;
  model: ArrayBuffer;
  vocab: Record<string, number>;
  style: Float32Array;
  backend: "webgpu" | "wasm";
};

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (message: WorkerResponse) => void;
  navigator?: { gpu?: unknown };
  crossOriginIsolated?: boolean;
};

ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/";
ort.env.wasm.numThreads = scope.crossOriginIsolated ? 2 : 1;

let enginePromise: Promise<Engine> | null = null;

async function fetchOk(url: string): Promise<Response> {
  const response = await fetch(url, { cache: "force-cache" });
  if (!response.ok) throw new Error(`TTS asset ${response.status}`);
  return response;
}

async function createSession(model: ArrayBuffer, backend: "webgpu" | "wasm") {
  return ort.InferenceSession.create(model.slice(0), {
    executionProviders: backend === "webgpu" ? ["webgpu", "wasm"] : ["wasm"],
    graphOptimizationLevel: "all",
  });
}

async function loadEngine(): Promise<Engine> {
  if (!enginePromise) {
    enginePromise = (async () => {
      const [modelResponse, tokenizerResponse, voiceResponse] = await Promise.all([
        fetchOk(MODEL_URL),
        fetchOk(TOKENIZER_URL),
        fetchOk(VOICE_URL),
      ]);
      const [model, tokenizer, voiceBuffer] = await Promise.all([
        modelResponse.arrayBuffer(),
        tokenizerResponse.json() as Promise<{ model: { vocab: Record<string, number> } }>,
        voiceResponse.arrayBuffer(),
      ]);
      let backend: "webgpu" | "wasm" = scope.navigator?.gpu ? "webgpu" : "wasm";
      let session: ort.InferenceSession;
      try {
        session = await createSession(model, backend);
      } catch {
        backend = "wasm";
        session = await createSession(model, backend);
      }
      return {
        session,
        wasmSession: backend === "wasm" ? session : null,
        model,
        vocab: tokenizer.model.vocab,
        style: new Float32Array(voiceBuffer),
        backend,
      };
    })();
  }
  return enginePromise;
}

function cleanText(text: string): string {
  return text
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

async function tokenIds(text: string, vocab: Record<string, number>): Promise<BigInt64Array> {
  const lines = await phonemize(cleanText(text), "en-us");
  const phonemes = lines.join(" ");
  return new BigInt64Array(`$${phonemes}$`.split("").map((char) => BigInt(vocab[char] ?? 0)));
}

async function run(engine: Engine, ids: BigInt64Array, speed: number, forceWasm = false) {
  if (forceWasm && !engine.wasmSession) engine.wasmSession = await createSession(engine.model, "wasm");
  const session = forceWasm ? engine.wasmSession! : engine.session;
  return session.run({
    input_ids: new ort.Tensor("int64", ids, [1, ids.length]),
    style: new ort.Tensor("float32", engine.style, [1, engine.style.length]),
    speed: new ort.Tensor("float32", new Float32Array([speed]), [1]),
  });
}

function validAudio(value: unknown): value is Float32Array {
  if (!(value instanceof Float32Array) || value.length === 0) return false;
  const stride = Math.max(1, Math.floor(value.length / 32));
  for (let index = 0; index < value.length; index += stride) {
    if (!Number.isFinite(value[index])) return false;
  }
  return true;
}

function encodeWav(samples: Float32Array): Blob {
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  const gain = peak > 0 && peak < 0.14 ? Math.min(4, 0.65 / peak) : 1;
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const write = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index));
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index++) {
    const sample = Math.max(-1, Math.min(1, samples[index] * gain));
    view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

scope.onmessage = (event) => {
  const request = event.data;
  void (async () => {
    try {
      const engine = await loadEngine();
      if (request.type === "warm") {
        scope.postMessage({ id: request.id, type: "ready" });
        return;
      }
      const ids = await tokenIds(request.text, engine.vocab);
      let outputs = await run(engine, ids, request.speed);
      let waveform = outputs.waveform?.data;
      if (!validAudio(waveform) && engine.backend === "webgpu") {
        outputs = await run(engine, ids, request.speed, true);
        waveform = outputs.waveform?.data;
      }
      if (!validAudio(waveform)) throw new Error("TTS produced invalid audio");
      scope.postMessage({ id: request.id, type: "audio", blob: encodeWav(waveform) });
    } catch (error) {
      scope.postMessage({
        id: request.id,
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })();
};
