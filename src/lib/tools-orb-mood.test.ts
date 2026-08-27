import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mock = vi.hoisted(() => ({ convexMutation: vi.fn(), convexQuery: vi.fn() }));
vi.mock("./context", () => ({ convexMutation: mock.convexMutation, convexQuery: mock.convexQuery }));
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

import { executeTool } from "./tools";

describe("orb_mood provenance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.convexQuery.mockResolvedValue("active-thread-should-not-win");
    mock.convexMutation.mockResolvedValue(undefined);
  });

  it("persists the admitted Jarvis conversation thread, never the mutable active thread", async () => {
    await executeTool("orb_mood", { mood: "tender" }, {
      invocationContext: { threadId: "jarvis-thread-a" },
    });

    expect(mock.convexMutation).toHaveBeenCalledWith("ui:setMood", {
      mood: "tender",
      source: "model",
      threadId: "jarvis-thread-a",
    });
    expect(mock.convexQuery).not.toHaveBeenCalled();
  });
});
