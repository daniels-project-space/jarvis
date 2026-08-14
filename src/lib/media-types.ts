import { normalizeUploadMime } from "./chat-files";

export type TranscribableMediaKind = "audio" | "video";

const MEDIA_EXTENSIONS: Readonly<Record<string, string>> = {
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/webm": "webm",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
};

const AUDIO_MIME_TYPES = new Set([
  "audio/mpeg",
  "audio/mp4",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
]);

const VIDEO_MIME_TYPES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
]);

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

function asciiAt(bytes: Uint8Array, offset: number, value: string): boolean {
  if (offset < 0 || offset + value.length > bytes.byteLength) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (bytes[offset + index] !== value.charCodeAt(index)) return false;
  }
  return true;
}

/** The narrow set of private media containers our configured transcribers can
 * receive directly. Keep this list explicit: a declared media MIME alone must
 * never cause arbitrary private bytes to leave the ingestion boundary. */
export function transcribableMediaKind(mimeType: unknown): TranscribableMediaKind | null {
  const normalized = normalizeUploadMime(mimeType);
  if (AUDIO_MIME_TYPES.has(normalized)) return "audio";
  if (VIDEO_MIME_TYPES.has(normalized)) return "video";
  return null;
}

export function mediaFilenameExtension(mimeType: unknown): string | null {
  return MEDIA_EXTENSIONS[normalizeUploadMime(mimeType)] ?? null;
}

/**
 * Validate a lightweight, container-level signature before handing a private
 * media object to a transcription provider. This is deliberately not a full
 * decoder; the provider remains the decoder, while this boundary rejects the
 * common "arbitrary bytes labelled as video" case.
 */
export function hasExpectedMediaSignature(mimeType: unknown, bytes: Uint8Array): boolean {
  const normalized = normalizeUploadMime(mimeType);
  if (normalized === "audio/mpeg") {
    return asciiAt(bytes, 0, "ID3") || (bytes.byteLength >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
  }
  if (normalized === "audio/wav") {
    return asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WAVE");
  }
  if (normalized === "audio/ogg") return asciiAt(bytes, 0, "OggS");
  if (normalized === "audio/webm" || normalized === "video/webm") {
    return startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3]);
  }
  if (["audio/mp4", "video/mp4", "video/quicktime"].includes(normalized)) {
    return asciiAt(bytes, 4, "ftyp");
  }
  return false;
}
