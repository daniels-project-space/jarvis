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
let resumeAllowed = true;

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

class FakeMediaElementSource {
  connect() {}
  disconnect() {}
}

class FakeSourceBuffer extends EventTarget {
  updating = false;
  chunks: ArrayBuffer[] = [];

  appendBuffer(chunk: ArrayBuffer) {
    this.updating = true;
    this.chunks.push(chunk);
    if (this.chunks.length === 2) FakeAudioElement.resolveDeferredPlay?.();
    queueMicrotask(() => {
      this.updating = false;
      this.dispatchEvent(new Event("updateend"));
    });
  }
}

class FakeMediaSource extends EventTarget {
  static instances: FakeMediaSource[] = [];
  readyState: "closed" | "open" | "ended" = "closed";
  sourceBuffer = new FakeSourceBuffer();

  constructor() {
    super();
    FakeMediaSource.instances.push(this);
  }

  static isTypeSupported(mime: string) { return mime === "audio/mpeg"; }
  addSourceBuffer(mime: string) {
    if (mime !== "audio/mpeg") throw new Error("Unexpected media type");
    return this.sourceBuffer;
  }
  open() {
    this.readyState = "open";
    this.dispatchEvent(new Event("sourceopen"));
  }
  endOfStream() {
    this.readyState = "ended";
    queueMicrotask(() => FakeAudioElement.instances.at(-1)?.finish());
  }
}

class FakeAudioElement extends EventTarget {
  static instances: FakeAudioElement[] = [];
  static onPlay: (() => void) | null = null;
  static deferPlayUntilSecondChunk = false;
  static resolveDeferredPlay: (() => void) | null = null;
  preload = "";
  src = "";
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  play = vi.fn(() => {
    FakeAudioElement.onPlay?.();
    if (!FakeAudioElement.deferPlayUntilSecondChunk) return Promise.resolve();
    return new Promise<void>((resolve) => { FakeAudioElement.resolveDeferredPlay = resolve; });
  });

  constructor() {
    super();
    FakeAudioElement.instances.push(this);
  }

  setAttribute() {}
  removeAttribute() {}
  load() {}
  pause() {}
  finish() { this.onended?.(); }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state = "running";
  destination = {};
  sampleRate = 48_000;
  resume = vi.fn(async () => { this.state = resumeAllowed ? "running" : "suspended"; });
  decodeAudioData = vi.fn(async () => ({ duration: 1.2 }));
  createBufferSource() { return new FakeSource(); }
  createAnalyser() { return new FakeAnalyser(); }
  createMediaElementSource() { return new FakeMediaElementSource(); }

  constructor() {
    FakeAudioContext.instances.push(this);
  }
}

describe("single Edge neural speech queue", () => {
  beforeEach(() => {
    FakeSource.instances = [];
    failNextSynthesis = false;
    synthesisCount = 0;
    warmCount = 0;
    resumeAllowed = true;
    FakeAudioElement.onPlay = null;
    FakeAudioElement.deferPlayUntilSecondChunk = false;
    FakeAudioElement.resolveDeferredPlay = null;
    const existingContext = FakeAudioContext.instances.at(-1);
    if (existingContext) existingContext.state = "running";
    vi.stubGlobal("window", {
      AudioContext: FakeAudioContext,
      location: { origin: "https://jarvis.test" },
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
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
    vi.unstubAllGlobals();
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
    expect(chunks[0].length).toBeLessThanOrEqual(88);
    expect(chunks.join(" ")).toBe(normalizeSpeechText(input));
  });

  it("does not add a third request for replies that fit the previous two-request budget", () => {
    const input = Array.from({ length: 52 }, (_, index) => `word${index}`).join(" ");
    const chunks = sentences(input);
    expect(normalizeSpeechText(input).length).toBeGreaterThan(328);
    expect(normalizeSpeechText(input).length).toBeLessThanOrEqual(360);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].length).toBeLessThanOrEqual(120);
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
    expect(completeSpeechPrefix("Two things matter: the rest is still streaming"))
      .toBe("Two things matter:");
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

  it("begins supported MP3 playback before the streamed response closes", async () => {
    FakeMediaSource.instances = [];
    FakeAudioElement.instances = [];
    let secondChunkScheduled = false;
    let releaseSecondChunk: () => void = () => { throw new Error("Second stream chunk was not scheduled"); };
    let firstPlayback!: () => void;
    const firstPlaybackStarted = new Promise<void>((resolve) => { firstPlayback = resolve; });
    FakeAudioElement.onPlay = firstPlayback;
    vi.stubGlobal("MediaSource", FakeMediaSource);
    vi.stubGlobal("Audio", FakeAudioElement);
    vi.stubGlobal("URL", {
      createObjectURL: (mediaSource: FakeMediaSource) => {
        queueMicrotask(() => mediaSource.open());
        return "blob:jarvis-test";
      },
      revokeObjectURL: vi.fn(),
    });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== "/api/tts" || init?.method !== "POST") return Response.json({ ok: true });
      synthesisCount += 1;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(700));
          releaseSecondChunk = () => {
            controller.enqueue(new Uint8Array(700));
            controller.close();
          };
          secondChunkScheduled = true;
        },
      });
      return Promise.resolve(new Response(stream, { status: 200, headers: { "content-type": "audio/mpeg" } }));
    }));

    let settled = false;
    const reply = speak("Start this streamed voice answer.", () => {}).then((played) => {
      settled = true;
      return played;
    });
    await firstPlaybackStarted;
    expect(synthesisCount).toBe(1);
    expect(FakeMediaSource.instances).toHaveLength(1);
    expect(FakeMediaSource.instances[0].sourceBuffer.chunks).toHaveLength(1);
    expect(settled).toBe(false);
    expect(secondChunkScheduled).toBe(true);

    releaseSecondChunk();
    await expect(reply).resolves.toBe(true);
    expect(FakeMediaSource.instances[0].sourceBuffer.chunks).toHaveLength(2);
  });

  it("keeps appending while the browser waits for enough streamed MP3 data to start", async () => {
    FakeMediaSource.instances = [];
    FakeAudioElement.instances = [];
    FakeAudioElement.deferPlayUntilSecondChunk = true;
    let releaseSecondChunk: () => void = () => { throw new Error("Second stream chunk was not scheduled"); };
    vi.stubGlobal("MediaSource", FakeMediaSource);
    vi.stubGlobal("Audio", FakeAudioElement);
    vi.stubGlobal("URL", {
      createObjectURL: (mediaSource: FakeMediaSource) => {
        queueMicrotask(() => mediaSource.open());
        return "blob:jarvis-test";
      },
      revokeObjectURL: vi.fn(),
    });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== "/api/tts" || init?.method !== "POST") return Response.json({ ok: true });
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(700));
          releaseSecondChunk = () => {
            controller.enqueue(new Uint8Array(700));
            controller.close();
          };
        },
      });
      return Promise.resolve(new Response(stream, { status: 200, headers: { "content-type": "audio/mpeg" } }));
    }));

    const reply = speak("Keep reading the streamed MP3 while startup buffers.", () => {});
    await vi.waitFor(() => expect(FakeMediaSource.instances[0]?.sourceBuffer.chunks).toHaveLength(1));
    releaseSecondChunk();
    await expect(reply).resolves.toBe(true);
    expect(FakeMediaSource.instances[0].sourceBuffer.chunks).toHaveLength(2);
  });

  it("cancels a progressive response while its browser startup is still buffering", async () => {
    FakeMediaSource.instances = [];
    FakeAudioElement.instances = [];
    FakeAudioElement.deferPlayUntilSecondChunk = true;
    vi.stubGlobal("MediaSource", FakeMediaSource);
    vi.stubGlobal("Audio", FakeAudioElement);
    vi.stubGlobal("URL", {
      createObjectURL: (mediaSource: FakeMediaSource) => {
        queueMicrotask(() => mediaSource.open());
        return "blob:jarvis-test";
      },
      revokeObjectURL: vi.fn(),
    });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== "/api/tts" || init?.method !== "POST") return Response.json({ ok: true });
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(700));
        },
      });
      return Promise.resolve(new Response(stream, { status: 200, headers: { "content-type": "audio/mpeg" } }));
    }));

    const reply = speak("Cancel this progressive voice response.", () => {});
    await vi.waitFor(() => expect(FakeMediaSource.instances[0]?.sourceBuffer.chunks).toHaveLength(1));
    stopSpeaking();
    await expect(reply).resolves.toBe(false);
  });

  it("keeps an autoplay-blocked reply queued and resumes it on the next gesture", async () => {
    unlockSpeechPlayback();
    await Promise.resolve();
    const context = FakeAudioContext.instances.at(-1)!;
    context.state = "suspended";
    resumeAllowed = false;

    let settled = false;
    const reply = speak("This reply must survive browser autoplay blocking.", () => {})
      .then((played) => {
        settled = true;
        return played;
      });

    await vi.waitFor(() => expect(document.documentElement.dataset.jarvisTts).toBe("blocked"));
    expect(FakeSource.instances).toHaveLength(0);
    expect(settled).toBe(false);

    resumeAllowed = true;
    unlockSpeechPlayback();
    await vi.waitFor(() => expect(FakeSource.instances).toHaveLength(1));
    FakeSource.instances[0].onended?.();

    await expect(reply).resolves.toBe(true);
    expect(document.documentElement.dataset.jarvisTts).toBe("ready");
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
