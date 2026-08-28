import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  adminSessionHash: vi.fn(),
  validateAdminSession: vi.fn(),
  controlQuery: vi.fn(),
  controlMutation: vi.fn(),
  isSameOriginRequest: vi.fn(),
  putPrivateCreationAsset: vi.fn(),
  deletePrivateCreationAsset: vi.fn(),
  creationMediaUrl: vi.fn(),
  writePrivateCreationAssetWithRecord: vi.fn(),
}));

vi.mock("@/lib/control-session", () => ({
  adminSessionHash: mock.adminSessionHash,
  validateAdminSession: mock.validateAdminSession,
  controlQuery: mock.controlQuery,
  controlMutation: mock.controlMutation,
  isSameOriginRequest: mock.isSameOriginRequest,
}));
vi.mock("@/lib/creation-assets", () => ({
  putPrivateCreationAsset: mock.putPrivateCreationAsset,
  deletePrivateCreationAsset: mock.deletePrivateCreationAsset,
  creationMediaUrl: mock.creationMediaUrl,
}));
vi.mock("@/lib/private-creation-asset-write", () => ({
  writePrivateCreationAssetWithRecord: mock.writePrivateCreationAssetWithRecord,
}));

import { POST } from "./route";

const OWNER = "a".repeat(64);
const board = {
  _id: "board-1",
  kind: "board",
  title: "Launch board",
  folder: "Projects / Jarvis",
  project: "jarvis",
  inquiry: "launch",
  threadId: "main",
};

function request(format: "png" | "svg" = "png") {
  return new NextRequest(`https://jarvis.example/api/creation-export?creationId=board-1&format=${format}`, {
    method: "POST",
    headers: { "content-type": format === "png" ? "image/png" : "image/svg+xml" },
    body: new Uint8Array([1, 2, 3]),
  });
}

describe("creation export persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.isSameOriginRequest.mockReturnValue(true);
    mock.adminSessionHash.mockResolvedValue(OWNER);
    mock.validateAdminSession.mockResolvedValue(true);
    mock.controlQuery.mockResolvedValue(board);
    mock.putPrivateCreationAsset.mockImplementation(async (_bytes: unknown, contentType: string) => ({
      key: "owners/daniel/creations/f47ac10b-58cc-4372-a567-0e02b2c3d479/asset",
      contentType,
    }));
    mock.deletePrivateCreationAsset.mockResolvedValue(undefined);
    mock.creationMediaUrl.mockImplementation((id: string) => `/api/creation-media?id=${encodeURIComponent(id)}&variant=asset`);
    mock.writePrivateCreationAssetWithRecord.mockImplementation(async ({ writeAsset, persistCreation }: any) => {
      let asset: any;
      try {
        asset = await writeAsset("f47ac10b-58cc-4372-a567-0e02b2c3d479", async () => new AbortController().signal);
        const creationId = await persistCreation(asset, "817fcdd9-43d8-46f7-bc89-5205af27d284");
        if (typeof creationId !== "string" || !creationId) throw new Error("creation persistence returned no id");
        return { ok: true, asset, creationId, recovered: false };
      } catch (error) {
        return { ok: false, stage: asset ? "creation_unverified" : "asset_write", error };
      }
    });
    mock.controlMutation.mockImplementation(async (path: string) => {
      if (path === "creations:create") return "export-1";
      return undefined;
    });
  });

  it("persists an immutable board export and posts a chat view with direct download", async () => {
    const response = await POST(request("svg"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      creationId: "export-1",
      url: "/api/creation-media?id=export-1&variant=asset",
      downloadUrl: "/api/creation-download?id=export-1",
      chatPosted: true,
    });
    expect(mock.putPrivateCreationAsset).toHaveBeenCalledWith(
      expect.any(Buffer), "image/svg+xml", "asset", expect.any(String),
      { beforeR2Write: expect.any(Function) },
    );
    expect(mock.controlMutation).toHaveBeenCalledWith("creations:create", expect.objectContaining({
      kind: "export",
      assetR2Key: "owners/daniel/creations/f47ac10b-58cc-4372-a567-0e02b2c3d479/asset",
      assetContentType: "image/svg+xml",
      assetWriteEpoch: "817fcdd9-43d8-46f7-bc89-5205af27d284",
      data: expect.stringContaining('"sourceCreationId":"board-1"'),
    }));
    const creationCall = mock.controlMutation.mock.calls.find(([path]) => path === "creations:create")?.[1];
    expect(creationCall).not.toHaveProperty("url");
    expect(mock.controlMutation).toHaveBeenCalledWith("chatQueue:postCard", expect.objectContaining({
      type: "image",
      downloadUrl: "/api/creation-download?id=export-1",
    }));
  });

  it("rejects a cross-origin export before consulting the owner session or storing bytes", async () => {
    mock.isSameOriginRequest.mockReturnValue(false);

    const response = await POST(request());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "cross-origin export rejected" });
    expect(mock.adminSessionHash).not.toHaveBeenCalled();
    expect(mock.putPrivateCreationAsset).not.toHaveBeenCalled();
    expect(mock.controlMutation).not.toHaveBeenCalled();
  });

  it("rejects non-board sources before uploading anything", async () => {
    mock.controlQuery.mockResolvedValue({ ...board, kind: "doc" });

    const response = await POST(request());

    expect(response.status).toBe(400);
    expect(mock.putPrivateCreationAsset).not.toHaveBeenCalled();
    expect(mock.controlMutation).not.toHaveBeenCalled();
  });

  it("fences a fresh object if its library record cannot be verified", async () => {
    mock.controlMutation.mockRejectedValueOnce(new Error("Convex unavailable"));

    const response = await POST(request());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "export persistence could not be verified; private storage is queued for safe recovery",
    });
    expect(mock.writePrivateCreationAssetWithRecord).toHaveBeenCalledTimes(1);
    expect(mock.deletePrivateCreationAsset).not.toHaveBeenCalled();
  });
});
