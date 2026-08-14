import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  controlActor: vi.fn(),
  privateCaptureObjectKey: vi.fn(),
  privateR2Put: vi.fn(),
}));

vi.mock("@/lib/request-auth", () => ({
  controlActor: mock.controlActor,
  isOwnerActor: (actor: { kind?: string }) => actor.kind === "owner",
}));
vi.mock("@/lib/private-r2", () => ({
  privateCaptureObjectKey: mock.privateCaptureObjectKey,
  privateR2Put: mock.privateR2Put,
}));

import { POST } from "./route";

function request(image = "data:image/jpeg;base64,AA==") {
  return new NextRequest("https://jarvis.example/api/see", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ image, mode: "camera" }),
  });
}

describe("private sight capture storage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.controlActor.mockResolvedValue({ kind: "owner" });
    mock.privateCaptureObjectKey.mockImplementation((id: string) => `owners/daniel/captures/${id}/image`);
    mock.privateR2Put.mockResolvedValue({ etag: "capture" });
  });

  it("returns only an opaque capture id after storing the frame privately", async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    const payload = await response.json() as { captureId?: string; imageUrl?: string };
    expect(payload.captureId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(payload.imageUrl).toBeUndefined();
    expect(mock.privateCaptureObjectKey).toHaveBeenCalledWith(payload.captureId);
    expect(mock.privateR2Put).toHaveBeenCalledWith(
      `owners/daniel/captures/${payload.captureId}/image`,
      expect.any(Buffer),
      "image/jpeg",
    );
  });

  it("rejects guests before accepting or storing screen/camera bytes", async () => {
    mock.controlActor.mockResolvedValue({ kind: "guest", guestId: "g".repeat(32) });

    const response = await POST(request());

    expect(response.status).toBe(403);
    expect(mock.privateR2Put).not.toHaveBeenCalled();
  });

  it("rejects malformed data before minting a private capture key", async () => {
    const response = await POST(request("https://attacker.invalid/image.png"));

    expect(response.status).toBe(400);
    expect(mock.privateCaptureObjectKey).not.toHaveBeenCalled();
    expect(mock.privateR2Put).not.toHaveBeenCalled();
  });
});
