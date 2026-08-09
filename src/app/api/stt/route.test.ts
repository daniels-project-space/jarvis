import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

const mock = vi.hoisted(() => ({
  controlActor: vi.fn(),
  getSecret: vi.fn(),
}));

vi.mock("@/lib/request-auth", () => ({ controlActor: mock.controlActor }));
vi.mock("@/lib/vault", () => ({ getSecret: mock.getSecret }));
vi.mock("@/lib/sttvocab", () => ({ STT_PROMPT: "Jarvis, Daniel, Codex" }));
vi.mock("@/lib/transcript", () => ({
  cleanSpeechTranscript: (text: string) => text.trim(),
  hasConfidentSpeechSegments: () => true,
  isMeaningfulSpeechTranscript: (text: string) => Boolean(text),
  shouldIgnoreHandsFreeTranscript: () => false,
}));

import { POST } from "./route";

function request(init: RequestInit): NextRequest {
  return new Request("https://jarvis.test/api/stt", init) as unknown as NextRequest;
}

describe("resilient STT route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mock.controlActor.mockResolvedValue({ kind: "owner" });
    mock.getSecret.mockImplementation(async (_service: string, name: string) => ({
      LOCAL_STT_URL: "http://local-stt:8080",
      LOCAL_STT_SHARED_SECRET: "shared-secret",
    })[name] ?? "");
  });

  it("sends an authenticated Turbo request to the self-hosted endpoint", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json({
      text: "Hello Jarvis",
      segments: [{ start: 0, end: 1, avg_logprob: -0.1, no_speech_prob: 0.01 }],
    }));
    vi.stubGlobal("fetch", fetcher);

    const response = await POST(request({
      method: "POST",
      headers: { "content-type": "audio/webm" },
      body: new Uint8Array(2_100),
    }));

    expect(await response.json()).toEqual({ text: "Hello Jarvis" });
    expect(response.headers.get("x-jarvis-stt-provider")).toBe("local-faster-whisper");
    const [url, init] = fetcher.mock.calls[0]!;
    expect(init).toBeDefined();
    const requestInit = init!;
    expect(url).toBe("http://local-stt:8080/v1/audio/transcriptions");
    expect(new Headers(requestInit.headers).get("authorization")).toBe("Bearer shared-secret");
    const body = requestInit.body as FormData;
    expect(body.get("model")).toBe("turbo");
    expect(body.get("prompt")).toBe("Jarvis, Daniel, Codex");
  });

  it("does not send speech to a paid fallback when the private worker is unavailable", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response("offline", { status: 503 }));
    vi.stubGlobal("fetch", fetcher);

    const response = await POST(request({
      method: "POST",
      headers: { "content-type": "audio/wav" },
      body: new Uint8Array(2_100),
    }));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "stt unavailable" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("fails closed when local speech recognition is not configured", async () => {
    mock.getSecret.mockResolvedValue("");
    const response = await POST(request({
      method: "POST",
      headers: { "content-type": "audio/wav" },
      body: new Uint8Array(2_100),
    }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "local speech recognition is not configured" });
  });
});
