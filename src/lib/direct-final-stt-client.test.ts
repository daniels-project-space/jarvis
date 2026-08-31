import { beforeEach, describe, expect, it, vi } from "vitest";

import { prepareDirectFinalStt } from "./direct-final-stt-client";

describe("direct final speech client", () => {
  beforeEach(() => vi.useRealTimers());

  it("prewarms a ticket, uploads once, and never exposes it to the app origin", async () => {
    const ticketFetcher = vi.fn().mockResolvedValue(Response.json({
      url: "https://speech.example/v1/audio/transcriptions",
      ticket: "signed.ticket",
      expiresAt: Date.now() + 30_000,
      prompt: "Jarvis, Paul, Maya",
    }));
    const directFetcher = vi.fn().mockResolvedValue(Response.json({ text: "Jarvis, hello." }));
    const prepared = prepareDirectFinalStt(ticketFetcher, directFetcher);
    expect(ticketFetcher).toHaveBeenCalledTimes(1);

    const response = await prepared.transcribe(
      new Blob([new Uint8Array(2_200)], { type: "audio/webm" }),
      "audio/webm",
      new AbortController().signal,
      4_000,
    );
    expect(response?.ok).toBe(true);
    expect(directFetcher).toHaveBeenCalledTimes(1);
    const [url, init] = directFetcher.mock.calls[0];
    expect(url).toBe("https://speech.example/v1/audio/transcriptions");
    expect(init.headers).toEqual({ Authorization: "Bearer signed.ticket" });
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get("prompt")).toBe("Jarvis, Paul, Maya");
    expect(await prepared.transcribe(new Blob(), "audio/webm", new AbortController().signal, 4_000)).toBeNull();
    expect(directFetcher).toHaveBeenCalledTimes(1);
  });

  it("fails closed so the caller can immediately use its existing proxy fallback", async () => {
    const ticketFetcher = vi.fn().mockResolvedValue(Response.json({ error: "unavailable" }, { status: 503 }));
    const directFetcher = vi.fn();
    const prepared = prepareDirectFinalStt(ticketFetcher, directFetcher);
    expect(await prepared.transcribe(new Blob(), "audio/webm", new AbortController().signal, 4_000)).toBeNull();
    expect(directFetcher).not.toHaveBeenCalled();
  });
});
