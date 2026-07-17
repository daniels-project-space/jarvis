import { afterEach, describe, expect, it, vi } from "vitest";
import { setTtsMode, speak, stopSpeaking } from "./tts";

class FakeUtterance {
  voice: unknown = null;
  lang = "";
  rate = 1;
  pitch = 1;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public readonly text: string) {}
}

describe("speech queue", () => {
  afterEach(() => {
    stopSpeaking();
    vi.unstubAllGlobals();
  });

  it("does not resolve a queued utterance before that utterance has finished", async () => {
    const utterances: FakeUtterance[] = [];
    const synth = {
      speaking: false,
      getVoices: () => [],
      speak: (utterance: FakeUtterance) => utterances.push(utterance),
      cancel: () => {},
    };
    vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
    vi.stubGlobal("window", { speechSynthesis: synth });
    setTtsMode("system");

    const first = speak("The first complete sentence is playing.", () => {});
    await vi.waitFor(() => expect(utterances).toHaveLength(1));
    let secondFinished = false;
    const second = speak("The second complete sentence waits its turn.", () => {}).then(() => {
      secondFinished = true;
    });

    await Promise.resolve();
    expect(secondFinished).toBe(false);
    utterances[0].onstart?.();
    utterances[0].onend?.();
    await first;
    await vi.waitFor(() => expect(utterances).toHaveLength(2));
    expect(secondFinished).toBe(false);

    utterances[1].onstart?.();
    utterances[1].onend?.();
    await second;
    expect(secondFinished).toBe(true);
  });
});
