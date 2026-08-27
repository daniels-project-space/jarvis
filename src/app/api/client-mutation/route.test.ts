import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mock = vi.hoisted(() => ({
  sameOrigin: vi.fn(() => true),
  controlMutation: vi.fn(),
  controlQuery: vi.fn(),
  privateR2Delete: vi.fn(),
  controlActor: vi.fn(async () => ({ kind: "owner", authTokenHash: "owner-hash" })),
  credentials: vi.fn(() => ({ authTokenHash: "owner-hash" })),
  isOwner: vi.fn(() => true),
}));

vi.mock("@/lib/control-session", () => ({
  controlMutation: mock.controlMutation,
  controlQuery: mock.controlQuery,
  isSameOriginRequest: mock.sameOrigin,
}));
vi.mock("@/lib/private-r2", () => ({ privateR2Delete: mock.privateR2Delete }));
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
  mock.controlQuery.mockResolvedValue(null);
  mock.privateR2Delete.mockResolvedValue(undefined);
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

  it("removes the exact authenticated private asset before finalizing a creation deletion", async () => {
    const assetR2Key = "owners/daniel/creations/f47ac10b-58cc-4372-a567-0e02b2c3d479/asset";
    mock.controlQuery.mockResolvedValue({ assetR2Key });

    const response = await POST(request({
      path: "creations:remove",
      args: { id: "creation-1" },
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, value: true });
    expect(mock.controlQuery).toHaveBeenCalledWith("creations:getForMedia", {
      id: "creation-1",
      authTokenHash: "owner-hash",
    });
    expect(mock.privateR2Delete).toHaveBeenCalledWith(assetR2Key);
    expect(mock.controlMutation).toHaveBeenCalledWith("creations:remove", {
      id: "creation-1",
      authTokenHash: "owner-hash",
    });
  });

  it("keeps creation metadata intact when private asset deletion fails", async () => {
    mock.controlQuery.mockResolvedValue({
      assetR2Key: "owners/daniel/creations/f47ac10b-58cc-4372-a567-0e02b2c3d479/asset",
    });
    mock.privateR2Delete.mockRejectedValue(new Error("R2 unavailable"));

    const response = await POST(request({
      path: "creations:remove",
      args: { id: "creation-1" },
    }));

    expect(response.status).toBe(409);
    expect(mock.controlMutation).not.toHaveBeenCalled();
  });

  it("keeps legacy metadata-only creations removable without inventing an R2 key", async () => {
    const response = await POST(request({
      path: "creations:remove",
      args: { id: "creation-legacy" },
    }));

    expect(response.status).toBe(200);
    expect(mock.privateR2Delete).not.toHaveBeenCalled();
    expect(mock.controlMutation).toHaveBeenCalledWith("creations:remove", {
      id: "creation-legacy",
      authTokenHash: "owner-hash",
    });
  });

  it("lets the owner retry after a lost creation-finalization response", async () => {
    const assetR2Key = "owners/daniel/creations/f47ac10b-58cc-4372-a567-0e02b2c3d479/asset";
    mock.controlQuery
      .mockResolvedValueOnce({ assetR2Key })
      .mockResolvedValueOnce(null);
    // Model a connection loss after Convex applied the idempotent deletion.
    mock.controlMutation.mockRejectedValueOnce(new Error("response lost"));
    mock.controlMutation.mockResolvedValueOnce(true);

    const first = await POST(request({ path: "creations:remove", args: { id: "creation-1" } }));
    expect(first.status).toBe(409);

    const retry = await POST(request({ path: "creations:remove", args: { id: "creation-1" } }));
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toEqual({ ok: true, value: true });
    expect(mock.privateR2Delete).toHaveBeenCalledOnce();
    expect(mock.privateR2Delete).toHaveBeenCalledWith(assetR2Key);
    expect(mock.controlMutation).toHaveBeenCalledTimes(2);
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
