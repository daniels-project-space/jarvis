"use client";

// Jarvis has one audible identity: KittenTTS Jasper, generated locally in a
// worker. Never fall back to Web Speech — doing so made one reply sound like
// two people and allowed a robotic voice to race the neural one.

type KittenWorkerRequest =
  | { id: number; type: "warm" }
  | { id: number; type: "generate"; text: string; speed: number };
type KittenWorkerPayload =
  | { type: "warm" }
  | { type: "generate"; text: string; speed: number };
type KittenWorkerResponse =
  | { id: number; type: "ready" }
  | { id: number; type: "audio"; blob: Blob }
  | { id: number; type: "error"; message: string };
type KittenWorkerResult = { ok: true; blob?: Blob } | { ok: false };

type SpeechBatch = {
  generation: number;
  text: string;
  segments: string[];
  onEnergy: (energy: number) => void;
  onStart?: () => void;
  onEnd?: () => void;
  resolve: () => void;
};

let generation = 0;
let draining = false;
let currentAudio: HTMLAudioElement | null = null;
let stopAudioPlayback: (() => void) | null = null;
let queue: SpeechBatch[] = [];
let activeBatch: SpeechBatch | null = null;
let kittenWorker: Worker | null = null;
let kittenReady = false;
let kittenLoading: Promise<boolean> | null = null;
let kittenRequestId = 0;
const kittenPending = new Map<number, { resolve: (result: KittenWorkerResult) => void }>();

type Recent = { text: string; until: number };
let recentUtterances: Recent[] = [];

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 1);

function trackUtterance(text: string, durationMs: number) {
  const now = Date.now();
  recentUtterances = recentUtterances.filter((row) => row.until > now);
  recentUtterances.push({ text, until: now + durationMs + 5_000 });
}

export function isEchoOfTts(input: string): boolean {
  const now = Date.now();
  recentUtterances = recentUtterances.filter((row) => row.until > now);
  const inputWords = words(input);
  if (inputWords.length < 3) return false;
  for (const row of recentUtterances) {
    const spoken = new Set(words(row.text));
    if (!spoken.size) continue;
    const matches = inputWords.filter((word) => spoken.has(word)).length;
    if (matches / inputWords.length >= 0.65) return true;
  }
  return false;
}

function setTtsStatus(status: "warming" | "ready" | "generating" | "speaking" | "idle" | "unavailable") {
  if (typeof document !== "undefined") {
    document.documentElement.dataset.jarvisTts = status;
    document.documentElement.dataset.jarvisTtsEngine = "kitten-jasper";
  }
}

function failKittenWorker() {
  kittenReady = false;
  kittenWorker?.terminate();
  kittenWorker = null;
  for (const pending of kittenPending.values()) pending.resolve({ ok: false });
  kittenPending.clear();
  setTtsStatus("unavailable");
}

function getKittenWorker() {
  if (kittenWorker) return kittenWorker;
  const worker = new Worker(new URL("../workers/kitten.worker.ts", import.meta.url), {
    type: "module",
    name: "jarvis-kitten-jasper",
  });
  worker.onmessage = (event: MessageEvent<KittenWorkerResponse>) => {
    const response = event.data;
    const pending = kittenPending.get(response.id);
    if (!pending) return;
    kittenPending.delete(response.id);
    if (response.type === "ready") {
      kittenReady = true;
      setTtsStatus("ready");
      pending.resolve({ ok: true });
    } else if (response.type === "audio") {
      pending.resolve({ ok: true, blob: response.blob });
    } else {
      pending.resolve({ ok: false });
    }
  };
  worker.onerror = failKittenWorker;
  worker.onmessageerror = failKittenWorker;
  kittenWorker = worker;
  return worker;
}

function askKittenWorker(request: KittenWorkerPayload): Promise<KittenWorkerResult> {
  const id = ++kittenRequestId;
  return new Promise((resolve) => {
    kittenPending.set(id, { resolve });
    try {
      getKittenWorker().postMessage({ ...request, id } as KittenWorkerRequest);
    } catch {
      kittenPending.delete(id);
      resolve({ ok: false });
      failKittenWorker();
    }
  });
}

async function prepareKitten(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  if (kittenReady) return true;
  if (kittenLoading) return kittenLoading;
  setTtsStatus("warming");
  kittenLoading = askKittenWorker({ type: "warm" })
    .then((result) => result.ok)
    .catch(() => false)
    .finally(() => {
      kittenLoading = null;
    });
  return kittenLoading;
}

// Model download/initialisation starts on Jarvis mount. It runs in a worker,
// so delaying it until after a message only created a long silent gap without
// protecting the UI thread.
export async function warm(): Promise<void> {
  await prepareKitten();
}

export function stopSpeaking() {
  generation++;
  const abandoned = queue;
  queue = [];
  for (const batch of abandoned) batch.resolve();
  stopAudioPlayback?.();
  stopAudioPlayback = null;
  currentAudio = null;
  setTtsStatus(kittenReady ? "ready" : "warming");
  void import("./wakeword").then((module) => module.setSuppressed?.(false)).catch(() => {});
}

export function isSpeaking() {
  return draining || Boolean(currentAudio);
}

export function sentences(text: string): string[] {
  const result: string[] = [];
  let buffer = "";
  for (const part of text.split(/(?<=[.!?])\s+(?=[A-Z0-9£"'])/)) {
    buffer = buffer ? `${buffer} ${part}` : part;
    if (buffer.length >= 24) {
      result.push(buffer);
      buffer = "";
    }
  }
  if (buffer.trim()) result.push(buffer);
  return result;
}

function speechSpeed(text: string): number {
  const tone = text.toLowerCase();
  if (/\b(urgent|careful|risk|serious|honestly|numbers|weak plan)\b/.test(tone)) return 0.95;
  if (/\b(sorry|rough|tired|stressed|gentle|here with you)\b/.test(tone)) return 0.93;
  if (/\b(ha|haha|brilliant|lets go|let's go|excited|love it)\b/.test(tone)) return 1.07;
  return 1.01;
}

function energyLoop(expectedGeneration: number, onEnergy: (energy: number) => void) {
  const startedAt = performance.now();
  return setInterval(() => {
    if (expectedGeneration !== generation) return;
    const phase = (performance.now() - startedAt) / 125;
    onEnergy(Math.min(1, 0.25 + 0.34 * Math.abs(Math.sin(phase))));
  }, 60);
}

async function generateSegment(text: string, expectedGeneration: number): Promise<Blob | null> {
  if (expectedGeneration !== generation) return null;
  setTtsStatus("generating");
  const result = await askKittenWorker({
    type: "generate",
    text,
    speed: speechSpeed(text),
  });
  return result.ok && result.blob ? result.blob : null;
}

function playSegment(
  blob: Blob,
  expectedGeneration: number,
  onEnergy: (energy: number) => void,
  onStart?: () => void,
): Promise<boolean> {
  if (expectedGeneration !== generation) return Promise.resolve(false);
  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(blob);
    const audio = new Audio(objectUrl);
    currentAudio = audio;
    let timer: ReturnType<typeof setInterval> | null = null;
    let settled = false;
    const finish = (played: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearInterval(timer);
      if (currentAudio === audio) currentAudio = null;
      if (stopAudioPlayback === stop) stopAudioPlayback = null;
      URL.revokeObjectURL(objectUrl);
      audio.removeAttribute("src");
      onEnergy(0);
      resolve(played);
    };
    const stop = () => {
      audio.pause();
      finish(false);
    };
    stopAudioPlayback = stop;
    audio.onplay = () => {
      if (expectedGeneration !== generation) return stop();
      setTtsStatus("speaking");
      onStart?.();
      timer = energyLoop(expectedGeneration, onEnergy);
    };
    audio.onended = () => finish(true);
    audio.onerror = () => finish(false);
    void audio.play().catch(() => finish(false));
  });
}

export async function speak(
  text: string,
  onEnergy: (energy: number) => void,
  onStart?: () => void,
  onEnd?: () => void,
): Promise<void> {
  if (typeof window === "undefined" || !text.trim()) {
    onEnd?.();
    return;
  }
  trackUtterance(text, Math.min(90_000, text.length * 70));
  const done = new Promise<void>((resolve) => {
    queue.push({ generation, text, segments: sentences(text), onEnergy, onStart, onEnd, resolve });
  });
  void drainSpeechQueue();
  await done;
}

async function drainSpeechQueue(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const batch = queue.shift()!;
      activeBatch = batch;
      const hardWakeGate = /jarvis/i.test(batch.text);
      void import("./wakeword").then((module) => module.setSuppressed?.(true, hardWakeGate)).catch(() => {});

      const ready = await prepareKitten();
      let started = false;
      if (ready && batch.generation === generation && batch.segments.length) {
        // Once segment N is generated, segment N+1 is generated during N's
        // playback. This keeps one inference in flight and removes the long
        // dead air that used to appear between sentences.
        let nextAudio = generateSegment(batch.segments[0], batch.generation);
        for (let index = 0; index < batch.segments.length; index++) {
          const blob = await nextAudio;
          if (!blob || batch.generation !== generation) break;
          nextAudio = index + 1 < batch.segments.length
            ? generateSegment(batch.segments[index + 1], batch.generation)
            : Promise.resolve(null);
          const played = await playSegment(
            blob,
            batch.generation,
            batch.onEnergy,
            started ? undefined : () => {
              started = true;
              batch.onStart?.();
            },
          );
          if (!played && batch.generation === generation) break;
        }
      }

      if (batch.generation === generation) {
        batch.onEnergy(0);
        batch.onEnd?.();
        setTtsStatus(kittenReady ? "ready" : "unavailable");
      }
      batch.resolve();
      activeBatch = null;
    }
  } finally {
    activeBatch = null;
    draining = false;
    setTimeout(() => {
      if (!draining && !activeBatch && queue.length === 0) {
        void import("./wakeword").then((module) => module.setSuppressed?.(false)).catch(() => {});
      }
    }, 650);
    if (queue.length) void drainSpeechQueue();
  }
}
