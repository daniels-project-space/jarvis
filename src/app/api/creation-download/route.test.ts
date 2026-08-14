import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  adminSessionHash: vi.fn(),
  validateAdminSession: vi.fn(),
  controlQuery: vi.fn(),
  privateR2Get: vi.fn(),
  markdownToPdf: vi.fn(),
}));

vi.mock("@/lib/control-session", () => ({
  adminSessionHash: mock.adminSessionHash,
  validateAdminSession: mock.validateAdminSession,
  controlQuery: mock.controlQuery,
}));
vi.mock("@/lib/private-r2", () => ({ privateR2Get: mock.privateR2Get }));
vi.mock("@/lib/pdf", () => ({ markdownToPdf: mock.markdownToPdf }));

import { GET } from "./route";

const OWNER = "a".repeat(64);
const privateRow = {
  _id: "creation-1",
  kind: "image",
  title: "Private image",
  hasPrivateAsset: true,
};
const privateMedia = {
  assetR2Key: "owners/daniel/creations/f47ac10b-58cc-4372-a567-0e02b2c3d479/asset",
  assetContentType: "image/png",
  title: "Private image",
  kind: "image",
};

function request(id = "creation-1") {
  return new NextRequest(`https://jarvis.example/api/creation-download?id=${id}`);
}

describe("creation downloads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.adminSessionHash.mockResolvedValue(OWNER);
    mock.validateAdminSession.mockResolvedValue(true);
    mock.controlQuery.mockImplementation(async (path: string) => {
      if (path === "creations:get") return privateRow;
      if (path === "creations:getForMedia") return privateMedia;
      return null;
    });
    mock.privateR2Get.mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "image/png" },
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("downloads private assets through the private key lookup without fetching a public URL", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(mock.controlQuery).toHaveBeenNthCalledWith(1, "creations:get", { id: "creation-1", authTokenHash: OWNER });
    expect(mock.controlQuery).toHaveBeenNthCalledWith(2, "creations:getForMedia", { id: "creation-1", authTokenHash: OWNER });
    expect(mock.privateR2Get).toHaveBeenCalledWith(privateMedia.assetR2Key);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(response.headers.get("content-type")).toBe("image/png");
  });

  it("only fetches legacy assets from the historical Jarvis public origin", async () => {
    const legacyRow = {
      _id: "legacy-1",
      kind: "pdf",
      title: "Legacy plan",
      url: "https://pub-901f8094a6f04b32a784dc06cf3ebbc3.r2.dev/creations/2026-08/plan.pdf",
    };
    mock.controlQuery.mockResolvedValue(legacyRow);
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([9]), {
      status: 200,
      headers: { "content-type": "application/pdf" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(request("legacy-1"));

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(legacyRow.url, { cache: "no-store", redirect: "error" });
    expect(response.headers.get("content-type")).toBe("application/pdf");
  });

  it("does not turn an arbitrary legacy URL into a server-side fetch", async () => {
    mock.controlQuery.mockResolvedValue({
      _id: "unsafe-1",
      kind: "image",
      title: "Unsafe",
      url: "https://internal.example/metadata",
      data: "saved fallback",
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(request("unsafe-1"));

    expect(response.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("rejects unauthenticated downloads before querying records or storage", async () => {
    mock.adminSessionHash.mockResolvedValue(null);

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(mock.controlQuery).not.toHaveBeenCalled();
    expect(mock.privateR2Get).not.toHaveBeenCalled();
  });
});
