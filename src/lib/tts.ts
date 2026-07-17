"use client";

// Zero-cost speech output. Jarvis uses the browser/OS speech engine only: no
// text is sent to ElevenLabs, Replicate, OpenAI audio, or another TTS provider.

let generation = 0;
let draining = false;
let currentUtterance: SpeechSynthesisUtterance | null = null;
let queue: string[] = [];
let cachedVoice: SpeechSynthesisVoice | null = null;

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

export async function warm() {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  prewarmTts();
  window.speechSynthesis.onvoiceschanged = () => {
    cachedVoice = null;
    window.speechSynthesis.getVoices();
  };
}

export function stopSpeaking() {
  generation++;
  queue = [];
  currentUtterance = null;
  draining = false;
  try {
    window.speechSynthesis?.cancel();
  } catch {
    /* unsupported browser */
  }
  void import("./wakeword").then((module) => module.setSuppressed?.(false)).catch(() => {});
}

export function isSpeaking() {
  return draining || Boolean(window.speechSynthesis?.speaking);
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

function speakOne(
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
    const tone = text.toLowerCase();
    // Web Speech has no emotion markup, but careful prosody makes the free
    // on-device voice feel far less flat without shipping text to a provider.
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
    let startedAt = 0;
    utterance.onstart = () => {
      onStart?.();
      startedAt = performance.now();
      energyTimer = setInterval(() => {
        if (expectedGeneration !== generation) return;
        const phase = (performance.now() - startedAt) / 125;
        onEnergy(Math.min(1, 0.25 + 0.34 * Math.abs(Math.sin(phase))));
      }, 60);
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

export async function speak(
  text: string,
  onEnergy: (energy: number) => void,
  onStart?: () => void,
  onEnd?: () => void,
): Promise<void> {
  if (typeof window === "undefined" || !window.speechSynthesis) {
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
    });
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
