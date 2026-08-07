"use client";

import { viewerFetchWithTimeout } from "./viewer-request";

type TimedFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs?: number,
) => Promise<Response>;

export async function transcribeRecordedAudio(
  blob: Blob,
  mime: string,
  fetcher: TimedFetcher = viewerFetchWithTimeout,
): Promise<string> {
  const response = await fetcher("/api/stt", {
    method: "POST",
    headers: { "content-type": mime },
    body: blob,
  }, 30_000);
  const payload = await response.json().catch(() => null) as { text?: unknown; error?: unknown } | null;
  if (!response.ok) {
    throw new Error(String(payload?.error ?? `Speech recognition returned ${response.status}`));
  }
  return typeof payload?.text === "string" ? payload.text.trim() : "";
}
