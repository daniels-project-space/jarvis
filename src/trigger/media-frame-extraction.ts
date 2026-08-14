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
 * Derive one bounded representative WebP entirely inside the trusted Trigger
 * worker. Untrusted bytes are written only to an owned 0700 temp directory,
 * passed as a generated path, and processed with no inherited credentials.
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
  const rawPreview = join(directory, "preview.webp");
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
    const frame = await runBoundedProcess(boundedProcessOptions(ffmpegPath, [
      "-v", "error",
      "-nostdin",
      "-protocol_whitelist", "file,pipe",
      "-threads", "1",
      "-i", source,
      "-map", "0:v:0",
      "-vf", "thumbnail=50,scale=1024:-2:force_original_aspect_ratio=decrease",
      "-frames:v", "1",
      "-an",
      "-c:v", "libwebp",
      "-quality", "78",
      "-compression_level", "4",
      "-y",
      rawPreview,
    ], directory));
    requiredZeroExit(frame, "media_frame_extraction_failed");
    const preview = await readFile(rawPreview);
    if (!preview.byteLength || preview.byteLength > MAX_PREVIEW_BYTES) {
      throw new MediaFrameExtractionError("media_preview_bounds_exceeded");
    }
    const normalized = await sharp(preview, { failOn: "error", limitInputPixels: PREVIEW_MAX_PIXELS })
      .rotate()
      .resize({ width: 1_024, height: 1_024, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 78, effort: 4 })
      .toBuffer();
    if (!normalized.byteLength || normalized.byteLength > MAX_PREVIEW_BYTES) {
      throw new MediaFrameExtractionError("media_preview_bounds_exceeded");
    }
    return {
      bytes: new Uint8Array(normalized),
      contentType: "image/webp",
      durationSeconds: metadata.durationSeconds,
      hasAudio: metadata.hasAudio,
    };
  } catch (error) {
    if (error instanceof MediaFrameExtractionError) throw error;
    throw new MediaFrameExtractionError("media_frame_extraction_failed");
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 2 }).catch(() => undefined);
  }
}
