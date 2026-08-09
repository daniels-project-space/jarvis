import { describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => {
  class AudioStream {
    handlers = new Map<string, Array<(value?: any) => void>>();
    destroy = vi.fn();
    on(event: string, handler: (value?: any) => void) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
      return this;
    }
    once(event: string, handler: (value?: any) => void) { return this.on(event, handler); }
    emit(event: string, value?: any) {
      for (const handler of this.handlers.get(event) ?? []) handler(value);
    }
  }
  const streams: AudioStream[] = [];
  const instances: any[] = [];
  class MsEdgeTTS {
    setMetadata = vi.fn(async () => {});
    close = vi.fn();
    toStream = vi.fn(() => {
      const audioStream = new AudioStream();
      streams.push(audioStream);
      return { audioStream };
    });
    constructor() { instances.push(this); }
  }
  return { MsEdgeTTS, instances, streams };
});

vi.mock("msedge-tts", () => ({
  MsEdgeTTS: mock.MsEdgeTTS,
  OUTPUT_FORMAT: { AUDIO_24KHZ_48KBITRATE_MONO_MP3: "mp3" },
}));
vi.mock("@/lib/control-session", () => ({ isSameOriginRequest: vi.fn(() => true) }));
vi.mock("@/lib/request-auth", () => ({ controlActor: vi.fn(async () => ({ id: "viewer" })) }));

import { GET, JARVIS_TTS_ENGINE, JARVIS_TTS_VOICE, POST } from "./route";

const request = (text = "A <safe> phrase") => new Request("https://jarvis.test/api/tts", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ text, speed: 1.1, pitchHz: 4 }),
});

describe("Ryan Neural route", () => {
  it("advertises one fixed engine and voice", async () => {
    const response = await GET(new Request("https://jarvis.test/api/tts") as any);
    expect(response.status).toBe(204);
    expect(response.headers.get("x-jarvis-tts-engine")).toBe(JARVIS_TTS_ENGINE);
    expect(response.headers.get("x-jarvis-tts-voice")).toBe("en-GB-RyanNeural");
  });

  it("constructs one Ryan upstream stream for one request", async () => {
    const before = mock.instances.length;
    const response = await POST(request() as any);
    const tts = mock.instances.at(-1);
    expect(mock.instances).toHaveLength(before + 1);
    expect(tts.setMetadata).toHaveBeenCalledWith(JARVIS_TTS_VOICE, "mp3");
    expect(tts.toStream).toHaveBeenCalledWith("A &lt;safe&gt; phrase", {
      rate: "+10%", pitch: "+4Hz", volume: 100,
    });
    expect(response.headers.get("x-jarvis-tts-engine")).toBe(JARVIS_TTS_ENGINE);
    expect(response.headers.get("x-jarvis-tts-voice")).toBe(JARVIS_TTS_VOICE);
    mock.streams.at(-1)!.emit("data", Buffer.from([1, 2, 3]));
    mock.streams.at(-1)!.emit("end");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(tts.close).toHaveBeenCalledTimes(1);
  });

  it("cancels the single upstream stream without starting another request", async () => {
    const before = mock.instances.length;
    const response = await POST(request("Cancel this") as any);
    const stream = mock.streams.at(-1)!;
    const tts = mock.instances.at(-1);
    await response.body!.cancel();
    expect(mock.instances).toHaveLength(before + 1);
    expect(stream.destroy).toHaveBeenCalledTimes(1);
    expect(tts.close).toHaveBeenCalledTimes(1);
  });
});
