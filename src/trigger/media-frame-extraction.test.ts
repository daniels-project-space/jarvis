import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { MediaFrameExtractionError, extractVideoPreview, probePrivateMedia } from "./media-frame-extraction";

const execFileAsync = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH ?? "/usr/bin/ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH ?? "/usr/bin/ffprobe";
const localFfmpegAvailable = existsSync(FFMPEG) && existsSync(FFPROBE);

describe("bounded private video frame extraction", () => {
  it("rejects empty input before creating a decoder process", async () => {
    await expect(extractVideoPreview({ bytes: new Uint8Array() })).rejects.toMatchObject({
      code: "media_size_invalid",
    } satisfies Partial<MediaFrameExtractionError>);
  });

  it.skipIf(!localFfmpegAvailable)("rejects a signature-only MP4 before speech can receive it", async () => {
    const signatureOnlyMp4 = Buffer.from("000000186674797069736f6d0000020069736f6d69736f3261766331", "hex");
    await expect(probePrivateMedia({
      bytes: signatureOnlyMp4,
      kind: "video",
      ffprobePath: FFPROBE,
    })).rejects.toMatchObject({ code: expect.stringMatching(/^media_/) } satisfies Partial<MediaFrameExtractionError>);
  }, 60_000);

  it.skipIf(!localFfmpegAvailable)("derives a real bounded WebP from a small MP4", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jarvis-media-frame-test-"));
    const input = join(directory, "fixture.mp4");
    try {
      await execFileAsync(FFMPEG, [
        "-v", "error",
        "-f", "lavfi",
        "-i", "testsrc2=size=320x180:rate=12",
        "-t", "1",
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        "-y",
        input,
      ]);
      const preview = await extractVideoPreview({
        bytes: await readFile(input),
        ffmpegPath: FFMPEG,
        ffprobePath: FFPROBE,
      });
      const metadata = await sharp(preview.bytes).metadata();

      expect(preview.contentType).toBe("image/webp");
      expect(preview.bytes.byteLength).toBeGreaterThan(0);
      expect(preview.bytes.byteLength).toBeLessThanOrEqual(1_000_000);
      expect(metadata.width).toBeGreaterThan(0);
      expect(metadata.height).toBeGreaterThan(0);
      expect(preview.durationSeconds).toBeCloseTo(1, 1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it.skipIf(!localFfmpegAvailable)("locally probes a real audio stream before it can be transcribed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jarvis-media-probe-test-"));
    const input = join(directory, "fixture.wav");
    try {
      await execFileAsync(FFMPEG, [
        "-v", "error",
        "-f", "lavfi",
        "-i", "sine=frequency=440:sample_rate=16000",
        "-t", "1",
        "-ac", "1",
        "-y",
        input,
      ]);
      const probe = await probePrivateMedia({
        bytes: await readFile(input),
        kind: "audio",
        ffprobePath: FFPROBE,
      });

      expect(probe.hasAudio).toBe(true);
      expect(probe.hasVideo).toBe(false);
      expect(probe.durationSeconds).toBeCloseTo(1, 1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
