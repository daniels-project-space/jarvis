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

// Boot the server TTS model early. Kokoro cold-starts on Replicate (~4s vs ~1.5s
// warm); firing a tiny synth the moment Daniel sends/taps mic boots the container
// IN PARALLEL with the LLM turn, so the real read-out lands warm. Throttled — a
// live conversation keeps it warm on its own, so this only bites the first turn
// after an idle gap.
let lastPrewarm = 0;
export function prewarmTts() {
  const now = Date.now();
  if (now - lastPrewarm < 45_000) return;
  lastPrewarm = now;
  try {
    const provider = typeof localStorage !== "undefined" ? localStorage.getItem("jarvis_tts") || "free" : "free";
    if (provider === "fast") return; // browser voice has no server to warm
    fetch("/api/tts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: ".", provider }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* ignore */
  }
}

// Call on a user gesture (send/mic tap) to unlock autoplay on iOS.
export async function warm() {
  prewarmTts();
  try {
    // preload speech voices (getVoices is async on first load) so the fast
    // path has its British voice ready instantly
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.getVoices();
      window.speechSynthesis.onvoiceschanged = () => {
        cachedVoice = null;
        window.speechSynthesis.getVoices();
      };
    }
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
  try {
    window.speechSynthesis?.cancel();
  } catch {
    /* ignore */
  }
}

// Instant on-device voice (Web Speech API): ZERO network latency — this is the
// "fast" path. Picks the best British male voice available, drives the orb with
// a synthetic amplitude, and honours barge-in via generation.
let cachedVoice: SpeechSynthesisVoice | null = null;
function pickVoice(): SpeechSynthesisVoice | null {
  if (cachedVoice) return cachedVoice;
  const vs = window.speechSynthesis?.getVoices?.() ?? [];
  if (!vs.length) return null;
  const pref = [
    /Google UK English Male/i, /en-GB.*(Ryan|George|Daniel|Arthur)/i, /Daniel/i, /(George|Arthur).*en-?GB/i,
    /Microsoft (Ryan|George|Thomas)/i, /en-GB/i, /British/i, /Google US English/i,
  ];
  for (const p of pref) {
    const v = vs.find((x) => p.test(`${x.name} ${x.lang}`));
    if (v) return (cachedVoice = v);
  }
  return (cachedVoice = vs.find((x) => /^en/i.test(x.lang)) ?? vs[0] ?? null);
}
function speakBrowser(text: string, onEnergy: (e: number) => void, onStart?: () => void, onEnd?: () => void): Promise<void> {
  return new Promise((resolve) => {
    const synth = window.speechSynthesis;
    if (!synth) return resolve();
    const gen = generation;
    const u = new SpeechSynthesisUtterance(text);
    const v = pickVoice();
    if (v) u.voice = v;
    u.lang = v?.lang || "en-GB";
    u.rate = 1.04;
    u.pitch = 1.0;
    let energyTimer: ReturnType<typeof setInterval> | null = null;
    let t0 = 0;
    u.onstart = () => {
      onStart?.();
      t0 = performance.now();
      // synthetic mouth-movement amplitude for the orb (no real analyser here)
      energyTimer = setInterval(() => {
        if (gen !== generation) return;
        const e = 0.28 + 0.32 * Math.abs(Math.sin((performance.now() - t0) / 130)) * (0.6 + 0.4 * Math.random());
        onEnergy(Math.min(1, e));
      }, 60);
    };
    const done = () => {
      if (energyTimer) clearInterval(energyTimer);
      onEnergy(0);
      onEnd?.();
      resolve();
    };
    u.onend = done;
    u.onerror = done;
    if (gen !== generation) return resolve();
    synth.speak(u);
  });
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
    const provider = typeof localStorage !== "undefined" ? localStorage.getItem("jarvis_tts") || undefined : undefined;
    const r = await fetch("/api/tts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, provider }),
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
  trackUtterance(text, Math.min(90_000, text.length * 70)); // whole-utterance echo window (appended text too)
  // FAST PATH (default): instant on-device speech, zero network round-trip.
  // Kokoro on Replicate cold-starts for many seconds — this is why JARVIS
  // "took too long to talk". Hosted providers stay available in options.
  const provider = typeof localStorage !== "undefined" ? localStorage.getItem("jarvis_tts") || "free" : "free";
  if (provider === "fast" && typeof window !== "undefined" && window.speechSynthesis) {
    if (draining) {
      if (/jarvis/i.test(text)) import("./wakeword").then((m) => m.setSuppressed?.(true, true)).catch(() => {});
      queue.push(...sentences(text));
      return;
    }
    draining = true;
    const fgen = generation;
    import("./wakeword").then((m) => m.setSuppressed?.(true, /jarvis/i.test(text))).catch(() => {});
    await speakBrowser(text, onEnergy, onStart, onEnd);
    // drain any sentences appended mid-speech (barge-in bumps generation)
    while (queue.length && generation === fgen) {
      const next = queue.shift()!;
      await speakBrowser(next, onEnergy);
    }
    draining = false;
    setTimeout(() => import("./wakeword").then((m) => m.setSuppressed?.(false)).catch(() => {}), 700);
    return;
  }
  queue.push(...sentences(text));
  if (draining) {
    // the first caller's drain loop speaks this text — but if it contains
    // "jarvis", escalate the wake gate to HARD or the readout self-wakes
    if (/jarvis/i.test(text)) import("./wakeword").then((m) => m.setSuppressed?.(true, true)).catch(() => {});
    return;
  }
  draining = true;
  const gen = generation;
  onStart?.();
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
