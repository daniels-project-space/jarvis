import { CHAT_FILE_LIMITS, boundedExtractedText, chunkExtractedText, normalizeUploadMime } from "../lib/chat-files";
import type { FileExtractionResult } from "../lib/file-extraction";
import { hasExpectedMediaSignature, mediaFilenameExtension, transcribableMediaKind } from "../lib/media-types";
import { isJsonRecord, readBoundedResponseJson, runWithDeadline } from "../lib/bounded-json";
import { getSecret } from "../lib/vault";
import { probePrivateMedia } from "./media-frame-extraction";

const LOCAL_STT_TIMEOUT_MS = 45_000;
const MAX_TRANSCRIPTION_RESPONSE_BYTES = 512 * 1024;

type MediaTranscriptionProvider = "local-faster-whisper";

export type MediaTranscriptionResult = {
  provider: MediaTranscriptionProvider;
  text: string;
};

export class MediaTranscriptionError extends Error {
  constructor(readonly code: string, readonly retryable: boolean) {
    super(code);
    this.name = "MediaTranscriptionError";
  }
}

type MediaTranscriptionEnvironment = {
  LOCAL_STT_URL?: string;
  LOCAL_STT_SHARED_SECRET?: string;
  JARVIS_LOCAL_STT_ORIGIN?: string;
};

type MediaTranscriptionDependencies = {
  fetcher: typeof fetch;
  getSecret: typeof getSecret;
  probeMedia: typeof probePrivateMedia;
  environment: MediaTranscriptionEnvironment;
};

type MediaTranscriptionOptions = Partial<MediaTranscriptionDependencies>;

const defaultDependencies: MediaTranscriptionDependencies = {
  fetcher: fetch,
  getSecret,
  probeMedia: probePrivateMedia,
  environment: {
    LOCAL_STT_URL: process.env.LOCAL_STT_URL,
    LOCAL_STT_SHARED_SECRET: process.env.LOCAL_STT_SHARED_SECRET,
    JARVIS_LOCAL_STT_ORIGIN: process.env.JARVIS_LOCAL_STT_ORIGIN,
  },
};

function allowedLocalTranscriptionOrigin(rawOrigin: string | undefined): string | null {
  try {
    const origin = new URL(rawOrigin?.trim() ?? "");
    if (origin.protocol !== "https:" || origin.username || origin.password
      || origin.pathname !== "/" || origin.search || origin.hash) return null;
    return origin.origin;
  } catch {
    return null;
  }
}

function localTranscriptionEndpoint(rawUrl: string, allowedOrigin: string | null): string | null {
  try {
    const base = new URL(rawUrl.trim());
    // Private uploads never travel over cleartext. The configured service is
    // authenticated separately with a Vault-backed bearer below.
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash
      || !allowedOrigin || base.origin !== allowedOrigin) return null;
    const path = base.pathname.replace(/\/$/, "");
    if (!path.endsWith("/v1/audio/transcriptions")) {
      base.pathname = `${path}/v1/audio/transcriptions`.replace(/^([^/])/, "/$1");
    }
    return base.toString();
  } catch {
    return null;
  }
}

async function configuredSecret(
  environmentValue: string | undefined,
  service: string,
  keyName: string,
  dependencies: Pick<MediaTranscriptionDependencies, "getSecret">,
): Promise<string> {
  if (environmentValue?.trim()) return environmentValue.trim();
  return await Promise.resolve(dependencies.getSecret(service, keyName)).catch(() => "");
}

async function runtimeConfig(dependencies: MediaTranscriptionDependencies) {
  const [configuredUrl, sharedSecret] = await Promise.all([
    configuredSecret(dependencies.environment.LOCAL_STT_URL, "local-stt", "LOCAL_STT_URL", dependencies),
    configuredSecret(dependencies.environment.LOCAL_STT_SHARED_SECRET, "local-stt", "LOCAL_STT_SHARED_SECRET", dependencies),
  ]);
  const endpoint = localTranscriptionEndpoint(
    configuredUrl,
    allowedLocalTranscriptionOrigin(dependencies.environment.JARVIS_LOCAL_STT_ORIGIN),
  );
  return {
    local: endpoint && sharedSecret ? { endpoint, sharedSecret } : null,
  };
}

function transcriptionForm(model: string, bytes: Uint8Array, mimeType: string): FormData {
  const extension = mediaFilenameExtension(mimeType);
  if (!extension) throw new MediaTranscriptionError("media_type_unsupported", false);
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type: mimeType }), `private-media.${extension}`);
  form.append("model", model);
  form.append("temperature", "0");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");
  return form;
}

async function requestTranscription(
  endpoint: string,
  bearerToken: string,
  form: FormData,
  timeoutMs: number,
  dependencies: Pick<MediaTranscriptionDependencies, "fetcher">,
): Promise<string | null> {
  try {
    return await runWithDeadline(timeoutMs, async (signal) => {
      const response = await dependencies.fetcher(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${bearerToken}` },
        body: form,
        redirect: "error",
        signal,
      });
      if (!response.ok) return null;
      const payload = await readBoundedResponseJson(response, MAX_TRANSCRIPTION_RESPONSE_BYTES);
      if (!isJsonRecord(payload) || typeof payload.text !== "string") return null;
      return boundedExtractedText(payload.text);
    });
  } catch {
    return null;
  }
}

/**
 * Send only a signature-admitted, locally probe-approved bounded private media
 * container to the configured speech provider. The transcription text is
 * returned to the caller; provider keys and upstream responses never become
 * durable file metadata or model context.
 */
export async function transcribePrivateMedia(
  input: { bytes: Uint8Array; mimeType: string },
  options: MediaTranscriptionOptions = {},
): Promise<MediaTranscriptionResult> {
  const dependencies: MediaTranscriptionDependencies = { ...defaultDependencies, ...options };
  const mimeType = normalizeUploadMime(input.mimeType);
  if (!input.bytes.byteLength || input.bytes.byteLength > CHAT_FILE_LIMITS.maxFileBytes) {
    throw new MediaTranscriptionError("media_size_invalid", false);
  }
  const mediaKind = transcribableMediaKind(mimeType);
  if (!mediaKind || !hasExpectedMediaSignature(mimeType, input.bytes)) {
    throw new MediaTranscriptionError("media_signature_mismatch", false);
  }
  let probe;
  try {
    probe = await dependencies.probeMedia({ bytes: input.bytes, kind: mediaKind });
  } catch {
    // Decoder/prober failures are intentionally indistinguishable to callers:
    // none may turn into a request carrying the original private media.
    throw new MediaTranscriptionError("media_decode_validation_failed", false);
  }
  if (!probe.hasAudio) throw new MediaTranscriptionError("media_audio_stream_missing", false);

  const config = await runtimeConfig(dependencies);
  if (!config.local) {
    throw new MediaTranscriptionError("media_transcription_unconfigured", false);
  }
  if (config.local) {
    const text = await requestTranscription(
      config.local.endpoint,
      config.local.sharedSecret,
      transcriptionForm("turbo", input.bytes, mimeType),
      LOCAL_STT_TIMEOUT_MS,
      dependencies,
    );
    if (text !== null) return { provider: "local-faster-whisper", text };
  }
  throw new MediaTranscriptionError("media_transcription_unavailable", true);
}

/** Convert a verified provider result into the exact text/chunk representation
 * already used by PDFs, documents, and CSV files in trusted chat context. */
export function applyMediaTranscription(
  source: FileExtractionResult,
  transcription: MediaTranscriptionResult,
): FileExtractionResult {
  return applyPrivateMediaAnalysis(source, { transcription });
}

/**
 * Frame extraction and private transcription can succeed independently. A
 * video with a verified visual preview remains useful to Jarvis even when its
 * audio track is silent or its local speech service is temporarily unavailable.
 */
export function applyPrivateMediaAnalysis(
  source: FileExtractionResult,
  analysis: {
    preview?: { bytes: Uint8Array; contentType: "image/webp" };
    transcription?: MediaTranscriptionResult;
  },
): FileExtractionResult {
  if (!source.media) throw new Error("media extraction result was required");
  const text = analysis.transcription?.text ?? "";
  const visualReady = Boolean(analysis.preview);
  const transcriptReady = Boolean(analysis.transcription);
  const status = visualReady || transcriptReady ? "ready" : "stored_only" as const;
  const summary = source.media.kind === "video"
    ? [
      "Video",
      visualReady ? "representative frame ready for visual analysis in chat" : "no visual frame is available",
      transcriptReady
        ? text
          ? `${text.length.toLocaleString("en-US")} transcript characters indexed`
          : "audio track processed · no speech was detected"
        : "audio transcription unavailable",
    ].join(" · ")
    : transcriptReady
      ? text
        ? `Audio · ${text.length.toLocaleString("en-US")} transcript characters indexed · ready for chat analysis`
        : "Audio · track processed · no speech was detected"
      : "Audio saved privately · transcription is unavailable, so Jarvis cannot inspect its contents.";
  return {
    ...source,
    status,
    summary,
    text,
    chunks: chunkExtractedText(text),
    preview: analysis.preview ?? source.preview,
  };
}
