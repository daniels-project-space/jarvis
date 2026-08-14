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
  key: "owners/daniel/creations/f47ac10b-58cc-4372-a567-0e02b2c3d479/asset",
  contentType: "image/webp",
};
const pdfAsset = {
  key: "owners/daniel/creations/570df4a2-8870-4fe1-a4cf-6d32ccf758e1/asset",
  contentType: "application/pdf",
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
    }));
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

  it("cleans up a generated image and withholds its card when creation persistence fails", async () => {
    mock.convexMutation.mockImplementation(async (name: string) => {
      if (name === "creations:create") throw new Error("Convex unavailable");
      return undefined;
    });

    await expect(createGeneratedImage()).resolves.toContain("could not be saved");

    expect(mock.deletePrivateCreationAsset).toHaveBeenCalledWith(imageAsset);
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
    }));
    expect(mock.convexMutation).toHaveBeenCalledWith("chatQueue:postCard", {
      threadId: "main",
      type: "image",
      value: "/api/creation-media?id=stored%2Fcreation%201&variant=asset",
      title: "Reference image",
      downloadUrl: "/api/creation-download?id=stored%2Fcreation%201",
    });
  });

  it("cleans up a stored image and withholds its card when creation persistence fails", async () => {
    mock.convexMutation.mockImplementation(async (name: string) => {
      if (name === "creations:create") throw new Error("Convex unavailable");
      return undefined;
    });

    await expect(executeTool("store_image", { title: "Reference image", url: "https://source.example/reference.webp" }))
      .resolves.toContain("could not be saved");

    expect(mock.deletePrivateCreationAsset).toHaveBeenCalledWith(imageAsset);
    expect(mock.convexMutation).not.toHaveBeenCalledWith("chatQueue:postCard", expect.anything());
  });

  it("does not claim a stored image when persistence returns no creation receipt", async () => {
    mock.convexMutation.mockResolvedValue(undefined);

    await expect(executeTool("store_image", { title: "Reference image", url: "https://source.example/reference.webp" }))
      .resolves.toContain("could not be saved");

    expect(mock.deletePrivateCreationAsset).toHaveBeenCalledWith(imageAsset);
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
    }));
    expect(mock.convexMutation).toHaveBeenCalledWith("chatQueue:postCard", {
      threadId: "main",
      type: "pdf",
      value: "/api/creation-media?id=pdf%2Fcreation%201&variant=asset",
      title: "Travel plan.pdf",
      downloadUrl: "/api/creation-download?id=pdf%2Fcreation%201",
    });
  });

  it("cleans up a rendered PDF and withholds its card when creation persistence fails", async () => {
    mock.convexMutation.mockImplementation(async (name: string) => {
      if (name === "creations:create") throw new Error("Convex unavailable");
      return undefined;
    });

    await expect(executeTool("create_pdf", { title: "Travel plan", markdown: "# Seville" }))
      .resolves.toContain("could not be saved");

    expect(mock.deletePrivateCreationAsset).toHaveBeenCalledWith(pdfAsset);
    expect(mock.convexMutation).not.toHaveBeenCalledWith("ui:setPanel", expect.anything());
    expect(mock.convexMutation).not.toHaveBeenCalledWith("chatQueue:postCard", expect.anything());
  });
});
