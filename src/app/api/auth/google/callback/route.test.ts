import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mock = vi.hoisted(() => ({
  adminSessionHash: vi.fn(async () => "owner"),
  validateAdminSession: vi.fn(async () => true),
  controlMutation: vi.fn(async () => undefined),
  encrypt: vi.fn(() => "encrypted-refresh-token"),
  configured: vi.fn(() => true),
}));

vi.mock("@/lib/control-session", () => ({
  adminSessionHash: mock.adminSessionHash,
  validateAdminSession: mock.validateAdminSession,
  controlMutation: mock.controlMutation,
}));
vi.mock("@/lib/google-oauth", () => ({
  encryptGoogleRefreshToken: mock.encrypt,
  isGoogleOAuthConfigurationReady: mock.configured,
  GoogleOAuthError: class GoogleOAuthError extends Error {},
}));

import { GET } from "./route";

function callbackRequest() {
  return new NextRequest("https://jarvis.test/api/auth/google/callback?code=code&state=valid-state", {
    headers: { cookie: "__Host-jarvis_google_oauth_state=valid-state" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GOOGLE_CLIENT_ID = "client-id";
  process.env.GOOGLE_CLIENT_SECRET = "client-secret";
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.includes("oauth2.googleapis.com/token")) {
      return Response.json({ refresh_token: "refresh", access_token: "access", scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose" });
    }
    if (url.includes("oauth2/v2/userinfo")) return Response.json({ email: "daniel@example.com" });
    throw new Error(`unexpected fetch ${url}`);
  }));
});

afterEach(() => {
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  vi.unstubAllGlobals();
});

describe("Google OAuth callback scope persistence", () => {
  it.each([
    "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/calendar.events.owned",
    "https://www.googleapis.com/auth/gmail.modify",
  ])("persists exactly Google's returned scope rather than assuming requested grants", async (scope) => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => Response.json({
      refresh_token: "refresh", access_token: "access", scope,
    }));

    const response = await GET(callbackRequest());

    expect(response.headers.get("location")).toContain("google_oauth=connected");
    expect(mock.controlMutation).toHaveBeenCalledWith("googleAuth:upsertConnection", expect.objectContaining({
      encryptedRefreshToken: "encrypted-refresh-token",
      scope,
      email: "daniel@example.com",
      authTokenHash: "owner",
    }));
  });

  it("fails closed when Google omits the granted scopes", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => Response.json({
      refresh_token: "refresh", access_token: "access",
    }));

    const response = await GET(callbackRequest());

    expect(response.headers.get("location")).toContain("google_oauth_detail=missing_scope");
    expect(mock.controlMutation).not.toHaveBeenCalled();
    expect(mock.encrypt).not.toHaveBeenCalled();
  });

  it("does not exchange an authorization code unless all secure OAuth settings are ready", async () => {
    mock.configured.mockReturnValue(false);

    const response = await GET(callbackRequest());

    expect(response.headers.get("location")).toContain("google_oauth_detail=not_configured");
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(mock.controlMutation).not.toHaveBeenCalled();
  });
});
