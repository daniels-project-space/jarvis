"use client";

import { viewerFetchWithTimeout } from "./viewer-request";

const TARGET_SAMPLE_RATE = 16_000;
const PCM_FRAME_BYTES = TARGET_SAMPLE_RATE / 10 * 2; // 100 ms, matching Sherpa's reference client cadence.
const CONNECT_TIMEOUT_MS = 2_500;
const FINAL_TIMEOUT_MS = 900;
const MAX_BUFFERED_AUDIO_BYTES = TARGET_SAMPLE_RATE * 2 * 5;

// A build-time opt-in keeps already deployed Jarvis instances on their proven
// browser/recorded-audio path until the separate WSS host is actually ready.
export const selfHostedStreamingSpeechEnabled = process.env.NEXT_PUBLIC_SELF_HOSTED_STREAMING_STT === "1";

type StreamTicket = { url: string; ticket: string; expiresAt: number; sampleRate: number };
type SpeechMessage = { type?: unknown; text?: unknown; sampleRate?: unknown };

export type SelfHostedStreamingSpeech = {
  finish: () => Promise<string>;
  stop: () => void;
};

function normalizedText(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function pcm16(samples: Float32Array, inputRate: number): ArrayBuffer {
  const rate = Number.isFinite(inputRate) && inputRate > 0 ? inputRate : TARGET_SAMPLE_RATE;
  const frames = Math.max(1, Math.round(samples.length * TARGET_SAMPLE_RATE / rate));
  const output = new Int16Array(frames);
  for (let index = 0; index < frames; index += 1) {
    const position = index * rate / TARGET_SAMPLE_RATE;
    const left = Math.min(samples.length - 1, Math.floor(position));
    const right = Math.min(samples.length - 1, left + 1);
    const fraction = position - left;
    const value = samples[left]! * (1 - fraction) + samples[right]! * fraction;
    output[index] = Math.max(-1, Math.min(1, value)) * 0x7fff;
  }
  return output.buffer;
}

async function ticket(): Promise<StreamTicket | null> {
  try {
    const response = await viewerFetchWithTimeout("/api/voice/stream-ticket", { method: "POST" }, CONNECT_TIMEOUT_MS);
    if (!response.ok) return null;
    const value = await response.json() as Partial<StreamTicket>;
    if (
      typeof value.url !== "string"
      || typeof value.ticket !== "string"
      || typeof value.expiresAt !== "number"
      || value.expiresAt <= Date.now()
      || value.sampleRate !== TARGET_SAMPLE_RATE
    ) return null;
    return value as StreamTicket;
  } catch {
    return null;
  }
}

/**
 * Optional CPU-hosted partial transcription. It is deliberately isolated from
 * command submission: only `finish()` may supply an authoritative transcript.
 */
export function startSelfHostedStreamingSpeech(args: {
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  onPartial: (text: string) => void;
}): SelfHostedStreamingSpeech {
  let socket: WebSocket | null = null;
  let processor: ScriptProcessorNode | null = null;
  let muted: GainNode | null = null;
  let stopped = false;
  let ended = false;
  let finalText = "";
  let resolveFinal: (text: string) => void = () => {};
  const final = new Promise<string>((resolve) => { resolveFinal = resolve; });
  const queued: ArrayBuffer[] = [];
  let queuedBytes = 0;
  let frameParts: ArrayBuffer[] = [];
  let frameBytes = 0;
  let started = false;

  const detach = () => {
    processor?.disconnect();
    muted?.disconnect();
    processor = null;
    muted = null;
  };
  const settle = (text = "") => {
    if (stopped) return;
    stopped = true;
    detach();
    try { socket?.close(); } catch { /* already closed */ }
    socket = null;
    resolveFinal(normalizedText(text));
  };
  const join = (parts: ArrayBuffer[], length: number): ArrayBuffer => {
    const output = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      output.set(new Uint8Array(part), offset);
      offset += part.byteLength;
    }
    return output.buffer;
  };
  const flushAudioFrame = () => {
    if (!frameBytes || stopped) return;
    const audio = join(frameParts, frameBytes);
    frameParts = [];
    frameBytes = 0;
    if (stopped) return;
    if (socket?.readyState === WebSocket.OPEN && started) {
      socket.send(audio);
      return;
    }
    if (queuedBytes + audio.byteLength > MAX_BUFFERED_AUDIO_BYTES) {
      const oldest = queued.shift();
      queuedBytes -= oldest?.byteLength ?? 0;
    }
    queued.push(audio);
    queuedBytes += audio.byteLength;
  };
  const sendAudio = (audio: ArrayBuffer) => {
    if (stopped) return;
    frameParts.push(audio);
    frameBytes += audio.byteLength;
    if (frameBytes >= PCM_FRAME_BYTES) flushAudioFrame();
  };

  // ScriptProcessor is supported in the browsers that support this app's
  // existing MediaRecorder path. The muted destination keeps its callback
  // alive without replaying microphone audio to the speaker.
  processor = args.context.createScriptProcessor(2048, 1, 1);
  muted = args.context.createGain();
  muted.gain.value = 0;
  processor.onaudioprocess = (event) => {
    if (stopped || ended) return;
    sendAudio(pcm16(event.inputBuffer.getChannelData(0), args.context.sampleRate));
  };
  args.source.connect(processor);
  processor.connect(muted);
  muted.connect(args.context.destination);

  void ticket().then((issued) => {
    if (!issued || stopped) return settle();
    try {
      socket = new WebSocket(issued.url);
      socket.binaryType = "arraybuffer";
      const timeout = window.setTimeout(() => {
        if (!started) settle();
      }, CONNECT_TIMEOUT_MS);
      socket.onopen = () => {
        if (!socket || stopped) return;
        socket.send(JSON.stringify({ type: "auth", ticket: issued.ticket }));
      };
      socket.onmessage = (event) => {
        const message = typeof event.data === "string"
          ? (() => { try { return JSON.parse(event.data) as SpeechMessage; } catch { return null; } })()
          : null;
        if (!message || typeof message.type !== "string") return;
        if (message.type === "ready") {
          if (message.sampleRate !== TARGET_SAMPLE_RATE || !socket || stopped) return settle();
          window.clearTimeout(timeout);
          started = true;
          for (const audio of queued.splice(0)) socket.send(audio);
          queuedBytes = 0;
          flushAudioFrame();
          if (ended) socket.send(JSON.stringify({ type: "end" }));
          return;
        }
        const text = normalizedText(message.text);
        if (message.type === "partial" && text && !ended) args.onPartial(text);
        if (message.type === "final") {
          finalText = text;
          settle(finalText);
        }
      };
      socket.onerror = () => settle();
      socket.onclose = () => {
        window.clearTimeout(timeout);
        if (!stopped) settle(finalText);
      };
    } catch {
      settle();
    }
  });

  return {
    stop: () => settle(),
    finish: async () => {
      if (stopped) return await final;
      ended = true;
      // Never make an existing voice turn wait on a host that is absent, cold,
      // or still opening. The recorded-audio path remains immediately eligible.
      if (!started) return "";
      flushAudioFrame();
      if (started && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "end" }));
      const timeout = new Promise<string>((resolve) => window.setTimeout(() => resolve(""), FINAL_TIMEOUT_MS));
      const text = await Promise.race([final, timeout]);
      if (!text) settle();
      return text;
    },
  };
}

export { pcm16 as downsamplePcm16ForTest };
