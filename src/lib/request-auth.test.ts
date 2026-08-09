import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  adminSessionHash: vi.fn(),
  controlQuery: vi.fn(),
  sha256Hex: vi.fn(),
  validateAdminSession: vi.fn(),
  isTrustedJarvisEmbedOrigin: vi.fn(),
  openOwnerSessionToken: vi.fn(),
  verifyViewerToken: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("./control-session", () => ({
  adminSessionHash: mock.adminSessionHash,
  controlQuery: mock.controlQuery,
  sha256Hex: mock.sha256Hex,
  validateAdminSession: mock.validateAdminSession,
}));
vi.mock("./embed-origin", () => ({
  isTrustedJarvisEmbedOrigin: mock.isTrustedJarvisEmbedOrigin,
}));
vi.mock("./open-owner-session", () => ({
  openOwnerSessionToken: mock.openOwnerSessionToken,
}));
vi.mock("./viewer-jwt", () => ({
  verifyViewerToken: mock.verifyViewerToken,
}));

import { controlActor } from "./request-auth";

const CONTROL_TOKEN = "c".repeat(43);
const CONTROL_HASH = "d".repeat(64);
const ADMIN_HASH = "a".repeat(64);
const OPEN_HASH = "b".repeat(64);
const HOST_ORIGIN = "https://project-hub-olive-pi.vercel.app";

function request(): NextRequest {
  return new Request("https://jarvis-orcin-six.vercel.app/api/chat", {
    headers: {
      authorization: `Bearer ${CONTROL_TOKEN}`,
      "x-jarvis-embed-origin": HOST_ORIGIN,
    },
  }) as unknown as NextRequest;
}

describe("owner control actor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("JARVIS_WORKER_TOKEN", "worker-secret");
    mock.adminSessionHash.mockResolvedValue(null);
    mock.validateAdminSession.mockResolvedValue(false);
    mock.sha256Hex.mockResolvedValue(CONTROL_HASH);
    mock.isTrustedJarvisEmbedOrigin.mockReturnValue(true);
    mock.openOwnerSessionToken.mockReturnValue("open-owner-token");
    mock.verifyViewerToken.mockResolvedValue(null);
    mock.controlQuery.mockResolvedValue({ valid: true, authTokenHash: ADMIN_HASH });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("resolves a host-bound embed capability only through the worker-authenticated query", async () => {
    await expect(controlActor(request())).resolves.toEqual({ kind: "owner", authTokenHash: ADMIN_HASH });
    expect(mock.controlQuery).toHaveBeenCalledWith("controlAuth:embedControlSessionStatus", {
      tokenHash: CONTROL_HASH,
      hostOrigin: HOST_ORIGIN,
      workerToken: "worker-secret",
    });
  });

  it("fails closed when the server worker capability is unavailable", async () => {
    vi.stubEnv("JARVIS_WORKER_TOKEN", "");
    await expect(controlActor(request())).resolves.toBeNull();
    expect(mock.controlQuery).not.toHaveBeenCalled();
    expect(mock.verifyViewerToken).toHaveBeenCalledWith(CONTROL_TOKEN);
  });

  it("uses a signed owner viewer capability for a fresh cookie-blocked overlay", async () => {
    const viewerToken = "v".repeat(160);
    mock.verifyViewerToken.mockResolvedValue({ kind: "owner" });
    mock.sha256Hex.mockResolvedValue(OPEN_HASH);
    mock.validateAdminSession.mockResolvedValue(true);
    const req = new Request("https://jarvis-orcin-six.vercel.app/api/chat", {
      headers: { authorization: `Bearer ${viewerToken}` },
    }) as unknown as NextRequest;

    await expect(controlActor(req)).resolves.toEqual({ kind: "owner", authTokenHash: OPEN_HASH });
    expect(mock.openOwnerSessionToken).toHaveBeenCalledWith("worker-secret");
    expect(mock.verifyViewerToken).toHaveBeenCalledWith(viewerToken);
    expect(mock.validateAdminSession).toHaveBeenCalledWith(OPEN_HASH);
    expect(mock.controlQuery).not.toHaveBeenCalled();
  });

  it("preserves a trusted embed grant across a temporary control-plane outage", async () => {
    mock.controlQuery.mockRejectedValueOnce(new Error("Convex unavailable"));
    await expect(controlActor(request())).rejects.toThrow("Convex unavailable");
    expect(mock.verifyViewerToken).not.toHaveBeenCalled();
  });
});
