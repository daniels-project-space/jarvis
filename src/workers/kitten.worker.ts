/// <reference lib="webworker" />

import { unzipSync } from "fflate";
import * as ort from "onnxruntime-web";
import { phonemize } from "phonemizer";

const MODEL_ROOT = "https://huggingface.co/onnx-community/KittenTTS-Nano-v0.8-ONNX/resolve/main";
const MODEL_URL = `${MODEL_ROOT}/onnx/model.onnx`;
const VOICES_URL = `${MODEL_ROOT}/voices.npz`;
const RUNTIME_ROOT = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.2/dist/";
const MODEL_CACHE = "jarvis-kitten-nano-v0.8-fp32";
const SAMPLE_RATE = 24_000;
const VOICE = "Jasper";

const SPEED_PRIORS: Record<string, number> = {
  "expr-voice-2-f": 0.8,
  "expr-voice-2-m": 0.8,
  "expr-voice-3-m": 0.8,
  "expr-voice-3-f": 0.8,
  "expr-voice-4-m": 0.9,
  "expr-voice-4-f": 0.8,
  "expr-voice-5-m": 0.8,
  "expr-voice-5-f": 0.8,
};

const VOICE_ALIASES: Record<string, string> = {
  Bella: "expr-voice-2-f",
  Jasper: "expr-voice-2-m",
  Luna: "expr-voice-3-f",
  Bruno: "expr-voice-3-m",
  Rosie: "expr-voice-4-f",
  Hugo: "expr-voice-4-m",
  Kiki: "expr-voice-5-f",
  Leo: "expr-voice-5-m",
};

type Request =
  | { type: "warm"; forceWasm?: boolean }
  | { type: "synthesize"; id: number; text: string; speed: number };

type Device = "webgpu" | "wasm";
type VoiceInfo = { data: Float32Array; rows: number; columns: number };

let session: ort.InferenceSession | null = null;
let modelData: ArrayBuffer | null = null;
let voices: Record<string, VoiceInfo> | null = null;
let selectedDevice: Device = "wasm";
let forceCpu = false;
let loadPromise: Promise<void> | null = null;

// Next may emit this module as a blob worker. ONNX Runtime occasionally hands
// fetch an origin-relative WASM URL, which cannot be resolved against blob:.
// Normalise only those URLs; model and runtime CDN requests remain untouched.
const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  const resolved = typeof input === "string" && input.startsWith("/")
    ? new URL(input, self.location.origin).toString()
    : input;
  return nativeFetch(resolved, init);
};

function progress(status: string, loaded = 0, total = 0) {
  self.postMessage({
    type: "progress",
    status,
    progress: total > 0 ? (loaded / total) * 100 : null,
    file: status,
  });
}

async function fetchBinary(url: string, label: string): Promise<ArrayBuffer> {
  try {
    const cache = await caches.open(MODEL_CACHE);
    const cached = await cache.match(url);
    if (cached) return cached.arrayBuffer();
  } catch {
    // Cache Storage is an optimisation; private browsing can disable it.
  }

  const response = await nativeFetch(url, { cache: "force-cache" });
  if (!response.ok) throw new Error(`${label} download failed (${response.status})`);
  try {
    const cache = await caches.open(MODEL_CACHE);
    await cache.put(url, response.clone());
  } catch {
    // The HTTP cache still prevents repeated full downloads in most browsers.
  }

  const total = Number(response.headers.get("content-length")) || 0;
  if (!response.body) return response.arrayBuffer();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    progress(`loading ${label}`, loaded, total);
  }
  const joined = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined.buffer;
}

function readNpy(bytes: Uint8Array): VoiceInfo {
  if (bytes[0] !== 0x93 || new TextDecoder().decode(bytes.slice(1, 6)) !== "NUMPY") {
    throw new Error("Kitten voice archive contains an invalid NPY file");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const major = bytes[6];
  const headerOffset = major === 1 ? 10 : 12;
  const headerLength = major === 1 ? view.getUint16(8, true) : view.getUint32(8, true);
  const header = new TextDecoder().decode(bytes.slice(headerOffset, headerOffset + headerLength));
  const dtype = header.match(/['"]descr['"]\s*:\s*['"]([^'"]+)['"]/)?.[1];
  const shape = header.match(/['"]shape['"]\s*:\s*\(([^)]*)\)/)?.[1]
    .split(",")
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter(Number.isFinite) ?? [];
  const raw = bytes.slice(headerOffset + headerLength);
  const aligned = raw.slice().buffer;
  let data: Float32Array;
  if (dtype === "<f4" || dtype === "|f4") {
    data = new Float32Array(aligned);
  } else if (dtype === "<f8" || dtype === "|f8") {
    const source = new Float64Array(aligned);
    data = Float32Array.from(source);
  } else {
    throw new Error(`Unsupported Kitten voice dtype: ${dtype ?? "unknown"}`);
  }
  const rows = shape[0] || 1;
  const columns = shape[1] || Math.floor(data.length / rows);
  return { data, rows, columns };
}

function parseVoices(buffer: ArrayBuffer): Record<string, VoiceInfo> {
  const files = unzipSync(new Uint8Array(buffer));
  const parsed: Record<string, VoiceInfo> = {};
  for (const [name, bytes] of Object.entries(files)) {
    if (!name.endsWith(".npy")) continue;
    parsed[name.replace(/\.npy$/, "")] = readNpy(bytes);
  }
  if (!Object.keys(parsed).length) throw new Error("Kitten voice archive was empty");
  return parsed;
}

async function hasRealWebGpu(): Promise<boolean> {
  if (forceCpu) return false;
  const gpu = (navigator as Navigator & {
    gpu?: { requestAdapter(options?: { powerPreference?: string }): Promise<{
      isFallbackAdapter?: boolean;
      info?: { vendor?: string; architecture?: string; device?: string; description?: string };
    } | null> };
  }).gpu;
  if (!gpu) return false;
  try {
    const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
    const info = adapter?.info;
    const description = `${info?.vendor ?? ""} ${info?.architecture ?? ""} ${info?.device ?? ""} ${info?.description ?? ""}`;
    return Boolean(adapter && !adapter.isFallbackAdapter && !/swiftshader|software|llvmpipe/i.test(description));
  } catch {
    return false;
  }
}

async function createSession(device: Device): Promise<ort.InferenceSession> {
  if (!modelData) throw new Error("Kitten model is not downloaded");
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = RUNTIME_ROOT;
  return ort.InferenceSession.create(modelData, {
    executionProviders: [device],
    graphOptimizationLevel: "all",
  });
}

async function load(): Promise<void> {
  if (session && voices) return;
  if (!loadPromise) {
    loadPromise = (async () => {
      progress("loading KittenTTS");
      const [model, voiceArchive] = await Promise.all([
        modelData ? Promise.resolve(modelData) : fetchBinary(MODEL_URL, "KittenTTS"),
        voices ? Promise.resolve(null) : fetchBinary(VOICES_URL, "Jasper voice"),
      ]);
      modelData = model;
      if (voiceArchive) voices = parseVoices(voiceArchive);
      selectedDevice = await hasRealWebGpu() ? "webgpu" : "wasm";
      try {
        session = await createSession(selectedDevice);
      } catch (error) {
        if (selectedDevice === "wasm") throw error;
        forceCpu = true;
        selectedDevice = "wasm";
        session = await createSession("wasm");
      }
    })().catch((error) => {
      loadPromise = null;
      session = null;
      throw error;
    });
  }
  await loadPromise;
}

const PAD = "$";
const PUNCTUATION = ';:,.!?¡¿—…"“”«» ';
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const IPA = "ɑɐɒæɓʙβɔɕçɗɖðʤəɘɚɛɜɝɞɟʄɡɠɢʛɦɧħɥʜɨɪʝɭɬɫɮʟɱɯɰŋɳɲɴøɵɸθœɶʘɹɺɾɻʀʁɽʂʃʈʧʉʊʋⱱʌɣɤʍχʎʏʑʐʒʔʡʕʢǀǁǂǃˈˌːˑʼʴʰʱʲʷˠˤ˞↓↑→↗↘'̩ᵻ";
const SYMBOLS = [PAD, ...PUNCTUATION, ...LETTERS, ...IPA];
const TOKEN_BY_CHARACTER = new Map(SYMBOLS.map((character, index) => [character, index]));

function tokenise(phonemes: string): bigint[] {
  const tokens = [...phonemes]
    .map((character) => TOKEN_BY_CHARACTER.get(character))
    .filter((value): value is number => value !== undefined);
  return [0, ...tokens, 10, 0].map(BigInt);
}

async function phonemeIds(text: string): Promise<bigint[]> {
  const punctuation = /(\s*[;:,.!?¡¿—…"“”«»()\[\]{}]+\s*)+/g;
  const sections: Array<{ punctuation: boolean; text: string }> = [];
  let cursor = 0;
  for (const match of text.matchAll(punctuation)) {
    const index = match.index ?? cursor;
    if (cursor < index) sections.push({ punctuation: false, text: text.slice(cursor, index) });
    sections.push({ punctuation: true, text: match[0] });
    cursor = index + match[0].length;
  }
  if (cursor < text.length) sections.push({ punctuation: false, text: text.slice(cursor) });
  const parts = await Promise.all(sections.map(async (section) => {
    if (section.punctuation) return section.text;
    return (await phonemize(section.text, "en-us")).join(" ");
  }));
  const phonemes = parts.join("");
  const wordsAndMarks = phonemes.match(/[\p{L}\p{N}_]+|[^\p{L}\p{N}_\s]/gu) ?? [];
  return tokenise(wordsAndMarks.join(" "));
}

async function synthesize(text: string, speed: number): Promise<Float32Array> {
  await load();
  if (!session || !voices) throw new Error("KittenTTS did not initialise");
  const voiceId = VOICE_ALIASES[VOICE];
  const voice = voices[voiceId];
  if (!voice) throw new Error(`KittenTTS voice ${VOICE} is unavailable`);
  const ids = await phonemeIds(text);
  const referenceRow = Math.min(text.length, voice.rows - 1);
  const style = voice.data.slice(referenceRow * voice.columns, (referenceRow + 1) * voice.columns);
  const inputs = {
    input_ids: new ort.Tensor("int64", BigInt64Array.from(ids), [1, ids.length]),
    style: new ort.Tensor("float32", style, [1, voice.columns]),
    speed: new ort.Tensor("float32", new Float32Array([speed * (SPEED_PRIORS[voiceId] ?? 1)]), [1]),
  };

  const run = async () => {
    if (!session) throw new Error("KittenTTS session was released");
    const output = await session.run(inputs);
    const tensor = output[session.outputNames[0]];
    const pcm = tensor.data instanceof Float32Array ? tensor.data : Float32Array.from(tensor.data as ArrayLike<number>);
    if (!pcm.length || !Number.isFinite(pcm[0])) throw new Error(`${selectedDevice} produced invalid KittenTTS audio`);
    return pcm.length > SAMPLE_RATE ? pcm.slice(0, -5_000) : pcm.slice();
  };

  try {
    return await run();
  } catch (error) {
    if (selectedDevice === "wasm") throw error;
    session.release();
    forceCpu = true;
    selectedDevice = "wasm";
    session = await createSession("wasm");
    self.postMessage({ type: "ready", engine: "kitten-nano-fp32-wasm-jasper" });
    return run();
  }
}

self.onmessage = async (event: MessageEvent<Request>) => {
  const request = event.data;
  if (request.type === "warm") {
    if (request.forceWasm) forceCpu = true;
    try {
      await load();
      self.postMessage({ type: "ready", engine: `kitten-nano-fp32-${selectedDevice}-jasper` });
    } catch (error) {
      self.postMessage({ type: "error", id: null, message: String(error) });
    }
    return;
  }
  try {
    const audio = await synthesize(request.text, request.speed);
    self.postMessage(
      { type: "audio", id: request.id, sampleRate: SAMPLE_RATE, audio: audio.buffer },
      [audio.buffer],
    );
  } catch (error) {
    self.postMessage({ type: "error", id: request.id, message: String(error) });
  }
};
