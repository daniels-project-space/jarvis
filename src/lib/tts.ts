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

async function playBuffer(arr: ArrayBuffer, onEnergy: (e: number) => void): Promise<void> {
  const c = ctx();
  await c.resume();
  const decoded = await c.decodeAudioData(arr);
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
  try {
    let pending: Promise<ArrayBuffer | null> | null = null;
    while ((queue.length || pending) && gen === generation) {
      const cur = pending ?? (queue.length ? fetchAudio(queue.shift()!) : null);
      pending = queue.length ? fetchAudio(queue.shift()!) : null; // prefetch next while current plays
      if (!cur) break;
      const buf = await cur;
      if (gen !== generation) break;
      if (buf) await playBuffer(buf, onEnergy);
    }
  } catch {
    /* audio errors are non-fatal */
  }
  draining = false;
  onEnergy(0);
  onEnd?.();
}
