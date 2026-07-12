"use client";
// Text-lane voice: fetches ElevenLabs/Kokoro audio from /api/tts and plays it
// through WebAudio with a sentence queue, driving the orb from live amplitude.
// stopSpeaking() halts playback instantly (stop button / barge-in).

let audioCtx: AudioContext | null = null;
let unlocked = false;
let currentSrc: AudioBufferSourceNode | null = null;
let queue: string[] = [];
let draining = false;
let generation = 0; // bumped on stop — cancels queued sentences

// ── self-trigger protection ─────────────────────────────────────────────────
// WebAudio output escapes the browser's echo canceller on some platforms, so
// the mic can hear JARVIS talk. Industry-standard fix: gate input detectors
// while speaking AND drop transcripts that match what was just said.
type Recent = { text: string; until: number };
let recentUtterances: Recent[] = [];
const norm = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9\s']/g, " ").split(/\s+/).filter((w) => w.length > 1);
function trackUtterance(text: string, durMs: number) {
  const now = Date.now();
  recentUtterances = recentUtterances.filter((r) => r.until > now);
  recentUtterances.push({ text, until: now + durMs + 5000 });
}
// True when `input` is (mostly) an echo of something JARVIS spoke recently.
export function isEchoOfTts(input: string): boolean {
  const now = Date.now();
  recentUtterances = recentUtterances.filter((r) => r.until > now);
  const inTok = norm(input);
  if (inTok.length < 3) return false; // short commands ("stop", "yes") always pass
  for (const r of recentUtterances) {
    const spoken = new Set(norm(r.text));
    if (!spoken.size) continue;
    const hits = inTok.filter((t) => spoken.has(t)).length;
    if (hits / inTok.length >= 0.65) return true;
  }
  return false;
}

function ctx(): AudioContext {
  if (!audioCtx) audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  return audioCtx;
}

// Call on a user gesture (send/mic tap) to unlock autoplay on iOS.
export async function warm() {
  try {
    const c = ctx();
    await c.resume();
    if (!unlocked) {
      const b = c.createBuffer(1, 1, 22050);
      const s = c.createBufferSource();
      s.buffer = b;
      s.connect(c.destination);
      s.start(0);
      unlocked = true;
    }
  } catch {
    /* ignore */
  }
}

export function stopSpeaking() {
  generation++;
  queue = [];
  try {
    currentSrc?.stop();
  } catch {
    /* already stopped */
  }
  currentSrc = null;
}

export function isSpeaking() {
  return draining || currentSrc !== null;
}

// Split text into speakable chunks (sentence boundaries, abbreviation-safe).
export function sentences(text: string): string[] {
  const out: string[] = [];
  let buf = "";
  for (const part of text.split(/(?<=[.!?])\s+(?=[A-Z0-9£"'])/)) {
    buf = buf ? `${buf} ${part}` : part;
    if (buf.length >= 24) {
      out.push(buf);
      buf = "";
    }
  }
  if (buf.trim()) out.push(buf);
  return out;
}

async function playBuffer(arr: ArrayBuffer, onEnergy: (e: number) => void, spokenText?: string): Promise<void> {
  const c = ctx();
  await c.resume();
  const decoded = await c.decodeAudioData(arr);
  if (spokenText) trackUtterance(spokenText, decoded.duration * 1000);
  return new Promise((resolve) => {
    const src = c.createBufferSource();
    src.buffer = decoded;
    const analyser = c.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);
    analyser.connect(c.destination);
    const data = new Uint8Array(analyser.frequencyBinCount);
    currentSrc = src;
    let playing = true;
    const tick = () => {
      if (!playing) return;
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const v of data) {
        const n = (v - 128) / 128;
        sum += n * n;
      }
      onEnergy(Math.min(1, Math.sqrt(sum / data.length) * 3));
      requestAnimationFrame(tick);
    };
    src.onended = () => {
      playing = false;
      onEnergy(0);
      if (currentSrc === src) currentSrc = null;
      resolve();
    };
    src.start();
    tick();
  });
}

async function fetchAudio(text: string): Promise<ArrayBuffer | null> {
  try {
    const r = await fetch("/api/tts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) return null;
    return await r.arrayBuffer();
  } catch {
    return null;
  }
}

// Queue sentences and drain sequentially, prefetching the next while speaking.
export async function speak(
  text: string,
  onEnergy: (e: number) => void,
  onStart?: () => void,
  onEnd?: () => void,
): Promise<void> {
  queue.push(...sentences(text));
  if (draining) return;
  draining = true;
  const gen = generation;
  onStart?.();
  trackUtterance(text, Math.min(90_000, text.length * 70)); // whole-utterance echo window
  // Gate the wake detector while speaking: HARD if the reply itself contains
  // "jarvis" (would self-wake), SOFT otherwise — so Daniel saying a bare
  // "hey jarvis" still barges in and shuts him up.
  import("./wakeword").then((m) => m.setSuppressed?.(true, /jarvis/i.test(text))).catch(() => {});
  let pendingText = "";
  let pending: Promise<ArrayBuffer | null> | null = null;
  while ((queue.length || pending) && gen === generation) {
    const curText = pending ? pendingText : queue[0] ?? "";
    const cur = pending ?? (queue.length ? fetchAudio(queue.shift()!) : null);
    pendingText = queue[0] ?? "";
    pending = queue.length ? fetchAudio(queue.shift()!) : null; // prefetch next while current plays
    if (!cur) break;
    try {
      const buf = await cur;
      if (gen !== generation) break;
      if (buf) await playBuffer(buf, onEnergy, curText);
    } catch {
      // ONE bad audio chunk (decode hiccup, truncated stream) must not kill the
      // rest of the read-out — skip the sentence and carry on
    }
  }
  draining = false;
  onEnergy(0);
  setTimeout(() => import("./wakeword").then((m) => m.setSuppressed?.(false)).catch(() => {}), 900);
  onEnd?.();
}
