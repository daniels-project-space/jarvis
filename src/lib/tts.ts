"use client";

// One speech engine, one queue, one voice. Kokoro runs in a Web Worker so
// neural generation never blocks captions, the orb, or pointer interaction.

type SpeechBatch = {
  generation: number;
  text: string;
  segments: string[];
  onEnergy: (energy: number) => void;
  onStart?: () => void;
  onEnd?: () => void;
  settled: boolean;
  resolve: () => void;
};

type AudioResult = { audio: Float32Array; sampleRate: number };
type WorkerReply =
  | { type: "ready" }
  | { type: "progress"; progress: number | null; status: string; file: string | null }
  | { type: "audio"; id: number; audio: ArrayBuffer; sampleRate: number }
  | { type: "error"; id: number | null; message: string };

type PendingAudio = {
  resolve: (result: AudioResult) => void;
  reject: (error: Error) => void;
};

const ECHO_GUARD_TAIL_MS = 45_000;
const WORKER_TIMEOUT_MS = 30_000;

let generation = 0;
let requestId = 0;
let worker: Worker | null = null;
let modelReady: Promise<void> | null = null;
let resolveModelReady: (() => void) | null = null;
let rejectModelReady: ((error: Error) => void) | null = null;
let audioContext: AudioContext | null = null;
let currentSource: AudioBufferSourceNode | null = null;
let finishCurrentPlayback: (() => void) | null = null;
let draining = false;
let activeBatch: SpeechBatch | null = null;
let queue: SpeechBatch[] = [];
const pending = new Map<number, PendingAudio>();
type Recent = { text: string; until: number };
let recentUtterances: Recent[] = [];

const words = (text: string) =>
  text.toLowerCase().replace(/[^a-z0-9\s']/g, " ").split(/\s+/).filter((word) => word.length > 1);

function setTtsStatus(status: "loading" | "ready" | "buffering" | "speaking" | "unavailable") {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.jarvisTts = status;
  document.documentElement.dataset.jarvisTtsEngine = "kokoro-q8-george";
}

function reportFailure(error: unknown) {
  const message = String(error).replace(/\s+/g, " ").slice(0, 240);
  setTtsStatus("unavailable");
  if (typeof document === "undefined") return;
  document.documentElement.dataset.jarvisTtsFailure = message;
  void fetch("/api/incident", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      signature: "client:kokoro-tts",
      message: `Jarvis's only speech engine failed: ${message}`,
    }),
  }).catch(() => {});
}

function invalidateWorker(instance: Worker, error: Error) {
  if (worker !== instance) return;
  rejectModelReady?.(error);
  for (const waiter of pending.values()) waiter.reject(error);
  pending.clear();
  resolveModelReady = null;
  rejectModelReady = null;
  modelReady = null;
  worker = null;
  try { instance.terminate(); } catch { /* already gone */ }
}

function ensureWorker(): Worker {
  if (worker) return worker;
  const instance = new Worker(new URL("../workers/kokoro.worker.ts", import.meta.url), { type: "module" });
  worker = instance;
  modelReady = new Promise<void>((resolve, reject) => {
    resolveModelReady = resolve;
    rejectModelReady = reject;
  });
  instance.onmessage = (event: MessageEvent<WorkerReply>) => {
    const reply = event.data;
    if (reply.type === "progress") {
      setTtsStatus("loading");
      if (typeof document !== "undefined" && reply.progress != null) {
        document.documentElement.dataset.jarvisTtsProgress = String(Math.round(reply.progress));
      }
      return;
    }
    if (reply.type === "ready") {
      resolveModelReady?.();
      resolveModelReady = null;
      rejectModelReady = null;
      setTtsStatus("ready");
      return;
    }
    if (reply.type === "error") {
      const error = new Error(reply.message);
      if (reply.id == null) {
        invalidateWorker(instance, error);
      } else {
        pending.get(reply.id)?.reject(error);
        pending.delete(reply.id);
      }
      return;
    }
    const waiter = pending.get(reply.id);
    if (!waiter) return;
    pending.delete(reply.id);
    waiter.resolve({ audio: new Float32Array(reply.audio), sampleRate: reply.sampleRate });
  };
  instance.onerror = (event) => {
    const error = new Error(event.message || "Kokoro worker failed");
    invalidateWorker(instance, error);
  };
  setTtsStatus("loading");
  instance.postMessage({ type: "warm" });
  return instance;
}

function ensureAudioContext(): AudioContext {
  if (!audioContext) {
    const Context = window.AudioContext
      ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context) throw new Error("Web Audio is unavailable in this browser");
    audioContext = new Context({ latencyHint: "interactive" });
  }
  return audioContext;
}

/** Resume Web Audio synchronously from a genuine pointer/key interaction. */
export function unlockSpeechPlayback(): void {
  if (typeof window === "undefined") return;
  try {
    const context = ensureAudioContext();
    if (context.state === "suspended") void context.resume().catch(reportFailure);
  } catch (error) {
    reportFailure(error);
  }
}

export async function warm(): Promise<void> {
  if (typeof window === "undefined" || typeof Worker === "undefined") return;
  try {
    ensureWorker();
    await modelReady;
  } catch (error) {
    reportFailure(error);
  }
}

function trackUtterance(text: string, durationMs: number) {
  const now = Date.now();
  recentUtterances = recentUtterances.filter((row) => row.until > now);
  recentUtterances.push({ text, until: now + durationMs + ECHO_GUARD_TAIL_MS });
}

export function isEchoOfTts(input: string): boolean {
  const now = Date.now();
  recentUtterances = recentUtterances.filter((row) => row.until > now);
  const inputWords = words(input);
  if (!inputWords.length) return false;
  for (const row of recentUtterances) {
    const spoken = new Set(words(row.text));
    if (!spoken.size) continue;
    const matches = inputWords.filter((word) => spoken.has(word)).length;
    if (inputWords.length <= 2 && matches === inputWords.length) return true;
    if (matches / inputWords.length >= 0.65) return true;
  }
  return false;
}

export function completeSpeechPrefix(input: string): string {
  const matches = [...input.matchAll(/[.!?](?:[”"')\]]+)?(?=\s|$)|\n\s*\n/g)];
  const last = matches.at(-1);
  if (!last || last.index == null) return "";
  const prefix = input.slice(0, last.index + last[0].length);
  return prefix.trim().length >= 18 ? prefix : "";
}

export function normalizeSpeechText(input: string): string {
  let text = input.normalize("NFKC").replace(/\r\n?/g, "\n");
  text = text
    .replace(/\[([^\]]+)]\((?:https?:\/\/)[^)]+\)/gi, "$1")
    .replace(/https?:\/\/\S+/gi, "the link")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*•▪◦]|\d+[.)])\s+/gm, "")
    .replace(/[`*]+/g, "")
    .replace(/_/g, " ")
    .replace(/\n+/g, ". ")
    .replace(/(\d)\s*[–—]\s*(\d)/g, "$1 to $2")
    .replace(/\s*[–—]\s*/g, ", ")
    .replace(/\s+--?\s+/g, ", ")
    .replace(/--+/g, ", ")
    .replace(/(?:\.{3,}|…+)(?=\s*(?:$|[”"']))/g, ".")
    .replace(/(?:\.{3,}|…+)/g, ", ")
    .replace(/\s+\/\s+/g, " or ")
    .replace(/\s*&\s*/g, " and ")
    .replace(/([!?])\1+/g, "$1")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/,\s*([.!?])/g, "$1")
    .replace(/(?:\.\s*){2,}/g, ". ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  if (!text) return "";
  if (/[,:;]\s*$/.test(text)) text = text.replace(/[,:;]\s*$/, ".");
  else if (!/[.!?][”"')\]]?$/.test(text)) text += ".";
  return text;
}

export function sentences(text: string): string[] {
  const speech = normalizeSpeechText(text);
  const result: string[] = [];
  let buffer = "";
  for (const part of speech.split(/(?<=[.!?;:])\s+|(?<=,)\s+(?=\S)/)) {
    buffer = buffer ? `${buffer} ${part}` : part;
    if (buffer.length >= 24) {
      result.push(buffer);
      buffer = "";
    }
  }
  if (buffer.trim()) result.push(buffer);
  return result;
}

export function speechPauseMs(text: string): number {
  const ending = text.trim();
  if (/[?!][”"')\]]?$/.test(ending)) return 170;
  if (/\.[”"')\]]?$/.test(ending)) return 140;
  if (/[;:][”"')\]]?$/.test(ending)) return 85;
  if (/,[”"')\]]?$/.test(ending)) return 45;
  return 0;
}

function speechSpeed(text: string): number {
  const tone = text.toLowerCase();
  if (/\b(urgent|careful|risk|serious|honestly|weak plan)\b/.test(tone)) return 0.98;
  if (/\b(sorry|rough|tired|stressed|gentle)\b/.test(tone)) return 0.96;
  if (/\b(ha|haha|brilliant|let's go|excited|love it)\b/.test(tone)) return 1.1;
  return 1.04;
}

async function synthesize(text: string, attempt = 0): Promise<AudioResult> {
  const activeWorker = ensureWorker();
  try {
    await modelReady;
    const id = ++requestId;
    return await new Promise<AudioResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        const error = new Error("Kokoro synthesis timed out");
        invalidateWorker(activeWorker, error);
        reject(error);
      }, WORKER_TIMEOUT_MS);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      activeWorker.postMessage({ type: "synthesize", id, text, speed: speechSpeed(text) });
    });
  } catch (error) {
    // One bounded retry covers a transient worker/GPU/WASM interruption while
    // preserving the one-engine invariant. A second failure is surfaced and
    // never replaced with a robotic browser voice.
    if (attempt === 0) return synthesize(text, 1);
    throw error;
  }
}

async function playPcm(result: AudioResult, expectedGeneration: number, onEnergy: (energy: number) => void) {
  if (expectedGeneration !== generation) return false;
  const context = ensureAudioContext();
  if (context.state === "suspended") await context.resume();
  const buffer = context.createBuffer(1, result.audio.length, result.sampleRate);
  // DOM's AudioBuffer typing requires an ArrayBuffer-backed view. Worker
  // replies are transferable, but TypeScript correctly allows their generic
  // view to also be SharedArrayBuffer-backed, so copy into an owned channel.
  const channel = new Float32Array(result.audio.length);
  channel.set(result.audio);
  buffer.copyToChannel(channel, 0);
  const source = context.createBufferSource();
  const analyser = context.createAnalyser();
  analyser.fftSize = 128;
  source.buffer = buffer;
  source.connect(analyser);
  analyser.connect(context.destination);
  currentSource = source;
  setTtsStatus("speaking");
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const levels = new Uint8Array(analyser.frequencyBinCount);
    const energyTimer = setInterval(() => {
      analyser.getByteFrequencyData(levels);
      const mean = levels.reduce((sum, value) => sum + value, 0) / Math.max(1, levels.length);
      onEnergy(Math.min(1, mean / 110));
    }, 48);
    const finish = (played: boolean) => {
      if (settled) return;
      settled = true;
      clearInterval(energyTimer);
      onEnergy(0);
      if (currentSource === source) currentSource = null;
      if (finishCurrentPlayback === stop) finishCurrentPlayback = null;
      source.disconnect();
      analyser.disconnect();
      resolve(played);
    };
    const stop = () => finish(false);
    finishCurrentPlayback = stop;
    source.onended = () => finish(true);
    source.start();
  });
}

function settle(batch: SpeechBatch, callEnd: boolean) {
  if (batch.settled) return;
  batch.settled = true;
  if (callEnd) batch.onEnd?.();
  batch.resolve();
}

export function stopSpeaking() {
  generation++;
  const abandoned = queue;
  queue = [];
  for (const batch of abandoned) settle(batch, false);
  if (activeBatch) settle(activeBatch, false);
  try { currentSource?.stop(); } catch { /* already ended */ }
  finishCurrentPlayback?.();
  currentSource = null;
  finishCurrentPlayback = null;
  setTtsStatus(modelReady ? "ready" : "loading");
  void import("./wakeword").then((module) => module.setSuppressed?.(false)).catch(() => {});
}

export function isSpeaking() {
  return Boolean(currentSource);
}

export async function speak(
  text: string,
  onEnergy: (energy: number) => void,
  onStart?: () => void,
  onEnd?: () => void,
): Promise<void> {
  const speech = normalizeSpeechText(text);
  if (typeof window === "undefined" || !speech) {
    onEnd?.();
    return;
  }
  trackUtterance(speech, Math.min(90_000, speech.length * 70));
  const done = new Promise<void>((resolve) => {
    queue.push({
      generation,
      text: speech,
      segments: sentences(speech),
      onEnergy,
      onStart,
      onEnd,
      settled: false,
      resolve,
    });
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
      let next = batch.segments[0] ? synthesize(batch.segments[0]) : null;
      try {
        for (let index = 0; next && index < batch.segments.length; index++) {
          if (batch.generation !== generation) break;
          setTtsStatus("buffering");
          const audio = await next;
          if (batch.generation !== generation) break;
          next = batch.segments[index + 1] ? synthesize(batch.segments[index + 1]) : null;
          if (!started) {
            started = true;
            batch.onStart?.();
          }
          const played = await playPcm(audio, batch.generation, batch.onEnergy);
          if (!played || batch.generation !== generation) break;
          const pause = speechPauseMs(batch.segments[index]);
          if (pause) await new Promise((resolve) => setTimeout(resolve, pause));
        }
        if (batch.generation === generation) {
          setTtsStatus("ready");
          settle(batch, true);
        } else {
          settle(batch, false);
        }
      } catch (error) {
        reportFailure(error);
        settle(batch, true);
      } finally {
        activeBatch = null;
      }
    }
  } finally {
    draining = false;
    if (!activeBatch && queue.length === 0) {
      setTimeout(() => {
        if (!currentSource) {
          void import("./wakeword").then((module) => module.setSuppressed?.(false)).catch(() => {});
        }
      }, 900);
    }
    if (queue.length) void drainSpeechQueue();
  }
}
