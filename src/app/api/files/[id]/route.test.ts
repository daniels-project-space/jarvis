import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  controlActor: vi.fn(),
  controlMutation: vi.fn(),
  controlQuery: vi.fn(),
  isSameOriginRequest: vi.fn(),
  privateR2Delete: vi.fn(),
  privateR2Get: vi.fn(),
  trigger: vi.fn(),
}));

vi.mock("@trigger.dev/sdk/v3", () => ({ tasks: { trigger: mock.trigger } }));
vi.mock("@/lib/request-auth", () => ({
  controlActor: mock.controlActor,
  controlCredentials: () => ({ authTokenHash: "owner-hash" }),
  isOwnerActor: (actor: { kind?: string }) => actor?.kind === "owner",
}));
vi.mock("@/lib/control-session", () => ({
  controlMutation: mock.controlMutation,
  controlQuery: mock.controlQuery,
  isSameOriginRequest: mock.isSameOriginRequest,
}));
vi.mock("@/lib/private-r2", () => ({
  privateR2Delete: mock.privateR2Delete,
  privateR2Get: mock.privateR2Get,
}));

import { DELETE, GET, PATCH } from "./route";

describe("private file controls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.isSameOriginRequest.mockReturnValue(true);
    mock.controlActor.mockResolvedValue({ kind: "owner" });
    mock.controlMutation.mockResolvedValue({
      ok: true,
      deferred: true,
      r2Keys: ["owners/daniel/files/file-1/v1/original"],
    });
    mock.trigger.mockResolvedValue({ id: "cleanup-run" });
    mock.controlQuery.mockResolvedValue(null);
    mock.privateR2Get.mockResolvedValue(new Response(new Uint8Array([0, 1, 2]), {
      status: 200,
      headers: { "content-length": "3", "content-type": "video/mp4" },
    }));
  });

  it("streams verified private video inline through the owner-authorized media route", async () => {
    mock.controlQuery.mockResolvedValueOnce({
      _id: "file-1",
      originalName: "walkthrough.mp4",
      mimeType: "video/mp4",
      detectedMimeType: "video/mp4",
      status: "ready",
      r2Key: "owners/daniel/files/file-1/v1/original",
    });
    const response = await GET(
      new NextRequest("https://jarvis.example/api/files/file-1"),
      { params: Promise.resolve({ id: "file-1" }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("content-disposition")).toContain("inline");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(mock.privateR2Get).toHaveBeenCalledWith("owners/daniel/files/file-1/v1/original", undefined);
  });

  it("previews ready private PDFs inline while preserving an explicit owner download", async () => {
    mock.controlQuery.mockResolvedValue({
      _id: "file-pdf",
      originalName: "itinerary.pdf",
      mimeType: "application/pdf",
      detectedMimeType: "application/pdf",
      status: "ready",
      r2Key: "owners/daniel/files/file-pdf/v1/original",
    });

    const preview = await GET(
      new NextRequest("https://jarvis.example/api/files/file-pdf"),
      { params: Promise.resolve({ id: "file-pdf" }) },
    );
    const download = await GET(
      new NextRequest("https://jarvis.example/api/files/file-pdf?download=1"),
      { params: Promise.resolve({ id: "file-pdf" }) },
    );

    expect(preview.status).toBe(200);
    expect(preview.headers.get("content-type")).toBe("application/pdf");
    expect(preview.headers.get("content-disposition")).toContain("inline");
    expect(download.headers.get("content-disposition")).toContain("attachment");
    expect(download.headers.get("cache-control")).toBe("private, no-store");
  });

  it("queues cleanup without deleting underneath an active PUT", async () => {
    const request = new NextRequest("https://jarvis.example/api/files/file-1", {
      method: "DELETE",
      headers: { origin: "https://jarvis.example" },
    });
    const response = await DELETE(request, { params: Promise.resolve({ id: "file-1" }) });

    expect(response.status).toBe(202);
    expect(mock.privateR2Delete).not.toHaveBeenCalled();
    expect(mock.trigger).toHaveBeenCalledWith("jarvis-file-cleanup", { fileId: "file-1" });
  });

  it("freezes direct deletion during the V1-to-V2 cutover", async () => {
    process.env.JARVIS_FILE_INGEST_WAKE_PAUSED = "1";
    try {
      const response = await DELETE(new NextRequest("https://jarvis.example/api/files/file-1", {
        method: "DELETE",
        headers: { origin: "https://jarvis.example" },
      }), { params: Promise.resolve({ id: "file-1" }) });

      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("60");
      expect(mock.controlMutation).not.toHaveBeenCalled();
      expect(mock.privateR2Delete).not.toHaveBeenCalled();
      expect(mock.trigger).not.toHaveBeenCalled();
    } finally {
      delete process.env.JARVIS_FILE_INGEST_WAKE_PAUSED;
    }
  });

  it.each(["favorite", "review_remove", "unreviewed"] as const)("writes %s as a reversible review label without scheduling private storage work", async (reviewState) => {
    mock.controlMutation.mockResolvedValueOnce({ fileId: "file-1", reviewState });
    const request = new NextRequest("https://jarvis.example/api/files/file-1", {
      method: "PATCH",
      headers: { origin: "https://jarvis.example", "content-type": "application/json" },
      body: JSON.stringify({ reviewState }),
    });

    const response = await PATCH(request, { params: Promise.resolve({ id: "file-1" }) });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, fileId: "file-1", reviewState });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mock.controlMutation).toHaveBeenCalledWith("files:setReviewState", {
      fileId: "file-1",
      reviewState,
      authTokenHash: "owner-hash",
    });
    expect(mock.privateR2Delete).not.toHaveBeenCalled();
    expect(mock.trigger).not.toHaveBeenCalled();
  });

  it("fails closed before a review mutation when the caller or label is invalid", async () => {
    const request = (reviewState: unknown) => new NextRequest("https://jarvis.example/api/files/file-1", {
      method: "PATCH",
      headers: { origin: "https://jarvis.example", "content-type": "application/json" },
      body: JSON.stringify({ reviewState }),
    });
    mock.isSameOriginRequest.mockReturnValue(false);
    expect((await PATCH(request("favorite"), { params: Promise.resolve({ id: "file-1" }) })).status).toBe(403);
    expect(mock.controlMutation).not.toHaveBeenCalled();

    mock.isSameOriginRequest.mockReturnValue(true);
    mock.controlActor.mockResolvedValue(null);
    expect((await PATCH(request("favorite"), { params: Promise.resolve({ id: "file-1" }) })).status).toBe(401);

    mock.controlActor.mockResolvedValue({ kind: "viewer" });
    expect((await PATCH(request("favorite"), { params: Promise.resolve({ id: "file-1" }) })).status).toBe(403);

    mock.controlActor.mockResolvedValue({ kind: "owner" });
    expect((await PATCH(request("delete"), { params: Promise.resolve({ id: "file-1" }) })).status).toBe(400);
    expect(mock.controlMutation).not.toHaveBeenCalled();
  });
});
