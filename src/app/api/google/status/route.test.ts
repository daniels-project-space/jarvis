import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const mock = vi.hoisted(() => ({
  controlActor: vi.fn(),
  configured: vi.fn(),
  storedConnection: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/request-auth", () => ({
  controlActor: mock.controlActor,
  isOwnerActor: (actor: { kind?: string }) => actor.kind === "owner",
}));
vi.mock("@/lib/google-oauth", () => ({
  isGoogleOAuthConfigurationReady: mock.configured,
  googleOAuthStoredConnectionReadiness: mock.storedConnection,
}));

import { GET } from "./route";

function request() {
  return new Request("https://jarvis.test/api/google/status") as unknown as NextRequest;
}

describe("Google OAuth status API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.controlActor.mockResolvedValue({ kind: "owner" });
    mock.storedConnection.mockResolvedValue("readable");
  });

  it("returns only non-secret server OAuth readiness to the owner", async () => {
    mock.configured.mockReturnValue(true);

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ ok: true, configured: true, storedConnection: "readable" });
  });

  it("makes incomplete server setup visible without exposing individual settings", async () => {
    mock.configured.mockReturnValue(false);
    mock.storedConnection.mockResolvedValue("not_configured");

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, configured: false, storedConnection: "not_configured" });
  });

  it("surfaces an unreadable saved connection without returning credential material", async () => {
    mock.configured.mockReturnValue(true);
    mock.storedConnection.mockResolvedValue("needs_reconnect");

    const response = await GET(request());

    expect(await response.json()).toEqual({ ok: true, configured: true, storedConnection: "needs_reconnect" });
  });

  it("refuses unauthenticated and guest status reads", async () => {
    mock.controlActor.mockResolvedValueOnce(null);
    expect((await GET(request())).status).toBe(401);

    mock.controlActor.mockResolvedValueOnce({ kind: "guest" });
    expect((await GET(request())).status).toBe(403);
  });
});
