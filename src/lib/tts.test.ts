import { afterEach, describe, expect, it, vi } from "vitest";
import { sentences, speak, stopSpeaking } from "./tts";

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
  });

  it("keeps complete sentences for neural generation", () => {
    expect(sentences("First complete sentence. Second complete sentence."))
      .toEqual(["First complete sentence.", "Second complete sentence."]);
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
