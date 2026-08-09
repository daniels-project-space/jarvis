import { describe, expect, it, vi } from "vitest";
import { SpeechRecognitionRequestError, transcribeRecordedAudio } from "./stt-client";

const audio = new Blob(["recorded audio"], { type: "audio/webm" });

describe("transcribeRecordedAudio", () => {
  it("returns a trimmed transcript and uses a bounded request", async () => {
    const fetcher = vi.fn(async () => Response.json({ text: "  hello Jarvis  " }));
    await expect(transcribeRecordedAudio(audio, "audio/webm", fetcher)).resolves.toBe("hello Jarvis");
    expect(fetcher).toHaveBeenCalledWith("/api/stt", expect.objectContaining({
      method: "POST",
      headers: { "content-type": "audio/webm" },
      body: audio,
    }), 30_000);
  });

  it("surfaces the server error instead of silently discarding speech", async () => {
    const fetcher = vi.fn(async () => Response.json({
      error: "transcriber unavailable",
      code: "stt_unavailable",
      retryAfterMs: 8_000,
      retryable: true,
    }, { status: 503 }));
    const error = await transcribeRecordedAudio(audio, "audio/webm", fetcher).catch((caught) => caught);
    expect(error).toBeInstanceOf(SpeechRecognitionRequestError);
    expect(error).toMatchObject({
      message: "transcriber unavailable",
      status: 503,
      code: "stt_unavailable",
      retryAfterMs: 8_000,
      retryable: true,
    });
  });

  it("honours a bounded server retry hint", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: "busy" }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "4" },
    }));
    const error = await transcribeRecordedAudio(audio, "audio/webm", fetcher).catch((caught) => caught);
    expect(error).toMatchObject({ status: 429, retryAfterMs: 4_000, retryable: true });
  });

  it("does not turn authentication or explicit configuration failures into retry loops", async () => {
    const unauthorized = vi.fn(async () => Response.json({ error: "unauthorized" }, { status: 401 }));
    const authError = await transcribeRecordedAudio(audio, "audio/webm", unauthorized).catch((caught) => caught);
    expect(authError).toMatchObject({ status: 401, retryable: false });

    const unconfigured = vi.fn(async () => Response.json({
      error: "stt unavailable",
      code: "STT_PROVIDERS_UNAVAILABLE",
      retryable: false,
    }, { status: 503 }));
    const configError = await transcribeRecordedAudio(audio, "audio/webm", unconfigured).catch((caught) => caught);
    expect(configError).toMatchObject({
      status: 503,
      code: "STT_PROVIDERS_UNAVAILABLE",
      retryable: false,
    });
  });
});
