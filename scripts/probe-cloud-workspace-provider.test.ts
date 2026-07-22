import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  blockUnscopedVercelHobbyActivation,
  observeFreshAuthenticatedVercelHobbyTeam,
  type VercelWorkloadEligibility,
} from "./vercel-hobby-team-observation";

const TEAM_ID = "team_exact";
const TOKEN = "controller-only-vercel-token";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function attempt(
  fetchImpl: typeof fetch,
  issue = vi.fn(() => "signed-provider-probe-envelope"),
  teamId = TEAM_ID,
  workloadEligibility: VercelWorkloadEligibility = "unknown",
) {
  return {
    issue,
    result: blockUnscopedVercelHobbyActivation(
      { teamId, token: TOKEN, workloadEligibility, issue },
      fetchImpl,
    ),
  };
}

describe("Vercel live-provider probe source contract", () => {
  it("uses the same finite owner-scoped page traversal as create-time admission", () => {
    const source = readFileSync(new URL("./probe-cloud-workspace-provider.ts", import.meta.url), "utf8");
    expect(source).toContain("namePrefix: VERCEL_NAME_PREFIX, tags: { owner: \"jarvis\" }");
    expect(source).toContain("limit: VERCEL_HISTORY_PAGE_LIMIT");
    expect(source).toContain("for await (const page of listed.pages())");
    expect(source).toContain("pages > VERCEL_HISTORY_PAGE_CEILING || total > VERCEL_HISTORY_TOTAL_CEILING");
    expect(source).toContain('["pending", "running", "snapshotting", "stopping"]');
    expect(source).not.toContain("for await (const item of listed)");
  });

  it("keeps the authenticated Hobby observation and unscoped-receipt block after replay and final cleanup", () => {
    const source = readFileSync(new URL("./probe-cloud-workspace-provider.ts", import.meta.url), "utf8");
    const replay = source.indexOf("if (marker !== runId)");
    const finalCleanup = source.indexOf('await provider.terminate(recreated, "terminal")', replay);
    const receipt = source.indexOf("const receipt: CloudProviderProbeReceipt", finalCleanup);
    const issue = source.indexOf("const issueReceipt =", receipt);
    const hobbyGate = source.indexOf("blockUnscopedVercelHobbyActivation({", issue);
    const pass = source.indexOf("console.log(JSON.stringify({ status: \"PASS\", envelope }))", hobbyGate);
    expect(replay).toBeGreaterThan(-1);
    expect(finalCleanup).toBeGreaterThan(replay);
    expect(receipt).toBeGreaterThan(finalCleanup);
    expect(issue).toBeGreaterThan(receipt);
    expect(hobbyGate).toBeGreaterThan(issue);
    expect(pass).toBeGreaterThan(hobbyGate);
    expect(source).not.toContain("requireAuthoritativeVercelPlanAndSpendObservation");
    expect(source).not.toContain("issueAfterFreshAuthenticatedVercelHobbyTeamObservation");
  });
});

describe("fresh authenticated Vercel Hobby team observation", () => {
  it("returns credential-free evidence only after the exact team is freshly observed as Hobby", async () => {
    let resolveResponse!: (response: Response) => void;
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => { resolveResponse = resolve; })) as unknown as typeof fetch;
    const result = observeFreshAuthenticatedVercelHobbyTeam({ teamId: TEAM_ID, token: TOKEN }, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0];
    expect(url).toBe(`https://api.vercel.com/v2/teams/${TEAM_ID}`);
    expect(init).toMatchObject({ method: "GET", cache: "no-store", redirect: "error" });
    expect(init?.headers).toEqual({ Accept: "application/json", Authorization: `Bearer ${TOKEN}` });
    expect(init?.signal).toBeInstanceOf(AbortSignal);

    resolveResponse(json({ id: TEAM_ID, billing: { plan: "hobby" } }));
    const observation = await result;
    expect(observation).toEqual({ teamId: TEAM_ID, plan: "hobby" });
    expect(Object.isFrozen(observation)).toBe(true);
    expect(JSON.stringify(observation)).not.toContain(TOKEN);
  });

  it.each(["commercial", "unknown"] as const)(
    "blocks workload eligibility %s from issuance even when the exact team is Hobby",
    async (workloadEligibility) => {
      const fetchImpl = vi.fn(async () => json({ id: TEAM_ID, billing: { plan: "hobby" } })) as unknown as typeof fetch;
      const { issue, result } = attempt(fetchImpl, vi.fn(() => "receipt"), TEAM_ID, workloadEligibility);
      await expect(result).rejects.toThrow("immutable receipt-bound personal_noncommercial workload eligibility");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(issue).not.toHaveBeenCalled();
    },
  );

  it("does not trust an unbound personal_noncommercial label or issue from partial evidence", async () => {
    const fetchImpl = vi.fn(async () => json({ id: TEAM_ID, billing: { plan: "hobby" } })) as unknown as typeof fetch;
    const { issue, result } = attempt(fetchImpl, vi.fn(() => "receipt"), TEAM_ID, "personal_noncommercial");
    const error = await result.catch((caught: unknown) => caught);
    expect(String(error)).toContain("immutable receipt-bound personal_noncommercial workload eligibility");
    expect(String(error)).not.toContain(TOKEN);
    expect(issue).not.toHaveBeenCalled();
  });

  it.each(["pro", "enterprise", "unknown"])("rejects the %s plan without issuing a receipt", async (plan) => {
    const fetchImpl = vi.fn(async () => json({ id: TEAM_ID, billing: { plan } })) as unknown as typeof fetch;
    const { issue, result } = attempt(fetchImpl);
    await expect(result).rejects.toThrow("fresh authenticated Vercel Hobby team observation is unavailable");
    expect(issue).not.toHaveBeenCalled();
  });

  it.each([
    ["missing response team", { billing: { plan: "hobby" } }],
    ["changed response team", { id: "team_changed", billing: { plan: "hobby" } }],
    ["missing billing", { id: TEAM_ID }],
    ["malformed billing", { id: TEAM_ID, billing: "hobby" }],
    ["malformed plan", { id: TEAM_ID, billing: { plan: true } }],
  ])("rejects %s evidence without issuing a receipt", async (_label, body) => {
    const fetchImpl = vi.fn(async () => json(body)) as unknown as typeof fetch;
    const { issue, result } = attempt(fetchImpl);
    await expect(result).rejects.toThrow("fresh authenticated Vercel Hobby team observation is unavailable");
    expect(issue).not.toHaveBeenCalled();
  });

  it("rejects a missing configured team before making a request", async () => {
    const fetchImpl = vi.fn(async () => json({ id: TEAM_ID, billing: { plan: "hobby" } })) as unknown as typeof fetch;
    const { issue, result } = attempt(fetchImpl, vi.fn(() => "receipt"), "");
    await expect(result).rejects.toThrow("fresh authenticated Vercel Hobby team observation is unavailable");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(issue).not.toHaveBeenCalled();
  });

  it.each([401, 403, 500, 503])("rejects HTTP %s without issuing a receipt", async (status) => {
    const fetchImpl = vi.fn(async () => json({ id: TEAM_ID, billing: { plan: "hobby" } }, status)) as unknown as typeof fetch;
    const { issue, result } = attempt(fetchImpl);
    await expect(result).rejects.toThrow("fresh authenticated Vercel Hobby team observation is unavailable");
    expect(issue).not.toHaveBeenCalled();
  });

  it("masks request failures and never exposes or issues with the controller credential", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error(`provider echoed ${TOKEN}`); }) as unknown as typeof fetch;
    const { issue, result } = attempt(fetchImpl);
    const error = await result.catch((caught: unknown) => caught);
    expect(String(error)).toContain("fresh authenticated Vercel Hobby team observation is unavailable");
    expect(String(error)).not.toContain(TOKEN);
    expect(issue).not.toHaveBeenCalled();
  });

  it("rejects a malformed API response without issuing a receipt", async () => {
    const fetchImpl = vi.fn(async () => new Response("{", { status: 200 })) as unknown as typeof fetch;
    const { issue, result } = attempt(fetchImpl);
    await expect(result).rejects.toThrow("fresh authenticated Vercel Hobby team observation is unavailable");
    expect(issue).not.toHaveBeenCalled();
  });
});
