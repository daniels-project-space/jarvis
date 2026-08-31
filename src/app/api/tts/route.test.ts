import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("@/lib/vault", () => ({ getSecret: vi.fn(async () => { throw new Error("not configured"); }) }));

import { EDGE_TTS_ENGINE, EDGE_TTS_VOICE, SELF_HOSTED_TTS_ENGINE, SELF_HOSTED_TTS_VOICE } from "@/lib/tts-config";
import { GET, POST } from "./route";

const request = (text = "A <safe> phrase") => new Request("https://jarvis.test/api/tts", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ text, speed: 1.1, pitchHz: 4 }),
});

describe("Ryan Neural route", () => {
  const selfHostedTts = process.env.JARVIS_SELF_HOSTED_TTS;
  const selfHostedUrl = process.env.SELF_HOSTED_TTS_URL;
  const selfHostedKey = process.env.SELF_HOSTED_TTS_API_KEY;

  beforeEach(() => {
    delete process.env.JARVIS_SELF_HOSTED_TTS;
    delete process.env.SELF_HOSTED_TTS_URL;
    delete process.env.SELF_HOSTED_TTS_API_KEY;
    vi.unstubAllGlobals();
  });

  afterAll(() => {
    if (selfHostedTts === undefined) delete process.env.JARVIS_SELF_HOSTED_TTS;
    else process.env.JARVIS_SELF_HOSTED_TTS = selfHostedTts;
    if (selfHostedUrl === undefined) delete process.env.SELF_HOSTED_TTS_URL;
    else process.env.SELF_HOSTED_TTS_URL = selfHostedUrl;
    if (selfHostedKey === undefined) delete process.env.SELF_HOSTED_TTS_API_KEY;
    else process.env.SELF_HOSTED_TTS_API_KEY = selfHostedKey;
  });

  it("advertises one fixed engine and voice", async () => {
    const before = mock.instances.length;
    const response = await GET(new Request("https://jarvis.test/api/tts") as any);
    expect(response.status).toBe(204);
    expect(response.headers.get("x-jarvis-tts-engine")).toBe(EDGE_TTS_ENGINE);
    expect(response.headers.get("x-jarvis-tts-voice")).toBe(EDGE_TTS_VOICE);
    expect(mock.instances).toHaveLength(before + 1);
    expect(mock.instances.at(-1)?.setMetadata).toHaveBeenCalledWith(EDGE_TTS_VOICE, "mp3");
  });

  it("reuses the gesture-warmed Ryan connection for the next speech request", async () => {
    const before = mock.instances.length;
    const response = await POST(request() as any);
    const tts = mock.instances.at(-1);
    expect(mock.instances).toHaveLength(before);
    expect(tts.setMetadata).toHaveBeenCalledTimes(2);
    expect(tts.toStream).toHaveBeenCalledWith("A &lt;safe&gt; phrase", {
      rate: "+10%", pitch: "+4Hz", volume: 100,
    });
    expect(response.headers.get("x-jarvis-tts-engine")).toBe(EDGE_TTS_ENGINE);
    expect(response.headers.get("x-jarvis-tts-voice")).toBe(EDGE_TTS_VOICE);
    mock.streams.at(-1)!.emit("data", Buffer.from([1, 2, 3]));
    mock.streams.at(-1)!.emit("end");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(tts.close).not.toHaveBeenCalled();
  });

  it("retires a cancelled pooled stream without starting another request", async () => {
    const before = mock.instances.length;
    const response = await POST(request("Cancel this") as any);
    const stream = mock.streams.at(-1)!;
    const tts = mock.instances.at(-1);
    await response.body!.cancel();
    expect(mock.instances).toHaveLength(before);
    expect(stream.destroy).toHaveBeenCalledTimes(1);
    expect(tts.close).toHaveBeenCalledTimes(1);
  });

  it("opens a fresh speech connection after the pooled socket was cancelled", async () => {
    const before = mock.instances.length;
    const response = await POST(request("Fresh connection") as any);
    const tts = mock.instances.at(-1);
    expect(mock.instances).toHaveLength(before + 1);
    expect(tts.setMetadata).toHaveBeenCalledWith(EDGE_TTS_VOICE, "mp3");
    mock.streams.at(-1)!.emit("data", Buffer.from([4, 5, 6]));
    mock.streams.at(-1)!.emit("end");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([4, 5, 6]));
    expect(tts.close).not.toHaveBeenCalled();
  });

  it("uses only the authenticated self-hosted Kokoro stream when opted in", async () => {
    process.env.JARVIS_SELF_HOSTED_TTS = "1";
    process.env.SELF_HOSTED_TTS_URL = "https://speech.example";
    process.env.SELF_HOSTED_TTS_API_KEY = "self-hosted-test-key";
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(new Uint8Array([7, 8, 9]), {
      headers: { "content-type": "audio/mpeg" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const before = mock.instances.length;

    const response = await POST(request("Hello locally") as any);

    expect(response.status).toBe(200);
    expect(mock.instances).toHaveLength(before);
    expect(response.headers.get("x-jarvis-tts-engine")).toBe(SELF_HOSTED_TTS_ENGINE);
    expect(response.headers.get("x-jarvis-tts-voice")).toBe(SELF_HOSTED_TTS_VOICE);
    expect(fetchMock).toHaveBeenCalledWith("https://speech.example/v1/audio/speech", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ authorization: "Bearer self-hosted-test-key" }),
    }));
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init).toBeDefined();
    if (!init) throw new Error("expected the self-hosted request options");
    expect(JSON.parse(String(init.body))).toEqual({
      model: "kokoro",
      input: "Hello locally",
      voice: SELF_HOSTED_TTS_VOICE,
      response_format: "mp3",
      speed: 1.1,
      stream_format: "audio",
    });
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([7, 8, 9]));
  });

  it("fails closed instead of falling back to Edge when self-hosted mode is incomplete", async () => {
    process.env.JARVIS_SELF_HOSTED_TTS = "1";
    const before = mock.instances.length;
    const response = await POST(request("Do not send this to Edge") as any);
    expect(response.status).toBe(503);
    expect(mock.instances).toHaveLength(before);
  });

  it("rejects a bad self-hosted response without trying the cloud engine", async () => {
    process.env.JARVIS_SELF_HOSTED_TTS = "1";
    process.env.SELF_HOSTED_TTS_URL = "https://speech.example";
    process.env.SELF_HOSTED_TTS_API_KEY = "self-hosted-test-key";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "bad upstream" }, { status: 502 })));
    const before = mock.instances.length;

    const response = await POST(request("Do not replay this") as any);

    expect(response.status).toBe(502);
    expect(mock.instances).toHaveLength(before);
  });
});
