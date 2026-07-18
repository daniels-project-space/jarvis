import { afterEach, describe, expect, it, vi } from "vitest";
import { completeSpeechPrefix, isEchoOfTts, normalizeSpeechText, sentences, speak, speechPauseMs, stopSpeaking } from "./tts";

class FakeAudio {
  static instances: FakeAudio[] = [];
  onplay: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  src: string;

  constructor(src: string) {
    this.src = src;
    FakeAudio.instances.push(this);
  }

  async play() {
    this.onplay?.();
  }

  pause() {}
  removeAttribute() {}
}

describe("single neural speech queue", () => {
  afterEach(() => {
    stopSpeaking();
    FakeAudio.instances = [];
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps complete sentences for neural generation", () => {
    expect(sentences("First complete sentence. Second complete sentence."))
      .toEqual(["First complete sentence.", "Second complete sentence."]);
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
    vi.stubGlobal("window", {});
    vi.stubGlobal("Audio", FakeAudio);
    const reply = speak("Music-house is the sensible next move.", () => {});
    await vi.waitFor(() => expect(FakeAudio.instances).toHaveLength(1));
    expect(isEchoOfTts("Music")).toBe(true);
    stopSpeaking();
    await reply;
  });

  it("keeps a spoken reply guarded through capture and transcription latency", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("Audio", FakeAudio);
    const startedAt = 1_000_000;
    vi.spyOn(Date, "now").mockReturnValue(startedAt);

    const reply = speak("Right here, sir. What's the first thing we're sorting?", () => {});
    await vi.waitFor(() => expect(FakeAudio.instances).toHaveLength(1));
    vi.spyOn(Date, "now").mockReturnValue(startedAt + 15_000);

    expect(isEchoOfTts("Right here sir, what's the first thing we're sorting?"))
      .toBe(true);
    stopSpeaking();
    await reply;
  });

  it("does not resolve a queued reply before its audio has finished", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("Audio", FakeAudio);

    const first = speak("The first reply is playing.", () => {});
    await vi.waitFor(() => expect(FakeAudio.instances).toHaveLength(1));
    let secondFinished = false;
    const second = speak("The second reply waits its turn.", () => {}).then(() => {
      secondFinished = true;
    });

    await Promise.resolve();
    expect(secondFinished).toBe(false);
    FakeAudio.instances[0].onended?.();
    await first;
    await vi.waitFor(() => expect(FakeAudio.instances).toHaveLength(2));
    expect(secondFinished).toBe(false);
    FakeAudio.instances[1].onended?.();
    await second;
    expect(secondFinished).toBe(true);
  });
});
