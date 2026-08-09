import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

const mock = vi.hoisted(() => ({
  controlActor: vi.fn(),
  getSecret: vi.fn(),
  hasConfidentSpeechSegments: vi.fn(),
}));

vi.mock("@/lib/request-auth", () => ({ controlActor: mock.controlActor }));
vi.mock("@/lib/vault", () => ({ getSecret: mock.getSecret }));
vi.mock("@/lib/sttvocab", () => ({ STT_PROMPT: "Jarvis, Daniel, Codex" }));
vi.mock("@/lib/transcript", () => ({
  cleanSpeechTranscript: (text: string) => text.trim(),
  hasConfidentSpeechSegments: mock.hasConfidentSpeechSegments,
  isMeaningfulSpeechTranscript: (text: string) => Boolean(text),
  shouldIgnoreHandsFreeTranscript: () => false,
}));

import { POST } from "./route";

function request(init: RequestInit): NextRequest {
  return new Request("https://jarvis.test/api/stt", init) as unknown as NextRequest;
}

let localSttPort = 8_080;
let localSttUrl = "";

describe("resilient STT route", () => {
  beforeEach(() => {
    localSttUrl = `http://local-stt:${++localSttPort}`;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv("LOCAL_STT_URL", "");
    vi.stubEnv("LOCAL_STT_SHARED_SECRET", "");
    vi.stubEnv("GROQ_API_KEY", "");
    mock.controlActor.mockResolvedValue({ kind: "owner" });
    mock.hasConfidentSpeechSegments.mockImplementation((segments: unknown) => Array.isArray(segments) && segments.length > 0);
    mock.getSecret.mockImplementation(async (_service: string, name: string) => ({
      LOCAL_STT_URL: localSttUrl,
      LOCAL_STT_SHARED_SECRET: "shared-secret",
      GROQ_API_KEY: "groq-secret",
    })[name] ?? "");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses a confident local transcript without spending the Groq fallback", async () => {
    const segments = [{ start: 0, end: 1, avg_logprob: -0.1, no_speech_prob: 0.01 }];
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json({
      text: "Hello Jarvis",
      segments,
    }));
    vi.stubGlobal("fetch", fetcher);

    const response = await POST(request({
      method: "POST",
      headers: { "content-type": "audio/webm" },
      body: new Uint8Array(2_100),
    }));

    expect(await response.json()).toEqual({ text: "Hello Jarvis" });
    expect(response.headers.get("x-jarvis-stt-provider")).toBe("local-faster-whisper");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(mock.hasConfidentSpeechSegments).toHaveBeenCalledWith(segments);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(init).toBeDefined();
    const requestInit = init!;
    expect(url).toBe(`${localSttUrl}/v1/audio/transcriptions`);
    expect(new Headers(requestInit.headers).get("authorization")).toBe("Bearer shared-secret");
    const body = requestInit.body as FormData;
    expect(body.get("model")).toBe("turbo");
    expect(body.get("prompt")).toBe("Jarvis, Daniel, Codex");
  });

  it("falls back to Groq when the private worker is unavailable", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response("offline", { status: 503 }))
      .mockResolvedValueOnce(Response.json({
        text: "Fallback heard me",
        segments: [{ start: 0, end: 1, avg_logprob: -0.1, no_speech_prob: 0.01 }],
      }));
    vi.stubGlobal("fetch", fetcher);

    const response = await POST(request({
      method: "POST",
      headers: { "content-type": "audio/wav" },
      body: new Uint8Array(2_100),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ text: "Fallback heard me" });
    expect(response.headers.get("x-jarvis-stt-provider")).toBe("groq-whisper");
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [url, init] = fetcher.mock.calls[1]!;
    expect(url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    expect(new Headers(init!.headers).get("authorization")).toBe("Bearer groq-secret");
    expect((init!.body as FormData).get("model")).toBe("whisper-large-v3-turbo");
  });

  it("bypasses a failed local worker on the next request", async () => {
    const groqTranscript = () => Response.json({
      text: "Fast fallback",
      segments: [{ start: 0, end: 1, avg_logprob: -0.1, no_speech_prob: 0.01 }],
    });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response("offline", { status: 503 }))
      .mockResolvedValueOnce(groqTranscript())
      .mockResolvedValueOnce(groqTranscript());
    vi.stubGlobal("fetch", fetcher);

    const makeRequest = () => POST(request({
      method: "POST",
      headers: { "content-type": "audio/wav" },
      body: new Uint8Array(2_100),
    }));
    await makeRequest();
    const second = await makeRequest();

    await expect(second.json()).resolves.toEqual({ text: "Fast fallback" });
    expect(second.headers.get("x-jarvis-stt-provider")).toBe("groq-whisper");
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[2]![0]).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
  });

  it("probes the local worker after cooldown and closes the circuit on recovery", async () => {
    let now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const groqTranscript = Response.json({
      text: "Temporary fallback",
      segments: [{ start: 0, end: 1, avg_logprob: -0.1, no_speech_prob: 0.01 }],
    });
    const localTranscript = () => Response.json({
      text: "Local recovered",
      segments: [{ start: 0, end: 1, avg_logprob: -0.1, no_speech_prob: 0.01 }],
    });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response("offline", { status: 503 }))
      .mockResolvedValueOnce(groqTranscript)
      .mockResolvedValueOnce(localTranscript())
      .mockResolvedValueOnce(localTranscript());
    vi.stubGlobal("fetch", fetcher);

    const makeRequest = () => POST(request({
      method: "POST",
      headers: { "content-type": "audio/wav" },
      body: new Uint8Array(2_100),
    }));
    await makeRequest();
    now += 30_001;
    const recovered = await makeRequest();
    const staysLocal = await makeRequest();

    await expect(recovered.json()).resolves.toEqual({ text: "Local recovered" });
    await expect(staysLocal.json()).resolves.toEqual({ text: "Local recovered" });
    expect(recovered.headers.get("x-jarvis-stt-provider")).toBe("local-faster-whisper");
    expect(staysLocal.headers.get("x-jarvis-stt-provider")).toBe("local-faster-whisper");
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(fetcher.mock.calls[2]![0]).toBe(`${localSttUrl}/v1/audio/transcriptions`);
    expect(fetcher.mock.calls[3]![0]).toBe(`${localSttUrl}/v1/audio/transcriptions`);
  });

  it("uses Groq directly when the local worker is not configured", async () => {
    mock.getSecret.mockImplementation(async (_service: string, name: string) => name === "GROQ_API_KEY" ? "groq-secret" : "");
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({
      text: "Direct fallback",
      segments: [{ start: 0, end: 1, avg_logprob: -0.1, no_speech_prob: 0.01 }],
    }));
    vi.stubGlobal("fetch", fetcher);

    const response = await POST(request({
      method: "POST",
      headers: { "content-type": "audio/wav" },
      body: new Uint8Array(2_100),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ text: "Direct fallback" });
    expect(response.headers.get("x-jarvis-stt-provider")).toBe("groq-whisper");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
  });

  it("returns structured provider state when both configured providers fail", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response("offline", { status: 503 }))
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }));
    vi.stubGlobal("fetch", fetcher);

    const response = await POST(request({
      method: "POST",
      headers: { "content-type": "audio/wav" },
      body: new Uint8Array(2_100),
    }));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "stt unavailable",
      code: "STT_PROVIDERS_UNAVAILABLE",
      retryable: true,
      providers: { local: "unavailable", groq: "unavailable" },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("returns structured configuration state when neither provider is configured", async () => {
    mock.getSecret.mockResolvedValue("");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    const response = await POST(request({
      method: "POST",
      headers: { "content-type": "audio/wav" },
      body: new Uint8Array(2_100),
    }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "stt unavailable",
      code: "STT_PROVIDERS_UNAVAILABLE",
      retryable: false,
      providers: { local: "not_configured", groq: "not_configured" },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not accept text from a provider without confident speech segments", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ text: "hallucinated", segments: [] }));
    vi.stubGlobal("fetch", fetcher);

    const response = await POST(request({
      method: "POST",
      headers: { "content-type": "audio/wav" },
      body: new Uint8Array(2_100),
    }));

    await expect(response.json()).resolves.toEqual({ text: "" });
    expect(response.headers.get("x-jarvis-stt-provider")).toBe("local-faster-whisper");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
