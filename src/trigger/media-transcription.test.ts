import { describe, expect, it, vi } from "vitest";
import type { FileExtractionResult } from "../lib/file-extraction";

vi.mock("../lib/vault", () => ({ getSecret: vi.fn() }));

import { applyPrivateMediaAnalysis, MediaTranscriptionError, transcribePrivateMedia } from "./media-transcription";

const MP4 = Buffer.from("000000186674797069736f6d0000020069736f6d69736f3261766331", "hex");

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("private media transcription", () => {
  it("sends a verified video to the authenticated local service and bounds its transcript", async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => jsonResponse({ text: "Meet at the station at 10." }));
    const probeMedia = vi.fn(async () => ({ hasVideo: true, hasAudio: true, durationSeconds: 1, width: 320, height: 180 }));
    const result = await transcribePrivateMedia(
      { bytes: MP4, mimeType: "video/mp4" },
      {
        fetcher,
        probeMedia,
        environment: {
          LOCAL_STT_URL: "https://speech.example/internal",
          LOCAL_STT_SHARED_SECRET: "local-secret",
          JARVIS_LOCAL_STT_ORIGIN: "https://speech.example",
        },
        getSecret: vi.fn(),
      },
    );

    expect(result).toEqual({ provider: "local-faster-whisper", text: "Meet at the station at 10." });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(probeMedia).toHaveBeenCalledWith({ bytes: MP4, kind: "video" });
    expect(fetcher.mock.calls[0][0]).toBe("https://speech.example/internal/v1/audio/transcriptions");
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get("authorization")).toBe("Bearer local-secret");
    const form = fetcher.mock.calls[0][1]?.body as FormData;
    expect((form.get("file") as File).name).toBe("private-media.mp4");
    expect(form.get("model")).toBe("turbo");
  });

  it("does not relay a private upload to any external fallback when the local service fails", async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response("unavailable", { status: 503 }));
    const probeMedia = vi.fn(async () => ({ hasVideo: true, hasAudio: true, durationSeconds: 1, width: 320, height: 180 }));
    await expect(transcribePrivateMedia(
      { bytes: MP4, mimeType: "video/mp4" },
      {
        fetcher,
        probeMedia,
        environment: {
          LOCAL_STT_URL: "https://speech.example",
          LOCAL_STT_SHARED_SECRET: "local-secret",
          JARVIS_LOCAL_STT_ORIGIN: "https://speech.example",
        },
        getSecret: vi.fn(),
      },
    )).rejects.toMatchObject({ code: "media_transcription_unavailable" } satisfies Partial<MediaTranscriptionError>);
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual(["https://speech.example/v1/audio/transcriptions"]);
  });

  it("rejects mislabeled bytes before requesting a provider", async () => {
    const fetcher = vi.fn();
    const probeMedia = vi.fn();
    await expect(transcribePrivateMedia(
      { bytes: new TextEncoder().encode("not a video"), mimeType: "video/mp4" },
      { fetcher, probeMedia, environment: {}, getSecret: vi.fn() },
    )).rejects.toMatchObject({ code: "media_signature_mismatch", retryable: false } satisfies Partial<MediaTranscriptionError>);
    expect(fetcher).not.toHaveBeenCalled();
    expect(probeMedia).not.toHaveBeenCalled();
  });

  it("requires a successful bounded local probe before private bytes leave the worker", async () => {
    const fetcher = vi.fn();
    const probeMedia = vi.fn(async () => { throw new Error("decoder rejected container"); });

    await expect(transcribePrivateMedia(
      { bytes: MP4, mimeType: "video/mp4" },
      {
        fetcher,
        probeMedia,
        environment: {
          LOCAL_STT_URL: "https://speech.example",
          LOCAL_STT_SHARED_SECRET: "local-secret",
          JARVIS_LOCAL_STT_ORIGIN: "https://speech.example",
        },
        getSecret: vi.fn(),
      },
    )).rejects.toMatchObject({ code: "media_decode_validation_failed", retryable: false } satisfies Partial<MediaTranscriptionError>);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses cleartext speech endpoints before requesting a provider", async () => {
    const fetcher = vi.fn();
    const probeMedia = vi.fn(async () => ({ hasVideo: true, hasAudio: true, durationSeconds: 1, width: 320, height: 180 }));

    await expect(transcribePrivateMedia(
      { bytes: MP4, mimeType: "video/mp4" },
      {
        fetcher,
        probeMedia,
        environment: {
          LOCAL_STT_URL: "http://127.0.0.1:8080",
          LOCAL_STT_SHARED_SECRET: "local-secret",
          JARVIS_LOCAL_STT_ORIGIN: "https://speech.example",
        },
        getSecret: vi.fn(),
      },
    )).rejects.toMatchObject({ code: "media_transcription_unconfigured", retryable: false } satisfies Partial<MediaTranscriptionError>);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("requires the Vault endpoint to match its operator-configured origin", async () => {
    const fetcher = vi.fn();
    const probeMedia = vi.fn(async () => ({ hasVideo: true, hasAudio: true, durationSeconds: 1, width: 320, height: 180 }));

    await expect(transcribePrivateMedia(
      { bytes: MP4, mimeType: "video/mp4" },
      {
        fetcher,
        probeMedia,
        environment: {
          LOCAL_STT_URL: "https://untrusted.example",
          LOCAL_STT_SHARED_SECRET: "local-secret",
          JARVIS_LOCAL_STT_ORIGIN: "https://speech.example",
        },
        getSecret: vi.fn(),
      },
    )).rejects.toMatchObject({ code: "media_transcription_unconfigured", retryable: false } satisfies Partial<MediaTranscriptionError>);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("turns verified media outputs into bounded chat text and a visual video capability", () => {
    const source: FileExtractionResult = {
      sha256: "a".repeat(64),
      detectedMimeType: "video/mp4",
      status: "stored_only",
      text: "",
      chunks: [],
      media: { kind: "video" },
    };
    const result = applyPrivateMediaAnalysis(source, {
      preview: { bytes: new Uint8Array([1, 2, 3]), contentType: "image/webp", timestamps: [0.1, 0.4, 0.7, 0.9] },
      transcription: {
        provider: "local-faster-whisper",
        text: "Daniel walks through the old town and says dinner is at eight.",
      },
    });

    expect(result.status).toBe("ready");
    expect(result.chunks[0]?.text).toContain("old town");
    expect(result.summary).toContain("4 timestamped frames ready for visual analysis");
    expect(result.summary).toContain("transcript characters indexed");
    expect(result.preview?.contentType).toBe("image/webp");
  });
});
