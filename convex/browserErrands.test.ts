import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import schema from "./schema";

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>;
  }
}

const modules = import.meta.glob("./**/*.ts");
const WORKER = "browser-errand-test-worker";
const OWNER = "a".repeat(64);
const LEASE = "b".repeat(32);

const proposal = {
  objective: "Ask support about a delayed refund",
  credentialId: "support-account",
  envelope: {
    allowedHosts: ["support.example.com"],
    allowedActions: ["navigate", "read", "type", "send"],
    maxSends: 1,
    maxSteps: 12,
    ttlMs: 60_000,
  },
  plan: ["Open the ticket", "Read the status", "Send one follow-up"],
};

beforeEach(() => {
  process.env.JARVIS_WORKER_TOKEN = WORKER;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-20T12:00:00.000Z"));
});

afterEach(() => {
  delete process.env.JARVIS_WORKER_TOKEN;
  vi.useRealTimers();
});

async function enrollOwner(t: ReturnType<typeof convexTest>) {
  await t.mutation(api.controlAuth.createOpenSession, {
    ownerTokenHash: OWNER,
    workerToken: WORKER,
  });
}

async function createProposal(t: ReturnType<typeof convexTest>) {
  return await t.mutation(api.browserErrands.propose, { ...proposal, workerToken: WORKER });
}

describe("browser errand owner gate and lease lifecycle", () => {
  it("requires an owner session to approve even when a worker capability exists", async () => {
    const t = convexTest(schema, modules);
    const errandId = await createProposal(t);

    await expect(t.mutation(api.browserErrands.decide, {
      errandId,
      decision: "approved",
      workerToken: WORKER,
    })).rejects.toThrow(/Authentication required/i);

    await enrollOwner(t);
    await expect(t.mutation(api.browserErrands.decide, {
      errandId,
      decision: "approved",
      authTokenHash: OWNER,
    })).resolves.toBe(true);

    const approved = await t.query(api.browserErrands.get, { errandId, authTokenHash: OWNER });
    expect(approved).toMatchObject({ status: "approved", approvalExpiresAt: Date.now() + proposal.envelope.ttlMs });
  });

  it("fences finalization to the exact claimant and fails a lease instead of replaying it", async () => {
    const t = convexTest(schema, modules);
    const errandId = await createProposal(t);
    await enrollOwner(t);
    await t.mutation(api.browserErrands.decide, { errandId, decision: "approved", authTokenHash: OWNER });

    const claim = await t.mutation(api.browserErrands.claim, { errandId, leaseToken: LEASE, workerToken: WORKER });
    expect(claim).toMatchObject({ ok: true, objective: proposal.objective });
    await expect(t.mutation(api.browserErrands.finish, {
      errandId,
      leaseToken: "c".repeat(32),
      workerToken: WORKER,
      status: "done",
    })).resolves.toBe(false);

    const running = await t.query(api.browserErrands.get, { errandId, authTokenHash: OWNER });
    expect(running).toMatchObject({ status: "running", leaseToken: LEASE, leaseUntil: Date.now() + proposal.envelope.ttlMs + 2 * 60_000 });

    vi.setSystemTime(new Date(Number(running?.leaseUntil) + 1));
    await expect(t.mutation(api.browserErrands.expireStale, { authTokenHash: OWNER })).resolves.toEqual({ expired: 1 });
    const expired = await t.query(api.browserErrands.get, { errandId, authTokenHash: OWNER });
    expect(expired).toMatchObject({
      status: "failed",
      result: expect.stringMatching(/outcome is unknown/i),
    });
    expect(expired?.leaseToken).toBeUndefined();
    expect(expired?.leaseUntil).toBeUndefined();
    await expect(t.mutation(api.browserErrands.finish, {
      errandId,
      leaseToken: LEASE,
      workerToken: WORKER,
      status: "done",
    })).resolves.toBe(false);
  });

  it("expires a stale approval before browser work starts", async () => {
    const t = convexTest(schema, modules);
    const errandId = await createProposal(t);
    await enrollOwner(t);
    await t.mutation(api.browserErrands.decide, { errandId, decision: "approved", authTokenHash: OWNER });

    vi.advanceTimersByTime(proposal.envelope.ttlMs + 1);
    await expect(t.mutation(api.browserErrands.claim, {
      errandId,
      leaseToken: LEASE,
      workerToken: WORKER,
    })).resolves.toMatchObject({ ok: false, reason: expect.stringMatching(/approval expired/i) });
    await expect(t.query(api.browserErrands.get, { errandId, authTokenHash: OWNER })).resolves.toMatchObject({
      status: "expired",
      result: expect.stringMatching(/Nothing was run/i),
    });
  });

  it("does not turn a paused unsealed step into a replayable approval", async () => {
    const t = convexTest(schema, modules);
    const errandId = await createProposal(t);
    await enrollOwner(t);
    await t.mutation(api.browserErrands.decide, { errandId, decision: "approved", authTokenHash: OWNER });
    await t.mutation(api.browserErrands.claim, { errandId, leaseToken: LEASE, workerToken: WORKER });
    await t.mutation(api.browserErrands.finish, {
      errandId,
      leaseToken: LEASE,
      workerToken: WORKER,
      status: "needs_step_approval",
      escalation: "The next destination is outside the approved host list.",
    });

    await expect(t.mutation(api.browserErrands.decide, {
      errandId,
      decision: "approved",
      authTokenHash: OWNER,
    })).resolves.toBe(false);
    await expect(t.mutation(api.browserErrands.decide, {
      errandId,
      decision: "declined",
      authTokenHash: OWNER,
    })).resolves.toBe(true);
    await expect(t.query(api.browserErrands.get, { errandId, authTokenHash: OWNER })).resolves.toMatchObject({ status: "declined" });
  });
});
