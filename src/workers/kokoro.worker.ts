import { KokoroTTS } from "kokoro-js";

type WorkerRequest =
  | { id: number; type: "warm" }
  | { id: number; type: "generate"; text: string; speed: number; voice: "bm_george" | "bf_emma" | "af_heart" | "bm_fable" };

type WorkerResponse =
  | { id: number; type: "ready" }
  | { id: number; type: "audio"; blob: Blob }
  | { id: number; type: "error"; message: string };

type KokoroEngine = Awaited<ReturnType<typeof KokoroTTS.from_pretrained>>;

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (message: WorkerResponse) => void;
};

let enginePromise: Promise<KokoroEngine> | null = null;

function loadEngine() {
  if (!enginePromise) {
    enginePromise = KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
      dtype: "q8",
      device: "wasm",
    });
  }
  return enginePromise;
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
      const audio = await engine.generate(request.text, {
        voice: request.voice,
        speed: request.speed,
      });
      scope.postMessage({ id: request.id, type: "audio", blob: audio.toBlob() });
    } catch (error) {
      scope.postMessage({
        id: request.id,
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })();
};
