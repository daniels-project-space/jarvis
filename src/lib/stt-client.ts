"use client";

import { viewerFetchWithTimeout } from "./viewer-request";
import {
  cleanSpeechTranscript,
  hasConfidentSpeechSegments,
  hasStrongClientSpeechEvidence,
  isMeaningfulSpeechTranscript,
  shouldIgnoreHandsFreeTranscript,
} from "./transcript";

type TimedFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs?: number,
) => Promise<Response>;

export class SpeechRecognitionRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterMs: number;
  readonly retryable: boolean;

  constructor(message: string, args: { status: number; code?: string; retryAfterMs?: number; retryable?: boolean }) {
    super(message);
    this.name = "SpeechRecognitionRequestError";
    this.status = args.status;
    this.code = args.code ?? "stt_request_failed";
    this.retryAfterMs = Math.max(0, args.retryAfterMs ?? 0);
    this.retryable = args.retryable ?? (args.status === 0 || args.status === 429 || args.status >= 500);
  }
}

export async function transcriptFromSttResponse(response: Response): Promise<string> {
  const payload = await response.json().catch(() => null) as {
    text?: unknown;
    error?: unknown;
    code?: unknown;
    retryAfterMs?: unknown;
    retryable?: unknown;
  } | null;
  if (!response.ok) {
    const retryHeaderSeconds = Number(response.headers.get("retry-after"));
    const payloadDelay = Number(payload?.retryAfterMs);
    const retryAfterMs = Number.isFinite(payloadDelay) && payloadDelay > 0
      ? payloadDelay
      : Number.isFinite(retryHeaderSeconds) && retryHeaderSeconds > 0
        ? retryHeaderSeconds * 1_000
        : 0;
    throw new SpeechRecognitionRequestError(
      String(payload?.error ?? `Speech recognition returned ${response.status}`),
      {
        status: response.status,
        code: typeof payload?.code === "string" ? payload.code : undefined,
        retryAfterMs,
        retryable: typeof payload?.retryable === "boolean" ? payload.retryable : undefined,
      },
    );
  }
  return typeof payload?.text === "string" ? payload.text.trim() : "";
}

export async function directTranscriptFromSttResponse(
  response: Response,
  evidence: { acceptedFrames: number; speechSpanMs: number; peakVoiceMargin: number },
): Promise<string> {
  const payload = await response.json().catch(() => null) as {
    text?: unknown;
    segments?: unknown;
  } | null;
  if (!response.ok || typeof payload?.text !== "string") return "";
  if (!hasConfidentSpeechSegments(payload.segments) && !hasStrongClientSpeechEvidence(evidence)) return "";
  let text = cleanSpeechTranscript(payload.text);
  if (shouldIgnoreHandsFreeTranscript(text, evidence)) text = "";
  const latin = (text.match(/[a-zA-Z0-9\s.,!?\"'£$%()@:;/-]/g) ?? []).length;
  if (text && latin / text.length < 0.7) text = "";
  return isMeaningfulSpeechTranscript(text) ? text : "";
}

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
  return transcriptFromSttResponse(response);
}
