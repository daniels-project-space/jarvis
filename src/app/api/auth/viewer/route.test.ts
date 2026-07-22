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

  it("opens an anonymous guest partition without minting an owner session", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, actor: "guest", viewerToken: "signed" });
    expect(mock.issueViewerToken).toHaveBeenCalledWith(expect.objectContaining({ kind: "guest" }));
    expect(response.headers.get("set-cookie")).toMatch(new RegExp(`${GUEST_COOKIE}=[A-Za-z0-9_-]{32}`));
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
