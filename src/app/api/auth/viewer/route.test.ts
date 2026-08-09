import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mock = vi.hoisted(() => ({
  issueViewerToken: vi.fn(),
  adminSessionHash: vi.fn(),
  adminSessionStatus: vi.fn(),
}));

vi.mock("@/lib/control-session", () => ({
  ADMIN_COOKIE: "jarvis_admin",
  adminSessionHash: mock.adminSessionHash,
  adminSessionStatus: mock.adminSessionStatus,
  isSameOriginRequest: vi.fn(() => true),
}));
vi.mock("@/lib/viewer-jwt", () => ({ issueViewerToken: mock.issueViewerToken }));

import { GUEST_COOKIE, POST } from "./route";

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
    mock.adminSessionStatus.mockResolvedValue({ valid: true, expiresAt: Date.now() + 60_000 });
    const response = await POST(request("jarvis_admin=owner-cookie"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, actor: "owner" });
    expect(mock.issueViewerToken).toHaveBeenCalledWith({ kind: "owner" });
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});
