import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  controlActor: vi.fn(),
  controlMutation: vi.fn(),
  assertPrivateBucketName: vi.fn(),
  assertPrivateR2Configured: vi.fn(),
  privateR2Delete: vi.fn(),
}));

vi.mock("@/lib/request-auth", () => ({
  controlActor: mock.controlActor,
  controlCredentials: () => ({ authTokenHash: "owner-hash" }),
  isOwnerActor: (actor: { kind?: string }) => actor?.kind === "owner",
}));
vi.mock("@/lib/control-session", () => ({
  controlMutation: mock.controlMutation,
  isSameOriginRequest: () => true,
}));
vi.mock("@/lib/private-r2", () => ({
  assertPrivateBucketName: mock.assertPrivateBucketName,
  assertPrivateR2Configured: mock.assertPrivateR2Configured,
  privateR2Delete: mock.privateR2Delete,
}));

import { POST } from "./route";

describe("private upload reservations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.controlActor.mockResolvedValue({ kind: "owner" });
    mock.assertPrivateBucketName.mockReturnValue("jarvis-private-files");
    mock.assertPrivateR2Configured.mockResolvedValue(undefined);
    mock.controlMutation.mockImplementation(async (path: string) => path === "files:cleanupExpiredReservations" ? [] : ({
      batchId: "batch-1",
      expiresAt: Date.now() + 60_000,
      files: [{
        clientId: "client-1",
        fileId: "file-1",
        name: "proof.txt",
        relativePath: "proof.txt",
        mimeType: "text/plain",
        sizeBytes: 5,
        status: "reserved",
      }],
    }));
  });

  it("returns only a same-origin application upload URL, never an R2 coordinate", async () => {
    const request = new NextRequest("https://jarvis.example/api/files/upload-session", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://jarvis.example" },
      body: JSON.stringify({
        requestId: "upload:request-1",
        threadId: "main",
        files: [{ clientId: "client-1", name: "proof.txt", relativePath: "proof.txt", mimeType: "text/plain", sizeBytes: 5, sha256: "a".repeat(64) }],
      }),
    });
    const response = await POST(request);
    const payload = await response.json();
    expect(response.status).toBe(201);
    expect(payload.files[0].uploadUrl).toBe("/api/files/upload/file-1?batchId=batch-1");
    expect(JSON.stringify(payload)).not.toContain("r2Key");
    expect(JSON.stringify(payload)).not.toContain("cloudflarestorage");
  });

  it("fails closed before reservation when the dedicated bucket is absent", async () => {
    mock.assertPrivateR2Configured.mockRejectedValueOnce(new Error("missing"));
    const request = new NextRequest("https://jarvis.example/api/files/upload-session", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://jarvis.example" },
      body: JSON.stringify({ requestId: "upload:request-2", files: [] }),
    });
    expect((await POST(request)).status).toBe(503);
    expect(mock.controlMutation).not.toHaveBeenCalled();
  });
});
