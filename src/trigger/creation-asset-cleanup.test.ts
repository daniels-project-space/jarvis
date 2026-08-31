import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ privateCreationAssetDelete: vi.fn() }));

vi.mock("@trigger.dev/sdk/v3", () => ({ task: (definition: unknown) => definition }));
vi.mock("../lib/private-creation-asset-store", () => ({ privateCreationAssetDelete: mock.privateCreationAssetDelete }));

import { creationAssetCleanup } from "./creation-asset-cleanup";

const WORKER = "creation-cleanup-test-worker";
const ASSET_KEY = "owners/daniel/creations/f47ac10b-58cc-4372-a567-0e02b2c3d479/asset";

function response(value: unknown, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => value };
}

describe("private creation asset cleanup task", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JARVIS_WORKER_TOKEN = WORKER;
    mock.privateCreationAssetDelete.mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete process.env.JARVIS_WORKER_TOKEN;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("rechecks the canonical creation immediately before deleting an unreferenced private object", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ value: { ready: true, assetR2Key: ASSET_KEY, assetStore: "private-r2-v1", assetLocator: ASSET_KEY, deletionTicketId: "j57d9dbxe9b31fkrbkk7pg2h7n7caa3t", cleanupProtocol: "nonterminal-reaper-v1" } }))
      .mockResolvedValueOnce(response({ value: null }))
      .mockResolvedValueOnce(response({ value: { finished: true, preserved: false } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect((creationAssetCleanup as any).run({ assetR2Key: ASSET_KEY })).resolves.toEqual({
      assetR2Key: ASSET_KEY,
      deleted: true,
      preserved: false,
    });

    expect(mock.privateCreationAssetDelete).toHaveBeenCalledWith({ assetStore: "private-r2-v1", assetLocator: ASSET_KEY });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      expect.stringContaining("/api/mutation"),
      expect.stringContaining("/api/query"),
      expect.stringContaining("/api/mutation"),
    ]);
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toMatchObject({
      path: "creationAssetCleanup:claim",
      args: { assetR2Key: ASSET_KEY, workerToken: WORKER },
    });
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string).args).not.toHaveProperty("claimToken");
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string)).toMatchObject({
      path: "creations:getByAssetLocator",
      args: { assetStore: "private-r2-v1", assetLocator: ASSET_KEY, workerToken: WORKER },
    });
    expect(JSON.parse(fetchMock.mock.calls[2]?.[1]?.body as string)).toMatchObject({
      path: "creationAssetCleanup:finish",
      args: { deletionTicketId: "j57d9dbxe9b31fkrbkk7pg2h7n7caa3t", workerToken: WORKER },
    });
  });

  it("preserves an asset when the immediate canonical check finds a committed creation", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ value: { ready: true, assetR2Key: ASSET_KEY, assetStore: "private-r2-v1", assetLocator: ASSET_KEY, deletionTicketId: "j57d9dbxe9b31fkrbkk7pg2h7n7caa3t", cleanupProtocol: "nonterminal-reaper-v1" } }))
      .mockResolvedValueOnce(response({ value: "creation-committed" }))
      .mockResolvedValueOnce(response({ value: { finished: false, preserved: true } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect((creationAssetCleanup as any).run({ assetR2Key: ASSET_KEY })).resolves.toEqual({
      assetR2Key: ASSET_KEY,
      preserved: true,
    });

    expect(mock.privateCreationAssetDelete).not.toHaveBeenCalled();
  });

  it("defers a bounded writer or cleanup lease to the durable periodic reconciler", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ value: { ready: false, retryAfterMs: 45_000 } })));

    await expect((creationAssetCleanup as any).run({ assetR2Key: ASSET_KEY }))
      .resolves.toEqual({ assetR2Key: ASSET_KEY, deferred: true });
    expect(mock.privateCreationAssetDelete).not.toHaveBeenCalled();
  });

  it("fails safe against an older Convex deployment that does not yet expose the cleanup contract", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({
      status: "error",
      errorMessage: "Could not find public function creationAssetCleanup:claim",
    })));

    await expect((creationAssetCleanup as any).run({ assetR2Key: ASSET_KEY }))
      .rejects.toThrow("creationAssetCleanup:claim failed");
    expect(mock.privateCreationAssetDelete).not.toHaveBeenCalled();
  });

  it("fails safe before R2 deletion when deployed against an older finite-retention Convex contract", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ value: { ready: true, assetR2Key: ASSET_KEY, assetStore: "private-r2-v1", assetLocator: ASSET_KEY, deletionTicketId: "j57d9dbxe9b31fkrbkk7pg2h7n7caa3t" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect((creationAssetCleanup as any).run({ assetR2Key: ASSET_KEY }))
      .rejects.toThrow("requires the nonterminal Convex reaper contract");
    expect(mock.privateCreationAssetDelete).not.toHaveBeenCalled();
  });
});
