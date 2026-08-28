import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mock = vi.hoisted(() => ({
  sameOrigin: vi.fn(() => true),
  controlMutation: vi.fn(),
  controlQuery: vi.fn(),
  privateR2Delete: vi.fn(),
  schedulePrivateCreationAssetCleanup: vi.fn(),
  controlActor: vi.fn(async () => ({ kind: "owner", authTokenHash: "owner-hash" })),
  credentials: vi.fn(() => ({ authTokenHash: "owner-hash" })),
  isOwner: vi.fn(() => true),
}));

vi.mock("@/lib/control-session", () => ({
  controlMutation: mock.controlMutation,
  controlQuery: mock.controlQuery,
  isSameOriginRequest: mock.sameOrigin,
}));
vi.mock("@/lib/private-creation-asset-write", () => ({
  schedulePrivateCreationAssetCleanup: mock.schedulePrivateCreationAssetCleanup,
}));
vi.mock("@/lib/private-r2", () => ({
  privateR2Delete: mock.privateR2Delete,
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
  mock.controlQuery.mockImplementation(async (path: string) => {
    if (path === "creationAssetCleanup:protocol") {
      return { cleanupProtocol: "nonterminal-reaper-v1" };
    }
    return null;
  });
  mock.schedulePrivateCreationAssetCleanup.mockResolvedValue(undefined);
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

  it("atomically removes private-asset metadata before accelerating durable cleanup", async () => {
    const assetR2Key = "owners/daniel/creations/f47ac10b-58cc-4372-a567-0e02b2c3d479/asset";
    mock.controlQuery.mockImplementation(async (path: string) => path === "creations:getForMedia"
      ? { assetR2Key }
      : { cleanupProtocol: "nonterminal-reaper-v1" });

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
    expect(mock.controlQuery).toHaveBeenCalledWith("creationAssetCleanup:protocol", {
      authTokenHash: "owner-hash",
    });
    expect(mock.controlMutation).toHaveBeenCalledWith("creations:remove", {
      id: "creation-1",
      authTokenHash: "owner-hash",
    });
    expect(mock.schedulePrivateCreationAssetCleanup).toHaveBeenCalledWith(assetR2Key);
  });

  it("keeps deletion durable when immediate cleanup dispatch is unavailable", async () => {
    mock.controlQuery.mockImplementation(async (path: string) => path === "creations:getForMedia"
      ? { assetR2Key: "owners/daniel/creations/f47ac10b-58cc-4372-a567-0e02b2c3d479/asset" }
      : { cleanupProtocol: "nonterminal-reaper-v1" });
    mock.schedulePrivateCreationAssetCleanup.mockRejectedValue(new Error("Trigger unavailable"));

    const response = await POST(request({
      path: "creations:remove",
      args: { id: "creation-1" },
    }));

    expect(response.status).toBe(200);
    expect(mock.controlMutation).toHaveBeenCalledWith("creations:remove", {
      id: "creation-1",
      authTokenHash: "owner-hash",
    });
  });

  it("keeps legacy metadata-only creations removable without inventing an R2 key", async () => {
    const response = await POST(request({
      path: "creations:remove",
      args: { id: "creation-legacy" },
    }));

    expect(response.status).toBe(200);
    expect(mock.schedulePrivateCreationAssetCleanup).not.toHaveBeenCalled();
    expect(mock.controlMutation).toHaveBeenCalledWith("creations:remove", {
      id: "creation-legacy",
      authTokenHash: "owner-hash",
    });
  });

  it("lets the owner retry after a lost creation-finalization response", async () => {
    const assetR2Key = "owners/daniel/creations/f47ac10b-58cc-4372-a567-0e02b2c3d479/asset";
    mock.controlQuery
      .mockResolvedValueOnce({ assetR2Key })
      .mockResolvedValueOnce({ cleanupProtocol: "nonterminal-reaper-v1" })
      .mockResolvedValueOnce(null);
    // Model a connection loss after Convex applied the idempotent deletion.
    mock.controlMutation.mockRejectedValueOnce(new Error("response lost"));
    mock.controlMutation.mockResolvedValueOnce(true);

    const first = await POST(request({ path: "creations:remove", args: { id: "creation-1" } }));
    expect(first.status).toBe(409);

    const retry = await POST(request({ path: "creations:remove", args: { id: "creation-1" } }));
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toEqual({ ok: true, value: true });
    expect(mock.schedulePrivateCreationAssetCleanup).not.toHaveBeenCalled();
    expect(mock.controlMutation).toHaveBeenCalledTimes(2);
  });

  it("fails closed before deletion when Vercel reaches the old Convex contract", async () => {
    const assetR2Key = "owners/daniel/creations/f47ac10b-58cc-4372-a567-0e02b2c3d479/asset";
    mock.controlQuery
      .mockResolvedValueOnce({ assetR2Key })
      // The old Convex deployment has no `creationAssetCleanup:protocol`
      // function, so this capability request rejects before metadata changes.
      .mockRejectedValueOnce(new Error("Could not find public function"));

    const response = await POST(request({ path: "creations:remove", args: { id: "creation-1" } }));

    expect(response.status).toBe(409);
    expect(mock.controlMutation).not.toHaveBeenCalled();
    expect(mock.schedulePrivateCreationAssetCleanup).not.toHaveBeenCalled();
    // The current route has no direct R2 delete path. Keep this assertion so
    // a future refactor cannot reintroduce the legacy delete-before-Convex
    // sequence beneath the old-Convex capability bridge.
    expect(mock.privateR2Delete).not.toHaveBeenCalled();
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
