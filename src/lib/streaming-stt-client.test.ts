import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

import { downsamplePcm16ForTest } from "./streaming-stt-client";

describe("self-hosted streaming speech browser PCM", () => {
  it("converts browser mono audio to bounded 16k signed PCM without a vendor SDK", () => {
    const output = new Int16Array(downsamplePcm16ForTest(new Float32Array([-1, 0, 1]), 16_000));
    expect([...output]).toEqual([-32_767, 0, 32_767]);

    const downsampled = new Int16Array(downsamplePcm16ForTest(new Float32Array([0, 1, 0, -1]), 32_000));
    expect(downsampled.length).toBe(2);
    expect(downsampled[0]).toBe(0);
    expect(downsampled[1]).toBe(0);
  });

  it("ships the low-jitter AudioWorklet capture processor used before the legacy fallback", () => {
    const worklet = readFileSync(resolve(process.cwd(), "public/streaming-stt-capture.worklet.js"), "utf8");
    expect(worklet).toContain("class JarvisStreamingSttCaptureProcessor extends AudioWorkletProcessor");
    expect(worklet).toContain('registerProcessor("jarvis-streaming-stt-capture", JarvisStreamingSttCaptureProcessor)');
    expect(worklet).toContain("const PCM_FRAME_SAMPLES = TARGET_SAMPLE_RATE / 10");
  });

  it("buffers pre-roll locally and exposes an explicit speech-confirmed connection gate", () => {
    const client = readFileSync(resolve(process.cwd(), "src/lib/streaming-stt-client.ts"), "utf8");
    const live = readFileSync(resolve(process.cwd(), "src/components/JarvisUI.tsx"), "utf8");
    const turn = live.slice(live.indexOf("async function freeVoiceTurn()"), live.indexOf("async function toggleMic()"));

    expect(client).toContain("activate: () => void");
    expect(client).toContain("if (connectionRequested || stopped) return");
    expect(client).toContain("const queued: ArrayBuffer[] = []");
    expect(turn.indexOf("prepareSelfHostedStream();")).toBeLessThan(turn.indexOf("const poll = setInterval"));
    expect(turn).toContain("selfHostedStreaming.current?.activate()");
  });

  it.each([16_000, 44_100, 48_000])("resamples one second of %i Hz microphone audio to exactly 16 kHz", (inputRate) => {
    const worklet = readFileSync(resolve(process.cwd(), "public/streaming-stt-capture.worklet.js"), "utf8");
    const output: ArrayBuffer[] = [];
    class Processor {
      port = {
        onmessage: null as ((event: { data: unknown }) => void) | null,
        postMessage: (value: unknown) => {
          if (value instanceof ArrayBuffer) output.push(value);
        },
      };
    }
    let Registered: (new () => Processor & { process: (inputs: Float32Array[][]) => boolean }) | null = null;
    runInNewContext(worklet, {
      AudioWorkletProcessor: Processor,
      Float32Array,
      Int16Array,
      Math,
      sampleRate: inputRate,
      registerProcessor: (_name: string, value: new () => Processor & { process: (inputs: Float32Array[][]) => boolean }) => {
        Registered = value;
      },
    });
    const processor = new (Registered!)();
    for (let offset = 0; offset < inputRate; offset += 128) {
      const length = Math.min(128, inputRate - offset);
      const samples = new Float32Array(length);
      for (let index = 0; index < length; index += 1) samples[index] = Math.sin((offset + index) / 17);
      processor.process([[samples]]);
    }
    processor.port.onmessage?.({ data: { type: "flush" } });
    expect(output.reduce((total, frame) => total + frame.byteLength / 2, 0)).toBe(16_000);
    expect(output.every((frame) => frame.byteLength <= 3_200)).toBe(true);
  });
});
