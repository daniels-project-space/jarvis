import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ trigger: vi.fn() }));

vi.mock("@trigger.dev/sdk/v3", () => ({
  task: (definition: unknown) => definition,
  schedules: { task: (definition: unknown) => definition },
  tasks: { trigger: mock.trigger },
}));
vi.mock("../lib/private-creation-asset-store", () => ({
  assertPrivateCreationAssetStoreConfigured: vi.fn(),
  privateCreationAssetGet: vi.fn(),
  privateCreationAssetPut: vi.fn(),
  requirePrivateCreationAssetLocator: (locator: unknown) => locator,
}));

import { rehomeCreationAsset } from "./creation-asset-rehome";

const CREATION_ID = "j57d9dbxe9b31fkrbkk7pg2h7n7caa3s";
const SOURCE = {
  assetStore: "private-r2-v1" as const,
  assetLocator: "owners/daniel/creations/f47ac10b-58cc-4372-a567-0e02b2c3d479/asset",
};
const DESTINATION = {
  assetStore: "private-r2-v2" as const,
  assetLocator: `owners/daniel/creation-assets-v2/migration/1/${CREATION_ID}/generation/1/asset`,
};

function claim() {
  return {
    ready: true as const,
    creationId: CREATION_ID,
    ticketId: "j57d9dbxe9b31fkrbkk7pg2h7n7caa3t",
    source: SOURCE,
    destination: DESTINATION,
    contentType: "image/png",
    maxBytes: 30 * 1024 * 1024,
  };
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("creation asset rehome task", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("receives only an opaque ID, then requires a full V2 readback SHA before Convex verification", async () => {
    const sourceBytes = new Uint8Array([0, 1, 2, 3, 255]);
    let v2Bytes: Uint8Array | undefined;
    const call = vi.fn(async (_kind: string, path: string, args: Record<string, unknown>) => {
      if (path === "creationAssetStoreMigration:claimCopy") return claim();
      if (path === "creationAssetStoreMigration:verifyCopy") return { state: "cutover_ready" };
      throw new Error(`unexpected Convex call ${path}`);
    });
    const get = vi.fn(async (locator: typeof SOURCE | typeof DESTINATION) => {
      if (locator.assetStore === "private-r2-v1") return new Response(sourceBytes);
      return new Response(v2Bytes ? v2Bytes as unknown as BodyInit : null);
    });
    const put = vi.fn(async (_locator: typeof DESTINATION, bytes: Uint8Array) => {
      v2Bytes = new Uint8Array(bytes);
      return {};
    });
    const assertStore = vi.fn().mockResolvedValue(undefined);

    await expect(rehomeCreationAsset(CREATION_ID, { call: call as any, get: get as any, put: put as any, assertStore }))
      .resolves.toEqual({ creationId: CREATION_ID, copied: true, sha256: digest(sourceBytes), sizeBytes: sourceBytes.byteLength });

    expect(call).toHaveBeenNthCalledWith(1, "mutation", "creationAssetStoreMigration:claimCopy", { creationId: CREATION_ID });
    expect(assertStore).toHaveBeenCalledWith("private-r2-v2");
    expect(get).toHaveBeenNthCalledWith(1, SOURCE);
    expect(put).toHaveBeenCalledWith(DESTINATION, sourceBytes, "image/png", { sha256: digest(sourceBytes) });
    expect(get).toHaveBeenNthCalledWith(2, DESTINATION);
    expect(call).toHaveBeenLastCalledWith("mutation", "creationAssetStoreMigration:verifyCopy", {
      creationId: CREATION_ID,
      ticketId: claim().ticketId,
      sha256: digest(sourceBytes),
      sizeBytes: sourceBytes.byteLength,
      contentType: "image/png",
    });
  });

  it("fails closed before V1 reads or writes when the V2 vault/bucket capability is unavailable", async () => {
    const call = vi.fn(async (_kind: string, path: string) => {
      if (path === "creationAssetStoreMigration:claimCopy") return claim();
      if (path === "creationAssetStoreMigration:releaseCopy") return true;
      throw new Error(`unexpected Convex call ${path}`);
    });
    const get = vi.fn();
    const put = vi.fn();
    const assertStore = vi.fn().mockRejectedValue(new Error("V2 vault unavailable"));

    await expect(rehomeCreationAsset(CREATION_ID, { call: call as any, get: get as any, put: put as any, assertStore }))
      .rejects.toThrow("V2 vault unavailable");

    expect(get).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(call).toHaveBeenLastCalledWith("mutation", "creationAssetStoreMigration:releaseCopy", {
      creationId: CREATION_ID,
      ticketId: claim().ticketId,
      reason: "V2 vault unavailable",
    });
  });

  it("retains an ambiguous V2 object and releases the server ticket when independent readback differs", async () => {
    const sourceBytes = new Uint8Array([1, 2, 3]);
    const call = vi.fn(async (_kind: string, path: string) => {
      if (path === "creationAssetStoreMigration:claimCopy") return claim();
      if (path === "creationAssetStoreMigration:releaseCopy") return true;
      throw new Error(`unexpected Convex call ${path}`);
    });
    const get = vi.fn()
      .mockResolvedValueOnce(new Response(sourceBytes))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 4])));
    const put = vi.fn().mockResolvedValue({});
    const assertStore = vi.fn().mockResolvedValue(undefined);

    await expect(rehomeCreationAsset(CREATION_ID, { call: call as any, get, put, assertStore }))
      .rejects.toThrow("readback digest mismatch");

    expect(call.mock.calls.map(([, path]) => path)).toEqual([
      "creationAssetStoreMigration:claimCopy",
      "creationAssetStoreMigration:releaseCopy",
    ]);
    expect(put).toHaveBeenCalledTimes(1);
  });
});
