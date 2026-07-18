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
const COMMON_GREETING = "Right here, sir. What's the first thing we're sorting?";
const ECHO_GUARD_TAIL_MS = 45_000;
const primedAudio = new Map<string, HTMLAudioElement>();
const reusableAudio = new WeakMap<HTMLAudioElement, string>();
// Browsers may fetch every byte of a TTS response and still reject play() once
// the short user-activation window has elapsed (especially inside the Project
// Hub iframe). Prime one real, reusable media element while Daniel is actively
// clicking/typing and use that same unlocked element if a later element is
// refused by autoplay policy.
const SILENT_WAV = "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQQAAACAgICA";
let unlockedAudio: HTMLAudioElement | null = null;
let playbackUnlocked = false;
let unlockInFlight = false;
let lastPlaybackFailure = { signature: "", at: 0 };

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

function describeMediaError(audio: HTMLAudioElement): string {
  const error = audio.error;
  if (!error) return "unknown media playback failure";
  return `media error ${error.code}${error.message ? `: ${error.message}` : ""}`;
}

function reportPlaybackFailure(reason: string) {
  if (typeof document === "undefined") return;
  const clean = reason.replace(/\s+/g, " ").slice(0, 240);
  document.documentElement.dataset.jarvisTtsFailure = clean;
  const signature = clean.replace(/https?:\/\/\S+/g, "url").slice(0, 100);
  const now = Date.now();
  if (lastPlaybackFailure.signature === signature && now - lastPlaybackFailure.at < 60_000) return;
  lastPlaybackFailure = { signature, at: now };
  const activation = typeof navigator !== "undefined" && "userActivation" in navigator
    ? `; user activation=${String((navigator as Navigator & { userActivation?: { hasBeenActive?: boolean } }).userActivation?.hasBeenActive)}`
    : "";
  void fetch("/api/incident", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      signature: `client:tts-playback:${signature}`,
      message: `Jarvis generated speech but the browser could not play it: ${clean}; visibility=${document.visibilityState}${activation}`,
    }),
  }).catch(() => {});
}

/** Call synchronously from a genuine pointer/key interaction. */
export function unlockSpeechPlayback(): void {
  if (typeof Audio === "undefined" || playbackUnlocked || unlockInFlight) return;
  const audio = unlockedAudio ?? new Audio(SILENT_WAV);
  unlockedAudio = audio;
  audio.preload = "auto";
  if (currentAudio === audio) return;
  unlockInFlight = true;
  try {
    audio.src = SILENT_WAV;
    const attempt = audio.play();
    void attempt.then(() => {
      playbackUnlocked = true;
      audio.pause();
      try { audio.currentTime = 0; } catch { /* not seekable in this browser */ }
    }).catch(() => {
      // Mount-time warmup has no user gesture and is expected to fail. The
      // pointer/key capture hook retries from a genuine interaction.
    }).finally(() => {
      unlockInFlight = false;
    });
  } catch {
    unlockInFlight = false;
  }
}

function trackUtterance(text: string, durationMs: number) {
  const now = Date.now();
  recentUtterances = recentUtterances.filter((row) => row.until > now);
  // Keep the fingerprint beyond playback, a full microphone window, and STT
  // turnaround so short Jarvis replies cannot return as delayed user turns.
  recentUtterances.push({ text, until: now + durationMs + ECHO_GUARD_TAIL_MS });
}

export function isEchoOfTts(input: string): boolean {
  const now = Date.now();
  recentUtterances = recentUtterances.filter((row) => row.until > now);
  const inputWords = words(input);
  if (!inputWords.length) return false;
  for (const row of recentUtterances) {
    const spokenWords = words(row.text);
    const spoken = new Set(spokenWords);
    if (!spoken.size) continue;
    const matches = inputWords.filter((word) => spoken.has(word)).length;
    // Short Whisper fragments need stricter, not weaker, echo protection. A
    // delayed "Music" extracted from Jarvis saying "Music-house" caused a
    // real self-answering loop in production.
    if (inputWords.length <= 2 && matches === inputWords.length) return true;
    if (matches / inputWords.length >= 0.65) return true;
  }
  return false;
}

// Return only source text whose sentence boundary is stable while tokens are
// still arriving. This lets complex answers begin speaking before the model
// finishes without guessing punctuation for an incomplete clause.
export function completeSpeechPrefix(input: string): string {
  const matches = [...input.matchAll(/[.!?](?:[”"')\]]+)?(?=\s|$)|\n\s*\n/g)];
  const last = matches.at(-1);
  if (!last || last.index == null) return "";
  const end = last.index + last[0].length;
  const prefix = input.slice(0, end);
  return prefix.trim().length >= 18 ? prefix : "";
}

// There is no local model to initialise. Keeping this API lets all voice entry
// points share the same lifecycle without delaying a message after interaction.
export async function warm(): Promise<void> {
  setTtsStatus("ready");
  unlockSpeechPlayback();
  if (typeof window !== "undefined" && !primedAudio.has(COMMON_GREETING)) {
    const audio = makeAudio(COMMON_GREETING);
    reusableAudio.set(audio, COMMON_GREETING);
    primedAudio.set(COMMON_GREETING, audio);
  }
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

// Models write for the eye even when the answer is destined for speech. Neural
// voices handle ordinary punctuation well, but raw markdown, URLs and long dash
// glyphs produce literal or oddly clipped delivery. Keep compound hyphens and
// ISO dates intact while turning visual separators into spoken phrasing.
export function normalizeSpeechText(input: string): string {
  let text = input.normalize("NFKC").replace(/\r\n?/g, "\n");
  text = text
    .replace(/\[([^\]]+)]\((?:https?:\/\/)[^)]+\)/gi, "$1")
    .replace(/https?:\/\/\S+/gi, "the link")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*•▪◦]|\d+[.)])\s+/gm, "")
    .replace(/[`*]+/g, "")
    .replace(/_/g, " ")
    .replace(/\n+/g, ". ");

  // A typographic range should sound like a range. Other em/en dashes are
  // conversational beats, so a comma gives Ryan a pause without saying “dash”.
  text = text
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
  // Clause boundaries keep time-to-first-audio low while preserving natural
  // phrasing. The next clause begins buffering during current playback.
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

function makeAudio(text: string): HTMLAudioElement {
  const params = new URLSearchParams({ text, speed: String(speechSpeed(text)) });
  const audio = new Audio(`/api/tts?${params.toString()}`);
  audio.preload = "auto";
  audio.load?.();
  return audio;
}

function prepareSegment(text: string): HTMLAudioElement {
  const ready = primedAudio.get(text);
  if (ready) {
    primedAudio.delete(text);
    return ready;
  }
  return makeAudio(text);
}

type PlaybackResult = { played: boolean; failure?: string; source: string };

function playAudio(
  audio: HTMLAudioElement,
  expectedGeneration: number,
  onEnergy: (energy: number) => void,
  onStart?: () => void,
): Promise<PlaybackResult> {
  const source = audio.currentSrc || audio.src;
  if (expectedGeneration !== generation) return Promise.resolve({ played: false, source });
  return new Promise((resolve) => {
    currentAudio = audio;
    let timer: ReturnType<typeof setInterval> | null = null;
    let settled = false;
    const finish = (played: boolean, failure?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearInterval(timer);
      if (currentAudio === audio) currentAudio = null;
      if (stopAudioPlayback === stop) stopAudioPlayback = null;
      const reusableText = reusableAudio.get(audio);
      if (reusableText) {
        try { audio.currentTime = 0; } catch { /* not seekable yet */ }
        primedAudio.set(reusableText, audio);
      } else {
        audio.removeAttribute("src");
        audio.load?.();
      }
      onEnergy(0);
      resolve({ played, failure, source });
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
    audio.onerror = () => finish(false, describeMediaError(audio));
    setTtsStatus("buffering");
    void audio.play().catch((error) => finish(false, String(error)));
  });
}

async function playSegment(
  audio: HTMLAudioElement,
  expectedGeneration: number,
  onEnergy: (energy: number) => void,
  onStart?: () => void,
): Promise<boolean> {
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    onStart?.();
  };
  const first = await playAudio(audio, expectedGeneration, onEnergy, start);
  if (first.played || expectedGeneration !== generation || !first.failure) return first.played;

  // Autoplay rejection is per media element on Safari/iOS and embedded Chrome.
  // Retry once on the exact element primed during Daniel's interaction.
  const fallback = playbackUnlocked ? unlockedAudio : null;
  if (fallback && fallback !== audio && first.source) {
    fallback.src = first.source;
    fallback.preload = "auto";
    fallback.load?.();
    const retried = await playAudio(fallback, expectedGeneration, onEnergy, start);
    if (retried.played) {
      if (typeof document !== "undefined") delete document.documentElement.dataset.jarvisTtsFailure;
      return true;
    }
    if (expectedGeneration === generation && retried.failure) {
      reportPlaybackFailure(`${first.failure}; unlocked retry failed: ${retried.failure}`);
    }
    return false;
  }

  reportPlaybackFailure(first.failure);
  return false;
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
    queue.push({ generation, text: speech, segments: sentences(speech), onEnergy, onStart, onEnd, resolve });
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
        const pause = speechPauseMs(batch.segments[index]);
        if (played && pause > 0 && batch.generation === generation) {
          await new Promise<void>((resolve) => setTimeout(resolve, pause));
        }
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
