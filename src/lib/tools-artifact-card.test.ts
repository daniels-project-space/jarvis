import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mock = vi.hoisted(() => ({
  convexMutation: vi.fn(),
  convexQuery: vi.fn(),
  getSecret: vi.fn(),
  deletePrivateCreationAsset: vi.fn(),
  putPrivateCreationAsset: vi.fn(),
  storePrivateCreationAssetFromUrl: vi.fn(),
  creationMediaUrl: vi.fn(),
  markdownToPdf: vi.fn(),
  writePrivateCreationAssetWithRecord: vi.fn(),
}));

vi.mock("./context", () => ({
  convexMutation: mock.convexMutation,
  convexQuery: mock.convexQuery,
}));
vi.mock("./control-context", () => ({
  withAdminSession: async (_authTokenHash: unknown, operation: () => Promise<unknown>) => await operation(),
}));
vi.mock("./vault", () => ({ getSecret: mock.getSecret, getServiceSecrets: vi.fn() }));
vi.mock("./creation-assets", () => ({
  deletePrivateCreationAsset: mock.deletePrivateCreationAsset,
  putPrivateCreationAsset: mock.putPrivateCreationAsset,
  storePrivateCreationAssetFromUrl: mock.storePrivateCreationAssetFromUrl,
  creationMediaUrl: mock.creationMediaUrl,
}));
vi.mock("./private-creation-asset-write", () => ({
  writePrivateCreationAssetWithRecord: mock.writePrivateCreationAssetWithRecord,
}));
vi.mock("./pdf", () => ({ markdownToPdf: mock.markdownToPdf }));
vi.mock("./booking-email", () => ({
  lookupGmailBookingsReadOnly: vi.fn(), scanGmailBookingConfirmations: vi.fn(),
}));
vi.mock("./icloud-calendar", () => ({
  createICloudEvent: vi.fn(), deleteICloudEvent: vi.fn(), findICloudEvents: vi.fn(), listICloudEvents: vi.fn(),
}));
vi.mock("./google-calendar", () => ({
  createGooglePrimaryCalendarEvent: vi.fn(), getManagedGooglePrimaryCalendarEvent: vi.fn(), listGooglePrimaryCalendarEvents: vi.fn(),
}));
vi.mock("./google-calendar-approval.server", () => ({
  issueGoogleCalendarApproval: vi.fn(),
  issueGoogleCalendarApprovalProposal: vi.fn(),
  googleCalendarApprovalMarker: (token: string) => `[JARVIS_GOOGLE_CALENDAR_APPROVAL:${token}]`,
}));

import { executeTool } from "./tools";

const imageAsset = {
  assetStore: "private-r2-v1" as const,
  assetLocator: "owners/daniel/creations/f47ac10b-58cc-4372-a567-0e02b2c3d479/asset",
  key: "owners/daniel/creations/f47ac10b-58cc-4372-a567-0e02b2c3d479/asset",
  contentType: "image/webp",
};
const pdfAsset = {
  assetStore: "private-r2-v1" as const,
  assetLocator: "owners/daniel/creations/570df4a2-8870-4fe1-a4cf-6d32ccf758e1/asset",
  key: "owners/daniel/creations/570df4a2-8870-4fe1-a4cf-6d32ccf758e1/asset",
  contentType: "application/pdf",
};
const mindMapAsset = {
  assetStore: "private-r2-v1" as const,
  assetLocator: "owners/daniel/creations/e01d4985-5aa4-4caa-b460-842871de3f84/asset",
  key: "owners/daniel/creations/e01d4985-5aa4-4caa-b460-842871de3f84/asset",
  contentType: "image/svg+xml",
};

function mockNovitaSuccess() {
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce(Response.json({ task_id: "novita-task" }))
    .mockResolvedValueOnce(Response.json({
      task: { status: "TASK_STATUS_SUCCEED" },
      images: [{ image_url: "https://provider.example/generated.png" }],
    })));
}

async function createGeneratedImage() {
  vi.useFakeTimers();
  const result = executeTool("create_image", { title: "Mood board", prompt: "a cyan cockpit" });
  await vi.advanceTimersByTimeAsync(1_000);
  return await result;
}

describe("created artifact download cards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.getSecret.mockResolvedValue("test-novita-key");
    mock.convexQuery.mockResolvedValue("main");
    mock.storePrivateCreationAssetFromUrl.mockResolvedValue(imageAsset);
    mock.putPrivateCreationAsset.mockResolvedValue(pdfAsset);
    mock.deletePrivateCreationAsset.mockResolvedValue(undefined);
    mock.creationMediaUrl.mockImplementation((id: string) => `/api/creation-media?id=${encodeURIComponent(id)}&variant=asset`);
    mock.markdownToPdf.mockResolvedValue(new Uint8Array([37, 80, 68, 70]));
    mock.writePrivateCreationAssetWithRecord.mockImplementation(async ({ writeAsset, persistCreation }: any) => {
      let asset: any;
      try {
        asset = await writeAsset("f47ac10b-58cc-4372-a567-0e02b2c3d479", async () => new AbortController().signal);
        const creationId = await persistCreation(asset, "817fcdd9-43d8-46f7-bc89-5205af27d284");
        if (typeof creationId !== "string" || !creationId) throw new Error("creation persistence returned no id");
        return { ok: true, asset, creationId, recovered: false };
      } catch (error) {
        return { ok: false, stage: asset ? "creation_unverified" : "asset_write", error };
      }
    });
    mock.convexMutation.mockImplementation(async (name: string) => {
      if (name === "creations:create") return "creation-default";
      return undefined;
    });
    mockNovitaSuccess();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("posts a generated image with its authenticated creation download link", async () => {
    mock.convexMutation.mockImplementation(async (name: string) => {
      if (name === "creations:create") return "image/creation 1";
      return undefined;
    });

    await expect(createGeneratedImage()).resolves.toContain("secure download card");

    expect(mock.convexMutation).toHaveBeenCalledWith("creations:create", expect.objectContaining({
      kind: "image", title: "Mood board", assetR2Key: imageAsset.key, assetContentType: imageAsset.contentType,
      assetWriteEpoch: "817fcdd9-43d8-46f7-bc89-5205af27d284",
    }));
    expect(mock.storePrivateCreationAssetFromUrl).toHaveBeenCalledWith(
      "https://provider.example/generated.png", "asset", expect.any(String), { beforeR2Write: expect.any(Function) },
    );
    const creationCall = mock.convexMutation.mock.calls.find(([path]) => path === "creations:create")?.[1];
    expect(creationCall).not.toHaveProperty("url");
    expect(mock.convexMutation).toHaveBeenCalledWith("chatQueue:postCard", {
      threadId: "main",
      type: "image",
      value: "/api/creation-media?id=image%2Fcreation%201&variant=asset",
      title: "Mood board",
      downloadUrl: "/api/creation-download?id=image%2Fcreation%201",
    });
  });

  it("fences a generated image and withholds its card when creation persistence is ambiguous", async () => {
    mock.convexMutation.mockImplementation(async (name: string) => {
      if (name === "creations:create") throw new Error("Convex unavailable");
      return undefined;
    });

    await expect(createGeneratedImage()).resolves.toContain("could not be verified");

    expect(mock.writePrivateCreationAssetWithRecord).toHaveBeenCalledTimes(1);
    expect(mock.deletePrivateCreationAsset).not.toHaveBeenCalled();
    expect(mock.convexMutation).not.toHaveBeenCalledWith("ui:setPanel", expect.anything());
    expect(mock.convexMutation).not.toHaveBeenCalledWith("chatQueue:postCard", expect.anything());
  });

  it("posts a stored image with its authenticated creation download link", async () => {
    mock.convexMutation.mockImplementation(async (name: string) => {
      if (name === "creations:create") return "stored/creation 1";
      return undefined;
    });

    await expect(executeTool("store_image", { title: "Reference image", url: "https://source.example/reference.webp" }))
      .resolves.toContain("secure download card");

    expect(mock.convexMutation).toHaveBeenCalledWith("creations:create", expect.objectContaining({
      kind: "image", title: "Reference image", assetR2Key: imageAsset.key, assetContentType: imageAsset.contentType,
      assetWriteEpoch: "817fcdd9-43d8-46f7-bc89-5205af27d284",
    }));
    expect(mock.storePrivateCreationAssetFromUrl).toHaveBeenCalledWith(
      "https://source.example/reference.webp", "asset", expect.any(String), { beforeR2Write: expect.any(Function) },
    );
    expect(mock.convexMutation).toHaveBeenCalledWith("chatQueue:postCard", {
      threadId: "main",
      type: "image",
      value: "/api/creation-media?id=stored%2Fcreation%201&variant=asset",
      title: "Reference image",
      downloadUrl: "/api/creation-download?id=stored%2Fcreation%201",
    });
  });

  it("fences a stored image and withholds its card when creation persistence is ambiguous", async () => {
    mock.convexMutation.mockImplementation(async (name: string) => {
      if (name === "creations:create") throw new Error("Convex unavailable");
      return undefined;
    });

    await expect(executeTool("store_image", { title: "Reference image", url: "https://source.example/reference.webp" }))
      .resolves.toContain("could not be verified");

    expect(mock.deletePrivateCreationAsset).not.toHaveBeenCalled();
    expect(mock.convexMutation).not.toHaveBeenCalledWith("chatQueue:postCard", expect.anything());
  });

  it("does not claim a stored image when persistence returns no creation receipt", async () => {
    mock.convexMutation.mockResolvedValue(undefined);

    await expect(executeTool("store_image", { title: "Reference image", url: "https://source.example/reference.webp" }))
      .resolves.toContain("could not be verified");

    expect(mock.deletePrivateCreationAsset).not.toHaveBeenCalled();
    expect(mock.convexMutation).not.toHaveBeenCalledWith("chatQueue:postCard", expect.anything());
  });

  it("posts a rendered PDF with its authenticated creation download link", async () => {
    mock.convexMutation.mockImplementation(async (name: string) => {
      if (name === "creations:create") return "pdf/creation 1";
      return undefined;
    });

    await expect(executeTool("create_pdf", { title: "Travel plan", markdown: "# Seville" }))
      .resolves.toContain("secure download card");

    expect(mock.convexMutation).toHaveBeenCalledWith("creations:create", expect.objectContaining({
      kind: "pdf", title: "Travel plan", assetR2Key: pdfAsset.key, assetContentType: pdfAsset.contentType,
      assetWriteEpoch: "817fcdd9-43d8-46f7-bc89-5205af27d284",
    }));
    expect(mock.putPrivateCreationAsset).toHaveBeenCalledWith(
      expect.any(Uint8Array), "application/pdf", "asset", expect.any(String), { beforeR2Write: expect.any(Function) },
    );
    expect(mock.convexMutation).toHaveBeenCalledWith("chatQueue:postCard", {
      threadId: "main",
      type: "pdf",
      value: "/api/creation-media?id=pdf%2Fcreation%201&variant=asset",
      title: "Travel plan.pdf",
      downloadUrl: "/api/creation-download?id=pdf%2Fcreation%201",
    });
  });

  it("posts a private mind-map image snapshot with a separate authenticated download", async () => {
    let creationCount = 0;
    mock.putPrivateCreationAsset.mockResolvedValue(mindMapAsset);
    mock.convexMutation.mockImplementation(async (name: string) => {
      if (name !== "creations:create") return undefined;
      creationCount += 1;
      return creationCount === 1 ? "mind-map/canvas 1" : "mind-map/image 1";
    });

    await expect(executeTool("mind_map", {
      action: "create",
      title: "Seville days",
      nodes: [{ id: "base", label: "Booked stay", color: "blue" }, { id: "food", label: "Tapas", parent: "base" }],
      edges: [{ from: "base", to: "food" }],
    })).resolves.toContain("secure download card");

    expect(mock.putPrivateCreationAsset).toHaveBeenCalledWith(
      expect.stringContaining("<svg"), "image/svg+xml", "asset", expect.any(String),
      { beforeR2Write: expect.any(Function) },
    );
    const creationCalls = mock.convexMutation.mock.calls.filter(([path]) => path === "creations:create");
    expect(creationCalls[0]?.[1]).toMatchObject({ kind: "canvas", title: "Seville days" });
    expect(creationCalls[1]?.[1]).toMatchObject({
      kind: "image",
      title: "Seville days · mind map",
      assetR2Key: mindMapAsset.key,
      assetContentType: "image/svg+xml",
      assetWriteEpoch: "817fcdd9-43d8-46f7-bc89-5205af27d284",
      data: JSON.stringify({ sourceCreationId: "mind-map/canvas 1", format: "svg", type: "mind_map_snapshot" }),
    });
    expect(creationCalls[1]?.[1]).not.toHaveProperty("url");
    expect(mock.convexMutation).toHaveBeenCalledWith("chatQueue:postCard", {
      threadId: "main",
      type: "image",
      value: "/api/creation-media?id=mind-map%2Fimage%201&variant=asset",
      title: "Seville days · mind map.svg",
      downloadUrl: "/api/creation-download?id=mind-map%2Fimage%201",
    });
  });

  it("fences a mind-map snapshot and withholds its card when artifact persistence is ambiguous", async () => {
    let creationCount = 0;
    mock.putPrivateCreationAsset.mockResolvedValue(mindMapAsset);
    mock.convexMutation.mockImplementation(async (name: string) => {
      if (name !== "creations:create") return undefined;
      creationCount += 1;
      if (creationCount === 1) return "mind-map/canvas 1";
      throw new Error("Convex unavailable");
    });

    await expect(executeTool("mind_map", {
      action: "create",
      title: "Seville days",
      nodes: [{ id: "base", label: "Booked stay" }],
    })).resolves.toContain("image snapshot could not be verified");

    expect(mock.deletePrivateCreationAsset).not.toHaveBeenCalled();
    expect(mock.convexMutation).not.toHaveBeenCalledWith("chatQueue:postCard", expect.anything());
  });

  it("still creates and posts the mind-map snapshot if the live canvas panel is temporarily unavailable", async () => {
    let creationCount = 0;
    mock.putPrivateCreationAsset.mockResolvedValue(mindMapAsset);
    mock.convexMutation.mockImplementation(async (name: string) => {
      if (name === "ui:setPanel") throw new Error("panel unavailable");
      if (name !== "creations:create") return undefined;
      creationCount += 1;
      return creationCount === 1 ? "mind-map/canvas 1" : "mind-map/image 1";
    });

    await expect(executeTool("mind_map", {
      action: "create",
      title: "Seville days",
      nodes: [{ id: "base", label: "Booked stay" }],
    })).resolves.toContain("live panel could not be shown");

    expect(mock.convexMutation).toHaveBeenCalledWith("chatQueue:postCard", expect.objectContaining({
      value: "/api/creation-media?id=mind-map%2Fimage%201&variant=asset",
      downloadUrl: "/api/creation-download?id=mind-map%2Fimage%201",
    }));
  });

  it("fences a rendered PDF and withholds its card when creation persistence is ambiguous", async () => {
    mock.convexMutation.mockImplementation(async (name: string) => {
      if (name === "creations:create") throw new Error("Convex unavailable");
      return undefined;
    });

    await expect(executeTool("create_pdf", { title: "Travel plan", markdown: "# Seville" }))
      .resolves.toContain("could not be verified");

    expect(mock.deletePrivateCreationAsset).not.toHaveBeenCalled();
    expect(mock.convexMutation).not.toHaveBeenCalledWith("ui:setPanel", expect.anything());
    expect(mock.convexMutation).not.toHaveBeenCalledWith("chatQueue:postCard", expect.anything());
  });
});
