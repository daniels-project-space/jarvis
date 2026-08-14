import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  controlActor: vi.fn(),
  controlMutation: vi.fn(),
  isSameOriginRequest: vi.fn(),
  privateR2Delete: vi.fn(),
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
  controlQuery: vi.fn(),
  isSameOriginRequest: mock.isSameOriginRequest,
}));
vi.mock("@/lib/private-r2", () => ({
  privateR2Delete: mock.privateR2Delete,
  privateR2Get: vi.fn(),
}));

import { DELETE, PATCH } from "./route";

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
