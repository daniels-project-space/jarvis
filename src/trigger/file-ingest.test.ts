import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MockFileExtractionError extends Error {
    constructor(readonly code: string, readonly quarantined: boolean) {
      super(code);
    }
  }
  class MockMediaFrameExtractionError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  }
  class MockMediaTranscriptionError extends Error {
    constructor(readonly code: string, readonly retryable: boolean) {
      super(code);
    }
  }
  process.env.CONVEX_URL = "https://convex.test";
  process.env.JARVIS_WORKER_TOKEN = "worker-token";
  return {
    FileExtractionError: MockFileExtractionError,
    MediaFrameExtractionError: MockMediaFrameExtractionError,
    MediaTranscriptionError: MockMediaTranscriptionError,
    extractPrivateFile: vi.fn(),
    extractVideoPreview: vi.fn(),
    transcribePrivateMedia: vi.fn(),
    applyPrivateMediaAnalysis: vi.fn(),
    privateFileObjectKey: vi.fn(),
    privateR2Delete: vi.fn(),
    privateR2Get: vi.fn(),
    privateR2Put: vi.fn(),
  };
});

vi.mock("@trigger.dev/sdk/v3", () => ({ task: (definition: unknown) => definition }));
vi.mock("../lib/file-extraction", () => ({
  FileExtractionError: mocks.FileExtractionError,
  extractPrivateFile: mocks.extractPrivateFile,
}));
vi.mock("../lib/private-r2", () => ({
  privateFileObjectKey: mocks.privateFileObjectKey,
  privateR2Delete: mocks.privateR2Delete,
  privateR2Get: mocks.privateR2Get,
  privateR2Put: mocks.privateR2Put,
}));
vi.mock("./media-frame-extraction", () => ({
  MediaFrameExtractionError: mocks.MediaFrameExtractionError,
  extractVideoPreview: mocks.extractVideoPreview,
}));
vi.mock("./media-transcription", () => ({
  MediaTranscriptionError: mocks.MediaTranscriptionError,
  applyPrivateMediaAnalysis: mocks.applyPrivateMediaAnalysis,
  transcribePrivateMedia: mocks.transcribePrivateMedia,
}));

import { runFileIngest } from "./file-ingest";

const ORIGINAL = new Uint8Array([1, 2, 3, 4]);
const SHA256 = createHash("sha256").update(ORIGINAL).digest("hex");
const CLAIM = {
  _id: "file-1",
  originalName: "walkthrough.mp4",
  mimeType: "video/mp4",
  sizeBytes: ORIGINAL.byteLength,
  expectedSha256: SHA256,
  r2Key: "owners/daniel/files/file-1/v1/original",
  ingestVersion: 1,
};

function r2Response(bytes: Uint8Array): Response {
  return new Response(Buffer.from(bytes), {
    status: 200,
    headers: { "content-length": String(bytes.byteLength) },
  });
}

function storedVideo() {
  return {
    sha256: SHA256,
    detectedMimeType: "video/mp4",
    status: "stored_only" as const,
    summary: "Video saved privately",
    text: "",
    chunks: [],
    media: { kind: "video" as const },
  };
}

function analyzedMedia(source: ReturnType<typeof storedVideo>, analysis: {
  preview?: { bytes: Uint8Array; contentType: "image/webp" };
  transcription?: { provider: "local-faster-whisper"; text: string };
}) {
  const text = analysis.transcription?.text ?? "";
  return {
    ...source,
    status: analysis.preview || analysis.transcription ? "ready" as const : "stored_only" as const,
    summary: "media analysis result",
    text,
    chunks: text ? [{ ordinal: 0, text }] : [],
    preview: analysis.preview,
  };
}

function configureConvex(options: {
  complete?: { ok: boolean; reason?: string };
  duplicate?: unknown;
} = {}) {
  const calls: Array<{ path: string; args: Record<string, unknown> }> = [];
  const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { path: string; args: Record<string, unknown> };
    calls.push({ path: body.path, args: body.args });
    const value = body.path === "files:claimIngest"
      ? CLAIM
      : body.path === "files:readyDuplicateByHash"
        ? (options.duplicate ?? null)
        : body.path === "files:completeIngest"
          ? (options.complete ?? { ok: true })
          : null;
    return new Response(JSON.stringify({ value }), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetcher);
  return { calls, fetcher };
}

describe("private media file ingest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.privateFileObjectKey.mockImplementation((fileId: string, version: number, purpose: string) =>
      `owners/daniel/files/${fileId}/v${version}/${purpose}`);
    mocks.privateR2Get.mockImplementation(async (key: string) => {
      if (key === CLAIM.r2Key) return r2Response(ORIGINAL);
      throw new Error(`unexpected R2 key ${key}`);
    });
    mocks.privateR2Put.mockResolvedValue(undefined);
    mocks.privateR2Delete.mockResolvedValue(undefined);
    mocks.extractPrivateFile.mockResolvedValue(storedVideo());
    mocks.extractVideoPreview.mockResolvedValue({ bytes: new Uint8Array([9, 8, 7]), contentType: "image/webp" });
    mocks.transcribePrivateMedia.mockResolvedValue({ provider: "local-faster-whisper", text: "Meet at ten." });
    mocks.applyPrivateMediaAnalysis.mockImplementation(analyzedMedia);
  });

  it("persists derived transcript and preview keys only after bounded media analysis", async () => {
    const { calls } = configureConvex();

    await expect(runFileIngest({ fileId: "file-1", ingestVersion: 1 })).resolves.toMatchObject({ status: "ready" });

    expect(mocks.privateR2Put).toHaveBeenCalledWith(
      "owners/daniel/files/file-1/v1/extracted.txt",
      "Meet at ten.",
      "text/plain",
    );
    expect(mocks.privateR2Put).toHaveBeenCalledWith(
      "owners/daniel/files/file-1/v1/preview.webp",
      new Uint8Array([9, 8, 7]),
      "image/webp",
    );
    const completion = calls.find((call) => call.path === "files:completeIngest");
    expect(completion?.args).toMatchObject({
      status: "ready",
      extractedTextR2Key: "owners/daniel/files/file-1/v1/extracted.txt",
      previewR2Key: "owners/daniel/files/file-1/v1/preview.webp",
    });
  });

  it("removes every derived media object when completion loses its claim", async () => {
    configureConvex({ complete: { ok: false, reason: "stale_claim" } });

    await expect(runFileIngest({ fileId: "file-1", ingestVersion: 1 })).resolves.toMatchObject({ stale: true });

    expect(mocks.privateR2Delete).toHaveBeenCalledWith("owners/daniel/files/file-1/v1/extracted.txt");
    expect(mocks.privateR2Delete).toHaveBeenCalledWith("owners/daniel/files/file-1/v1/preview.webp");
    expect(mocks.privateR2Delete).toHaveBeenCalledTimes(2);
  });

  it("keeps an undecodable video honestly stored-only without orphaning a preview", async () => {
    const { calls } = configureConvex();
    mocks.extractVideoPreview.mockRejectedValue(new mocks.MediaFrameExtractionError("media_frame_extraction_failed"));
    mocks.transcribePrivateMedia.mockRejectedValue(new mocks.MediaTranscriptionError("media_decode_validation_failed", false));

    await expect(runFileIngest({ fileId: "file-1", ingestVersion: 1 })).resolves.toMatchObject({ status: "stored_only" });

    expect(mocks.privateR2Put).not.toHaveBeenCalled();
    expect(mocks.privateR2Delete).not.toHaveBeenCalled();
    expect(calls.find((call) => call.path === "files:completeIngest")?.args.status).toBe("stored_only");
    expect(calls.some((call) => call.path === "files:failIngest")).toBe(false);
  });

  it("copies a ready duplicate into new owner-bound derived keys without reprocessing media", async () => {
    const duplicate = {
      file: {
        status: "ready",
        sha256: SHA256,
        mimeType: "video/mp4",
        summary: "cached analysis",
        extractedTextR2Key: "owners/daniel/files/file-old/v1/extracted.txt",
        previewR2Key: "owners/daniel/files/file-old/v1/preview.webp",
      },
      chunks: [{ ordinal: 0, text: "Cached transcript." }],
    };
    const { calls } = configureConvex({ duplicate });
    mocks.privateR2Get.mockImplementation(async (key: string) => {
      if (key === CLAIM.r2Key) return r2Response(ORIGINAL);
      if (key === duplicate.file.extractedTextR2Key) return r2Response(new TextEncoder().encode("Cached transcript."));
      if (key === duplicate.file.previewR2Key) return r2Response(new Uint8Array([7, 7, 7]));
      throw new Error(`unexpected R2 key ${key}`);
    });

    await expect(runFileIngest({ fileId: "file-1", ingestVersion: 1 })).resolves.toMatchObject({ status: "ready", reused: true });

    expect(mocks.extractPrivateFile).not.toHaveBeenCalled();
    expect(mocks.extractVideoPreview).not.toHaveBeenCalled();
    expect(mocks.transcribePrivateMedia).not.toHaveBeenCalled();
    expect(mocks.privateR2Put).toHaveBeenCalledWith(
      "owners/daniel/files/file-1/v1/preview.webp",
      new Uint8Array([7, 7, 7]),
      "image/webp",
    );
    expect(calls.find((call) => call.path === "files:completeIngest")?.args.previewR2Key)
      .toBe("owners/daniel/files/file-1/v1/preview.webp");
  });
});
