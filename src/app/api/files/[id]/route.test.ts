import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  controlActor: vi.fn(),
  controlMutation: vi.fn(),
  privateR2Delete: vi.fn(),
  trigger: vi.fn(),
}));

vi.mock("@trigger.dev/sdk/v3", () => ({ tasks: { trigger: mock.trigger } }));
vi.mock("@/lib/request-auth", () => ({
  controlActor: mock.controlActor,
  controlCredentials: () => ({ authTokenHash: "owner-hash" }),
  isOwnerActor: (actor: { kind?: string }) => actor?.kind === "owner",
}));
vi.mock("@/lib/control-session", () => ({
  controlMutation: mock.controlMutation,
  controlQuery: vi.fn(),
  isSameOriginRequest: () => true,
}));
vi.mock("@/lib/private-r2", () => ({
  privateR2Delete: mock.privateR2Delete,
  privateR2Get: vi.fn(),
}));

import { DELETE } from "./route";

describe("private file deletion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.controlActor.mockResolvedValue({ kind: "owner" });
    mock.controlMutation.mockResolvedValue({
      ok: true,
      deferred: true,
      r2Keys: ["owners/daniel/files/file-1/v1/original"],
    });
    mock.trigger.mockResolvedValue({ id: "cleanup-run" });
  });

  it("queues cleanup without deleting underneath an active PUT", async () => {
    const request = new NextRequest("https://jarvis.example/api/files/file-1", {
      method: "DELETE",
      headers: { origin: "https://jarvis.example" },
    });
    const response = await DELETE(request, { params: Promise.resolve({ id: "file-1" }) });

    expect(response.status).toBe(202);
    expect(mock.privateR2Delete).not.toHaveBeenCalled();
    expect(mock.trigger).toHaveBeenCalledWith("jarvis-file-cleanup", { fileId: "file-1" });
  });
});
