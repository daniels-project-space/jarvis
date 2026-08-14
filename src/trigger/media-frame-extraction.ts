import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { CHAT_FILE_LIMITS } from "../lib/chat-files";
import { isJsonRecord, parseStrictJson } from "../lib/bounded-json";
import { runBoundedProcess } from "./agent-process-bounds";

const MAX_VIDEO_DURATION_SECONDS = 30 * 60;
const MAX_VIDEO_WIDTH = 4_096;
const MAX_VIDEO_HEIGHT = 4_096;
const MAX_PREVIEW_BYTES = 1_000_000;
const PREVIEW_MAX_PIXELS = 16_000_000;
const TEMPORAL_FRAME_COUNT = 4;
const TEMPORAL_FRAME_WIDTH = 512;
const TEMPORAL_FRAME_HEIGHT = 288;
const MAX_RAW_TEMPORAL_FRAME_BYTES = 350_000;
const PROCESS_TIMEOUT_MS = 45_000;
// Cast-then-assign (not a `: NodeJS.ProcessEnv` literal annotation, and not a
// literal `as` cast either): Next.js augments ProcessEnv with a required
// `NODE_ENV`, so TypeScript rejects both forms for this deliberately bounded
// subprocess env, which carries only PATH/LANG/LC_ALL. Matches the same
// pattern already used in subscription-runtime.ts and subscription-session-r2.ts.
const PROCESS_ENV = {} as NodeJS.ProcessEnv;
PROCESS_ENV.PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
PROCESS_ENV.LANG = "C";
PROCESS_ENV.LC_ALL = "C";

export type PrivateMediaProbeResult = {
  hasVideo: boolean;
  hasAudio: boolean;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
};

type PrivateMediaKind = "audio" | "video";

export type VideoPreviewResult = {
  bytes: Uint8Array;
  contentType: "image/webp";
  durationSeconds: number | null;
  hasAudio: boolean;
  /** Timestamps represented in the private temporal contact sheet, in order. */
  timestamps: number[];
};

export class MediaFrameExtractionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "MediaFrameExtractionError";
  }
}

function executable(value: string | undefined, fallback: string): string {
  const candidate = value?.trim() || fallback;
  if (!/^\/(?:[a-zA-Z0-9._-]+\/)*[a-zA-Z0-9._-]+$/.test(candidate)) {
    throw new MediaFrameExtractionError("media_tool_path_invalid");
  }
  return candidate;
}

function boundedProcessOptions(command: string, args: readonly string[], cwd: string) {
  return {
    command,
    args,
    cwd,
    env: { ...PROCESS_ENV, HOME: cwd, TMPDIR: cwd },
    maxInputBytes: 0,
    timeoutMs: PROCESS_TIMEOUT_MS,
    stdout: { maxBytes: 64 * 1024, maxChunks: 64, maxLines: 1_000, retain: "all" as const },
    stderr: { maxBytes: 64 * 1024, maxChunks: 64, maxLines: 1_000, retain: { tailBytes: 4_096 } },
  };
}

function requiredZeroExit(result: { code: number | null }, code: string): void {
  if (result.code !== 0) throw new MediaFrameExtractionError(code);
}

function numeric(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function temporalTimestamps(durationSeconds: number): number[] {
  // Keep the first/last seek away from potentially empty stream boundaries.
  // Every value comes from ffprobe's bounded numeric duration, never input text.
  const lastFrameAt = Math.max(0, durationSeconds - Math.min(0.25, durationSeconds / 4));
  return [0.08, 0.35, 0.65, 0.92].map((fraction) =>
    Number(Math.min(lastFrameAt, Math.max(0, durationSeconds * fraction)).toFixed(3)));
}

function formatTimestamp(seconds: number): string {
  const totalMilliseconds = Math.max(0, Math.round(seconds * 1_000));
  const wholeSeconds = Math.floor(totalMilliseconds / 1_000);
  const minutes = Math.floor(wholeSeconds / 60);
  const remainingSeconds = wholeSeconds % 60;
  const tenths = Math.floor((totalMilliseconds % 1_000) / 100);
  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}.${tenths}`;
}

function timestampBadge(seconds: number): Buffer {
  // The label is produced solely from a numeric probe result, so embedding it
  // in the SVG cannot turn an upload name or media metadata into markup.
  const label = formatTimestamp(seconds);
  return Buffer.from(
    `<svg width="84" height="26" xmlns="http://www.w3.org/2000/svg"><rect width="84" height="26" rx="5" fill="#111827" fill-opacity="0.88"/><text x="9" y="18" font-family="sans-serif" font-size="14" font-weight="600" fill="#ffffff">${label}</text></svg>`,
    "utf8",
  );
}

function parseProbe(stdout: Uint8Array, expectedKind: PrivateMediaKind): PrivateMediaProbeResult {
  let parsed: unknown;
  try {
    parsed = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(stdout));
  } catch {
    throw new MediaFrameExtractionError("media_probe_payload_invalid");
  }
  if (!isJsonRecord(parsed)) throw new MediaFrameExtractionError("media_probe_payload_invalid");
  const format = isJsonRecord(parsed.format) ? parsed.format : null;
  const streams = Array.isArray(parsed.streams) ? parsed.streams.filter(isJsonRecord) : [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const hasAudio = streams.some((stream) => stream.codec_type === "audio");
  const durationSeconds = numeric(format?.duration);
  const width = numeric(video?.width);
  const height = numeric(video?.height);
  if (durationSeconds === null || durationSeconds > MAX_VIDEO_DURATION_SECONDS
    || (width !== null && width > MAX_VIDEO_WIDTH)
    || (height !== null && height > MAX_VIDEO_HEIGHT)) {
    throw new MediaFrameExtractionError("video_decode_bounds_exceeded");
  }
  if (expectedKind === "video" && !video) throw new MediaFrameExtractionError("video_stream_missing");
  if (expectedKind === "audio" && !hasAudio) throw new MediaFrameExtractionError("audio_stream_missing");
  // An audio-labelled upload with a visual stream is intentionally not sent
  // to speech. This keeps the MIME admission and decoded container aligned.
  if (expectedKind === "audio" && video) throw new MediaFrameExtractionError("media_stream_kind_mismatch");
  return { hasVideo: Boolean(video), hasAudio, durationSeconds, width, height };
}

/**
 * Parse an admitted private media container locally before it can be handed to
 * the speech service. Signature checks deliberately remain only a cheap
 * first gate; this bounded ffprobe pass is the authoritative decode admission.
 */
export async function probePrivateMedia(input: {
  bytes: Uint8Array;
  kind: PrivateMediaKind;
  ffprobePath?: string;
}): Promise<PrivateMediaProbeResult> {
  if (!input.bytes.byteLength || input.bytes.byteLength > CHAT_FILE_LIMITS.maxFileBytes) {
    throw new MediaFrameExtractionError("media_size_invalid");
  }
  const directory = await mkdtemp(join(tmpdir(), "jarvis-private-media-probe-"));
  const source = join(directory, "source.media");
  try {
    await chmod(directory, 0o700);
    await writeFile(source, input.bytes, { mode: 0o600 });
    const ffprobePath = executable(input.ffprobePath ?? process.env.FFPROBE_PATH, "/usr/bin/ffprobe");
    const probe = await runBoundedProcess(boundedProcessOptions(ffprobePath, [
      "-v", "error",
      "-protocol_whitelist", "file,pipe",
      "-show_entries", "format=duration:stream=codec_type,width,height",
      "-of", "json",
      source,
    ], directory));
    requiredZeroExit(probe, "media_probe_failed");
    return parseProbe(probe.stdout, input.kind);
  } catch (error) {
    if (error instanceof MediaFrameExtractionError) throw error;
    throw new MediaFrameExtractionError("media_probe_failed");
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 2 }).catch(() => undefined);
  }
}

/**
 * Derive one bounded, timestamped four-frame contact sheet entirely inside the
 * trusted Trigger worker. It gives chat temporal video context without ever
 * uploading the source container or multiplying the durable object surface.
 * Untrusted bytes are written only to an owned 0700 temp directory, passed as
 * generated paths, and processed with no inherited credentials.
 */
export async function extractVideoPreview(input: {
  bytes: Uint8Array;
  ffmpegPath?: string;
  ffprobePath?: string;
}): Promise<VideoPreviewResult> {
  if (!input.bytes.byteLength || input.bytes.byteLength > CHAT_FILE_LIMITS.maxFileBytes) {
    throw new MediaFrameExtractionError("media_size_invalid");
  }
  const directory = await mkdtemp(join(tmpdir(), "jarvis-private-video-"));
  const source = join(directory, "source.media");
  const rawFrames = Array.from({ length: TEMPORAL_FRAME_COUNT }, (_, index) => join(directory, `frame-${index}.webp`));
  try {
    await chmod(directory, 0o700);
    await writeFile(source, input.bytes, { mode: 0o600 });
    const ffprobePath = executable(input.ffprobePath ?? process.env.FFPROBE_PATH, "/usr/bin/ffprobe");
    const ffmpegPath = executable(input.ffmpegPath ?? process.env.FFMPEG_PATH, "/usr/bin/ffmpeg");
    const probe = await runBoundedProcess(boundedProcessOptions(ffprobePath, [
      "-v", "error",
      "-protocol_whitelist", "file,pipe",
      "-show_entries", "format=duration:stream=codec_type,width,height",
      "-of", "json",
      source,
    ], directory));
    requiredZeroExit(probe, "media_probe_failed");
    const metadata = parseProbe(probe.stdout, "video");
    if (metadata.durationSeconds === null) throw new MediaFrameExtractionError("video_decode_bounds_exceeded");
    const timestamps = temporalTimestamps(metadata.durationSeconds);
    const frame = await runBoundedProcess(boundedProcessOptions(ffmpegPath, [
      "-v", "error",
      "-nostdin",
      "-protocol_whitelist", "file,pipe",
      "-threads", "1",
      ...timestamps.flatMap((timestamp, index) => [
        "-ss", timestamp.toFixed(3),
        "-i", source,
        "-map", `${index}:v:0`,
        "-frames:v", "1",
        "-an",
        "-vf", `scale=${TEMPORAL_FRAME_WIDTH}:${TEMPORAL_FRAME_HEIGHT}:force_original_aspect_ratio=decrease`,
        "-c:v", "libwebp",
        "-quality", "70",
        "-compression_level", "4",
        "-fs", String(MAX_RAW_TEMPORAL_FRAME_BYTES),
        "-y",
        rawFrames[index],
      ]),
    ], directory));
    requiredZeroExit(frame, "media_frame_extraction_failed");
    const normalizedFrames = await Promise.all(rawFrames.map(async (rawFrame) => {
      const bytes = await readFile(rawFrame);
      if (!bytes.byteLength || bytes.byteLength > MAX_RAW_TEMPORAL_FRAME_BYTES) {
        throw new MediaFrameExtractionError("media_preview_bounds_exceeded");
      }
      const normalizedFrame = await sharp(bytes, { failOn: "error", limitInputPixels: PREVIEW_MAX_PIXELS })
        .rotate()
        .resize({
          width: TEMPORAL_FRAME_WIDTH,
          height: TEMPORAL_FRAME_HEIGHT,
          fit: "contain",
          background: { r: 15, g: 23, b: 42, alpha: 1 },
        })
        .webp({ quality: 70, effort: 4 })
        .toBuffer();
      if (!normalizedFrame.byteLength || normalizedFrame.byteLength > MAX_RAW_TEMPORAL_FRAME_BYTES) {
        throw new MediaFrameExtractionError("media_preview_bounds_exceeded");
      }
      return normalizedFrame;
    }));
    const normalized = await sharp({
      create: {
        width: TEMPORAL_FRAME_WIDTH * 2,
        height: TEMPORAL_FRAME_HEIGHT * 2,
        channels: 4,
        background: { r: 15, g: 23, b: 42, alpha: 1 },
      },
    })
      .composite([
        ...normalizedFrames.map((image, index) => ({
          input: image,
          left: (index % 2) * TEMPORAL_FRAME_WIDTH,
          top: Math.floor(index / 2) * TEMPORAL_FRAME_HEIGHT,
        })),
        ...timestamps.map((timestamp, index) => ({
          input: timestampBadge(timestamp),
          left: (index % 2) * TEMPORAL_FRAME_WIDTH + 10,
          top: Math.floor(index / 2) * TEMPORAL_FRAME_HEIGHT + 10,
        })),
      ])
      .webp({ quality: 74, effort: 4 })
      .toBuffer();
    if (!normalized.byteLength || normalized.byteLength > MAX_PREVIEW_BYTES) {
      throw new MediaFrameExtractionError("media_preview_bounds_exceeded");
    }
    return {
      bytes: new Uint8Array(normalized),
      contentType: "image/webp",
      durationSeconds: metadata.durationSeconds,
      hasAudio: metadata.hasAudio,
      timestamps,
    };
  } catch (error) {
    if (error instanceof MediaFrameExtractionError) throw error;
    throw new MediaFrameExtractionError("media_frame_extraction_failed");
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 2 }).catch(() => undefined);
  }
}
