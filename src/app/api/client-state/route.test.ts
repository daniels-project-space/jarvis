import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/request-auth", () => ({
  controlActor: vi.fn(),
  controlCredentials: vi.fn(() => ({ authTokenHash: "owner-hash" })),
  isOwnerActor: (actor: { kind?: string }) => actor.kind === "owner",
}));
vi.mock("@/lib/control-session", () => ({ controlMutation: vi.fn() }));

import { controlMutation } from "@/lib/control-session";
import { controlActor } from "@/lib/request-auth";
import { POST } from "./route";

function request(body: Record<string, unknown>) {
  return new Request("https://jarvis.test/api/client-state", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }) as any;
}

describe("guest client-state boundary", () => {
  beforeEach(() => vi.clearAllMocks());

  it("writes a guest's foreground transcript only to its partition", async () => {
    vi.mocked(controlActor).mockResolvedValue({ kind: "guest", guestId: "g".repeat(32) } as any);
    vi.mocked(controlMutation).mockResolvedValue("message-1" as never);

    const response = await POST(request({ action: "log_turn", threadId: "main", role: "assistant", text: "Hello" }));

    expect(response.status).toBe(200);
    expect(controlMutation).toHaveBeenCalledWith("chatQueue:logTurn", expect.objectContaining({
      guestId: "g".repeat(32), threadId: "main", role: "assistant", text: "Hello",
    }));
    expect(controlMutation).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ authTokenHash: expect.anything() }));
  });

  it("still rejects a guest control mutation", async () => {
    vi.mocked(controlActor).mockResolvedValue({ kind: "guest", guestId: "g".repeat(32) } as any);
    const response = await POST(request({ action: "set_active_thread", thread: "other" }));
    expect(response.status).toBe(403);
    expect(controlMutation).not.toHaveBeenCalled();
  });

  it("accepts bounded owner live-location updates", async () => {
    vi.mocked(controlActor).mockResolvedValue({ kind: "owner" } as any);
    vi.mocked(controlMutation).mockResolvedValue(undefined as never);

    const response = await POST(request({ action: "set_location", lat: 51.5074, lng: -0.1278, label: "London" }));

    expect(response.status).toBe(200);
    expect(controlMutation).toHaveBeenCalledWith("ui:setLocation", {
      lat: 51.5074, lng: -0.1278, label: "London", authTokenHash: "owner-hash",
    });
  });

  it.each([
    { lat: 91, lng: 0 },
    { lat: -91, lng: 0 },
    { lat: 0, lng: 181 },
    { lat: 0, lng: -181 },
    { lat: "NaN", lng: 0 },
    { lat: 0, lng: "Infinity" },
  ])("rejects invalid location coordinates: %o", async ({ lat, lng }) => {
    vi.mocked(controlActor).mockResolvedValue({ kind: "owner" } as any);

    const response = await POST(request({ action: "set_location", lat, lng }));

    expect(response.status).toBe(400);
    expect(controlMutation).not.toHaveBeenCalled();
  });
});
