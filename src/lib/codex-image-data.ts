import { CHAT_FILE_LIMITS } from "./chat-files";

const TRUSTED_CAPTURE_BASE = "https://pub-901f8094a6f04b32a784dc06cf3ebbc3.r2.dev";
const JARVIS_IMAGE_MARKER = /\[JARVIS_IMAGE_URL:([^\]]+)\]/;
const JARVIS_IMAGE_MARKERS = /\s*\[JARVIS_IMAGE_URL:[^\]]+\]\s*/g;

export const CODEX_IMAGE_LIMITS = Object.freeze({
  maxSourceBytes: 12 * 1024 * 1024,
  maxInputPixels: 16_000_000,
  maxDataUrlBytesPerImage: 512 * 1024,
  // The app-server accepts one 2 MiB JSONL frame. Keep all image records
  // within half of that envelope so bounded text/context still has headroom.
  maxTransportBytes: 1_024 * 1_024,
  maxDimension: 2_048,
  maxInputs: CHAT_FILE_LIMITS.maxImageInputsPerTurn,
  fetchTimeoutMs: 4_000,
  batchTimeoutMs: 10_000,
});

export type CodexImageInput =
  | { status: "ready"; label: string; dataUrl: string }
  | { status: "unavailable"; label: string };

function encodedByteLength(base64: string): number {
  if (base64.length % 4 !== 0) return Number.POSITIVE_INFINITY;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

export function isCodexInlineImageDataUrl(value: string): boolean {
  const match = value.match(/^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) return false;
  const bytes = encodedByteLength(match[1]);
  return bytes > 0
    && Buffer.byteLength(value, "utf8") <= CODEX_IMAGE_LIMITS.maxDataUrlBytesPerImage;
}

function boundedImageLabel(value: string): string | null {
  const label = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 320);
  return label || null;
}

export function boundedCodexImageInputs(values: readonly CodexImageInput[]): CodexImageInput[] {
  const accepted: CodexImageInput[] = [];
  let transportBytes = 0;
  for (const value of values) {
    const label = boundedImageLabel(value.label);
    if (!label) continue;
    const candidate: CodexImageInput = value.status === "ready" && isCodexInlineImageDataUrl(value.dataUrl)
      ? { status: "ready", label, dataUrl: value.dataUrl }
      : { status: "unavailable", label };
    const bytes = Buffer.byteLength(JSON.stringify(candidate), "utf8");
    if (transportBytes + bytes > CODEX_IMAGE_LIMITS.maxTransportBytes) continue;
    accepted.push(candidate);
    transportBytes += bytes;
    if (accepted.length >= CODEX_IMAGE_LIMITS.maxInputs) break;
  }
  return accepted;
}

export function stripJarvisImageMarkers(text: string): string {
  return text.replace(JARVIS_IMAGE_MARKERS, " ").trim();
}

export function trustedCaptureUrl(text: string): URL | null {
  const raw = text.match(JARVIS_IMAGE_MARKER)?.[1]?.trim();
  if (!raw || raw.length > 2_048) return null;
  try {
    const url = new URL(raw);
    if (
      url.origin !== TRUSTED_CAPTURE_BASE ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.pathname.startsWith("/creations/")
    ) return null;
    return url;
  } catch {
    return null;
  }
}
