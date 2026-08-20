import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  oidc: vi.fn(),
  secret: vi.fn(),
  convexMutation: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@vercel/oidc", () => ({ getVercelOidcToken: mock.oidc }));
vi.mock("./vault", () => ({ getSecret: mock.secret }));
vi.mock("./context", () => ({ convexMutation: mock.convexMutation }));
vi.mock("./gmail", () => ({ gmailSearch: vi.fn(), gmailReadMessage: vi.fn() }));

import { runApprovedErrand } from "./browser-errand";

const ERRAND_ID = "browserErrand123";

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.JARVIS_BROWSER_URL;
  delete process.env.JARVIS_BROWSER_TOKEN;
  mock.oidc.mockResolvedValue("vercel-oidc");
  mock.secret.mockResolvedValue(null);
  mock.convexMutation.mockImplementation(async (path: string) => {
    if (path === "browserErrands:claim") {
      return {
        ok: true,
        objective: "Check the support ticket",
        credentialId: "support-account",
        envelope: {
          allowedHosts: ["support.example.com"], allowedActions: ["navigate", "read"], maxSends: 0, maxSteps: 4, ttlMs: 60_000,
        },
        plan: ["Open the ticket"],
      };
    }
    return true;
  });
  mock.fetch.mockRejectedValue(new Error("secret upstream detail"));
  vi.stubGlobal("fetch", mock.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.JARVIS_BROWSER_URL;
  delete process.env.JARVIS_BROWSER_TOKEN;
});

describe("browser errand claim compensation", () => {
  it("leaves an approval untouched when browser configuration cannot be resolved", async () => {
    mock.oidc.mockResolvedValue(null);
    mock.secret.mockResolvedValue(null);

    const outcome = await runApprovedErrand(ERRAND_ID, [{ action: "read" }]);

    expect(outcome).toMatchObject({
      status: "failed",
      summary: expect.stringMatching(/approval was left intact/i),
      sends: 0,
    });
    expect(mock.convexMutation).not.toHaveBeenCalled();
    expect(mock.fetch).not.toHaveBeenCalled();
  });

  it("terminalizes the matching lease after a post-claim browser handoff failure", async () => {
    const outcome = await runApprovedErrand(ERRAND_ID, [{ action: "read" }]);

    expect(outcome).toMatchObject({
      status: "failed",
      summary: expect.stringMatching(/not retried automatically/i),
      sends: 0,
    });
    expect(outcome.summary).not.toContain("secret upstream detail");
    const claim = mock.convexMutation.mock.calls.find(([path]) => path === "browserErrands:claim");
    const finish = mock.convexMutation.mock.calls.find(([path]) => path === "browserErrands:finish");
    expect(claim?.[1]).toMatchObject({ errandId: ERRAND_ID, leaseToken: expect.stringMatching(/^[A-Za-z0-9_-]{24,128}$/) });
    expect(finish?.[1]).toMatchObject({
      errandId: ERRAND_ID,
      leaseToken: (claim?.[1] as { leaseToken: string }).leaseToken,
      status: "failed",
      result: expect.stringMatching(/outcome may be unknown/i),
    });
    // The second request is an idempotent close attempt in case the service
    // accepted /tasks just before its response was lost.
    expect(mock.fetch).toHaveBeenCalledTimes(2);
  });
});
