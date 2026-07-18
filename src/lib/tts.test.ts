import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  completeSpeechPrefix,
  isEchoOfTts,
  normalizeSpeechText,
  primeSpeech,
  sentences,
  speak,
  speechPauseMs,
  stopSpeaking,
  unlockSpeechPlayback,
  warm,
} from "./tts";

class FakeWorker {
  static instances: FakeWorker[] = [];
  static failNextSynthesis = false;
  static synthesisCount = 0;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  syntheses: string[] = [];

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(message: { type: string; id?: number; text?: string }) {
    queueMicrotask(() => {
      if (message.type === "warm") {
        this.onmessage?.({ data: { type: "ready" } } as MessageEvent);
      } else if (message.type === "synthesize") {
        FakeWorker.synthesisCount += 1;
        this.syntheses.push(message.text ?? "");
        if (FakeWorker.failNextSynthesis) {
          FakeWorker.failNextSynthesis = false;
          this.onmessage?.({ data: { type: "error", id: message.id, message: "transient generation error" } } as MessageEvent);
          return;
        }
        const audio = new Float32Array(2_400);
        audio.fill(0.2);
        this.onmessage?.({
          data: { type: "audio", id: message.id, sampleRate: 24_000, audio: audio.buffer },
        } as MessageEvent);
      }
    });
  }

  terminate() {}
}

class FakeSource {
  static instances: FakeSource[] = [];
  buffer: unknown = null;
  onended: (() => void) | null = null;

  constructor() {
    FakeSource.instances.push(this);
  }

  connect() {}
  disconnect() {}
  start() {}
  stop() { this.onended?.(); }
}

class FakeAnalyser {
  fftSize = 128;
  frequencyBinCount = 64;
  connect() {}
  disconnect() {}
  getByteFrequencyData(levels: Uint8Array) { levels.fill(32); }
}

class FakeAudioContext {
  state = "running";
  destination = {};
  resume = vi.fn(async () => { this.state = "running"; });
  createBuffer() {
    return { copyToChannel: vi.fn() };
  }
  createBufferSource() { return new FakeSource(); }
  createAnalyser() { return new FakeAnalyser(); }
}

describe("single Kokoro speech queue", () => {
  beforeEach(() => {
    FakeSource.instances = [];
    FakeWorker.failNextSynthesis = false;
    FakeWorker.synthesisCount = 0;
    vi.stubGlobal("Worker", FakeWorker);
    vi.stubGlobal("window", { AudioContext: FakeAudioContext });
  });

  afterEach(() => {
    stopSpeaking();
    vi.restoreAllMocks();
  });

  it("keeps complete sentences for neural generation", () => {
    expect(sentences("First complete sentence. Second complete sentence."))
      .toEqual(["First complete sentence.", "Second complete sentence."]);
  });

  it("starts a short complete opening without waiting for the next sentence", () => {
    expect(sentences("Right here, sir. What's the first thing we're sorting?"))
      .toEqual(["Right here, sir.", "What's the first thing we're sorting?"]);
  });

  it("bounds long neural requests without losing spoken content", () => {
    const input = "This deliberately long sentence explains the entire plan in enough detail that a single neural generation request would otherwise become slow and timeout-prone on a browser without a hardware GPU, while every word must still be spoken in order.";
    const chunks = sentences(input);
    expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThanOrEqual(84);
    expect(chunks.join(" ")).toBe(normalizeSpeechText(input));
  });

  it("turns visual dash marks into natural phrasing without breaking compound words", () => {
    expect(normalizeSpeechText("Right — that is the real-time fix -- ship it"))
      .toBe("Right, that is the real-time fix, ship it.");
    expect(normalizeSpeechText("Budget: 5–10 pounds"))
      .toBe("Budget: 5 to 10 pounds.");
  });

  it("removes speech-hostile presentation syntax and supplies a sentence ending", () => {
    expect(normalizeSpeechText("**Done**… details: https://example.com/report"))
      .toBe("Done, details: the link.");
    expect(normalizeSpeechText("Open project_hub"))
      .toBe("Open project hub.");
    expect(sentences("This answer arrived without punctuation"))
      .toEqual(["This answer arrived without punctuation."]);
  });

  it("gives complete sentence endings a longer pause than clause endings", () => {
    expect(speechPauseMs("One thought,")).toBeLessThan(speechPauseMs("That is the answer."));
    expect(speechPauseMs("Is that right?")).toBeGreaterThanOrEqual(150);
  });

  it("exposes only stable complete sentences during token streaming", () => {
    expect(completeSpeechPrefix("I have the first answer. The second is still"))
      .toBe("I have the first answer.");
    expect(completeSpeechPrefix("Still thinking")).toBe("");
  });

  it("blocks short delayed fragments of Jarvis's own speech", async () => {
    const reply = speak("Music-house is the sensible next move.", () => {});
    await vi.waitFor(() => expect(FakeSource.instances).toHaveLength(1));
    expect(isEchoOfTts("Music")).toBe(true);
    stopSpeaking();
    await reply;
  });

  it("keeps a spoken reply guarded through capture and transcription latency", async () => {
    const startedAt = 1_000_000;
    vi.spyOn(Date, "now").mockReturnValue(startedAt);
    const reply = speak("Right here, sir. What's the first thing we're sorting?", () => {});
    await vi.waitFor(() => expect(FakeSource.instances).toHaveLength(1));
    vi.spyOn(Date, "now").mockReturnValue(startedAt + 40_000);
    expect(isEchoOfTts("Right here sir, what's the first thing we're sorting?"))
      .toBe(true);
    stopSpeaking();
    await reply;
  });

  it("does not resolve a queued reply before its PCM playback has finished", async () => {
    const first = speak("The first reply is playing.", () => {});
    await vi.waitFor(() => expect(FakeSource.instances).toHaveLength(1));
    let secondFinished = false;
    const second = speak("The second reply waits its turn.", () => {}).then(() => {
      secondFinished = true;
    });
    await Promise.resolve();
    expect(secondFinished).toBe(false);
    FakeSource.instances[0].onended?.();
    await first;
    await vi.waitFor(() => expect(FakeSource.instances).toHaveLength(2));
    expect(secondFinished).toBe(false);
    FakeSource.instances[1].onended?.();
    await second;
    expect(secondFinished).toBe(true);
  });

  it("warms the worker without spending an audio playback attempt", async () => {
    const sourcesBefore = FakeSource.instances.length;
    await warm();
    expect(FakeSource.instances).toHaveLength(sourcesBefore);
  });

  it("primes courtesy audio once and reuses it without another synthesis", async () => {
    const courtesy = "A uniquely cached courtesy reply.";
    await primeSpeech([courtesy]);
    expect(FakeWorker.synthesisCount).toBe(1);
    const reply = speak(courtesy, () => {});
    await vi.waitFor(() => expect(FakeSource.instances).toHaveLength(1));
    expect(FakeWorker.synthesisCount).toBe(1);
    FakeSource.instances[0].onended?.();
    await reply;
  });

  it("uses Web Audio only and never invokes a browser speech fallback", async () => {
    const browserSpeak = vi.fn();
    vi.stubGlobal("speechSynthesis", { speak: browserSpeak });
    unlockSpeechPlayback();
    const reply = speak("There is exactly one voice engine.", () => {});
    await vi.waitFor(() => expect(FakeSource.instances).toHaveLength(1));
    expect(browserSpeak).not.toHaveBeenCalled();
    FakeSource.instances[0].onended?.();
    await reply;
  });

  it("retries one transient neural generation failure without changing engines", async () => {
    FakeWorker.failNextSynthesis = true;
    const reply = speak("Recover the same neural voice once.", () => {});
    await vi.waitFor(() => expect(FakeSource.instances).toHaveLength(1));
    expect(FakeWorker.synthesisCount).toBe(2);
    FakeSource.instances[0].onended?.();
    await reply;
  });
});
