"use client";

import { viewerFetchWithTimeout } from "./viewer-request";

type TicketResponse = {
  url: string;
  ticket: string;
  expiresAt: number;
  prompt: string;
};

type TimedFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs?: number,
) => Promise<Response>;

type DirectFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type PreparedDirectFinalStt = {
  transcribe(blob: Blob, mime: string, signal: AbortSignal, timeoutMs: number): Promise<Response | null>;
};

function parseTicket(value: unknown): TicketResponse | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<TicketResponse>;
  try {
    const url = new URL(String(candidate.url ?? ""));
    const local = url.protocol === "http:" && url.hostname === "localhost";
    if (url.protocol !== "https:" && !local) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    if (!url.pathname.endsWith("/v1/audio/transcriptions")) return null;
  } catch {
    return null;
  }
  if (
    typeof candidate.ticket !== "string"
    || !candidate.ticket.includes(".")
    || typeof candidate.expiresAt !== "number"
    || candidate.expiresAt <= Date.now()
    || typeof candidate.prompt !== "string"
    || candidate.prompt.length > 2_000
  ) return null;
  return candidate as TicketResponse;
}

/**
 * Begin the owner-ticket request while speech is still arriving. The returned
 * capability can be consumed exactly once; any failure falls back to /api/stt.
 */
export function prepareDirectFinalStt(
  ticketFetcher: TimedFetcher = viewerFetchWithTimeout,
  directFetcher: DirectFetcher = fetch,
): PreparedDirectFinalStt {
  const ticketPromise = ticketFetcher("/api/voice/final-ticket", { method: "POST" }, 4_000)
    .then(async (response) => response.ok ? parseTicket(await response.json().catch(() => null)) : null)
    .catch(() => null);
  let consumed = false;
  return {
    async transcribe(blob, mime, signal, timeoutMs) {
      if (consumed) return null;
      consumed = true;
      const issued = await ticketPromise;
      if (!issued || issued.expiresAt <= Date.now()) return null;
      const form = new FormData();
      const extension = mime === "audio/mp4" ? "mp4" : mime === "audio/ogg" ? "ogg" : "webm";
      form.append("file", blob, `speech.${extension}`);
      form.append("model", "turbo");
      form.append("language", "en");
      form.append("temperature", "0");
      form.append("prompt", issued.prompt);
      form.append("response_format", "verbose_json");
      form.append("timestamp_granularities[]", "segment");
      try {
        const response = await directFetcher(issued.url, {
          method: "POST",
          headers: { Authorization: `Bearer ${issued.ticket}` },
          body: form,
          signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(1_000, timeoutMs))]),
          redirect: "error",
          credentials: "omit",
        });
        return response.ok ? response : null;
      } catch {
        return null;
      }
    },
  };
}
