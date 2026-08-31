import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  signedFetch: vi.fn(),
  legacyGet: vi.fn(),
  legacyPut: vi.fn(),
  legacyDelete: vi.fn(),
  legacyConfigured: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("aws4fetch", () => ({
  AwsClient: class AwsClient {
    fetch = mock.signedFetch;
  },
}));
vi.mock("./chat-files", () => ({
  normalizeUploadMime: (value: string) => value,
  normalizeUploadSha256: (value: string) => value,
}));
vi.mock("./private-r2", () => ({
  assertPrivateR2Configured: mock.legacyConfigured,
  privateCreationObjectKey: (id: string, purpose: string) => `owners/daniel/creations/${id}/${purpose}`,
  privateR2Delete: mock.legacyDelete,
  privateR2Get: mock.legacyGet,
  privateR2Put: mock.legacyPut,
}));

import {
  PRIVATE_CREATION_ASSET_STORE_V2,
  PRIVATE_CREATION_ASSET_V2_BUCKET_ENV,
  PRIVATE_CREATION_ASSET_V2_ENDPOINT_ENV,
  privateCreationAssetGet,
  resetPrivateCreationAssetStoreForTests,
} from "./private-creation-asset-store";

const HUB_ORIGIN = "https://fantastic-roadrunner-485.convex.cloud";
const HUB_QUERY_URL = `${HUB_ORIGIN}/api/query`;
const V2_ENDPOINT = "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com";
const LOCATOR = {
  assetStore: PRIVATE_CREATION_ASSET_STORE_V2,
  assetLocator: "owners/daniel/creation-assets-v2/migration/1/j57d9dbxe9b31fkrbkk7pg2h7n7caa3s/generation/1/asset",
} as const;

function responseAt(url: string, body?: BodyInit | null, init?: ResponseInit): Response {
  const response = new Response(body, init);
  Object.defineProperty(response, "url", { value: url });
  return response;
}

describe("private creation V2 store and dedicated vault integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPrivateCreationAssetStoreForTests();
    process.env[PRIVATE_CREATION_ASSET_V2_BUCKET_ENV] = "jarvis-private-creation-assets-v2";
    process.env[PRIVATE_CREATION_ASSET_V2_ENDPOINT_ENV] = V2_ENDPOINT;
  });

  afterEach(() => {
    resetPrivateCreationAssetStoreForTests();
    delete process.env[PRIVATE_CREATION_ASSET_V2_BUCKET_ENV];
    delete process.env[PRIVATE_CREATION_ASSET_V2_ENDPOINT_ENV];
    delete process.env.JARVIS_PRIVATE_CREATION_ASSET_V2_VAULT_TOKEN;
    delete process.env.VAULT_ACCESS_TOKEN;
    vi.unstubAllGlobals();
  });

  it("uses the real fixed V2 vault client through the store and never sends the generic bearer or a service selector", async () => {
    const genericToken = "legacy-generic-bearer";
    const v2Token = "v2-only-bearer";
    process.env.VAULT_ACCESS_TOKEN = genericToken;
    process.env.JARVIS_PRIVATE_CREATION_ASSET_V2_VAULT_TOKEN = v2Token;
    const hubFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => responseAt(HUB_QUERY_URL, JSON.stringify({
      status: "success",
      value: {
        service: "cloudflare-private-r2-v2",
        secrets: {
          R2_ACCESS_KEY_ID: "test-v2-access-key",
          R2_SECRET_ACCESS_KEY: "test-v2-secret-key",
          R2_ENDPOINT: V2_ENDPOINT,
        },
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", hubFetch);
    mock.signedFetch.mockResolvedValue(responseAt(
      `${V2_ENDPOINT}/jarvis-private-creation-assets-v2/${LOCATOR.assetLocator}`,
      new Uint8Array([0x76, 0x32]),
      { status: 200 },
    ));

    await expect(privateCreationAssetGet(LOCATOR)).resolves.toBeInstanceOf(Response);

    expect(hubFetch).toHaveBeenCalledTimes(1);
    const [url, init] = hubFetch.mock.calls[0];
    expect(String(url)).toBe(HUB_QUERY_URL);
    expect(JSON.parse(String(init?.body))).toEqual({
      path: "privateCreationAssetV2:credentials",
      args: { v2VaultToken: v2Token },
      format: "json",
    });
    expect(String(init?.body)).not.toContain(genericToken);
    expect(String(init?.body)).not.toContain("service");
    expect(mock.signedFetch).toHaveBeenCalledWith(
      `${V2_ENDPOINT}/jarvis-private-creation-assets-v2/${LOCATOR.assetLocator}`,
      expect.objectContaining({ method: "GET" }),
    );
    expect(mock.legacyGet).not.toHaveBeenCalled();
  });

  it("fails before either vault or signed-storage request when only the generic capability is configured", async () => {
    process.env.VAULT_ACCESS_TOKEN = "legacy-generic-bearer";
    const hubFetch = vi.fn();
    vi.stubGlobal("fetch", hubFetch);

    await expect(privateCreationAssetGet(LOCATOR)).rejects.toThrow("V2 vault capability is unavailable");

    expect(hubFetch).not.toHaveBeenCalled();
    expect(mock.signedFetch).not.toHaveBeenCalled();
    expect(mock.legacyGet).not.toHaveBeenCalled();
  });
});
