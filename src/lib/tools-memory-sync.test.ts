import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mock = vi.hoisted(() => ({
  convexMutation: vi.fn(),
  convexQuery: vi.fn(),
  vaultWrite: vi.fn(),
}));

vi.mock("./context", () => ({
  convexMutation: mock.convexMutation,
  convexQuery: mock.convexQuery,
}));
vi.mock("./control-context", () => ({
  withAdminSession: async (_authTokenHash: unknown, operation: () => Promise<unknown>) => await operation(),
}));
vi.mock("./obsidian", () => ({ vaultWrite: mock.vaultWrite }));
vi.mock("./vault", () => ({ getSecret: vi.fn(), getServiceSecrets: vi.fn() }));
vi.mock("./booking-email", () => ({
  lookupGmailBookingsReadOnly: vi.fn(), scanGmailBookingConfirmations: vi.fn(),
}));
vi.mock("./icloud-calendar", () => ({
  createICloudEvent: vi.fn(), deleteICloudEvent: vi.fn(), findICloudEvents: vi.fn(), listICloudEvents: vi.fn(),
}));

import { executeTool } from "./tools";

describe("memory and Obsidian mirror result", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.convexMutation.mockResolvedValue(undefined);
    mock.vaultWrite.mockResolvedValue(true);
  });

  it("reports an unavailable Obsidian mirror without losing the canonical memory write", async () => {
    mock.vaultWrite.mockResolvedValue(false);

    await expect(executeTool("remember", {
      kind: "decision",
      title: "Production safety",
      body: "Require an approval before consequential external actions.",
      project: "jarvis",
    })).resolves.toContain("but the Obsidian mirror did not sync yet");

    expect(mock.convexMutation).toHaveBeenCalledWith("memory:write", expect.objectContaining({
      kind: "decision",
      title: "Production safety",
    }));
    expect(mock.vaultWrite).toHaveBeenCalledWith(
      "decision",
      "Production safety",
      "Require an approval before consequential external actions.",
      "jarvis",
    );
  });

  it("confirms both persistence targets when the mirror succeeds", async () => {
    await expect(executeTool("remember", {
      title: "Favourite place",
      body: "Keep the travel map around the old town.",
    })).resolves.toBe("Saved to memory and synced to Obsidian.");
  });
});
