import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mock = vi.hoisted(() => ({
  convexMutation: vi.fn(),
  convexQuery: vi.fn(),
  gmailUnsubscribe: vi.fn(),
  gmailMarkSpam: vi.fn(),
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
vi.mock("./gmail", () => ({
  gmailSearch: vi.fn(),
  gmailReadMessage: vi.fn(),
  gmailCreateDraft: vi.fn(),
  gmailListLikelySubscriptions: vi.fn(),
  gmailUnsubscribe: mock.gmailUnsubscribe,
  gmailMarkSpam: mock.gmailMarkSpam,
}));

import { executeTool, TOOL_DEFS } from "./tools";

describe("Gmail destructive action boundary", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not expose or execute unsubscribe and spam mutations from model arguments", async () => {
    expect(TOOL_DEFS.some((tool) => tool.name === "gmail_unsubscribe")).toBe(false);
    expect(TOOL_DEFS.some((tool) => tool.name === "gmail_mark_spam")).toBe(false);

    await expect(executeTool("gmail_unsubscribe", { message_id: "msg-1", confirmed: true }))
      .resolves.toContain("host-mediated owner-approval receipt");
    await expect(executeTool("gmail_mark_spam", { message_id: "msg-2", confirmed: true }))
      .resolves.toContain("host-mediated owner-approval receipt");

    expect(mock.gmailUnsubscribe).not.toHaveBeenCalled();
    expect(mock.gmailMarkSpam).not.toHaveBeenCalled();
  });
});
