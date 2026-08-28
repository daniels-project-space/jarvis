import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mock = vi.hoisted(() => ({
  randomUUID: vi.fn(),
  activePrivateCreationAssetStore: vi.fn(),
  privateCreationAssetLocatorForWrite: vi.fn(),
  trigger: vi.fn(),
}));

vi.mock("node:crypto", () => ({ randomUUID: mock.randomUUID }));
vi.mock("@trigger.dev/sdk/v3", () => ({ tasks: { trigger: mock.trigger } }));
vi.mock("./private-creation-asset-store", () => ({
  activePrivateCreationAssetStore: mock.activePrivateCreationAssetStore,
  privateCreationAssetLocatorForWrite: mock.privateCreationAssetLocatorForWrite,
}));

import { writePrivateCreationAssetWithRecord } from "./private-creation-asset-write";

const ASSET_ID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const WRITER_EPOCH = "817fcdd9-43d8-46f7-bc89-5205af27d284";
const ASSET_KEY = `owners/daniel/creations/${ASSET_ID}/asset`;
const locator = { assetStore: "private-r2-v1" as const, assetLocator: ASSET_KEY };
const asset = { ...locator, key: ASSET_KEY, contentType: "image/png" };

function lifecycle() {
  return {
    reserve: vi.fn().mockResolvedValue(undefined),
    renewForWrite: vi.fn().mockResolvedValue({ writerLeaseExpiresAt: Date.now() + 60_000 }),
    markWritten: vi.fn().mockResolvedValue({ state: "writing" }),
    abandon: vi.fn().mockResolvedValue({ state: "cleanup_ready" }),
    complete: vi.fn().mockResolvedValue(true),
    findCreationByAssetLocator: vi.fn().mockResolvedValue(null),
  };
}

function fencedWrite(result: {
  key?: string;
  contentType?: string;
  assetStore?: "private-r2-v1" | "private-r2-v2";
  assetLocator?: string;
} = asset) {
  return vi.fn().mockImplementation(async (_assetId: string, beforeR2Write: () => Promise<void>) => {
    await beforeR2Write();
    return result;
  });
}

describe("private creation asset write fence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.randomUUID.mockReturnValueOnce(ASSET_ID).mockReturnValueOnce(WRITER_EPOCH);
    mock.activePrivateCreationAssetStore.mockReturnValue("private-r2-v1");
    mock.privateCreationAssetLocatorForWrite.mockImplementation((_store: string, assetId: string, purpose: string) => ({
      assetStore: "private-r2-v1",
      assetLocator: `owners/daniel/creations/${assetId}/${purpose}`,
    }));
    mock.trigger.mockResolvedValue({ id: "cleanup-run" });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renews immediately at the R2 boundary and recovers a Convex response loss after the creation commit", async () => {
    const state = lifecycle();
    state.findCreationByAssetLocator.mockResolvedValueOnce("creation-committed");
    const persistCreation = vi.fn().mockRejectedValueOnce(new Error("response stream lost after commit"));

    await expect(writePrivateCreationAssetWithRecord({
      writeAsset: fencedWrite(),
      persistCreation,
      lifecycle: state,
    })).resolves.toEqual({ ok: true, asset, creationId: "creation-committed", recovered: true });

    expect(state.reserve).toHaveBeenCalledWith(locator, WRITER_EPOCH);
    expect(state.renewForWrite).toHaveBeenCalledWith(locator, WRITER_EPOCH);
    expect(state.markWritten).toHaveBeenCalledWith(locator, WRITER_EPOCH);
    expect(persistCreation).toHaveBeenCalledWith(asset, WRITER_EPOCH);
    expect(state.abandon).not.toHaveBeenCalled();
    expect(mock.trigger).not.toHaveBeenCalled();
    expect(state.complete).toHaveBeenCalledWith(locator);
  });

  it("fences and queues recovery after an R2 response loss instead of directly deleting the opaque key", async () => {
    const state = lifecycle();
    const writeError = new Error("R2 acknowledgement lost");
    const writeAsset = vi.fn().mockImplementation(async (_assetId: string, beforeR2Write: () => Promise<void>) => {
      await beforeR2Write();
      throw writeError;
    });

    await expect(writePrivateCreationAssetWithRecord({
      writeAsset,
      persistCreation: vi.fn(),
      lifecycle: state,
    })).resolves.toMatchObject({ ok: false, stage: "asset_write", error: writeError });

    expect(state.abandon).toHaveBeenCalledWith(locator, WRITER_EPOCH);
    expect(mock.trigger).toHaveBeenCalledWith(
      "jarvis-creation-asset-cleanup",
      { assetR2Key: ASSET_KEY, assetStore: "private-r2-v1", assetLocator: ASSET_KEY },
      { idempotencyKey: `jarvis-creation-asset-cleanup-private-r2-v1-${ASSET_ID}` },
    );
  });

  it("retries the exact opaque-key create before scheduling recovery when a receipt is never observed", async () => {
    const state = lifecycle();
    const persistCreation = vi.fn().mockRejectedValue(new Error("Convex response lost"));

    await expect(writePrivateCreationAssetWithRecord({
      writeAsset: fencedWrite(),
      persistCreation,
      lifecycle: state,
    })).resolves.toMatchObject({ ok: false, stage: "creation_unverified" });

    expect(persistCreation).toHaveBeenCalledTimes(2);
    expect(persistCreation).toHaveBeenNthCalledWith(1, asset, WRITER_EPOCH);
    expect(persistCreation).toHaveBeenNthCalledWith(2, asset, WRITER_EPOCH);
    expect(state.abandon).toHaveBeenCalledWith(locator, WRITER_EPOCH);
    expect(mock.trigger).toHaveBeenCalledWith(
      "jarvis-creation-asset-cleanup",
      { assetR2Key: ASSET_KEY, assetStore: "private-r2-v1", assetLocator: ASSET_KEY },
      { idempotencyKey: `jarvis-creation-asset-cleanup-private-r2-v1-${ASSET_ID}` },
    );
  });

  it("refuses a storage writer that does not return the reserved opaque key", async () => {
    const state = lifecycle();
    const wrongAsset = { key: "owners/daniel/creations/570df4a2-8870-4fe1-a4cf-6d32ccf758e1/asset", contentType: "image/png" };
    const persistCreation = vi.fn();

    await expect(writePrivateCreationAssetWithRecord({
      writeAsset: fencedWrite(wrongAsset),
      persistCreation,
      lifecycle: state,
    })).resolves.toMatchObject({ ok: false, stage: "asset_write" });

    expect(persistCreation).not.toHaveBeenCalled();
    expect(state.abandon).toHaveBeenCalledWith(locator, WRITER_EPOCH);
  });

  it("fails closed when a producer bypasses the shared R2 renewal callback", async () => {
    const state = lifecycle();

    await expect(writePrivateCreationAssetWithRecord({
      writeAsset: vi.fn().mockResolvedValue(asset),
      persistCreation: vi.fn(),
      lifecycle: state,
    })).resolves.toMatchObject({ ok: false, stage: "asset_write" });

    expect(state.renewForWrite).not.toHaveBeenCalled();
    expect(state.abandon).toHaveBeenCalledWith(locator, WRITER_EPOCH);
    expect(mock.trigger).toHaveBeenCalled();
  });

  it("does not start an R2 write when deployed against an older Convex contract", async () => {
    const state = lifecycle();
    const unsupported = new Error("Could not find public function creationAssetCleanup:reserve");
    state.reserve.mockRejectedValueOnce(unsupported);
    const writeAsset = vi.fn();

    await expect(writePrivateCreationAssetWithRecord({
      writeAsset,
      persistCreation: vi.fn(),
      lifecycle: state,
    })).resolves.toMatchObject({ ok: false, stage: "reservation", error: unsupported });

    expect(writeAsset).not.toHaveBeenCalled();
  });

  it("does not rely on a returned deadline for correctness; a current Convex contract may return no timing field", async () => {
    const state = lifecycle();
    state.renewForWrite.mockResolvedValue(undefined);

    await expect(writePrivateCreationAssetWithRecord({
      writeAsset: fencedWrite(),
      persistCreation: vi.fn().mockResolvedValue("creation-committed"),
      lifecycle: state,
    })).resolves.toEqual({ ok: true, asset, creationId: "creation-committed", recovered: false });

    expect(state.renewForWrite).toHaveBeenCalledWith(locator, WRITER_EPOCH);
    expect(state.markWritten).toHaveBeenCalledWith(locator, WRITER_EPOCH);
    expect(state.abandon).not.toHaveBeenCalled();
  });
});
