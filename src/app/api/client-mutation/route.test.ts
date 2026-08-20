import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mock = vi.hoisted(() => ({
  sameOrigin: vi.fn(() => true),
  controlMutation: vi.fn(),
  controlActor: vi.fn(async () => ({ kind: "owner", authTokenHash: "owner-hash" })),
  credentials: vi.fn(() => ({ authTokenHash: "owner-hash" })),
  isOwner: vi.fn(() => true),
}));

vi.mock("@/lib/control-session", () => ({
  controlMutation: mock.controlMutation,
  isSameOriginRequest: mock.sameOrigin,
}));
vi.mock("@/lib/request-auth", () => ({
  controlActor: mock.controlActor,
  controlCredentials: mock.credentials,
  isOwnerActor: mock.isOwner,
}));

import { POST } from "./route";

function request(body: unknown) {
  return new NextRequest("https://jarvis.test/api/client-mutation", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://jarvis.test" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mock.sameOrigin.mockReturnValue(true);
  mock.controlActor.mockResolvedValue({ kind: "owner", authTokenHash: "owner-hash" });
  mock.credentials.mockReturnValue({ authTokenHash: "owner-hash" });
  mock.isOwner.mockReturnValue(true);
  mock.controlMutation.mockResolvedValue(true);
});

describe("browser errand owner decision boundary", () => {
  it("forwards an approval only from the same-origin owner control route", async () => {
    const response = await POST(request({
      path: "browserErrands:decide",
      args: { errandId: "browser-errand-1", decision: "approved" },
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, value: true });
    expect(mock.controlMutation).toHaveBeenCalledWith("browserErrands:decide", {
      errandId: "browser-errand-1",
      decision: "approved",
      authTokenHash: "owner-hash",
    });
  });

  it("does not expose execution finalization as a generic model-callable client mutation", async () => {
    const response = await POST(request({
      path: "browserErrands:finish",
      args: { errandId: "browser-errand-1", status: "done" },
    }));

    expect(response.status).toBe(400);
    expect(mock.controlMutation).not.toHaveBeenCalled();
  });

  it("rejects a non-owner or cross-origin request before it reaches Convex", async () => {
    mock.sameOrigin.mockReturnValue(false);
    const crossOrigin = await POST(request({
      path: "browserErrands:decide",
      args: { errandId: "browser-errand-1", decision: "approved" },
    }));
    expect(crossOrigin.status).toBe(403);
    expect(mock.controlMutation).not.toHaveBeenCalled();

    mock.sameOrigin.mockReturnValue(true);
    mock.controlActor.mockResolvedValue({ kind: "guest", guestId: "g".repeat(32) } as any);
    mock.isOwner.mockReturnValue(false);
    const guest = await POST(request({
      path: "browserErrands:decide",
      args: { errandId: "browser-errand-1", decision: "approved" },
    }));
    expect(guest.status).toBe(403);
    expect(mock.controlMutation).not.toHaveBeenCalled();
  });
});
