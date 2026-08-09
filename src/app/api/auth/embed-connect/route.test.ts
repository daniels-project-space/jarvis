import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mock = vi.hoisted(() => ({
  adminSessionHash: vi.fn(),
  validateAdminSession: vi.fn(),
  controlMutation: vi.fn(),
  sha256Hex: vi.fn(async (value: string) => `hash:${value}`),
  issueViewerToken: vi.fn(),
}));

vi.mock("@/lib/control-session", () => ({
  adminSessionHash: mock.adminSessionHash,
  validateAdminSession: mock.validateAdminSession,
  controlMutation: mock.controlMutation,
  sha256Hex: mock.sha256Hex,
}));
vi.mock("@/lib/embed-origin", () => ({
  isTrustedJarvisEmbedOrigin: (origin: string | null) => origin === "https://project-hub-olive-pi.vercel.app",
}));
vi.mock("@/lib/viewer-jwt", () => ({ issueViewerToken: mock.issueViewerToken }));

import { GET } from "./route";

function request(origin = "https://project-hub-olive-pi.vercel.app", state = "s".repeat(40)) {
  const url = new URL("https://jarvis.test/api/auth/embed-connect");
  url.searchParams.set("hostOrigin", origin);
  url.searchParams.set("state", state);
  return new NextRequest(url);
}

describe("trusted embed owner connection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.adminSessionHash.mockResolvedValue("a".repeat(64));
    mock.validateAdminSession.mockResolvedValue(true);
    mock.controlMutation.mockResolvedValue({ expiresAt: Date.now() + 60_000 });
    mock.issueViewerToken.mockResolvedValue({ token: "owner-viewer-jwt", expiresAt: Date.now() + 60_000 });
  });

  it("binds control to the host but posts the secret only to the Jarvis opener origin", async () => {
    const response = await GET(request());
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(mock.controlMutation).toHaveBeenCalledWith("controlAuth:createEmbedControlSession", expect.objectContaining({
      authTokenHash: "a".repeat(64),
      hostOrigin: "https://project-hub-olive-pi.vercel.app",
      tokenHash: expect.stringMatching(/^hash:/),
    }));
    expect(body).toContain('"jarvis":"owner-embed-grant"');
    expect(body).toContain('postMessage(');
    expect(body).toContain(',"https://jarvis.test")');
  });

  it("rejects untrusted hosts and browsers without an owner cookie", async () => {
    expect((await GET(request("https://evil.example"))).status).toBe(403);
    mock.validateAdminSession.mockResolvedValueOnce(false);
    const unpaired = await GET(request());
    expect(unpaired.status).toBe(401);
    expect(mock.controlMutation).not.toHaveBeenCalled();
    expect(await unpaired.text()).not.toContain("owner-viewer-jwt");
  });
});
