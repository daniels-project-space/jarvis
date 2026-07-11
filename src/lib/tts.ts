"use client";
// Client voice: fetches server-rendered Kokoro fp32 audio from /api/tts and plays
// it through WebAudio, driving the orb from live amplitude. No in-browser model →
// no iOS WASM garbling. stopSpeaking() enables barge-in in the always-on loop.

let audioCtx: AudioContext | null = null;
let unlocked = false;
let currentSrc: AudioBufferSourceNode | null = null;

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
  try {
    currentSrc?.stop();
  } catch {
    /* already stopped */
  }
  currentSrc = null;
}

export async function speak(
  text: string,
  onEnergy: (e: number) => void,
  onStart?: () => void,
  onEnd?: () => void,
): Promise<void> {
  try {
    const r = await fetch("/api/tts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) throw new Error("tts " + r.status);
    const arr = await r.arrayBuffer();
    const c = ctx();
    await c.resume();
    const decoded = await c.decodeAudioData(arr);
    stopSpeaking();
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
      onEnd?.();
    };
    onStart?.();
    src.start();
    tick();
  } catch (e) {
    console.error("tts failed", e);
    onEnergy(0);
    onEnd?.();
  }
}
