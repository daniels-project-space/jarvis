import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mock = vi.hoisted(() => ({
  controlMutation: vi.fn(),
  sha256Hex: vi.fn(async (value: string) => `hash:${value}`),
}));

vi.mock("@/lib/control-session", () => ({
  ADMIN_COOKIE: "__Host-jarvis_admin",
  LEGACY_ADMIN_COOKIE: "jarvis_admin",
  ADMIN_SESSION_SECONDS: 365 * 24 * 60 * 60,
  controlMutation: mock.controlMutation,
  isSameOriginRequest: vi.fn(() => true),
  sha256Hex: mock.sha256Hex,
}));

import { POST } from "./route";

function request(ticket: string) {
  return new NextRequest("https://jarvis.test/api/auth/pair", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://jarvis.test" },
    body: JSON.stringify({ ticket }),
  });
}

describe("single-use owner pairing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.controlMutation.mockResolvedValue({ expiresAt: Date.now() + 60_000 });
  });

  it("consumes only a hash and sets an exact secure host cookie", async () => {
    const ticket = "t".repeat(43);
    const response = await POST(request(ticket));
    expect(response.status).toBe(200);
    expect(mock.controlMutation).toHaveBeenCalledWith("controlAuth:consumeOwnerPairingTicket", expect.objectContaining({
      tokenHash: `hash:${ticket}`,
      ownerTokenHash: expect.stringMatching(/^hash:/),
    }));
    expect(JSON.stringify(mock.controlMutation.mock.calls)).not.toContain(`\"ticket\":\"${ticket}\"`);
    const cookies = response.headers.getSetCookie().join("\n");
    expect(cookies).toContain("__Host-jarvis_admin=");
    expect(cookies).toContain("HttpOnly");
    expect(cookies).toContain("Secure");
    expect(cookies).toContain("SameSite=lax");
    expect(cookies).toContain("jarvis_guest=;");
  });

  it("rejects malformed and consumed or expired tickets without a session", async () => {
    expect((await POST(request("short"))).status).toBe(401);
    expect(mock.controlMutation).not.toHaveBeenCalled();
    mock.controlMutation.mockResolvedValueOnce(false);
    const replay = await POST(request("x".repeat(43)));
    expect(replay.status).toBe(401);
    expect(replay.headers.getSetCookie()).toEqual([]);
  });
});
