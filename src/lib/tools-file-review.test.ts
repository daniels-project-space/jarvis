import { beforeEach, describe, expect, it, vi } from "vitest";

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
  createGooglePrimaryCalendarEvent: vi.fn(), getManagedGooglePrimaryCalendarEvent: vi.fn(), listGooglePrimaryCalendarEvents: vi.fn(),
}));
vi.mock("./google-calendar-approval.server", () => ({
  issueGoogleCalendarApproval: vi.fn(),
  issueGoogleCalendarApprovalProposal: vi.fn(),
  googleCalendarApprovalMarker: (token: string) => `[JARVIS_GOOGLE_CALENDAR_APPROVAL:${token}]`,
}));

import { executeTool, TOOL_DEFS } from "./tools";

describe("review_uploaded_file tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.convexMutation.mockResolvedValue({ fileId: "file-1", reviewState: "favorite" });
  });

  it("uses only the exact current-message attachment mutation for a favourite", async () => {
    const definition = TOOL_DEFS.find((tool) => tool.name === "review_uploaded_file");
    expect(definition?.parameters).toMatchObject({
      required: ["file_id", "review_state"],
      properties: { review_state: { enum: ["unreviewed", "favorite", "review_remove"] } },
    });

    await expect(executeTool(
      "review_uploaded_file",
      { file_id: "file-1", review_state: "favorite" },
      { invocationContext: { userMessageId: "message-1" } },
    )).resolves.toContain("favourite");

    expect(mock.convexMutation).toHaveBeenCalledWith("files:setReviewStateForMessage", {
      messageId: "message-1",
      fileId: "file-1",
      reviewState: "favorite",
    });
  });

  it("fails closed without trusted current-message provenance or a valid state", async () => {
    await expect(executeTool("review_uploaded_file", {
      file_id: "file-1",
      review_state: "favorite",
    })).resolves.toContain("trusted current-message provenance");
    await expect(executeTool("review_uploaded_file", {
      file_id: "file-1",
      review_state: "delete",
    }, { invocationContext: { userMessageId: "message-1" } })).resolves.toContain("review_state must be");
    expect(mock.convexMutation).not.toHaveBeenCalled();
  });

  it("makes a removal-review result explicitly non-destructive", async () => {
    mock.convexMutation.mockResolvedValueOnce({ fileId: "file-1", reviewState: "review_remove" });

    await expect(executeTool(
      "review_uploaded_file",
      { file_id: "file-1", review_state: "review_remove" },
      { invocationContext: { userMessageId: "message-1" } },
    )).resolves.toContain("Nothing was deleted");
    expect(mock.convexMutation.mock.calls.map(([path]) => path)).toEqual(["files:setReviewStateForMessage"]);
  });

  it("does not claim success when the attachment-scoped mutation rejects the file", async () => {
    mock.convexMutation.mockResolvedValueOnce(null);

    await expect(executeTool(
      "review_uploaded_file",
      { file_id: "unrelated-file", review_state: "favorite" },
      { invocationContext: { userMessageId: "message-1" } },
    )).resolves.toContain("not attached to this message");
  });
});
