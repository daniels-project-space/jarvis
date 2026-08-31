import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  controlActor: vi.fn(),
  controlMutation: vi.fn(),
  privateR2Put: vi.fn(),
  privateR2Delete: vi.fn(),
  trigger: vi.fn(),
  reportIncident: vi.fn(),
}));

vi.mock("@trigger.dev/sdk/v3", () => ({ tasks: { trigger: mock.trigger } }));
vi.mock("@/lib/request-auth", () => ({
  actorAdminHash: () => "owner-hash",
  controlActor: mock.controlActor,
  controlCredentials: () => ({ authTokenHash: "owner-hash" }),
  isOwnerActor: (actor: { kind?: string }) => actor?.kind === "owner",
}));
vi.mock("@/lib/control-session", () => ({
  controlMutation: mock.controlMutation,
  isSameOriginRequest: () => true,
}));
vi.mock("@/lib/context", () => ({ reportIncident: mock.reportIncident }));
vi.mock("@/lib/private-r2", () => ({
  privateFileObjectKey: (fileId: string, version: number, purpose: string) => `owners/daniel/files/${fileId}/v${version}/${purpose}`,
  privateR2Put: mock.privateR2Put,
  privateR2Delete: mock.privateR2Delete,
}));

import { PUT } from "./route";

describe("server-mediated private upload", () => {
  const bytes = new TextEncoder().encode("real private bytes");
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  beforeEach(() => {
    vi.clearAllMocks();
    mock.controlActor.mockResolvedValue({ kind: "owner" });
    mock.controlMutation.mockImplementation(async (path: string) => {
      if (path === "files:claimUpload") return {
        claimed: true,
        r2Key: "owners/daniel/files/file-1/v1/original",
        sizeBytes: bytes.byteLength,
        mimeType: "text/plain",
        expectedSha256: sha256,
        ingestVersion: 1,
        expiresAt: Date.now() + 60_000,
      };
      if (path === "files:markUploaded") return { ok: true, ingestVersion: 1 };
      return true;
    });
    mock.privateR2Put.mockResolvedValue({ etag: "etag-1" });
    mock.privateR2Delete.mockResolvedValue(undefined);
    mock.trigger.mockResolvedValue({ id: "run-1" });
  });

  it("hashes bytes on Jarvis before private storage and completion", async () => {
    const request = new NextRequest("https://jarvis.example/api/files/upload/file-1?batchId=batch-1", {
      method: "PUT",
      headers: { "content-type": "text/plain", "x-jarvis-sha256": sha256, origin: "https://jarvis.example" },
      body: bytes,
    });
    const response = await PUT(request, { params: Promise.resolve({ id: "file-1" }) });
    expect(response.status).toBe(201);
    expect(mock.privateR2Put).toHaveBeenCalledWith("owners/daniel/files/file-1/v1/original", expect.any(Uint8Array), "text/plain", { sha256 });
    expect(mock.controlMutation).toHaveBeenCalledWith("files:markUploaded", expect.objectContaining({ sha256, sizeBytes: bytes.byteLength }));
    expect(mock.trigger).toHaveBeenCalledWith("jarvis-file-ingest", { fileId: "file-1", ingestVersion: 1 }, expect.anything());
  });

  it("holds the immediate ingest wake during the V1-to-V2 cutover without rejecting the upload", async () => {
    process.env.JARVIS_FILE_INGEST_WAKE_PAUSED = "1";
    try {
      const request = new NextRequest("https://jarvis.example/api/files/upload/file-1?batchId=batch-1", {
        method: "PUT",
        headers: { "content-type": "text/plain", "x-jarvis-sha256": sha256, origin: "https://jarvis.example" },
        body: bytes,
      });
      const response = await PUT(request, { params: Promise.resolve({ id: "file-1" }) });
      expect(response.status).toBe(201);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        status: "uploaded",
        processingScheduled: false,
        processingWakePaused: true,
      });
      expect(mock.privateR2Put).toHaveBeenCalled();
      expect(mock.trigger).not.toHaveBeenCalled();
    } finally {
      delete process.env.JARVIS_FILE_INGEST_WAKE_PAUSED;
    }
  });

  it("never stores a body whose computed digest differs", async () => {
    mock.controlMutation.mockImplementationOnce(async () => ({
      claimed: true,
      r2Key: "owners/daniel/files/file-1/v1/original",
      sizeBytes: bytes.byteLength,
      mimeType: "text/plain",
      expectedSha256: "b".repeat(64),
      ingestVersion: 1,
      expiresAt: Date.now() + 60_000,
    }));
    const request = new NextRequest("https://jarvis.example/api/files/upload/file-1?batchId=batch-1", {
      method: "PUT",
      headers: { "content-type": "text/plain", "x-jarvis-sha256": "b".repeat(64), origin: "https://jarvis.example" },
      body: bytes,
    });
    expect((await PUT(request, { params: Promise.resolve({ id: "file-1" }) })).status).toBe(409);
    expect(mock.privateR2Put).not.toHaveBeenCalled();
  });
});
