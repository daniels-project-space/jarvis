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
  process.env.JARVIS_FILE_REHOME_TOKEN = "file-derived-artifact-rehome-test-token";
  return {
    FileExtractionError: MockFileExtractionError,
    MediaFrameExtractionError: MockMediaFrameExtractionError,
    MediaTranscriptionError: MockMediaTranscriptionError,
    extractPrivateFile: vi.fn(),
    extractVideoPreview: vi.fn(),
    transcribePrivateMedia: vi.fn(),
    applyPrivateMediaAnalysis: vi.fn(),
    privateFileAttemptObjectKey: vi.fn(),
    privateR2Delete: vi.fn(),
    privateR2Get: vi.fn(),
    privateR2Put: vi.fn(),
    triggerTask: vi.fn(),
  };
});

vi.mock("@trigger.dev/sdk/v3", () => ({
  task: (definition: unknown) => definition,
  tasks: { trigger: mocks.triggerTask },
}));
vi.mock("../lib/file-extraction", () => ({
  FileExtractionError: mocks.FileExtractionError,
  extractPrivateFile: mocks.extractPrivateFile,
}));
vi.mock("../lib/private-r2", () => ({
  privateFileAttemptObjectKey: mocks.privateFileAttemptObjectKey,
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

import { runFileIngest, runFileIngestOutputProtocolV2Activation } from "./file-ingest";

const ORIGINAL = new Uint8Array([1, 2, 3, 4]);
const SHA256 = createHash("sha256").update(ORIGINAL).digest("hex");
const OUTPUT_ATTEMPT = "1-123e4567-e89b-12d3-a456-426614174000";
const OUTPUT_EXTRACTED = `owners/daniel/files/file-1/v1/a${OUTPUT_ATTEMPT}/extracted.txt`;
const OUTPUT_PREVIEW = `owners/daniel/files/file-1/v1/a${OUTPUT_ATTEMPT}/preview.webp`;
const CLAIM = {
  _id: "file-1",
  originalName: "walkthrough.mp4",
  mimeType: "video/mp4",
  sizeBytes: ORIGINAL.byteLength,
  expectedSha256: SHA256,
  r2Key: "owners/daniel/files/file-1/v1/original",
  ingestVersion: 1,
  ingestOutputProtocol: 2,
  ingestOutputAttemptId: OUTPUT_ATTEMPT,
  derivedOutput: {
    outputAttemptOutboxId: "output-attempt-outbox-1",
    extractedTextR2Key: OUTPUT_EXTRACTED,
    previewR2Key: OUTPUT_PREVIEW,
  },
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

function readySpreadsheet() {
  return {
    sha256: SHA256,
    detectedMimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    status: "ready" as const,
    summary: "Excel workbook · 2 sheets · 5 cells indexed",
    text: "[Booked stay · A1:B2]\nA1: City | B1: Venice\nA2: Cost | B2: 2645",
    chunks: [{
      ordinal: 0,
      text: "A1: City | B1: Venice\nA2: Cost | B2: 2645",
      sheet: "Booked stay",
      cellRange: "A1:B2",
    }],
    sheetNames: ["Booked stay", "Flights"],
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
  throwAfterCommittedCompletion?: boolean;
  throwAfterUncommittedCompletion?: boolean;
  receiptFailuresBeforeResponse?: number;
  activation?: {
    activated: boolean;
    activatedAt: number;
    protocolVersion: number;
    requeue: Array<{ fileId: string; ingestVersion: number }>;
  };
} = {}) {
  const calls: Array<{ path: string; args: Record<string, unknown> }> = [];
  let committedCompletion: Record<string, unknown> | null = null;
  let receiptRequests = 0;
  const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { path: string; args: Record<string, unknown> };
    calls.push({ path: body.path, args: body.args });
    if (body.path === "files:completeIngest" && options.throwAfterCommittedCompletion) {
      // The server mutation has committed, but the caller loses its response.
      committedCompletion = body.args;
      throw new Error("simulated response loss after committed completeIngest mutation");
    }
    if (body.path === "files:completeIngest" && options.throwAfterUncommittedCompletion) {
      throw new Error("simulated response loss before completeIngest mutation commits");
    }
    if (body.path === "files:ingestCommitReceipt") {
      receiptRequests += 1;
      if (receiptRequests <= Number(options.receiptFailuresBeforeResponse ?? 0)) {
        throw new Error("simulated receipt transport outage");
      }
    }
    const value = body.path === "files:claimIngest"
      ? CLAIM
      : body.path === "files:readyDuplicateByHash"
        ? (options.duplicate ?? null)
        : body.path === "files:completeIngest"
          ? (options.complete ?? { ok: true })
          : body.path === "files:ingestCommitReceipt"
            ? (
              committedCompletion
              && body.args.fileId === committedCompletion.fileId
              && body.args.ingestVersion === committedCompletion.ingestVersion
              && body.args.extractedTextR2Key === committedCompletion.extractedTextR2Key
              && body.args.previewR2Key === committedCompletion.previewR2Key
              && body.args.outputAttemptId === committedCompletion.outputAttemptId
                ? { committed: true, status: "ready" }
                : { committed: false }
            )
          : body.path === "files:retireIngestOutputAttempt"
            ? (
              committedCompletion
              && body.args.fileId === committedCompletion.fileId
              && body.args.ingestVersion === committedCompletion.ingestVersion
              && body.args.outputAttemptId === CLAIM.derivedOutput.outputAttemptOutboxId
                ? { committed: true, status: "ready" }
                : { committed: false, outputAttemptId: CLAIM.derivedOutput.outputAttemptOutboxId }
            )
          : body.path === "files:activateIngestOutputProtocolV2"
            ? (options.activation ?? { activated: true, activatedAt: 1_760_000_000_000, protocolVersion: 2, requeue: [] })
            : body.path === "files:beginIngestOutputWrite"
              ? true
            : null;
    return new Response(JSON.stringify({ value }), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetcher);
  return { calls, fetcher };
}

describe("private media file ingest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.privateFileAttemptObjectKey.mockImplementation((fileId: string, version: number, attempt: string, purpose: string) =>
      `owners/daniel/files/${fileId}/v${version}/a${attempt}/${purpose}`);
    mocks.privateR2Get.mockImplementation(async (key: string) => {
      if (key === CLAIM.r2Key) return r2Response(ORIGINAL);
      throw new Error(`unexpected R2 key ${key}`);
    });
    mocks.privateR2Put.mockResolvedValue(undefined);
    mocks.privateR2Delete.mockResolvedValue(undefined);
    mocks.triggerTask.mockResolvedValue({ id: "cleanup-run-1" });
    mocks.extractPrivateFile.mockResolvedValue(storedVideo());
    mocks.extractVideoPreview.mockResolvedValue({
      bytes: new Uint8Array([9, 8, 7]),
      contentType: "image/webp",
      timestamps: [0.1, 0.4, 0.7, 0.9],
    });
    mocks.transcribePrivateMedia.mockResolvedValue({ provider: "local-faster-whisper", text: "Meet at ten." });
    mocks.applyPrivateMediaAnalysis.mockImplementation(analyzedMedia);
  });

  it("persists derived transcript and preview keys only after bounded media analysis", async () => {
    const { calls } = configureConvex();

    await expect(runFileIngest({ fileId: "file-1", ingestVersion: 1 })).resolves.toMatchObject({ status: "ready" });

    expect(mocks.privateR2Put).toHaveBeenCalledWith(
      OUTPUT_EXTRACTED,
      "Meet at ten.",
      "text/plain",
    );
    expect(mocks.privateR2Put).toHaveBeenCalledWith(
      OUTPUT_PREVIEW,
      new Uint8Array([9, 8, 7]),
      "image/webp",
    );
    const completion = calls.find((call) => call.path === "files:completeIngest");
    expect(completion?.args).toMatchObject({
      status: "ready",
      extractedTextR2Key: OUTPUT_EXTRACTED,
      previewR2Key: OUTPUT_PREVIEW,
    });
    expect(mocks.applyPrivateMediaAnalysis).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        preview: expect.objectContaining({ timestamps: [0.1, 0.4, 0.7, 0.9] }),
      }),
    );
    expect(calls.filter((call) => call.path === "files:beginIngestOutputWrite").map((call) => call.args))
      .toEqual([
        expect.objectContaining({ outputAttemptId: CLAIM.derivedOutput.outputAttemptOutboxId, purpose: "extracted.txt" }),
        expect.objectContaining({ outputAttemptId: CLAIM.derivedOutput.outputAttemptOutboxId, purpose: "preview.webp" }),
      ]);
  });

  it("persists an XLSX's private extracted text and sheet/cell provenance for chat context", async () => {
    const { calls } = configureConvex();
    mocks.extractPrivateFile.mockResolvedValue(readySpreadsheet());

    await expect(runFileIngest({ fileId: "file-1", ingestVersion: 1 })).resolves.toMatchObject({ status: "ready" });

    expect(mocks.privateR2Put).toHaveBeenCalledWith(
      OUTPUT_EXTRACTED,
      "[Booked stay · A1:B2]\nA1: City | B1: Venice\nA2: Cost | B2: 2645",
      "text/plain",
    );
    const completion = calls.find((call) => call.path === "files:completeIngest");
    expect(completion?.args).toMatchObject({
      detectedMimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      sheetNames: ["Booked stay", "Flights"],
      chunks: [expect.objectContaining({ sheet: "Booked stay", cellRange: "A1:B2" })],
    });
    expect(mocks.extractVideoPreview).not.toHaveBeenCalled();
    expect(mocks.transcribePrivateMedia).not.toHaveBeenCalled();
  });

  it("hands stale completion output to durable cleanup instead of deleting inline", async () => {
    const { calls } = configureConvex({ complete: { ok: false, reason: "stale_claim" } });

    await expect(runFileIngest({ fileId: "file-1", ingestVersion: 1 }))
      .resolves.toMatchObject({ stale: true, reason: "stale_claim", cleanupQueued: true });

    expect(calls.some((call) => call.path === "files:ingestCommitReceipt")).toBe(true);
    expect(calls.find((call) => call.path === "files:retireIngestOutputAttempt")?.args).toMatchObject({
      outputAttemptId: CLAIM.derivedOutput.outputAttemptOutboxId,
    });
    expect(mocks.privateR2Delete).not.toHaveBeenCalled();
    expect(mocks.triggerTask).toHaveBeenCalledWith(
      "jarvis-file-ingest-derived-cleanup",
      { outputAttemptId: "output-attempt-outbox-1" },
      { idempotencyKey: "jarvis-file-ingest-derived-cleanup-v2-output-attempt-outbox-1" },
    );
  });

  it("keeps committed derived media when the complete response is lost", async () => {
    const { calls } = configureConvex({ throwAfterCommittedCompletion: true });

    await expect(runFileIngest({ fileId: "file-1", ingestVersion: 1 }))
      .resolves.toMatchObject({ status: "ready", recovered: true });

    const receipt = calls.find((call) => call.path === "files:ingestCommitReceipt");
    expect(receipt?.args).toMatchObject({
      fileId: "file-1",
      ingestVersion: 1,
      extractedTextR2Key: OUTPUT_EXTRACTED,
      previewR2Key: OUTPUT_PREVIEW,
      workerToken: "worker-token",
    });
    expect(calls.map((call) => call.path)).toEqual([
      "files:claimIngest",
      "files:readyDuplicateByHash",
      "files:beginIngestOutputWrite",
      "files:beginIngestOutputWrite",
      "files:completeIngest",
      "files:ingestCommitReceipt",
    ]);
    expect(mocks.privateR2Delete).not.toHaveBeenCalled();
    expect(calls.some((call) => call.path === "files:failIngest")).toBe(false);
  });

  it("hands an unavailable receipt and non-commit to durable derived cleanup", async () => {
    const { calls } = configureConvex({
      throwAfterUncommittedCompletion: true,
      receiptFailuresBeforeResponse: 1,
    });

    await expect(runFileIngest({ fileId: "file-1", ingestVersion: 1 }))
      .rejects.toThrow("simulated response loss before completeIngest mutation commits");

    expect(calls.filter((call) => call.path === "files:ingestCommitReceipt")).toHaveLength(2);
    const enqueue = calls.find((call) => call.path === "files:retireIngestOutputAttempt");
    expect(enqueue?.args).toMatchObject({
      fileId: "file-1",
      ingestVersion: 1,
      outputAttemptId: CLAIM.derivedOutput.outputAttemptOutboxId,
      workerToken: "worker-token",
    });
    expect(mocks.privateR2Delete).not.toHaveBeenCalled();
    expect(mocks.triggerTask).toHaveBeenCalledWith(
      "jarvis-file-ingest-derived-cleanup",
      { outputAttemptId: "output-attempt-outbox-1" },
      { idempotencyKey: "jarvis-file-ingest-derived-cleanup-v2-output-attempt-outbox-1" },
    );
  });

  it("records a durable prewrite before an R2 response-loss failure can reach retirement", async () => {
    const { calls } = configureConvex();
    mocks.privateR2Put.mockRejectedValueOnce(new Error("simulated R2 response loss after PUT acceptance"));

    await expect(runFileIngest({ fileId: "file-1", ingestVersion: 1 }))
      .rejects.toThrow("simulated R2 response loss after PUT acceptance");

    const prewrite = calls.find((call) => call.path === "files:beginIngestOutputWrite");
    expect(prewrite?.args).toMatchObject({
      outputAttemptId: CLAIM.derivedOutput.outputAttemptOutboxId,
      purpose: "extracted.txt",
    });
    expect(calls.find((call) => call.path === "files:retireIngestOutputAttempt")).toBeTruthy();
    expect(mocks.privateR2Delete).not.toHaveBeenCalled();
  });

  it("keeps a partial first-PUT success plus second-PUT failure in the exact attempt reaper", async () => {
    const { calls } = configureConvex();
    mocks.privateR2Put
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("simulated preview PUT response loss after acceptance"));

    await expect(runFileIngest({ fileId: "file-1", ingestVersion: 1 }))
      .rejects.toThrow("simulated preview PUT response loss after acceptance");

    expect(calls.filter((call) => call.path === "files:beginIngestOutputWrite").map((call) => call.args.purpose))
      .toEqual(["extracted.txt", "preview.webp"]);
    expect(calls.find((call) => call.path === "files:retireIngestOutputAttempt")).toBeTruthy();
    expect(mocks.privateR2Delete).not.toHaveBeenCalled();
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
      OUTPUT_PREVIEW,
      new Uint8Array([7, 7, 7]),
      "image/webp",
    );
    expect(calls.find((call) => call.path === "files:completeIngest")?.args.previewR2Key)
      .toBe(OUTPUT_PREVIEW);
  });

  it("immediately requeues pre-activation uploads with a fresh V2 wake namespace", async () => {
    const { calls } = configureConvex({
      activation: {
        activated: true,
        activatedAt: 1_760_000_000_000,
        protocolVersion: 2,
        requeue: [
          { fileId: "file-1", ingestVersion: 1 },
          { fileId: "file-2", ingestVersion: 4 },
        ],
      },
    });

    await expect(runFileIngestOutputProtocolV2Activation({
      triggerDeploymentVersion: "trigger-v2-release",
    })).resolves.toEqual({
      activated: true,
      activatedAt: 1_760_000_000_000,
      requeued: 2,
      skippedInvalidCandidates: 0,
    });

    expect(calls).toEqual([
      expect.objectContaining({
        path: "files:activateIngestOutputProtocolV2",
        args: expect.objectContaining({ rehomeToken: "file-derived-artifact-rehome-test-token", triggerDeploymentVersion: "trigger-v2-release" }),
      }),
    ]);
    expect(mocks.triggerTask).toHaveBeenNthCalledWith(
      1,
      "jarvis-file-ingest",
      { fileId: "file-1", ingestVersion: 1 },
      { idempotencyKey: "jarvis-file-ingest-v2-activation-1760000000000-file-1-v1" },
    );
    expect(mocks.triggerTask).toHaveBeenNthCalledWith(
      2,
      "jarvis-file-ingest",
      { fileId: "file-2", ingestVersion: 4 },
      { idempotencyKey: "jarvis-file-ingest-v2-activation-1760000000000-file-2-v4" },
    );
  });
});
