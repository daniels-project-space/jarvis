import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  process.env.CONVEX_URL = "https://convex.test";
  process.env.JARVIS_FILE_REHOME_TOKEN = "file-derived-artifact-rehome-test-token";
  return {
    privateFileAttemptObjectKey: vi.fn(),
    privateR2Get: vi.fn(),
    privateR2Head: vi.fn(),
    privateR2Put: vi.fn(),
    triggerTask: vi.fn(),
  };
});

vi.mock("@trigger.dev/sdk/v3", () => ({
  task: (definition: unknown) => definition,
  tasks: { trigger: mocks.triggerTask },
}));
vi.mock("../lib/private-r2", () => ({
  privateFileAttemptObjectKey: mocks.privateFileAttemptObjectKey,
  privateR2Get: mocks.privateR2Get,
  privateR2Head: mocks.privateR2Head,
  privateR2Put: mocks.privateR2Put,
}));

import { runFileDerivedArtifactRehome } from "./file-derived-artifact-rehome";

const REHOME_ID = "rehome-123e4567-e89b-12d3-a456-426614174000";
const CLAIM_TOKEN = "claim-123e4567-e89b-12d3-a456-426614174000";
const FILE_ID = "file-1";
const VERSION = 1;
const ATTEMPT = "rehome-attempt-123e4567-e89b-12d3-a456-426614174000";
const SOURCE_TEXT = `owners/daniel/files/${FILE_ID}/v${VERSION}/extracted.txt`;
const SOURCE_PREVIEW = `owners/daniel/files/${FILE_ID}/v${VERSION}/preview.webp`;
const TARGET_TEXT = `owners/daniel/files/${FILE_ID}/v${VERSION}/a${ATTEMPT}/extracted.txt`;
const TARGET_PREVIEW = `owners/daniel/files/${FILE_ID}/v${VERSION}/a${ATTEMPT}/preview.webp`;
const TEXT = new TextEncoder().encode("A full source readback.");
const PREVIEW = new Uint8Array([7, 8, 9, 10]);

function response(bytes: Uint8Array | undefined): Response {
  return bytes
    ? new Response(Buffer.from(bytes), { status: 200, headers: { "content-length": String(bytes.byteLength) } })
    : new Response(null, { status: 404 });
}

function configure(options: {
  throwAfterCommit?: boolean;
  missingPreview?: boolean;
  textOnly?: boolean;
  corruptTargetReadback?: boolean;
  putFails?: boolean;
  alreadyVerified?: boolean;
} = {}) {
  const calls: Array<{ path: string; args: Record<string, unknown> }> = [];
  const objects = new Map<string, { bytes: Uint8Array; contentType: string; sha256: string }>([
    [SOURCE_TEXT, { bytes: TEXT, contentType: "text/plain", sha256: createHash("sha256").update(TEXT).digest("hex") }],
    ...(options.missingPreview || options.textOnly
      ? []
      : [[SOURCE_PREVIEW, { bytes: PREVIEW, contentType: "image/webp", sha256: createHash("sha256").update(PREVIEW).digest("hex") }] as const]),
  ]);
  let committed = false;
  const claim = options.alreadyVerified ? { claimed: false, verified: true, targetGeneration: 1 } : {
    claimed: true,
    rehomeId: REHOME_ID,
    fileId: FILE_ID,
    sourceIngestVersion: VERSION,
    sourceExtractedTextR2Key: SOURCE_TEXT,
    sourcePreviewR2Key: options.textOnly ? undefined : SOURCE_PREVIEW,
    targetOutputAttemptId: ATTEMPT,
    targetOutputAttemptOutboxId: "output-attempt-row-1",
    targetExtractedTextR2Key: TARGET_TEXT,
    targetPreviewR2Key: TARGET_PREVIEW,
    targetGeneration: 1,
  };
  vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { path: string; args: Record<string, unknown> };
    calls.push({ path: body.path, args: body.args });
    if (body.path === "fileDerivedArtifactRehomes:commitFileDerivedArtifactRehome" && options.throwAfterCommit) {
      committed = true;
      throw new Error("simulated committed CAS response loss");
    }
    const value = body.path === "fileDerivedArtifactRehomes:fileDerivedArtifactRehomeReceipt"
      ? { committed, blocked: false, targetGeneration: 1 }
      : body.path === "fileDerivedArtifactRehomes:claimFileDerivedArtifactRehome"
        ? claim
        : body.path === "fileDerivedArtifactRehomes:beginFileDerivedArtifactRehomeWrite"
          ? true
          : body.path === "fileDerivedArtifactRehomes:recordFileDerivedArtifactRehomeReadback"
            ? { verified: true }
            : body.path === "fileDerivedArtifactRehomes:commitFileDerivedArtifactRehome"
              ? { committed: true }
              : body.path === "fileDerivedArtifactRehomes:blockFileDerivedArtifactRehome"
                ? true
                : body.path === "fileDerivedArtifactRehomes:retireFileDerivedArtifactRehome"
                  ? { committed: false, requeued: true }
                  : null;
    return new Response(JSON.stringify({ value }), { status: 200, headers: { "content-type": "application/json" } });
  }));
  mocks.privateR2Get.mockImplementation(async (key: string) => response(objects.get(key)?.bytes));
  mocks.privateR2Head.mockImplementation(async (key: string) => {
    const object = objects.get(key);
    return object ? { sizeBytes: object.bytes.byteLength, contentType: object.contentType, expectedSha256: object.sha256 } : null;
  });
  mocks.privateR2Put.mockImplementation(async (key: string, body: Uint8Array, contentType: string, metadata?: { sha256?: string }) => {
    if (options.putFails) throw new Error("simulated target PUT failure");
    const bytes = new Uint8Array(body);
    if (options.corruptTargetReadback) bytes[0] ^= 0xff;
    // Keep the source digest in target metadata for the corrupt-readback
    // regression: HEAD can pass only because full GET still catches it.
    objects.set(key, { bytes, contentType, sha256: String(metadata?.sha256 ?? "") });
    return {};
  });
  return { calls, objects };
}

describe("file-derived-artifact rehome worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.triggerTask.mockResolvedValue({ id: "controller-run" });
    mocks.privateFileAttemptObjectKey.mockImplementation((fileId: string, version: number, attempt: string, purpose: string) =>
      `owners/daniel/files/${fileId}/v${version}/a${attempt}/${purpose}`);
  });

  it("full-reads, hashes, prewrites, copies, HEAD/full-readbacks, then commits the CAS", async () => {
    const { calls, objects } = configure();
    await expect(runFileDerivedArtifactRehome({ rehomeId: REHOME_ID, claimToken: CLAIM_TOKEN }))
      .resolves.toMatchObject({ committed: true, copiedRoles: 2 });
    expect(objects.get(TARGET_TEXT)?.bytes).toEqual(TEXT);
    expect(objects.get(TARGET_PREVIEW)?.bytes).toEqual(PREVIEW);
    expect(mocks.privateR2Put).toHaveBeenCalledWith(
      TARGET_TEXT,
      TEXT,
      "text/plain",
      { sha256: createHash("sha256").update(TEXT).digest("hex") },
    );
    expect(mocks.privateR2Head).toHaveBeenCalledWith(TARGET_TEXT);
    expect(mocks.privateR2Get).toHaveBeenCalledWith(TARGET_TEXT);
    const firstPrewrite = calls.findIndex((call) => call.path === "fileDerivedArtifactRehomes:beginFileDerivedArtifactRehomeWrite");
    expect(firstPrewrite).toBeGreaterThan(calls.findIndex((call) => call.path === "fileDerivedArtifactRehomes:claimFileDerivedArtifactRehome"));
    expect(calls.filter((call) => call.path === "fileDerivedArtifactRehomes:beginFileDerivedArtifactRehomeWrite")
      .map((call) => call.args.purpose)).toEqual(["extracted.txt", "preview.webp"]);
    expect(calls.find((call) => call.path === "fileDerivedArtifactRehomes:commitFileDerivedArtifactRehome")).toBeTruthy();
  });

  it("reconciles a lost committed CAS response instead of retiring its referenced target", async () => {
    const { calls } = configure({ throwAfterCommit: true });
    await expect(runFileDerivedArtifactRehome({ rehomeId: REHOME_ID, claimToken: CLAIM_TOKEN }))
      .resolves.toMatchObject({ committed: true, recovered: true });
    expect(calls.some((call) => call.path === "fileDerivedArtifactRehomes:retireFileDerivedArtifactRehome")).toBe(false);
    expect(calls.some((call) => call.path === "fileDerivedArtifactRehomes:blockFileDerivedArtifactRehome")).toBe(false);
  });

  it("resumes a durable verified manifest after the prior worker dies before its CAS", async () => {
    const { calls } = configure({ alreadyVerified: true });
    await expect(runFileDerivedArtifactRehome({ rehomeId: REHOME_ID, claimToken: CLAIM_TOKEN }))
      .resolves.toMatchObject({ committed: true, recovered: true });
    expect(mocks.privateR2Put).not.toHaveBeenCalled();
    expect(calls.some((call) => call.path === "fileDerivedArtifactRehomes:commitFileDerivedArtifactRehome")).toBe(true);
    expect(calls.some((call) => call.path === "fileDerivedArtifactRehomes:retireFileDerivedArtifactRehome")).toBe(false);
  });

  it("copies only the source roles that exist on a terminal V1 row", async () => {
    const { calls, objects } = configure({ textOnly: true });
    await expect(runFileDerivedArtifactRehome({ rehomeId: REHOME_ID, claimToken: CLAIM_TOKEN }))
      .resolves.toMatchObject({ committed: true, copiedRoles: 1 });
    expect(objects.get(TARGET_TEXT)?.bytes).toEqual(TEXT);
    expect(objects.has(TARGET_PREVIEW)).toBe(false);
    expect(calls.filter((call) => call.path === "fileDerivedArtifactRehomes:beginFileDerivedArtifactRehomeWrite")
      .map((call) => call.args.purpose)).toEqual(["extracted.txt"]);
  });

  it("blocks migration when a required V1 preview is missing and never commits", async () => {
    const { calls } = configure({ missingPreview: true });
    await expect(runFileDerivedArtifactRehome({ rehomeId: REHOME_ID, claimToken: CLAIM_TOKEN }))
      .rejects.toThrow("preview.webp source is missing");
    expect(calls.some((call) => call.path === "fileDerivedArtifactRehomes:blockFileDerivedArtifactRehome" && call.args.failureCode === "source_missing")).toBe(true);
    expect(calls.some((call) => call.path === "fileDerivedArtifactRehomes:commitFileDerivedArtifactRehome")).toBe(false);
  });

  it("blocks a same-length target readback mismatch even when target metadata matches", async () => {
    const { calls } = configure({ corruptTargetReadback: true });
    await expect(runFileDerivedArtifactRehome({ rehomeId: REHOME_ID, claimToken: CLAIM_TOKEN }))
      .rejects.toThrow("target full readback is not identical");
    expect(calls.some((call) => call.path === "fileDerivedArtifactRehomes:blockFileDerivedArtifactRehome" && call.args.failureCode === "target_readback_mismatch")).toBe(true);
    expect(calls.some((call) => call.path === "fileDerivedArtifactRehomes:commitFileDerivedArtifactRehome")).toBe(false);
  });

  it("retires an ambiguous target attempt and wakes the controller for a fresh generation", async () => {
    const { calls } = configure({ putFails: true });
    await expect(runFileDerivedArtifactRehome({ rehomeId: REHOME_ID, claimToken: CLAIM_TOKEN }))
      .rejects.toThrow("simulated target PUT failure");
    expect(calls.some((call) => call.path === "fileDerivedArtifactRehomes:retireFileDerivedArtifactRehome")).toBe(true);
    expect(mocks.triggerTask).toHaveBeenCalledWith(
      "jarvis-file-derived-artifact-rehome-controller",
      { limit: 8 },
      expect.objectContaining({ idempotencyKey: expect.stringContaining("jarvis-file-derived-artifact-rehome-progress-") }),
    );
  });
});
