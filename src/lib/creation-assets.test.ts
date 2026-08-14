import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mock = vi.hoisted(() => ({
  privateCreationObjectKey: vi.fn(),
  privateR2Delete: vi.fn(),
  privateR2Put: vi.fn(),
}));

vi.mock("./private-r2", () => ({
  privateCreationObjectKey: mock.privateCreationObjectKey,
  privateR2Delete: mock.privateR2Delete,
  privateR2Put: mock.privateR2Put,
}));

import {
  creationMediaUrl,
  deletePrivateCreationAsset,
  putPrivateCreationAsset,
  storePrivateCreationAssetFromUrl,
} from "./creation-assets";

describe("private creation assets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.privateCreationObjectKey.mockImplementation((id: string, purpose: string) => `owners/daniel/creations/${id}/${purpose}`);
    mock.privateR2Put.mockResolvedValue({ etag: "asset-etag" });
    mock.privateR2Delete.mockResolvedValue(undefined);
  });

  it("stores opaque assets without deriving a public URL from their title", async () => {
    const asset = await putPrivateCreationAsset(new Uint8Array([1, 2, 3]), "image/WEBP; charset=binary");

    expect(asset).toMatchObject({ contentType: "image/webp" });
    expect(asset.key).toMatch(/^owners\/daniel\/creations\/[0-9a-f-]{36}\/asset$/i);
    expect(asset.key).not.toContain("title");
    expect(mock.privateR2Put).toHaveBeenCalledWith(asset.key, expect.any(Uint8Array), "image/webp");
  });

  it("re-homes a bounded remote result without retaining its source URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([9, 8, 7]), {
      status: 200,
      headers: { "content-type": "image/png", "content-length": "3" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const asset = await storePrivateCreationAssetFromUrl("https://provider.example/result.png", "thumb");

    expect(fetchMock).toHaveBeenCalledWith(new URL("https://provider.example/result.png"), { cache: "no-store", redirect: "error" });
    expect(asset.key).toMatch(/\/thumb$/);
    expect(mock.privateR2Put).toHaveBeenCalledWith(asset.key, expect.any(ArrayBuffer), "image/png");
  });

  it("rejects credentialed or non-HTTP source URLs before fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(storePrivateCreationAssetFromUrl("file:///private.png")).rejects.toThrow("credential-free HTTP(S)");
    await expect(storePrivateCreationAssetFromUrl("https://token@provider.example/private.png")).rejects.toThrow("credential-free HTTP(S)");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses a first-party media route and delegates deletion to strict private R2", async () => {
    expect(creationMediaUrl("creation/one", "thumb")).toBe("/api/creation-media?id=creation%2Fone&variant=thumb");
    await deletePrivateCreationAsset({ key: "owners/daniel/creations/f47ac10b-58cc-4372-a567-0e02b2c3d479/asset", contentType: "image/png" });
    expect(mock.privateR2Delete).toHaveBeenCalledWith("owners/daniel/creations/f47ac10b-58cc-4372-a567-0e02b2c3d479/asset");
  });
});
