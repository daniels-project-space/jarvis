import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GOOGLE_GMAIL_COMPOSE_SCOPE,
  GOOGLE_GMAIL_MODIFY_SCOPE,
  GOOGLE_GMAIL_READONLY_SCOPE,
} from "./google-scopes";

const mock = vi.hoisted(() => ({
  controlQuery: vi.fn(async (): Promise<unknown> => {
    throw new Error("no stored connection in this test");
  }),
}));

vi.mock("server-only", () => ({}));
vi.mock("./control-session", () => ({ controlQuery: mock.controlQuery }));

const GOOGLE_ENV = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_TOKEN_ENCRYPTION_KEY",
  "GMAIL_BOOKINGS_CLIENT_ID",
  "GMAIL_BOOKINGS_CLIENT_SECRET",
  "GMAIL_BOOKINGS_REFRESH_TOKEN",
] as const;

afterEach(() => {
  for (const name of GOOGLE_ENV) delete process.env[name];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  mock.controlQuery.mockClear();
});

describe("Google OAuth access-token cache", () => {
  it("requires every connect setting, including a valid AES-256 key, before consent can start", async () => {
    const { isGoogleOAuthConfigurationReady } = await import("./google-oauth");

    expect(isGoogleOAuthConfigurationReady()).toBe(false);
    process.env.GOOGLE_CLIENT_ID = "client";
    process.env.GOOGLE_CLIENT_SECRET = "secret";
    process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = "invalid";
    expect(isGoogleOAuthConfigurationReady()).toBe(false);
    process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    expect(isGoogleOAuthConfigurationReady()).toBe(true);
  });

  it("does not reuse a warm bearer token after the legacy Gmail credentials change", async () => {
    process.env.GMAIL_BOOKINGS_CLIENT_ID = "client";
    process.env.GMAIL_BOOKINGS_CLIENT_SECRET = "secret";
    process.env.GMAIL_BOOKINGS_REFRESH_TOKEN = "refresh-a";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "token-a", expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "token-b", expires_in: 3600 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { getGoogleAccessTokenForGmail } = await import("./google-oauth");
    await expect(getGoogleAccessTokenForGmail([GOOGLE_GMAIL_READONLY_SCOPE])).resolves.toBe("token-a");

    // A reconnect can happen while this Node process is still warm. The
    // cache must compare the current credential identity, not just expiry.
    process.env.GMAIL_BOOKINGS_REFRESH_TOKEN = "refresh-b";
    await expect(getGoogleAccessTokenForGmail([GOOGLE_GMAIL_READONLY_SCOPE])).resolves.toBe("token-b");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][1]?.body)).toContain("refresh_token=refresh-b");
  });

  it("allows unscoped legacy credentials only for read-only Gmail", async () => {
    process.env.GMAIL_BOOKINGS_CLIENT_ID = "client";
    process.env.GMAIL_BOOKINGS_CLIENT_SECRET = "secret";
    process.env.GMAIL_BOOKINGS_REFRESH_TOKEN = "refresh";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { getGoogleAccessTokenForGmail } = await import("./google-oauth");

    await expect(getGoogleAccessTokenForGmail([GOOGLE_GMAIL_COMPOSE_SCOPE])).rejects.toThrow(/Reconnect Google/i);
    await expect(getGoogleAccessTokenForGmail([GOOGLE_GMAIL_MODIFY_SCOPE])).rejects.toThrow(/cannot verify a Gmail modify grant.*inbox modifications are unavailable/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed before contacting Google when a stored connection lacks the requested Gmail grant", async () => {
    process.env.GOOGLE_CLIENT_ID = "client";
    process.env.GOOGLE_CLIENT_SECRET = "secret";
    process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    const { encryptGoogleRefreshToken, getGoogleAccessTokenForGmail } = await import("./google-oauth");
    mock.controlQuery.mockResolvedValueOnce({
      encryptedRefreshToken: encryptGoogleRefreshToken("refresh-token"),
      scope: GOOGLE_GMAIL_READONLY_SCOPE,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(getGoogleAccessTokenForGmail([GOOGLE_GMAIL_COMPOSE_SCOPE])).rejects.toThrow(/Gmail permission/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not offer reconnect as a way to obtain Gmail modify authority", async () => {
    process.env.GOOGLE_CLIENT_ID = "client";
    process.env.GOOGLE_CLIENT_SECRET = "secret";
    process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    const { encryptGoogleRefreshToken, getGoogleAccessTokenForGmail } = await import("./google-oauth");
    mock.controlQuery.mockResolvedValueOnce({
      encryptedRefreshToken: encryptGoogleRefreshToken("refresh-token"),
      scope: `${GOOGLE_GMAIL_READONLY_SCOPE} ${GOOGLE_GMAIL_COMPOSE_SCOPE}`,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(getGoogleAccessTokenForGmail([GOOGLE_GMAIL_MODIFY_SCOPE])).rejects.toThrow(/cannot verify a Gmail modify grant.*inbox modifications are unavailable/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports an unreadable saved envelope as reconnectable without refreshing a Google token", async () => {
    process.env.GOOGLE_CLIENT_ID = "client";
    process.env.GOOGLE_CLIENT_SECRET = "secret";
    process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    const { encryptGoogleRefreshToken, googleOAuthStoredConnectionReadiness } = await import("./google-oauth");
    const encryptedRefreshToken = encryptGoogleRefreshToken("refresh-token");
    mock.controlQuery.mockResolvedValueOnce({
      encryptedRefreshToken,
      scope: "https://www.googleapis.com/auth/gmail.readonly",
    });

    // Model a safe key rotation/configuration mismatch after the connection
    // was saved. The readiness probe may inspect the envelope but must not
    // contact Google or emit an access token.
    process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 8).toString("base64");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(googleOAuthStoredConnectionReadiness()).resolves.toBe("needs_reconnect");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps a transient trusted-store failure distinct from reconnectable credentials", async () => {
    process.env.GOOGLE_CLIENT_ID = "client";
    process.env.GOOGLE_CLIENT_SECRET = "secret";
    process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    mock.controlQuery.mockRejectedValueOnce(new Error("Convex unavailable"));

    const { googleOAuthStoredConnectionReadiness } = await import("./google-oauth");

    await expect(googleOAuthStoredConnectionReadiness()).resolves.toBe("unavailable");
  });
});
