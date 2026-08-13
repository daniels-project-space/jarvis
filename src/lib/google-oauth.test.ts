import { afterEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  controlQuery: vi.fn(async () => {
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
  it("does not reuse a warm bearer token after the connected credentials change", async () => {
    process.env.GMAIL_BOOKINGS_CLIENT_ID = "client";
    process.env.GMAIL_BOOKINGS_CLIENT_SECRET = "secret";
    process.env.GMAIL_BOOKINGS_REFRESH_TOKEN = "refresh-a";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "token-a", expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "token-b", expires_in: 3600 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { getGoogleAccessToken } = await import("./google-oauth");
    await expect(getGoogleAccessToken()).resolves.toBe("token-a");

    // A reconnect can happen while this Node process is still warm. The
    // cache must compare the current credential identity, not just expiry.
    process.env.GMAIL_BOOKINGS_REFRESH_TOKEN = "refresh-b";
    await expect(getGoogleAccessToken()).resolves.toBe("token-b");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][1]?.body)).toContain("refresh_token=refresh-b");
  });

  it("never treats unscoped legacy Gmail credentials as Calendar authorization", async () => {
    process.env.GMAIL_BOOKINGS_CLIENT_ID = "client";
    process.env.GMAIL_BOOKINGS_CLIENT_SECRET = "secret";
    process.env.GMAIL_BOOKINGS_REFRESH_TOKEN = "refresh";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { getGoogleAccessTokenForScopes } = await import("./google-oauth");
    await expect(getGoogleAccessTokenForScopes(["https://www.googleapis.com/auth/calendar.events.owned"])).rejects.toThrow(/Calendar access/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
