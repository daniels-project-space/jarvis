import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  adminSessionHash: vi.fn(),
  validateAdminSession: vi.fn(),
  controlQuery: vi.fn(),
  privateCreationAssetGet: vi.fn(),
}));

vi.mock("@/lib/control-session", () => ({
  adminSessionHash: mock.adminSessionHash,
  validateAdminSession: mock.validateAdminSession,
  controlQuery: mock.controlQuery,
}));
vi.mock("@/lib/private-creation-asset-store", () => ({ privateCreationAssetGet: mock.privateCreationAssetGet }));

import { GET } from "./route";

const OWNER = "a".repeat(64);
const media = {
  assetStore: "private-r2-v1" as const,
  assetLocator: "owners/daniel/creations/f47ac10b-58cc-4372-a567-0e02b2c3d479/asset",
  assetContentType: "image/png",
  title: "Launch image",
  kind: "image",
};

function request(query = "id=creation-1", headers: HeadersInit = {}) {
  return new NextRequest(`https://jarvis.example/api/creation-media?${query}`, { headers });
}

describe("private creation media", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.adminSessionHash.mockResolvedValue(OWNER);
    mock.validateAdminSession.mockResolvedValue(true);
    mock.controlQuery.mockResolvedValue(media);
    mock.privateCreationAssetGet.mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "image/svg+xml", "content-length": "3", "accept-ranges": "bytes" },
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("streams a private object only after owner authentication and media lookup", async () => {
    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(mock.controlQuery).toHaveBeenCalledWith("creations:getForMedia", { id: "creation-1", authTokenHash: OWNER });
    expect(mock.privateCreationAssetGet).toHaveBeenCalledWith({ assetStore: media.assetStore, assetLocator: media.assetLocator }, undefined);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("content-disposition")).toContain("inline");
    expect(response.headers.get("cache-control")).toContain("private");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    await expect(response.arrayBuffer()).resolves.toEqual(new Uint8Array([1, 2, 3]).buffer);
  });

  it("honours a valid range and only changes disposition when an explicit download is requested", async () => {
    mock.privateCreationAssetGet.mockResolvedValue(new Response(new Uint8Array([2]), {
      status: 206,
      headers: { "content-type": "image/png", "content-range": "bytes 1-1/3", "content-length": "1" },
    }));

    const response = await GET(request("id=creation-1&download=1", { range: "bytes=1-1" }));

    expect(response.status).toBe(206);
    expect(mock.privateCreationAssetGet).toHaveBeenCalledWith({ assetStore: media.assetStore, assetLocator: media.assetLocator }, "bytes=1-1");
    expect(response.headers.get("content-range")).toBe("bytes 1-1/3");
    expect(response.headers.get("content-disposition")).toContain("attachment");
  });

  it("proxies a trusted legacy object only through the authenticated media route", async () => {
    const legacyUrl = "https://pub-901f8094a6f04b32a784dc06cf3ebbc3.r2.dev/creations/2026-08/legacy.png";
    mock.controlQuery.mockResolvedValue({ legacyUrl, title: "Legacy image", kind: "image" });
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([4, 5]), {
      status: 200,
      headers: { "content-type": "image/png", "content-length": "2" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(request("id=legacy-1", { range: "bytes=0-1" }));

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(legacyUrl, {
      cache: "no-store",
      redirect: "error",
      headers: { range: "bytes=0-1" },
    });
    expect(mock.privateCreationAssetGet).not.toHaveBeenCalled();
    expect(response.headers.get("content-type")).toBe("image/png");
    await expect(response.arrayBuffer()).resolves.toEqual(new Uint8Array([4, 5]).buffer);
  });

  it("rejects malformed legacy ranges without fetching the historical object", async () => {
    const legacyUrl = "https://pub-901f8094a6f04b32a784dc06cf3ebbc3.r2.dev/creations/2026-08/legacy.png";
    mock.controlQuery.mockResolvedValue({ legacyUrl, title: "Legacy image", kind: "image" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(request("id=legacy-1", { range: "bytes=0-1,4-5" }));

    expect(response.status).toBe(416);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an oversized legacy object before returning its body", async () => {
    const legacyUrl = "https://pub-901f8094a6f04b32a784dc06cf3ebbc3.r2.dev/creations/2026-08/large.png";
    mock.controlQuery.mockResolvedValue({ legacyUrl, title: "Large legacy image", kind: "image" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Uint8Array([1]), {
      status: 200,
      headers: { "content-type": "image/png", "content-length": String(30 * 1024 * 1024 + 1) },
    })));

    const response = await GET(request("id=legacy-large"));

    expect(response.status).toBe(413);
    expect(mock.privateCreationAssetGet).not.toHaveBeenCalled();
  });

  it("fails closed without a media row and never asks storage for an arbitrary key", async () => {
    mock.controlQuery.mockResolvedValue(null);

    const response = await GET(request());

    expect(response.status).toBe(404);
    expect(mock.privateCreationAssetGet).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated media reads before querying Convex or R2", async () => {
    mock.adminSessionHash.mockResolvedValue(null);

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(mock.controlQuery).not.toHaveBeenCalled();
    expect(mock.privateCreationAssetGet).not.toHaveBeenCalled();
  });
});
