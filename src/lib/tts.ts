"use client";

import { viewerFetch } from "./viewer-request";
import { planVoiceDelivery, voiceDeliveryCacheKey } from "./voice-delivery";

// One speech route and one queue: free streamed en-GB-RyanNeural. The browser
// only decodes audio; it never loads a model or falls back to SpeechSynthesis.

type SpeechBatch = {
  generation: number;
  text: string;
  segments: string[];
  onEnergy: (energy: number) => void;
  onStart?: () => void;
  onEnd?: () => void;
  settled: boolean;
  resolve: (played: boolean) => void;
};

export type TtsRuntimeStatus = "loading" | "ready" | "buffering" | "speaking" | "blocked" | "unavailable";

class SpeechPlaybackBlockedError extends Error {
  constructor() {
    super("Audio playback is blocked until the next user gesture");
    this.name = "SpeechPlaybackBlockedError";
  }
}

type AudioResult = { audio: ArrayBuffer };

const ECHO_GUARD_TAIL_MS = 45_000;
const REQUEST_TIMEOUT_MS = 4_000;
// Edge handles sentence rhythm better than a browser-side chain of tiny MP3s.
// Keep ordinary replies in one request. For genuinely long speech, make only
// the first clause smaller so audio can begin while the larger continuation is
// synthesized in parallel; this preserves cadence without waiting for a whole
// long MP3 before the first sound.
// The browser decodes an Edge MP3 after the segment completes, so first-audio
// latency scales with the first segment's length. Keep only the first segment
// short; continuation segments stay large and are synthesized during playback,
// preserving voice quality, the same total spoken content, and bounded calls.
const FIRST_SPEECH_CHUNK_CHARS = 88;
const PREVIOUS_FIRST_SPEECH_CHUNK_CHARS = 120;
const TARGET_SPEECH_CHUNK_CHARS = 170;
const MAX_SPEECH_CHUNK_CHARS = 240;
const MAX_MEMORY_AUDIO_SEGMENTS = 12;
let ttsEngine = "edge-neural-ryan-gb";

let generation = 0;
let audioContext: AudioContext | null = null;
let currentSource: AudioBufferSourceNode | null = null;
let finishCurrentPlayback: (() => void) | null = null;
let draining = false;
let activeBatch: SpeechBatch | null = null;
let blockedBatch: SpeechBatch | null = null;
let runtimeStatus: TtsRuntimeStatus = "ready";
let queue: SpeechBatch[] = [];
const pendingRequests = new Set<AbortController>();
const audioCache = new Map<string, AudioResult>();
const synthesisInFlight = new Map<string, Promise<AudioResult>>();
type Recent = { text: string; until: number };
let recentUtterances: Recent[] = [];

const words = (text: string) =>
  text.toLowerCase().replace(/[^a-z0-9\s']/g, " ").split(/\s+/).filter((word) => word.length > 1);

function setTtsStatus(status: TtsRuntimeStatus) {
  runtimeStatus = status;
  if (typeof document === "undefined") return;
  document.documentElement.dataset.jarvisTts = status;
  document.documentElement.dataset.jarvisTtsEngine = ttsEngine;
  if (status !== "unavailable") delete document.documentElement.dataset.jarvisTtsFailure;
  if (
    typeof window !== "undefined" &&
    typeof window.dispatchEvent === "function" &&
    typeof CustomEvent !== "undefined"
  ) {
    window.dispatchEvent(new CustomEvent("jarvis:tts-status", { detail: { status } }));
  }
}

function isPlaybackBlocked(error: unknown): boolean {
  if (error instanceof SpeechPlaybackBlockedError) return true;
  const name = String((error as { name?: unknown })?.name ?? "");
  const message = String((error as { message?: unknown })?.message ?? error ?? "");
  return name === "NotAllowedError" || /user gesture|not allowed|autoplay/i.test(message);
}

function reportFailure(error: unknown) {
  const message = String(error).replace(/\s+/g, " ").slice(0, 240);
  setTtsStatus("unavailable");
  if (typeof document === "undefined") return;
  document.documentElement.dataset.jarvisTtsFailure = message;
  void viewerFetch("/api/incident", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      signature: "client:tts",
      message: `Jarvis's speech route failed: ${message}`,
    }),
  }).catch(() => {});
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
    const finishUnlock = () => {
      if (context.state === "suspended") {
        setTtsStatus("blocked");
        return;
      }
      // Some iOS/Safari versions resolve resume() before accepting a later
      // source. Prime a silent frame while this genuine gesture is active.
      try {
        if (typeof context.createBuffer === "function") {
          const source = context.createBufferSource();
          source.buffer = context.createBuffer(1, 1, context.sampleRate || 44_100);
          source.connect(context.destination);
          source.start(0);
          source.disconnect();
        }
      } catch {
        // A running context is sufficient; the silent primer is best effort.
      }
      if (runtimeStatus === "blocked") setTtsStatus("ready");
      const batch = blockedBatch;
      if (!batch) return;
      blockedBatch = null;
      queue.unshift(batch);
      void drainSpeechQueue();
    };
    if (context.state === "suspended") {
      void context.resume().then(finishUnlock).catch((error) => {
        if (isPlaybackBlocked(error)) setTtsStatus("blocked");
        else reportFailure(error);
      });
    } else {
      finishUnlock();
    }
  } catch (error) {
    if (isPlaybackBlocked(error)) setTtsStatus("blocked");
    else reportFailure(error);
  }
}

/** Warm only the small Vercel route bundle. There is no browser model to load. */
export async function warm(): Promise<void> {
  if (typeof window === "undefined") return;
  setTtsStatus("ready");
  const response = await viewerFetch("/api/tts", { method: "GET", cache: "no-store" }).catch(() => undefined);
  const engine = response?.headers.get("x-jarvis-tts-engine")?.trim();
  if (engine) {
    ttsEngine = engine;
    setTtsStatus("ready");
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
  // Colons and semicolons are stable spoken clause boundaries too. Accepting
  // them lets TTS synthesize the opening clause while later model tokens keep
  // streaming instead of waiting for the first full stop.
  const matches = [...input.matchAll(/[.!?;:](?:[”"')\]]+)?(?=\s|$)|\n\s*\n/g)];
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

  const appendBounded = (value: string) => {
    let remaining = value.trim();
    const nextLimit = () => result.length === 0 && remaining.length >= TARGET_SPEECH_CHUNK_CHARS
      ? FIRST_SPEECH_CHUNK_CHARS
      : MAX_SPEECH_CHUNK_CHARS;
    while (remaining.length > nextLimit()) {
      const limit = nextLimit();
      // Preserve the old two-request ceiling for replies that previously fit
      // in 120 + 240 characters. Start at 88 when possible, but move the cut
      // just far enough forward to keep the remainder in one continuation.
      const minimumTwoChunkCut = remaining.length - MAX_SPEECH_CHUNK_CHARS;
      if (
        result.length === 0
        && remaining.length <= PREVIOUS_FIRST_SPEECH_CHUNK_CHARS + MAX_SPEECH_CHUNK_CHARS
        && minimumTwoChunkCut > limit
      ) {
        const forwardBoundary = remaining.indexOf(" ", minimumTwoChunkCut);
        if (forwardBoundary > 0 && forwardBoundary <= PREVIOUS_FIRST_SPEECH_CHUNK_CHARS) {
          result.push(remaining.slice(0, forwardBoundary).trim());
          remaining = remaining.slice(forwardBoundary).trim();
          continue;
        }
      }
      const window = remaining.slice(0, limit + 1);
      const boundary = window.lastIndexOf(" ");
      const cut = boundary >= Math.floor(limit * 0.58)
        ? boundary
        : limit;
      result.push(remaining.slice(0, cut).trim());
      remaining = remaining.slice(cut).trim();
    }
    if (remaining) result.push(remaining);
  };

  const flush = () => {
    if (!buffer.trim()) return;
    appendBounded(buffer);
    buffer = "";
  };

  for (const part of speech.split(/(?<=[.!?;:])\s+/)) {
    const next = buffer ? `${buffer} ${part}` : part;
    if (buffer && next.length > MAX_SPEECH_CHUNK_CHARS) flush();
    buffer = buffer ? `${buffer} ${part}` : part;
    if (buffer.length >= TARGET_SPEECH_CHUNK_CHARS) flush();
  }
  flush();
  return result;
}

export function speechPauseMs(text: string): number {
  const ending = text.trim();
  if (/[?!][”"')\]]?$/.test(ending)) return 45;
  if (/\.[”"')\]]?$/.test(ending)) return 30;
  if (/[;:][”"')\]]?$/.test(ending)) return 15;
  return 0;
}

async function requestAudio(text: string, expectedGeneration: number): Promise<AudioResult> {
  if (expectedGeneration !== generation) throw new Error("speech cancelled");
  const controller = new AbortController();
  pendingRequests.add(controller);
  if (typeof document !== "undefined") document.documentElement.dataset.jarvisTtsRequestMs = String(Math.round(performance.now()));
  const timeout = window.setTimeout(() => controller.abort("TTS timed out"), REQUEST_TIMEOUT_MS);
  try {
    const delivery = planVoiceDelivery(text);
    const response = await viewerFetch("/api/tts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, speed: delivery.rate, pitchHz: delivery.pitchHz }),
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => null) as { error?: unknown } | null;
      throw new Error(String(detail?.error ?? `TTS returned ${response.status}`));
    }
    const engine = response.headers.get("x-jarvis-tts-engine")?.trim();
    if (engine) ttsEngine = engine;
    const audio = await response.arrayBuffer();
    if (audio.byteLength < 512) throw new Error("TTS returned empty audio");
    return { audio };
  } finally {
    window.clearTimeout(timeout);
    pendingRequests.delete(controller);
  }
}

function rememberAudio(key: string, result: AudioResult): AudioResult {
  audioCache.delete(key);
  audioCache.set(key, result);
  while (audioCache.size > MAX_MEMORY_AUDIO_SEGMENTS) {
    const oldest = audioCache.keys().next().value;
    if (typeof oldest !== "string") break;
    audioCache.delete(oldest);
  }
  return result;
}

async function synthesize(text: string, expectedGeneration: number): Promise<AudioResult> {
  const key = `${ttsEngine}:${voiceDeliveryCacheKey(planVoiceDelivery(text))}:${text}`;
  const cached = audioCache.get(key);
  if (cached) return cached;
  const existing = synthesisInFlight.get(key);
  if (existing) return existing;
  const request = requestAudio(text, expectedGeneration).then((result) => rememberAudio(key, result));
  synthesisInFlight.set(key, request);
  try {
    return await request;
  } finally {
    if (synthesisInFlight.get(key) === request) synthesisInFlight.delete(key);
  }
}

async function playAudio(
  result: AudioResult,
  expectedGeneration: number,
  onEnergy: (energy: number) => void,
  onStart?: () => void,
) {
  if (expectedGeneration !== generation) return false;
  const context = ensureAudioContext();
  if (context.state === "suspended") {
    try {
      await context.resume();
    } catch (error) {
      if (isPlaybackBlocked(error)) throw new SpeechPlaybackBlockedError();
      throw error;
    }
    if (context.state === "suspended") throw new SpeechPlaybackBlockedError();
  }
  const buffer = await context.decodeAudioData(result.audio.slice(0));
  if (expectedGeneration !== generation) return false;
  if (typeof document !== "undefined") document.documentElement.dataset.jarvisTtsFirstPlayableMs = String(Math.round(performance.now()));
  const source = context.createBufferSource();
  const analyser = context.createAnalyser();
  analyser.fftSize = 128;
  source.buffer = buffer;
  source.connect(analyser);
  analyser.connect(context.destination);
  return new Promise<boolean>((resolve, reject) => {
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
      clearTimeout(playbackTimer);
      onEnergy(0);
      if (currentSource === source) currentSource = null;
      if (finishCurrentPlayback === stop) finishCurrentPlayback = null;
      source.disconnect();
      analyser.disconnect();
      resolve(played);
    };
    const stop = () => finish(false);
    const playbackTimer = window.setTimeout(
      () => finish(false),
      Math.max(2_500, Math.ceil(Number(buffer.duration || 0) * 1_000) + 2_000),
    );
    finishCurrentPlayback = stop;
    source.onended = () => finish(true);
    try {
      source.start();
    } catch (error) {
      settled = true;
      clearInterval(energyTimer);
      clearTimeout(playbackTimer);
      onEnergy(0);
      source.disconnect();
      analyser.disconnect();
      reject(isPlaybackBlocked(error) ? new SpeechPlaybackBlockedError() : error);
      return;
    }
    currentSource = source;
    setTtsStatus("speaking");
    onStart?.();
  });
}

function settle(batch: SpeechBatch, callEnd: boolean, played: boolean) {
  if (batch.settled) return;
  batch.settled = true;
  if (callEnd) batch.onEnd?.();
  batch.resolve(played);
}

export function stopSpeaking() {
  generation++;
  for (const controller of pendingRequests) controller.abort("speech cancelled");
  pendingRequests.clear();
  // An aborted synthesis promise is tied to the old generation. Do not let an
  // immediate replay of the same phrase inherit that rejected promise.
  synthesisInFlight.clear();
  const abandoned = queue;
  queue = [];
  for (const batch of abandoned) settle(batch, false, false);
  if (blockedBatch) settle(blockedBatch, false, false);
  blockedBatch = null;
  if (activeBatch) settle(activeBatch, false, false);
  try { currentSource?.stop(); } catch { /* already ended */ }
  finishCurrentPlayback?.();
  currentSource = null;
  finishCurrentPlayback = null;
  setTtsStatus("ready");
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
): Promise<boolean> {
  const speech = normalizeSpeechText(text);
  if (typeof window === "undefined" || !speech) {
    onEnd?.();
    return false;
  }
  const done = new Promise<boolean>((resolve) => {
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
  return await done;
}

async function drainSpeechQueue(): Promise<void> {
  if (draining || blockedBatch) return;
  draining = true;
  try {
    while (queue.length) {
      const batch = queue.shift()!;
      activeBatch = batch;
      void import("./wakeword").then((module) => module.setSuppressed?.(true, /jarvis/i.test(batch.text))).catch(() => {});
      let started = false;
      let next = batch.segments[0] ? synthesize(batch.segments[0], batch.generation) : null;
      try {
        for (let index = 0; next && index < batch.segments.length; index++) {
          if (batch.generation !== generation) break;
          setTtsStatus("buffering");
          const audio = await next;
          if (batch.generation !== generation) break;
          next = batch.segments[index + 1]
            ? synthesize(batch.segments[index + 1], batch.generation)
            : null;
          const played = await playAudio(
            audio,
            batch.generation,
            batch.onEnergy,
            !started
              ? () => {
                  started = true;
                  trackUtterance(batch.text, Math.min(90_000, batch.text.length * 70));
                  batch.onStart?.();
                }
              : undefined,
          );
          if (!played && batch.generation === generation) throw new Error("Audio playback ended before completion");
          if (!played || batch.generation !== generation) break;
          const pause = index + 1 < batch.segments.length
            ? speechPauseMs(batch.segments[index])
            : 0;
          if (pause) await new Promise((resolve) => setTimeout(resolve, pause));
        }
        if (batch.generation === generation) {
          setTtsStatus("ready");
          settle(batch, true, true);
        } else {
          settle(batch, false, false);
        }
      } catch (error) {
        if (batch.generation === generation) {
          if (isPlaybackBlocked(error)) {
            blockedBatch = batch;
            setTtsStatus("blocked");
            break;
          }
          reportFailure(error);
          settle(batch, true, false);
        } else {
          settle(batch, false, false);
        }
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
    if (queue.length && !blockedBatch) void drainSpeechQueue();
  }
}
