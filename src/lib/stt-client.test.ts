import { describe, expect, it, vi } from "vitest";
import { transcribeRecordedAudio } from "./stt-client";

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
    const fetcher = vi.fn(async () => Response.json({ error: "transcriber unavailable" }, { status: 503 }));
    await expect(transcribeRecordedAudio(audio, "audio/webm", fetcher)).rejects.toThrow("transcriber unavailable");
  });
});
