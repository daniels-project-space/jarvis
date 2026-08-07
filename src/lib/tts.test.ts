import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  completeSpeechPrefix,
  isEchoOfTts,
  normalizeSpeechText,
  sentences,
  speak,
  speechPauseMs,
  stopSpeaking,
  unlockSpeechPlayback,
  warm,
} from "./tts";

let failNextSynthesis = false;
let synthesisCount = 0;
let warmCount = 0;

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
  decodeAudioData = vi.fn(async () => ({ duration: 1.2 }));
  createBufferSource() { return new FakeSource(); }
  createAnalyser() { return new FakeAnalyser(); }
}

describe("single Edge neural speech queue", () => {
  beforeEach(() => {
    FakeSource.instances = [];
    failNextSynthesis = false;
    synthesisCount = 0;
    warmCount = 0;
    vi.stubGlobal("window", {
      AudioContext: FakeAudioContext,
      location: { origin: "https://jarvis.test" },
      setTimeout,
      clearTimeout,
    });
    vi.stubGlobal("document", { documentElement: { dataset: {} } });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/tts" && init?.method === "GET") {
        warmCount += 1;
        return new Response(null, { status: 204 });
      }
      if (url === "/api/tts") {
        synthesisCount += 1;
        if (failNextSynthesis) {
          failNextSynthesis = false;
          return Response.json({ error: "transient service error" }, { status: 502 });
        }
        return new Response(new Uint8Array(2_400), {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        });
      }
      return Response.json({ ok: true });
    }));
  });

  afterEach(() => {
    stopSpeaking();
    vi.restoreAllMocks();
  });

  it("keeps an ordinary multi-sentence reply in one neural generation", () => {
    expect(sentences("First complete sentence. Second complete sentence."))
      .toEqual(["First complete sentence. Second complete sentence."]);
  });

  it("does not introduce a decode seam between two short spoken thoughts", () => {
    expect(sentences("Right here, sir. What's the first thing we're sorting?"))
      .toEqual(["Right here, sir. What's the first thing we're sorting?"]);
  });

  it("bounds long neural requests without losing spoken content", () => {
    const input = "This deliberately long sentence explains the entire plan in enough detail that a single neural generation request would otherwise become slow and timeout-prone on a browser without a hardware GPU, while every word must still be spoken in order.";
    const chunks = sentences(input);
    expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThanOrEqual(240);
    expect(chunks.length).toBeLessThanOrEqual(2);
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

  it("keeps only a short boundary pause between separately generated chunks", () => {
    expect(speechPauseMs("One thought,")).toBeLessThan(speechPauseMs("That is the answer."));
    expect(speechPauseMs("Is that right?")).toBeLessThanOrEqual(45);
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

  it("does not resolve a queued reply before its decoded playback has finished", async () => {
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

  it("warms the cloud route without spending an audio playback attempt", async () => {
    const sourcesBefore = FakeSource.instances.length;
    await warm();
    expect(FakeSource.instances).toHaveLength(sourcesBefore);
    expect(warmCount).toBe(1);
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

  it("makes one bounded neural generation attempt on a transport failure", async () => {
    failNextSynthesis = true;
    const reply = speak("Surface the single request failure.", () => {});
    await vi.waitFor(() => expect(synthesisCount).toBe(1));
    expect(FakeSource.instances).toHaveLength(0);
    await expect(reply).resolves.toBe(false);
    expect(document.documentElement.dataset.jarvisTts).toBe("unavailable");
    expect(document.documentElement.dataset.jarvisTtsFailure).toMatch(/transient service error/i);
  });

  it("cancels the one in-flight neural request without a fallback attempt", async () => {
    let aborted = false;
    let started = 0;
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      started += 1;
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new DOMException("cancelled", "AbortError"));
      }, { once: true });
    })));
    const reply = speak("Cancel the active neural phrase.", () => {});
    await vi.waitFor(() => expect(started).toBe(1));
    stopSpeaking();
    await reply;
    expect(aborted).toBe(true);
    expect(started).toBe(1);
  });
});
