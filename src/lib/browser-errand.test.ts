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
const RECEIPT = "assistant-1:call-browser-1";
const AUTHORIZATION = { foregroundReceiptKey: RECEIPT };
const CLAIM_STEPS = [{ action: "read", selector: "main", limit: 200, label: "Read the ticket" }];

function claimResult(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    objective: "Check the support ticket",
    credentialId: "support-account",
    envelope: {
      allowedHosts: ["support.example.com"], allowedActions: ["navigate", "read"], maxSends: 0, maxSteps: 4, ttlMs: 60_000,
    },
    steps: CLAIM_STEPS,
    browserDeadlineAt: Date.now() + 60_000,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.JARVIS_BROWSER_URL;
  delete process.env.JARVIS_BROWSER_TOKEN;
  mock.oidc.mockResolvedValue("vercel-oidc");
  mock.secret.mockResolvedValue(null);
  mock.convexMutation.mockImplementation(async (path: string) => {
    if (path === "browserErrands:claim") return claimResult();
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

describe("browser errand sealed execution and provider redaction", () => {
  it("refuses to claim or configure a browser run without a foreground owner receipt", async () => {
    const outcome = await runApprovedErrand(ERRAND_ID, undefined);

    expect(outcome).toMatchObject({
      status: "failed",
      summary: expect.stringMatching(/one-time foreground owner execution receipt/i),
      sends: 0,
    });
    expect(mock.convexMutation).not.toHaveBeenCalled();
    expect(mock.oidc).not.toHaveBeenCalled();
    expect(mock.fetch).not.toHaveBeenCalled();
  });

  it("leaves an approval untouched when browser configuration cannot be resolved", async () => {
    mock.oidc.mockResolvedValue(null);
    mock.secret.mockResolvedValue(null);

    const outcome = await runApprovedErrand(ERRAND_ID, AUTHORIZATION);

    expect(outcome).toMatchObject({
      status: "failed",
      summary: expect.stringMatching(/approval was left intact/i),
      sends: 0,
    });
    expect(mock.convexMutation).not.toHaveBeenCalled();
    expect(mock.fetch).not.toHaveBeenCalled();
  });

  it("terminalizes the matching lease after a post-claim browser handoff failure", async () => {
    const outcome = await runApprovedErrand(ERRAND_ID, AUTHORIZATION);

    expect(outcome).toMatchObject({
      status: "failed",
      summary: expect.stringMatching(/not retried automatically/i),
      sends: 0,
    });
    expect(outcome.summary).not.toContain("secret upstream detail");
    const claim = mock.convexMutation.mock.calls.find(([path]) => path === "browserErrands:claim");
    const finish = mock.convexMutation.mock.calls.find(([path]) => path === "browserErrands:finish");
    expect(claim?.[1]).toMatchObject({
      errandId: ERRAND_ID,
      foregroundReceiptKey: RECEIPT,
      leaseToken: expect.stringMatching(/^[A-Za-z0-9_-]{24,128}$/),
    });
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

  it("sends only the sealed claim steps and the persisted browser deadline", async () => {
    mock.fetch
      .mockResolvedValueOnce(Response.json({}, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ untrustedPageText: "The ticket is still open." }, { status: 200 }))
      .mockResolvedValueOnce(Response.json({}, { status: 200 }));

    const outcome = await runApprovedErrand(ERRAND_ID, AUTHORIZATION);

    expect(outcome).toMatchObject({ status: "done", sends: 0 });
    const open = mock.fetch.mock.calls[0];
    const step = mock.fetch.mock.calls[1];
    const openBody = JSON.parse(String(open[1]?.body));
    const stepBody = JSON.parse(String(step[1]?.body));
    expect(openBody.envelope).toMatchObject({
      ttlMs: 60_000,
      deadlineAt: expect.any(Number),
      approvalRef: ERRAND_ID,
    });
    expect(stepBody).toEqual(CLAIM_STEPS[0]);
    expect(outcome.transcript.join(" ")).toContain("untrusted page evidence");
  });

  it("does not accept a sealed step response that arrives after the browser deadline", async () => {
    let now = 1_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    mock.convexMutation.mockImplementation(async (path: string) => {
      if (path === "browserErrands:claim") return claimResult({ browserDeadlineAt: 2_000 });
      return true;
    });
    mock.fetch
      .mockResolvedValueOnce(Response.json({}, { status: 201 }))
      .mockImplementationOnce(async () => {
        now = 2_000;
        return Response.json({ untrustedPageText: "too late" }, { status: 200 });
      })
      .mockResolvedValueOnce(Response.json({}, { status: 200 }));

    try {
      const outcome = await runApprovedErrand(ERRAND_ID, AUTHORIZATION);

      expect(outcome).toMatchObject({
        status: "failed",
        summary: expect.stringMatching(/browser deadline elapsed before a final result/i),
      });
      const finish = mock.convexMutation.mock.calls.find(([path]) => path === "browserErrands:finish");
      expect(finish?.[1]).toMatchObject({ status: "failed" });
      // The final request is cleanup only; no later sealed step is issued.
      expect(mock.fetch).toHaveBeenCalledTimes(3);
    } finally {
      clock.mockRestore();
    }
  });

  it("never reflects provider reason or detail into chat or durable errand results", async () => {
    mock.fetch
      .mockResolvedValueOnce(Response.json({
        reason: "secret provider reason: password=do-not-leak",
        detail: "secret provider detail: token=do-not-leak",
      }, { status: 500 }))
      .mockResolvedValueOnce(Response.json({}, { status: 200 }));

    const outcome = await runApprovedErrand(ERRAND_ID, AUTHORIZATION);

    expect(outcome).toMatchObject({ status: "failed", summary: "Could not start the browser task (service status 500)." });
    expect(JSON.stringify(outcome)).not.toContain("do-not-leak");
    const finish = mock.convexMutation.mock.calls.find(([path]) => path === "browserErrands:finish");
    expect(JSON.stringify(finish?.[1])).not.toContain("do-not-leak");
  });

  it("does not issue browser work after the persisted deadline has already elapsed", async () => {
    mock.convexMutation.mockImplementation(async (path: string) => {
      if (path === "browserErrands:claim") return claimResult({ browserDeadlineAt: Date.now() });
      return true;
    });

    const outcome = await runApprovedErrand(ERRAND_ID, AUTHORIZATION);

    expect(outcome).toMatchObject({ status: "failed", summary: expect.stringMatching(/sealed browser plan was unavailable/i) });
    expect(mock.fetch).not.toHaveBeenCalled();
  });
});
