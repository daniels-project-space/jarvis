import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mock = vi.hoisted(() => ({
  convexMutation: vi.fn(),
  convexQuery: vi.fn(),
  getSecret: vi.fn(),
  r2DeleteFreshCreation: vi.fn(),
  r2Put: vi.fn(),
  r2StoreFromUrl: vi.fn(),
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
vi.mock("./r2", () => ({
  r2DeleteFreshCreation: mock.r2DeleteFreshCreation,
  r2Put: mock.r2Put,
  r2StoreFromUrl: mock.r2StoreFromUrl,
}));
vi.mock("./pdf", () => ({ markdownToPdf: mock.markdownToPdf }));
vi.mock("./booking-email", () => ({
  lookupGmailBookingsReadOnly: vi.fn(), scanGmailBookingConfirmations: vi.fn(),
}));
vi.mock("./icloud-calendar", () => ({
  createICloudEvent: vi.fn(), deleteICloudEvent: vi.fn(), findICloudEvents: vi.fn(), listICloudEvents: vi.fn(),
}));
vi.mock("./google-calendar", () => ({
  createGooglePrimaryCalendarEvent: vi.fn(), listGooglePrimaryCalendarEvents: vi.fn(),
}));
vi.mock("./google-calendar-approval.server", () => ({
  issueGoogleCalendarApproval: vi.fn(),
  googleCalendarApprovalMarker: (token: string) => `[JARVIS_GOOGLE_CALENDAR_APPROVAL:${token}]`,
}));

import { executeTool } from "./tools";

const imageUrl = "https://pub.example/creations/test-image.webp";
const pdfUrl = "https://pub.example/creations/test-document.pdf";

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
    mock.r2StoreFromUrl.mockResolvedValue({ url: imageUrl, contentType: "image/webp" });
    mock.r2Put.mockResolvedValue(pdfUrl);
    mock.r2DeleteFreshCreation.mockResolvedValue(undefined);
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
      kind: "image", title: "Mood board", url: imageUrl, thumb: imageUrl,
    }));
    expect(mock.convexMutation).toHaveBeenCalledWith("chatQueue:postCard", {
      threadId: "main",
      type: "image",
      value: imageUrl,
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

    expect(mock.r2DeleteFreshCreation).toHaveBeenCalledWith(imageUrl);
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
      kind: "image", title: "Reference image", url: imageUrl, thumb: imageUrl,
    }));
    expect(mock.convexMutation).toHaveBeenCalledWith("chatQueue:postCard", {
      threadId: "main",
      type: "image",
      value: imageUrl,
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

    expect(mock.r2DeleteFreshCreation).toHaveBeenCalledWith(imageUrl);
    expect(mock.convexMutation).not.toHaveBeenCalledWith("chatQueue:postCard", expect.anything());
  });

  it("does not claim a stored image when persistence returns no creation receipt", async () => {
    mock.convexMutation.mockResolvedValue(undefined);

    await expect(executeTool("store_image", { title: "Reference image", url: "https://source.example/reference.webp" }))
      .resolves.toContain("could not be saved");

    expect(mock.r2DeleteFreshCreation).toHaveBeenCalledWith(imageUrl);
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
      kind: "pdf", title: "Travel plan", url: pdfUrl,
    }));
    expect(mock.convexMutation).toHaveBeenCalledWith("chatQueue:postCard", {
      threadId: "main",
      type: "pdf",
      value: pdfUrl,
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

    expect(mock.r2DeleteFreshCreation).toHaveBeenCalledWith(pdfUrl);
    expect(mock.convexMutation).not.toHaveBeenCalledWith("ui:setPanel", expect.anything());
    expect(mock.convexMutation).not.toHaveBeenCalledWith("chatQueue:postCard", expect.anything());
  });
});
