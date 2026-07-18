"use client";

// One speech path: streamed Microsoft neural audio through Jarvis's own London
// edge route. Intelligence remains Codex CLI; this module only plays sound.

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

type Recent = { text: string; until: number };
let recentUtterances: Recent[] = [];

const words = (text: string) =>
  text.toLowerCase().replace(/[^a-z0-9\s']/g, " ").split(/\s+/).filter((word) => word.length > 1);

function setTtsStatus(status: "ready" | "buffering" | "speaking" | "idle" | "unavailable") {
  if (typeof document !== "undefined") {
    document.documentElement.dataset.jarvisTts = status;
    document.documentElement.dataset.jarvisTtsEngine = "neural-ryan-stream";
  }
}

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

// There is no local model to initialise. Keeping this API lets all voice entry
// points share the same lifecycle without delaying a message after interaction.
export async function warm(): Promise<void> {
  setTtsStatus("ready");
}

export function stopSpeaking() {
  generation++;
  const abandoned = queue;
  queue = [];
  for (const batch of abandoned) batch.resolve();
  stopAudioPlayback?.();
  stopAudioPlayback = null;
  currentAudio = null;
  setTtsStatus("ready");
  void import("./wakeword").then((module) => module.setSuppressed?.(false)).catch(() => {});
}

export function isSpeaking() {
  return draining || Boolean(currentAudio);
}

export function sentences(text: string): string[] {
  const result: string[] = [];
  let buffer = "";
  // Clause boundaries keep time-to-first-audio low while preserving natural
  // phrasing. The next clause begins buffering during current playback.
  for (const part of text.split(/(?<=[.!?;:])\s+|(?<=,)\s+(?=\S)/)) {
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
  if (/\b(urgent|careful|risk|serious|honestly|numbers|weak plan)\b/.test(tone)) return 0.98;
  if (/\b(sorry|rough|tired|stressed|gentle|here with you)\b/.test(tone)) return 0.95;
  if (/\b(ha|haha|brilliant|lets go|let's go|excited|love it)\b/.test(tone)) return 1.1;
  return 1.04;
}

function energyLoop(expectedGeneration: number, onEnergy: (energy: number) => void) {
  const startedAt = performance.now();
  return setInterval(() => {
    if (expectedGeneration !== generation) return;
    const phase = (performance.now() - startedAt) / 125;
    onEnergy(Math.min(1, 0.25 + 0.34 * Math.abs(Math.sin(phase))));
  }, 60);
}

function prepareSegment(text: string): HTMLAudioElement {
  const params = new URLSearchParams({ text, speed: String(speechSpeed(text)) });
  const audio = new Audio(`/api/tts?${params.toString()}`);
  audio.preload = "auto";
  audio.load?.();
  return audio;
}

function playSegment(
  audio: HTMLAudioElement,
  expectedGeneration: number,
  onEnergy: (energy: number) => void,
  onStart?: () => void,
): Promise<boolean> {
  if (expectedGeneration !== generation) return Promise.resolve(false);
  return new Promise((resolve) => {
    currentAudio = audio;
    let timer: ReturnType<typeof setInterval> | null = null;
    let settled = false;
    const finish = (played: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearInterval(timer);
      if (currentAudio === audio) currentAudio = null;
      if (stopAudioPlayback === stop) stopAudioPlayback = null;
      audio.removeAttribute("src");
      audio.load?.();
      onEnergy(0);
      resolve(played);
    };
    const stop = () => {
      audio.pause();
      finish(false);
    };
    stopAudioPlayback = stop;
    audio.onwaiting = () => setTtsStatus("buffering");
    audio.onplay = () => {
      if (expectedGeneration !== generation) return stop();
      setTtsStatus("speaking");
      onStart?.();
      timer = energyLoop(expectedGeneration, onEnergy);
    };
    audio.onended = () => finish(true);
    audio.onerror = () => finish(false);
    setTtsStatus("buffering");
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
      void import("./wakeword").then((module) => module.setSuppressed?.(true, /jarvis/i.test(batch.text))).catch(() => {});
      let started = false;
      let nextAudio = batch.segments.length ? prepareSegment(batch.segments[0]) : null;
      for (let index = 0; nextAudio && index < batch.segments.length; index++) {
        if (batch.generation !== generation) break;
        const audio = nextAudio;
        nextAudio = index + 1 < batch.segments.length ? prepareSegment(batch.segments[index + 1]) : null;
        const played = await playSegment(
          audio,
          batch.generation,
          batch.onEnergy,
          started ? undefined : () => {
            started = true;
            batch.onStart?.();
          },
        );
        if (!played && batch.generation === generation) break;
      }
      if (batch.generation === generation) {
        batch.onEnergy(0);
        batch.onEnd?.();
        setTtsStatus("ready");
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
