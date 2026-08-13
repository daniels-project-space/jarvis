import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  adminSessionHash: vi.fn(),
  validateAdminSession: vi.fn(),
  controlQuery: vi.fn(),
  controlMutation: vi.fn(),
  r2Put: vi.fn(),
  r2DeleteFreshCreation: vi.fn(),
}));

vi.mock("@/lib/control-session", () => ({
  adminSessionHash: mock.adminSessionHash,
  validateAdminSession: mock.validateAdminSession,
  controlQuery: mock.controlQuery,
  controlMutation: mock.controlMutation,
}));
vi.mock("@/lib/r2", () => ({
  r2Put: mock.r2Put,
  r2DeleteFreshCreation: mock.r2DeleteFreshCreation,
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
    mock.adminSessionHash.mockResolvedValue(OWNER);
    mock.validateAdminSession.mockResolvedValue(true);
    mock.controlQuery.mockResolvedValue(board);
    mock.r2Put.mockResolvedValue("https://pub.example/creations/2026-08/launch-board.png");
    mock.r2DeleteFreshCreation.mockResolvedValue(undefined);
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
      downloadUrl: "/api/creation-download?id=export-1",
      chatPosted: true,
    });
    expect(mock.r2Put).toHaveBeenCalledWith("Launch board-svg", expect.any(Buffer), "image/svg+xml");
    expect(mock.controlMutation).toHaveBeenCalledWith("creations:create", expect.objectContaining({
      kind: "export",
      url: "https://pub.example/creations/2026-08/launch-board.png",
      data: expect.stringContaining('"sourceCreationId":"board-1"'),
    }));
    expect(mock.controlMutation).toHaveBeenCalledWith("chatQueue:postCard", expect.objectContaining({
      type: "image",
      downloadUrl: "/api/creation-download?id=export-1",
    }));
  });

  it("rejects non-board sources before uploading anything", async () => {
    mock.controlQuery.mockResolvedValue({ ...board, kind: "doc" });

    const response = await POST(request());

    expect(response.status).toBe(400);
    expect(mock.r2Put).not.toHaveBeenCalled();
    expect(mock.controlMutation).not.toHaveBeenCalled();
  });

  it("cleans up a fresh object if its library record cannot be persisted", async () => {
    mock.controlMutation.mockRejectedValueOnce(new Error("Convex unavailable"));

    const response = await POST(request());

    expect(response.status).toBe(502);
    expect(mock.r2DeleteFreshCreation).toHaveBeenCalledWith("https://pub.example/creations/2026-08/launch-board.png");
  });
});
