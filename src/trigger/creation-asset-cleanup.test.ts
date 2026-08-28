import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ privateR2Delete: vi.fn() }));

vi.mock("@trigger.dev/sdk/v3", () => ({ task: (definition: unknown) => definition }));
vi.mock("../lib/private-r2", () => ({ privateR2Delete: mock.privateR2Delete }));

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
    mock.privateR2Delete.mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete process.env.JARVIS_WORKER_TOKEN;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("rechecks the canonical creation immediately before deleting an unreferenced private object", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ value: { ready: true, assetR2Key: ASSET_KEY, claimToken: "cleanup-claim", cleanupProtocol: "nonterminal-reaper-v1" } }))
      .mockResolvedValueOnce(response({ value: null }))
      .mockResolvedValueOnce(response({ value: { finished: true, preserved: false } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect((creationAssetCleanup as any).run({ assetR2Key: ASSET_KEY })).resolves.toEqual({
      assetR2Key: ASSET_KEY,
      deleted: true,
      preserved: false,
    });

    expect(mock.privateR2Delete).toHaveBeenCalledWith(ASSET_KEY);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      expect.stringContaining("/api/mutation"),
      expect.stringContaining("/api/query"),
      expect.stringContaining("/api/mutation"),
    ]);
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string)).toMatchObject({
      path: "creations:getByAssetR2Key",
      args: { assetR2Key: ASSET_KEY, workerToken: WORKER },
    });
  });

  it("preserves an asset when the immediate canonical check finds a committed creation", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ value: { ready: true, assetR2Key: ASSET_KEY, claimToken: "cleanup-claim", cleanupProtocol: "nonterminal-reaper-v1" } }))
      .mockResolvedValueOnce(response({ value: "creation-committed" }))
      .mockResolvedValueOnce(response({ value: { finished: false, preserved: true } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect((creationAssetCleanup as any).run({ assetR2Key: ASSET_KEY })).resolves.toEqual({
      assetR2Key: ASSET_KEY,
      preserved: true,
    });

    expect(mock.privateR2Delete).not.toHaveBeenCalled();
  });

  it("defers a bounded writer or cleanup lease to the durable periodic reconciler", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ value: { ready: false, retryAfterMs: 45_000 } })));

    await expect((creationAssetCleanup as any).run({ assetR2Key: ASSET_KEY }))
      .resolves.toEqual({ assetR2Key: ASSET_KEY, deferred: true });
    expect(mock.privateR2Delete).not.toHaveBeenCalled();
  });

  it("fails safe against an older Convex deployment that does not yet expose the cleanup contract", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({
      status: "error",
      errorMessage: "Could not find public function creationAssetCleanup:claim",
    })));

    await expect((creationAssetCleanup as any).run({ assetR2Key: ASSET_KEY }))
      .rejects.toThrow("creationAssetCleanup:claim failed");
    expect(mock.privateR2Delete).not.toHaveBeenCalled();
  });

  it("fails safe before R2 deletion when deployed against an older finite-retention Convex contract", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ value: { ready: true, assetR2Key: ASSET_KEY, claimToken: "cleanup-claim" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect((creationAssetCleanup as any).run({ assetR2Key: ASSET_KEY }))
      .rejects.toThrow("requires the nonterminal Convex reaper contract");
    expect(mock.privateR2Delete).not.toHaveBeenCalled();
  });
});
