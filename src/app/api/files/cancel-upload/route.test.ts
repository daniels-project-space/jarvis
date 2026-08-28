import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  controlActor: vi.fn(),
  controlMutation: vi.fn(),
  trigger: vi.fn(),
  privateR2Delete: vi.fn(),
}));

vi.mock("@trigger.dev/sdk/v3", () => ({ tasks: { trigger: mock.trigger } }));
vi.mock("@/lib/request-auth", () => ({
  controlActor: mock.controlActor,
  controlCredentials: () => ({ authTokenHash: "owner-hash" }),
  isOwnerActor: (actor: { kind?: string }) => actor?.kind === "owner",
}));
vi.mock("@/lib/control-session", () => ({
  controlMutation: mock.controlMutation,
  isSameOriginRequest: () => true,
}));
vi.mock("@/lib/private-r2", () => ({ privateR2Delete: mock.privateR2Delete }));

import { POST } from "./route";

describe("private upload cancellation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.controlActor.mockResolvedValue({ kind: "owner" });
  });

  it("does not create direct cleanup work during the ingest protocol cutover", async () => {
    process.env.JARVIS_FILE_INGEST_WAKE_PAUSED = "1";
    try {
      const response = await POST(new NextRequest("https://jarvis.example/api/files/cancel-upload", {
        method: "POST",
        headers: { origin: "https://jarvis.example", "content-type": "application/json" },
        body: JSON.stringify({ batchId: "batch-1" }),
      }));

      expect(response.status).toBe(503);
      expect(mock.controlMutation).not.toHaveBeenCalled();
      expect(mock.privateR2Delete).not.toHaveBeenCalled();
      expect(mock.trigger).not.toHaveBeenCalled();
    } finally {
      delete process.env.JARVIS_FILE_INGEST_WAKE_PAUSED;
    }
  });
});
