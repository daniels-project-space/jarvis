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
    expect(mock.putPrivateCreationAsset).toHaveBeenCalledWith(expect.any(Buffer), "image/svg+xml");
    expect(mock.controlMutation).toHaveBeenCalledWith("creations:create", expect.objectContaining({
      kind: "export",
      assetR2Key: "owners/daniel/creations/f47ac10b-58cc-4372-a567-0e02b2c3d479/asset",
      assetContentType: "image/svg+xml",
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

  it("cleans up a fresh object if its library record cannot be persisted", async () => {
    mock.controlMutation.mockRejectedValueOnce(new Error("Convex unavailable"));

    const response = await POST(request());

    expect(response.status).toBe(502);
    expect(mock.deletePrivateCreationAsset).toHaveBeenCalledWith({
      key: "owners/daniel/creations/f47ac10b-58cc-4372-a567-0e02b2c3d479/asset",
      contentType: "image/png",
    });
  });
});
