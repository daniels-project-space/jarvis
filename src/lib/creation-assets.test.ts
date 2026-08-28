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

  it("accepts a server-minted opaque asset id so a durable write intent can reserve the exact R2 key first", async () => {
    const assetId = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
    const asset = await putPrivateCreationAsset(new Uint8Array([1, 2, 3]), "image/png", "asset", assetId);

    expect(asset).toEqual({
      key: `owners/daniel/creations/${assetId}/asset`,
      contentType: "image/png",
    });
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
    expect(mock.privateR2Put).toHaveBeenCalledWith(asset.key, expect.any(Uint8Array), "image/png");
  });

  it("renews only at the private R2 boundary, after a provider download has completed", async () => {
    const order: string[] = [];
    const fetchMock = vi.fn().mockImplementation(async () => {
      order.push("source-fetch");
      return new Response(new Uint8Array([9, 8, 7]), {
        status: 200,
        headers: { "content-type": "image/png", "content-length": "3" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    mock.privateR2Put.mockImplementation(async () => {
      order.push("r2-put");
      return { etag: "asset-etag" };
    });
    const beforeR2Write = vi.fn(async () => {
      order.push("renew");
    });

    await storePrivateCreationAssetFromUrl(
      "https://provider.example/result.png",
      "asset",
      "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      { beforeR2Write },
    );

    expect(order).toEqual(["source-fetch", "renew", "r2-put"]);
    expect(mock.privateR2Put).toHaveBeenCalledWith(
      "owners/daniel/creations/f47ac10b-58cc-4372-a567-0e02b2c3d479/asset",
      expect.any(Uint8Array),
      "image/png",
    );
  });

  it("does not begin a private R2 PUT when the durable writer renewal fails", async () => {
    const renewalError = new Error("writer lease expired");

    await expect(putPrivateCreationAsset(
      new Uint8Array([1]),
      "image/png",
      "asset",
      "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      { beforeR2Write: async () => { throw renewalError; } },
    )).rejects.toThrow("writer lease expired");
    expect(mock.privateR2Put).not.toHaveBeenCalled();
  });

  it("stops an oversized chunked response before buffering or storing it", async () => {
    const tooLargeStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(16 * 1024 * 1024));
        controller.enqueue(new Uint8Array(16 * 1024 * 1024));
        controller.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(tooLargeStream, {
      status: 200,
      headers: { "content-type": "image/png" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(storePrivateCreationAssetFromUrl("https://provider.example/chunked.png")).rejects.toThrow("creation asset too large (30MB cap)");

    expect(mock.privateR2Put).not.toHaveBeenCalled();
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
