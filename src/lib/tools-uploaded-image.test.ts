import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mock = vi.hoisted(() => ({
  convexMutation: vi.fn(),
  convexQuery: vi.fn(),
}));

vi.mock("./context", () => ({
  convexMutation: mock.convexMutation,
  convexQuery: mock.convexQuery,
}));
vi.mock("./control-context", () => ({
  withAdminSession: async (_authTokenHash: unknown, operation: () => Promise<unknown>) => await operation(),
}));
vi.mock("./vault", () => ({ getSecret: vi.fn(), getServiceSecrets: vi.fn() }));
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

import { executeTool, TOOL_DEFS } from "./tools";

const readyImage = {
  _id: "file/one",
  originalName: "sunrise.webp",
  status: "ready",
  detectedMimeType: "image/webp",
  r2Key: "owners/daniel/private/never-expose-me",
};

describe("show_uploaded_image tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.convexQuery.mockImplementation(async (path: string) =>
      path === "files:getForOwner" ? readyImage : "thread-main",
    );
    mock.convexMutation.mockResolvedValue(undefined);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("shows only a ready detected image through the authenticated file route and posts a download card", async () => {
    expect(TOOL_DEFS.some((definition) => definition.name === "show_uploaded_image")).toBe(true);

    await expect(executeTool("show_uploaded_image", { file_id: "file/one" }))
      .resolves.toContain("owner-authenticated download card");

    const fileUrl = "/api/files/file%2Fone";
    expect(mock.convexMutation).toHaveBeenCalledWith("ui:setPanel", {
      type: "image",
      value: fileUrl,
      title: "sunrise.webp",
    });
    expect(mock.convexMutation).toHaveBeenCalledWith("chatQueue:postCard", {
      threadId: "thread-main",
      type: "image",
      value: fileUrl,
      title: "sunrise.webp",
      downloadUrl: `${fileUrl}?download=1`,
    });
    expect(JSON.stringify(mock.convexMutation.mock.calls)).not.toContain(readyImage.r2Key);
  });

  it.each(["image/jpeg", "image/png", "image/webp"])("allows ready %s uploads", async (detectedMimeType) => {
    mock.convexQuery.mockImplementation(async (path: string) =>
      path === "files:getForOwner" ? { ...readyImage, detectedMimeType } : "thread-main",
    );

    await expect(executeTool("show_uploaded_image", { file_id: "file/one" }))
      .resolves.toContain("owner-authenticated download card");
  });

  it.each([
    [{ ...readyImage, status: "stored_only" }, "stored-only"],
    [{ ...readyImage, status: "processing" }, "not ready for image display"],
    [{ ...readyImage, detectedMimeType: "application/pdf" }, "not a safely detected JPEG, PNG, or WebP"],
    [{ ...readyImage, detectedMimeType: undefined, mimeType: "image/jpeg" }, "not a safely detected JPEG, PNG, or WebP"],
  ])("refuses unsafe or unavailable image state %#", async (file, expected) => {
    mock.convexQuery.mockImplementation(async (path: string) =>
      path === "files:getForOwner" ? file : "thread-main",
    );

    await expect(executeTool("show_uploaded_image", { file_id: "file/one" })).resolves.toContain(expected);
    expect(mock.convexMutation).not.toHaveBeenCalled();
  });

  it("rejects deleted or missing file records before a panel or card can be created", async () => {
    mock.convexQuery.mockImplementation(async (path: string) =>
      path === "files:getForOwner" ? { ...readyImage, status: "deleted" } : "thread-main",
    );
    await expect(executeTool("show_uploaded_image", { file_id: "file/one" })).resolves.toContain("not available");
    expect(mock.convexMutation).not.toHaveBeenCalled();

    mock.convexQuery.mockImplementation(async (path: string) =>
      path === "files:getForOwner" ? null : "thread-main",
    );
    await expect(executeTool("show_uploaded_image", { file_id: "file/one" })).resolves.toContain("not available");
    expect(mock.convexMutation).not.toHaveBeenCalled();
  });

  it("does not claim both surfaces succeeded when panel or card persistence fails", async () => {
    mock.convexMutation.mockImplementation(async (path: string) => {
      if (path === "ui:setPanel" || path === "chatQueue:postCard") throw new Error("temporary failure");
    });

    await expect(executeTool("show_uploaded_image", { file_id: "file/one" }))
      .resolves.toContain("could not be shown on screen, and its authenticated download card could not be posted");
  });
});
