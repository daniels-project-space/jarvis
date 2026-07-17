"use client";

// Free speech output. Jarvis uses either the browser/OS voice or Kokoro running
// locally in this browser; assistant text is never sent to a hosted TTS vendor.

let generation = 0;
let draining = false;
let currentUtterance: SpeechSynthesisUtterance | null = null;
let currentAudio: HTMLAudioElement | null = null;
let stopAudioPlayback: (() => void) | null = null;
let queue: string[] = [];
let cachedVoice: SpeechSynthesisVoice | null = null;
type TtsMode = "kokoro" | "system";
type KokoroEngine = {
  generate: (text: string, options: { voice: "bm_fable"; speed: number }) => Promise<{ toBlob: () => Blob }>;
};
let ttsMode: TtsMode = "kokoro";
let kokoro: KokoroEngine | null = null;
let kokoroLoading: Promise<boolean> | null = null;
let kokoroWarmTimer: number | null = null;
let lastInteractionAt = 0;

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

function pickVoice(): SpeechSynthesisVoice | null {
  if (cachedVoice) return cachedVoice;
  const voices = window.speechSynthesis?.getVoices?.() ?? [];
  if (!voices.length) return null;
  const preferences = [
    /Google UK English Male/i,
    /(Daniel|Arthur|George|Ryan).*en[-_]?GB/i,
    /Microsoft (Ryan|George|Thomas)/i,
    /en[-_]?GB.*(Male|Natural|Neural)/i,
    /en[-_]?GB/i,
    /British/i,
    /Google US English/i,
  ];
  for (const preference of preferences) {
    const voice = voices.find((candidate) => preference.test(`${candidate.name} ${candidate.lang}`));
    if (voice) return (cachedVoice = voice);
  }
  return (cachedVoice = voices.find((voice) => /^en/i.test(voice.lang)) ?? voices[0] ?? null);
}

export function prewarmTts() {
  try {
    window.speechSynthesis?.getVoices();
  } catch {
    /* unsupported browser */
  }
}

// Kokoro runs entirely in this browser. The dynamic import keeps its neural
// runtime out of JARVIS's startup bundle; captions and the first reply never
// wait for a model download. q8 is the explicit "balanced local" setting shown
// in Options, rather than a hidden downgrade or a paid hosted voice.
async function prepareKokoro(): Promise<boolean> {
  if (typeof window === "undefined" || ttsMode !== "kokoro") return false;
  if (kokoro) return true;
  if (kokoroLoading) return kokoroLoading;
  kokoroLoading = import("kokoro-js")
    .then(async ({ KokoroTTS }) => {
      const loaded = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
        dtype: "q8",
        device: "wasm",
      });
      kokoro = loaded as unknown as KokoroEngine;
      return true;
    })
    .catch(() => false)
    .finally(() => {
      kokoroLoading = null;
    });
  return kokoroLoading;
}

function scheduleKokoroWarm(immediate = false) {
  if (kokoro || ttsMode !== "kokoro") return;
  if (kokoroWarmTimer) {
    window.clearTimeout(kokoroWarmTimer);
    kokoroWarmTimer = null;
  }
  // The local neural model is intentionally never initialised in the small
  // window where a typed message is waiting for its first response. That work
  // can briefly occupy the browser's main thread on lower-powered devices,
  // which made JARVIS look frozen even though the text lane was healthy.
  const startWhenIdle = () => {
    const run = () => {
      if (!immediate && Date.now() - lastInteractionAt < 8_000) {
        scheduleKokoroWarm();
        return;
      }
      void prepareKokoro();
    };
    const idle = (window as typeof window & { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number }).requestIdleCallback;
    if (idle) idle(run, { timeout: 8_000 });
    else window.setTimeout(run, 500);
  };
  const waitForQuiet = () => {
    // Initialising the WASM runtime is deliberately deferred until JARVIS has
    // had a quiet window. On slower machines it can take seconds and was the
    // source of the visible freeze right after sending a message.
    if (!immediate && Date.now() - lastInteractionAt < 8_000) {
      kokoroWarmTimer = window.setTimeout(waitForQuiet, 2_000);
      return;
    }
    kokoroWarmTimer = null;
    startWhenIdle();
  };
  kokoroWarmTimer = window.setTimeout(waitForQuiet, immediate ? 120 : 12_000);
}

export function setTtsMode(mode: TtsMode, warmNow = false) {
  ttsMode = mode;
  if (mode === "kokoro") scheduleKokoroWarm(warmNow);
}

export async function warm() {
  if (typeof window === "undefined") return;
  lastInteractionAt = Date.now();
  prewarmTts();
  if (window.speechSynthesis) {
    window.speechSynthesis.onvoiceschanged = () => {
      cachedVoice = null;
      window.speechSynthesis.getVoices();
    };
  }
  // Preserve the natural Kokoro voice, but never make first-message input or
  // captions compete with its model startup. It warms after the interaction
  // settles and is retained in browser cache for later replies.
  if (ttsMode === "kokoro" && !kokoro) scheduleKokoroWarm();
}

export function stopSpeaking() {
  generation++;
  queue = [];
  currentUtterance = null;
  draining = false;
  stopAudioPlayback?.();
  stopAudioPlayback = null;
  currentAudio = null;
  try {
    window.speechSynthesis?.cancel();
  } catch {
    /* unsupported browser */
  }
  void import("./wakeword").then((module) => module.setSuppressed?.(false)).catch(() => {});
}

export function isSpeaking() {
  return draining || Boolean(currentAudio) || Boolean(window.speechSynthesis?.speaking);
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

async function speakKokoroOne(
  text: string,
  expectedGeneration: number,
  onEnergy: (energy: number) => void,
  onStart?: () => void,
): Promise<boolean> {
  const engine = kokoro;
  if (!engine || expectedGeneration !== generation) return false;
  let blob: Blob;
  try {
    blob = (await engine.generate(text, { voice: "bm_fable", speed: speechSpeed(text) })).toBlob();
  } catch {
    return false;
  }
  if (expectedGeneration !== generation) return true;
  return new Promise((resolve) => {
    const audio = new Audio(URL.createObjectURL(blob));
    currentAudio = audio;
    let timer: ReturnType<typeof setInterval> | null = null;
    let settled = false;
    const finish = (played: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearInterval(timer);
      if (currentAudio === audio) currentAudio = null;
      if (stopAudioPlayback === stop) stopAudioPlayback = null;
      URL.revokeObjectURL(audio.src);
      audio.removeAttribute("src");
      onEnergy(0);
      resolve(played);
    };
    const stop = () => {
      audio.pause();
      finish(true);
    };
    stopAudioPlayback = stop;
    audio.onplay = () => {
      if (expectedGeneration !== generation) return stop();
      onStart?.();
      timer = energyLoop(expectedGeneration, onEnergy);
    };
    audio.onended = () => finish(true);
    audio.onerror = () => finish(false);
    void audio.play().catch(() => finish(false));
  });
}

function speakSystemOne(
  text: string,
  expectedGeneration: number,
  onEnergy: (energy: number) => void,
  onStart?: () => void,
): Promise<void> {
  return new Promise((resolve) => {
    const synth = window.speechSynthesis;
    if (!synth || expectedGeneration !== generation) return resolve();
    const utterance = new SpeechSynthesisUtterance(text);
    currentUtterance = utterance;
    const voice = pickVoice();
    if (voice) utterance.voice = voice;
    utterance.lang = voice?.lang || "en-GB";
    // Web Speech has no emotion markup, but careful prosody makes the free
    // on-device voice feel far less flat without shipping text to a provider.
    const tone = text.toLowerCase();
    if (/\b(urgent|careful|risk|serious|honestly|numbers|weak plan)\b/.test(tone)) {
      utterance.rate = 0.99;
      utterance.pitch = 0.9;
    } else if (/\b(sorry|rough|tired|stressed|gentle|here with you)\b/.test(tone)) {
      utterance.rate = 0.97;
      utterance.pitch = 0.93;
    } else if (/\b(ha|haha|brilliant|lets go|let's go|excited|love it)\b/.test(tone)) {
      utterance.rate = 1.1;
      utterance.pitch = 1.03;
    } else {
      utterance.rate = 1.06;
      utterance.pitch = 0.96;
    }
    let energyTimer: ReturnType<typeof setInterval> | null = null;
    utterance.onstart = () => {
      onStart?.();
      energyTimer = energyLoop(expectedGeneration, onEnergy);
    };
    const done = () => {
      if (energyTimer) clearInterval(energyTimer);
      if (currentUtterance === utterance) currentUtterance = null;
      onEnergy(0);
      resolve();
    };
    utterance.onend = done;
    utterance.onerror = done;
    synth.speak(utterance);
  });
}

async function speakOne(
  text: string,
  expectedGeneration: number,
  onEnergy: (energy: number) => void,
  onStart?: () => void,
  useKokoro = false,
): Promise<void> {
  if (useKokoro) {
    const played = await speakKokoroOne(text, expectedGeneration, onEnergy, onStart);
    if (played || expectedGeneration !== generation) return;
  }
  await speakSystemOne(text, expectedGeneration, onEnergy, onStart);
}

export async function speak(
  text: string,
  onEnergy: (energy: number) => void,
  onStart?: () => void,
  onEnd?: () => void,
): Promise<void> {
  if (typeof window === "undefined") {
    onEnd?.();
    return;
  }
  const useKokoro = ttsMode === "kokoro" && Boolean(kokoro);
  if (!useKokoro && !window.speechSynthesis) {
    onEnd?.();
    return;
  }
  trackUtterance(text, Math.min(90_000, text.length * 70));
  queue.push(...sentences(text));
  if (draining) return;

  draining = true;
  const expectedGeneration = generation;
  const hardWakeGate = /jarvis/i.test(text);
  void import("./wakeword").then((module) => module.setSuppressed?.(true, hardWakeGate)).catch(() => {});
  let started = false;
  while (queue.length && expectedGeneration === generation) {
    const next = queue.shift()!;
    await speakOne(next, expectedGeneration, onEnergy, started ? undefined : () => {
      started = true;
      onStart?.();
    }, useKokoro);
  }
  if (expectedGeneration === generation) {
    draining = false;
    onEnergy(0);
    onEnd?.();
    setTimeout(() => {
      void import("./wakeword").then((module) => module.setSuppressed?.(false)).catch(() => {});
    }, 650);
  }
}
