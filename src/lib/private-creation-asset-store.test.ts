import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  privateCreationObjectKey: vi.fn(),
  privateR2Get: vi.fn(),
  privateR2Put: vi.fn(),
  privateR2Delete: vi.fn(),
  assertPrivateR2Configured: vi.fn(),
  getServiceSecrets: vi.fn(),
  vaultFailureStage: vi.fn(),
  getPrivateCreationAssetV2VaultSecrets: vi.fn(),
  privateCreationAssetV2VaultFailureStage: vi.fn(),
  AwsClient: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("aws4fetch", () => ({ AwsClient: mock.AwsClient }));
vi.mock("./chat-files", () => ({
  normalizeUploadMime: (value: string) => value,
  normalizeUploadSha256: (value: string) => value,
}));
vi.mock("./private-r2", () => ({
  assertPrivateR2Configured: mock.assertPrivateR2Configured,
  privateCreationObjectKey: mock.privateCreationObjectKey,
  privateR2Delete: mock.privateR2Delete,
  privateR2Get: mock.privateR2Get,
  privateR2Put: mock.privateR2Put,
}));
vi.mock("./vault", () => ({ getServiceSecrets: mock.getServiceSecrets }));
vi.mock("./vault-client", () => ({ vaultFailureStage: mock.vaultFailureStage }));
vi.mock("./private-creation-asset-v2-vault", () => ({
  getPrivateCreationAssetV2VaultSecrets: mock.getPrivateCreationAssetV2VaultSecrets,
  privateCreationAssetV2VaultFailureStage: mock.privateCreationAssetV2VaultFailureStage,
  PRIVATE_CREATION_ASSET_V2_VAULT_SERVICE: "cloudflare-private-r2-v2",
}));

import {
  PRIVATE_CREATION_ASSET_STORE_ENV,
  PRIVATE_CREATION_ASSET_STORE_V1,
  PRIVATE_CREATION_ASSET_STORE_V2,
  PRIVATE_CREATION_ASSET_V2_BUCKET_ENV,
  PRIVATE_CREATION_ASSET_V2_ENDPOINT_ENV,
  activePrivateCreationAssetStore,
  isPrivateCreationAssetLocator,
  privateCreationAssetGet,
  privateCreationAssetLocatorForCapabilityProbe,
  privateCreationAssetLocatorForMigration,
  privateCreationAssetLocatorForWrite,
  provePrivateCreationAssetV2Capability,
  resetPrivateCreationAssetStoreForTests,
} from "./private-creation-asset-store";

const UUID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const V1 = { assetStore: "private-r2-v1" as const, assetLocator: `owners/daniel/creations/${UUID}/asset` };
const V2 = { assetStore: "private-r2-v2" as const, assetLocator: "owners/daniel/creation-assets-v2/migration/1/j57d9dbxe9b31fkrbkk7pg2h7n7caa3s/generation/1/asset" };
const PROOF_ID = "j57d9dbxe9b31fkrbkk7pg2h7n7caa3u";
const V2_ENDPOINT = "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com";

describe("private creation asset store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPrivateCreationAssetStoreForTests();
    mock.privateCreationObjectKey.mockImplementation((id: string, purpose: string) => `owners/daniel/creations/${id}/${purpose}`);
    mock.privateR2Get.mockResolvedValue(new Response(new Uint8Array([1])));
    mock.vaultFailureStage.mockReturnValue("unknown");
    mock.privateCreationAssetV2VaultFailureStage.mockReturnValue("unknown");
  });

  afterEach(() => {
    resetPrivateCreationAssetStoreForTests();
    delete process.env[PRIVATE_CREATION_ASSET_V2_BUCKET_ENV];
    delete process.env[PRIVATE_CREATION_ASSET_V2_ENDPOINT_ENV];
  });

  it("keeps V1 default-compatible while reserving a separate V2 grammar", () => {
    expect(activePrivateCreationAssetStore({})).toBe(PRIVATE_CREATION_ASSET_STORE_V1);
    expect(activePrivateCreationAssetStore({ [PRIVATE_CREATION_ASSET_STORE_ENV]: PRIVATE_CREATION_ASSET_STORE_V2 }))
      .toBe(PRIVATE_CREATION_ASSET_STORE_V2);
    expect(() => activePrivateCreationAssetStore({ [PRIVATE_CREATION_ASSET_STORE_ENV]: "some-other-store" }))
      .toThrow(PRIVATE_CREATION_ASSET_STORE_ENV);

    expect(privateCreationAssetLocatorForWrite(PRIVATE_CREATION_ASSET_STORE_V1, UUID)).toEqual(V1);
    expect(privateCreationAssetLocatorForWrite(PRIVATE_CREATION_ASSET_STORE_V2, UUID)).toEqual({
      assetStore: PRIVATE_CREATION_ASSET_STORE_V2,
      assetLocator: `owners/daniel/creation-assets-v2/live/${UUID}/asset`,
    });
    expect(privateCreationAssetLocatorForMigration("j57d9dbxe9b31fkrbkk7pg2h7n7caa3s")).toEqual(V2);
    expect(isPrivateCreationAssetLocator(V1)).toBe(true);
    expect(isPrivateCreationAssetLocator(V2)).toBe(true);
    expect(isPrivateCreationAssetLocator({ ...V2, assetStore: PRIVATE_CREATION_ASSET_STORE_V1 })).toBe(false);
  });

  it("never falls a V2 read back to V1 when the separate vault capability is absent", async () => {
    process.env[PRIVATE_CREATION_ASSET_V2_BUCKET_ENV] = "jarvis-private-creation-assets-v2";
    process.env[PRIVATE_CREATION_ASSET_V2_ENDPOINT_ENV] = V2_ENDPOINT;
    mock.getPrivateCreationAssetV2VaultSecrets.mockRejectedValue(new Error("vault unavailable"));

    await expect(privateCreationAssetGet(V2)).rejects.toThrow("V2 vault capability is unavailable");
    expect(mock.privateR2Get).not.toHaveBeenCalled();
  });

  it("uses only the dedicated V2 vault capability and pins its signed R2 endpoint", async () => {
    process.env[PRIVATE_CREATION_ASSET_V2_BUCKET_ENV] = "jarvis-private-creation-assets-v2";
    process.env[PRIVATE_CREATION_ASSET_V2_ENDPOINT_ENV] = V2_ENDPOINT;
    const signedFetch = vi.fn().mockResolvedValue(new Response(new Uint8Array([2])));
    mock.AwsClient.mockImplementation(function () {
      return { fetch: signedFetch };
    });
    mock.getPrivateCreationAssetV2VaultSecrets.mockResolvedValue({
      R2_ACCESS_KEY_ID: "test-v2-access-key",
      R2_SECRET_ACCESS_KEY: "test-v2-secret-key",
      R2_ENDPOINT: V2_ENDPOINT,
    });

    await expect(privateCreationAssetGet(V2)).resolves.toBeInstanceOf(Response);

    expect(mock.getPrivateCreationAssetV2VaultSecrets).toHaveBeenCalledWith();
    expect(mock.getServiceSecrets).not.toHaveBeenCalled();
    expect(mock.privateR2Get).not.toHaveBeenCalled();
    expect(mock.AwsClient).toHaveBeenCalledTimes(1);
    expect(signedFetch).toHaveBeenCalledWith(
      `${V2_ENDPOINT}/jarvis-private-creation-assets-v2/${"owners/daniel/creation-assets-v2/migration/1/j57d9dbxe9b31fkrbkk7pg2h7n7caa3s/generation/1/asset"}`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("rejects an unpinned or malicious V2 R2 endpoint before signed storage access", async () => {
    process.env[PRIVATE_CREATION_ASSET_V2_BUCKET_ENV] = "jarvis-private-creation-assets-v2";
    process.env[PRIVATE_CREATION_ASSET_V2_ENDPOINT_ENV] = V2_ENDPOINT;
    mock.getPrivateCreationAssetV2VaultSecrets.mockResolvedValue({
      R2_ACCESS_KEY_ID: "test-v2-access-key",
      R2_SECRET_ACCESS_KEY: "test-v2-secret-key",
      R2_ENDPOINT: "https://evil.example/collect",
    });

    await expect(privateCreationAssetGet(V2)).rejects.toThrow("V2 R2 endpoint is invalid");
    expect(mock.AwsClient).not.toHaveBeenCalled();
  });

  it("rejects a syntactically valid V2 endpoint for a different account before signing", async () => {
    process.env[PRIVATE_CREATION_ASSET_V2_BUCKET_ENV] = "jarvis-private-creation-assets-v2";
    process.env[PRIVATE_CREATION_ASSET_V2_ENDPOINT_ENV] = V2_ENDPOINT;
    mock.getPrivateCreationAssetV2VaultSecrets.mockResolvedValue({
      R2_ACCESS_KEY_ID: "test-v2-access-key",
      R2_SECRET_ACCESS_KEY: "test-v2-secret-key",
      R2_ENDPOINT: "https://fedcba9876543210fedcba9876543210.r2.cloudflarestorage.com",
    });

    await expect(privateCreationAssetGet(V2)).rejects.toThrow("does not match the pinned V2 R2 endpoint");
    expect(mock.AwsClient).not.toHaveBeenCalled();
  });

  it("rejects an explicit default port in a V2 endpoint before signing", async () => {
    process.env[PRIVATE_CREATION_ASSET_V2_BUCKET_ENV] = "jarvis-private-creation-assets-v2";
    process.env[PRIVATE_CREATION_ASSET_V2_ENDPOINT_ENV] = V2_ENDPOINT;
    mock.getPrivateCreationAssetV2VaultSecrets.mockResolvedValue({
      R2_ACCESS_KEY_ID: "test-v2-access-key",
      R2_SECRET_ACCESS_KEY: "test-v2-secret-key",
      R2_ENDPOINT: `${V2_ENDPOINT}:443`,
    });

    await expect(privateCreationAssetGet(V2)).rejects.toThrow("V2 R2 endpoint is invalid");
    expect(mock.AwsClient).not.toHaveBeenCalled();
  });

  it("continues to read an existing V1 locator through the established V1 primitive", async () => {
    await expect(privateCreationAssetGet(V1)).resolves.toBeInstanceOf(Response);
    expect(mock.privateR2Get).toHaveBeenCalledWith(V1.assetLocator, undefined, undefined);
    expect(mock.getServiceSecrets).not.toHaveBeenCalled();
  });

  it("proves the selected V2 runtime with an isolated put and full-byte SHA readback", async () => {
    let stored: Uint8Array | undefined;
    const put = vi.fn(async (_locator: unknown, body: Uint8Array) => {
      stored = new Uint8Array(body);
      return {};
    });
    const get = vi.fn(async () => new Response(stored ? stored as unknown as BodyInit : null));
    const remove = vi.fn(async () => undefined);
    const assertStore = vi.fn(async () => undefined);

    const result = await provePrivateCreationAssetV2Capability(PROOF_ID, {
      activeStore: () => PRIVATE_CREATION_ASSET_STORE_V2,
      assertStore: assertStore as any,
      put: put as any,
      get: get as any,
      remove: remove as any,
    });

    const probe = privateCreationAssetLocatorForCapabilityProbe(PROOF_ID);
    expect(probe).toEqual({
      assetStore: PRIVATE_CREATION_ASSET_STORE_V2,
      assetLocator: `owners/daniel/creation-assets-v2/probe/${PROOF_ID}/capability`,
    });
    expect(assertStore).toHaveBeenCalledWith(PRIVATE_CREATION_ASSET_STORE_V2);
    expect(put).toHaveBeenCalledWith(probe, expect.any(Uint8Array), "application/octet-stream", { sha256: result.sha256 });
    expect(get).toHaveBeenCalledWith(probe);
    expect(remove).toHaveBeenCalledWith(probe);
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("fails closed without V2 selection before it can read, write, or delete through another store", async () => {
    const get = vi.fn();
    const put = vi.fn();
    const remove = vi.fn();

    await expect(provePrivateCreationAssetV2Capability(PROOF_ID, {
      activeStore: () => PRIVATE_CREATION_ASSET_STORE_V1,
      get: get as any,
      put: put as any,
      remove: remove as any,
    })).rejects.toThrow(PRIVATE_CREATION_ASSET_STORE_ENV);

    expect(get).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
});
