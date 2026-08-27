import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mock = vi.hoisted(() => ({
  adminSessionStatus: vi.fn(),
  issueViewerToken: vi.fn(),
  sha256Hex: vi.fn(),
}));

vi.mock("@/lib/control-session", () => ({
  adminSessionStatus: mock.adminSessionStatus,
  sha256Hex: mock.sha256Hex,
}));
vi.mock("@/lib/viewer-jwt", () => ({ issueViewerToken: mock.issueViewerToken }));

import {
  getInitialOwnerViewerSession,
  OWNER_VIEWER_BOOTSTRAP_DEADLINE_MS,
  requestOriginFromHeaders,
} from "./owner-viewer-bootstrap";

const directOwnerNavigation = {
  origin: null,
  fetchSite: "none",
  requestOrigin: "https://jarvis.test",
} as const;

describe("getInitialOwnerViewerSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.sha256Hex.mockResolvedValue("owner-session-hash");
    mock.adminSessionStatus.mockResolvedValue({ valid: true, expiresAt: Date.now() + 60_000 });
    mock.issueViewerToken.mockResolvedValue({ token: "signed-viewer-token", expiresAt: Date.now() + 21_600_000 });
  });

  it("mints one bootstrap capability only after validating the owner session", async () => {
    await expect(getInitialOwnerViewerSession("owner-cookie", directOwnerNavigation)).resolves.toEqual({
      token: "signed-viewer-token",
      expiresAt: expect.any(Number),
    });

    expect(mock.sha256Hex).toHaveBeenCalledWith("owner-cookie");
    expect(mock.adminSessionStatus).toHaveBeenCalledWith("owner-session-hash", expect.any(AbortSignal));
    expect(mock.issueViewerToken).toHaveBeenCalledTimes(1);
    expect(mock.issueViewerToken).toHaveBeenCalledWith({ kind: "owner" });
  });

  it.each([
    ["no cookie", undefined, { valid: true }],
    ["revoked session", "owner-cookie", { valid: false }],
    ["unavailable session", "owner-cookie", { valid: false, unavailable: true }],
  ])("never mints a capability for %s", async (_label, cookie, status) => {
    mock.adminSessionStatus.mockResolvedValue(status);

    await expect(getInitialOwnerViewerSession(cookie, directOwnerNavigation)).resolves.toBeNull();
    expect(mock.issueViewerToken).not.toHaveBeenCalled();
  });

  it("rejects cross-site and unknown navigations before checking the session", async () => {
    await expect(getInitialOwnerViewerSession("owner-cookie", {
      origin: null,
      fetchSite: "cross-site",
      requestOrigin: "https://jarvis.test",
    })).resolves.toBeNull();
    await expect(getInitialOwnerViewerSession("owner-cookie", {
      origin: null,
      fetchSite: null,
      requestOrigin: "https://jarvis.test",
    })).resolves.toBeNull();
    await expect(getInitialOwnerViewerSession("owner-cookie", {
      origin: "https://attacker.test",
      fetchSite: "cross-site",
      requestOrigin: "https://jarvis.test",
    })).resolves.toBeNull();

    expect(mock.sha256Hex).not.toHaveBeenCalled();
    expect(mock.adminSessionStatus).not.toHaveBeenCalled();
    expect(mock.issueViewerToken).not.toHaveBeenCalled();
  });

  it("derives and accepts the forwarded same-origin request origin", async () => {
    const requestOrigin = requestOriginFromHeaders(new Headers({
      host: "internal-host",
      "x-forwarded-host": "jarvis.test, internal-host",
      "x-forwarded-proto": "https, http",
    }));

    await expect(getInitialOwnerViewerSession("owner-cookie", {
      origin: "https://jarvis.test",
      fetchSite: "same-origin",
      requestOrigin,
    })).resolves.toMatchObject({ token: "signed-viewer-token" });
  });

  it("fails closed when the signer is unavailable", async () => {
    mock.issueViewerToken.mockRejectedValue(new Error("signer unavailable"));

    await expect(getInitialOwnerViewerSession("owner-cookie", directOwnerNavigation)).resolves.toBeNull();
    expect(mock.issueViewerToken).toHaveBeenCalledTimes(1);
  });

  it("falls back to the client bootstrap when owner validation stalls", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      mock.adminSessionStatus.mockImplementation((_tokenHash: string, nextSignal?: AbortSignal) => {
        signal = nextSignal;
        return new Promise(() => {});
      });

      const bootstrap = getInitialOwnerViewerSession("owner-cookie", directOwnerNavigation);
      await vi.advanceTimersByTimeAsync(OWNER_VIEWER_BOOTSTRAP_DEADLINE_MS);

      await expect(bootstrap).resolves.toBeNull();
      expect(signal?.aborted).toBe(true);
      expect(mock.issueViewerToken).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
