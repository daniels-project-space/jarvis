import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mock = vi.hoisted(() => ({
  adminSessionHash: vi.fn(async () => "owner"),
  validateAdminSession: vi.fn(async () => true),
  configured: vi.fn(() => true),
}));

vi.mock("@/lib/control-session", () => ({
  adminSessionHash: mock.adminSessionHash,
  validateAdminSession: mock.validateAdminSession,
}));
vi.mock("@/lib/google-oauth", () => ({ isGoogleOAuthConfigurationReady: mock.configured }));

import { GET } from "./route";

function startRequest() {
  return new NextRequest("https://jarvis.test/api/auth/google/start");
}

beforeEach(() => {
  vi.clearAllMocks();
  mock.configured.mockReturnValue(true);
  process.env.GOOGLE_CLIENT_ID = "client-id";
});

afterEach(() => {
  delete process.env.GOOGLE_CLIENT_ID;
});

describe("Google OAuth start", () => {
  it("returns to Jarvis with an actionable status when the complete secure configuration is absent", async () => {
    mock.configured.mockReturnValue(false);

    const response = await GET(startRequest());

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://jarvis.test/?google_oauth=error&google_oauth_detail=not_configured");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("starts a least-privilege consent flow only after the full configuration is ready", async () => {
    const response = await GET(startRequest());
    const location = new URL(response.headers.get("location")!);

    expect(location.origin).toBe("https://accounts.google.com");
    expect(location.searchParams.get("scope")).toBe([
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.compose",
      "https://www.googleapis.com/auth/calendar.events.owned",
    ].join(" "));
    expect(location.searchParams.has("include_granted_scopes")).toBe(false);
    expect(response.headers.get("set-cookie")).toContain("__Host-jarvis_google_oauth_state=");
  });
});
