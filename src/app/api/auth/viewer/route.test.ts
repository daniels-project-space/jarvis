import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mock = vi.hoisted(() => ({
  issueViewerToken: vi.fn(),
  adminSessionHash: vi.fn(),
  adminSessionStatus: vi.fn(),
  controlMutation: vi.fn(),
}));

vi.mock("@/lib/control-session", () => ({
  ADMIN_COOKIE: "jarvis_admin",
  ADMIN_SESSION_SECONDS: 365 * 24 * 60 * 60,
  adminSessionHash: mock.adminSessionHash,
  adminSessionStatus: mock.adminSessionStatus,
  controlMutation: mock.controlMutation,
  isSameOriginRequest: vi.fn(() => true),
}));
vi.mock("@/lib/viewer-jwt", () => ({ issueViewerToken: mock.issueViewerToken }));

import { POST } from "./route";

const GUEST_COOKIE = "jarvis_guest";

function request(cookie = "") {
  return new NextRequest("https://jarvis.test/api/auth/viewer", {
    method: "POST",
    headers: cookie ? { cookie } : undefined,
  });
}

describe("viewer bootstrap boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.issueViewerToken.mockResolvedValue({ token: "signed", expiresAt: 123 });
    mock.adminSessionHash.mockResolvedValue("a".repeat(64));
    mock.adminSessionStatus.mockResolvedValue({ valid: false });
    mock.controlMutation.mockResolvedValue(null);
  });

  it("fails closed without minting an anonymous identity or conversation", async () => {
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ ok: false, error: "owner_pairing_required" });
    expect(mock.issueViewerToken).not.toHaveBeenCalled();
    expect(response.headers.get("set-cookie")).toContain(`${GUEST_COOKIE}=;`);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("uses an enrolled owner cookie only after server-side validation", async () => {
    mock.adminSessionStatus.mockResolvedValue({ valid: true, expiresAt: Date.now() + 90 * 24 * 60 * 60_000 });
    const response = await POST(request("jarvis_admin=owner-cookie"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, actor: "owner" });
    expect(mock.issueViewerToken).toHaveBeenCalledWith({ kind: "owner" });
    expect(response.headers.get("set-cookie")).toContain("jarvis_admin=owner-cookie");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=31536000");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("Secure");
    expect(mock.controlMutation).not.toHaveBeenCalled();
  });

  it("retries temporary session validation failures instead of falsely locking the owner", async () => {
    mock.adminSessionStatus.mockResolvedValue({ valid: false, unavailable: true });
    const response = await POST(request("jarvis_admin=owner-cookie"));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, error: "owner_session_temporarily_unavailable" });
    expect(mock.issueViewerToken).not.toHaveBeenCalled();
  });

  it("refreshes the durable server session only near expiry", async () => {
    mock.adminSessionStatus.mockResolvedValue({ valid: true, expiresAt: Date.now() + 60_000 });
    const response = await POST(request("jarvis_admin=owner-cookie"));
    expect(response.status).toBe(200);
    expect(mock.controlMutation).toHaveBeenCalledWith("controlAuth:refreshSession", {
      tokenHash: "a".repeat(64),
    });
  });
});
