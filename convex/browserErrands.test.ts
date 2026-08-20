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
  steps: [
    { action: "navigate" as const, url: "https://support.example.com/tickets/123", label: "Open the existing ticket" },
    { action: "read" as const, selector: "main", limit: 500, label: "Read its status" },
    { action: "type" as const, selector: "textarea[name=reply]", text: "Please share an update on my refund.", label: "Write one follow-up" },
    { action: "send" as const, selector: "button[type=submit]", label: "Submit the follow-up" },
  ],
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

async function foregroundExecutionReceipt(
  t: ReturnType<typeof convexTest>,
  errandId: string,
  callId = "call-browser-1",
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const messageId = await ctx.db.insert("chatMessages", {
      threadId: "main",
      role: "user",
      text: "Run approved browser errand.",
      status: "done",
      createdAt: now,
    });
    const assistantId = await ctx.db.insert("chatMessages", {
      threadId: "main",
      role: "assistant",
      text: "Running the approved browser errand.",
      status: "done",
      createdAt: now + 1,
    });
    const receiptKey = `${String(assistantId)}:${callId}`;
    await ctx.db.insert("chatTurnOwnerToolUses", {
      receiptKey,
      messageId,
      assistantId,
      callId,
      toolName: "browser_errand_run",
      browserErrandId: errandId,
      committedAt: now,
    });
    return receiptKey;
  });
}

describe("browser errand owner gate and sealed execution lifecycle", () => {
  it("requires an owner session to approve and snapshots the canonical executable plan", async () => {
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
    expect(approved).toMatchObject({
      status: "approved",
      approvalExpiresAt: Date.now() + proposal.envelope.ttlMs,
      approvedEnvelope: proposal.envelope,
      approvedSteps: proposal.steps,
    });
    expect(approved?.plan.join(" ")).toContain("Please share an update on my refund.");
  });

  it("requires a matching one-time foreground receipt and executes only the owner-approved step snapshot", async () => {
    const t = convexTest(schema, modules);
    const errandId = await createProposal(t);
    await enrollOwner(t);
    await t.mutation(api.browserErrands.decide, { errandId, decision: "approved", authTokenHash: OWNER });

    const wrongReceipt = await foregroundExecutionReceipt(t, "different-errand", "wrong-browser-call");
    await expect(t.mutation(api.browserErrands.claim, {
      errandId,
      leaseToken: LEASE,
      foregroundReceiptKey: wrongReceipt,
      workerToken: WORKER,
    })).resolves.toMatchObject({ ok: false, reason: expect.stringMatching(/matching one-time/i) });
    await expect(t.query(api.browserErrands.get, { errandId, authTokenHash: OWNER }))
      .resolves.toMatchObject({ status: "approved" });

    // Simulate a future buggy/malicious mutation trying to change the proposal
    // after Daniel approved it. `claim` must still return the stored approval
    // snapshot, never the mutable proposal field.
    await t.run(async (ctx) => {
      await ctx.db.patch(errandId, {
        executionSteps: [{ action: "type", selector: "textarea", text: "different text" }],
      });
    });
    const receipt = await foregroundExecutionReceipt(t, errandId, "right-browser-call");
    const claim = await t.mutation(api.browserErrands.claim, {
      errandId,
      leaseToken: LEASE,
      foregroundReceiptKey: receipt,
      workerToken: WORKER,
    });
    expect(claim).toMatchObject({ ok: true, steps: proposal.steps });
    expect(claim).not.toMatchObject({ steps: [{ action: "type", text: "different text" }] });
  });

  it("fences finalization to the claimant and terminalizes an expired lease even without the owner reaper", async () => {
    const t = convexTest(schema, modules);
    const errandId = await createProposal(t);
    await enrollOwner(t);
    await t.mutation(api.browserErrands.decide, { errandId, decision: "approved", authTokenHash: OWNER });
    const receipt = await foregroundExecutionReceipt(t, errandId);

    await expect(t.mutation(api.browserErrands.claim, {
      errandId,
      leaseToken: LEASE,
      foregroundReceiptKey: receipt,
      workerToken: WORKER,
    })).resolves.toMatchObject({ ok: true, objective: proposal.objective, steps: proposal.steps });
    await expect(t.mutation(api.browserErrands.finish, {
      errandId,
      leaseToken: "c".repeat(32),
      workerToken: WORKER,
      status: "done",
    })).resolves.toBe(false);

    const running = await t.query(api.browserErrands.get, { errandId, authTokenHash: OWNER });
    expect(running).toMatchObject({
      status: "running",
      leaseToken: LEASE,
      browserDeadlineAt: Date.now() + proposal.envelope.ttlMs,
      leaseUntil: Date.now() + proposal.envelope.ttlMs + 2 * 60_000,
    });

    vi.setSystemTime(new Date(Number(running?.leaseUntil) + 1));
    await expect(t.mutation(api.browserErrands.finish, {
      errandId,
      leaseToken: LEASE,
      workerToken: WORKER,
      status: "done",
    })).resolves.toBe(false);
    const expired = await t.query(api.browserErrands.get, { errandId, authTokenHash: OWNER });
    expect(expired).toMatchObject({
      status: "failed",
      result: expect.stringMatching(/outcome is unknown/i),
    });
    expect(expired?.leaseToken).toBeUndefined();
    expect(expired?.leaseUntil).toBeUndefined();
  });

  it("expires a stale approval before browser work starts", async () => {
    const t = convexTest(schema, modules);
    const errandId = await createProposal(t);
    await enrollOwner(t);
    await t.mutation(api.browserErrands.decide, { errandId, decision: "approved", authTokenHash: OWNER });
    const receipt = await foregroundExecutionReceipt(t, errandId);

    vi.advanceTimersByTime(proposal.envelope.ttlMs + 1);
    await expect(t.mutation(api.browserErrands.claim, {
      errandId,
      leaseToken: LEASE,
      foregroundReceiptKey: receipt,
      workerToken: WORKER,
    })).resolves.toMatchObject({ ok: false, reason: expect.stringMatching(/approval expired/i) });
    await expect(t.query(api.browserErrands.get, { errandId, authTokenHash: OWNER })).resolves.toMatchObject({
      status: "expired",
      result: expect.stringMatching(/Nothing was run/i),
    });
  });

  it("rejects malformed or unbounded envelopes before they can become an approval", async () => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(api.browserErrands.propose, {
      ...proposal,
      envelope: { ...proposal.envelope, maxSends: 11 },
      workerToken: WORKER,
    })).rejects.toThrow(/max sends/i);
    await expect(t.mutation(api.browserErrands.propose, {
      ...proposal,
      envelope: { ...proposal.envelope, allowedHosts: ["HTTPS://support.example.com"] },
      workerToken: WORKER,
    })).rejects.toThrow(/allowed host/i);
  });

  it("does not turn a paused unsealed step into a replayable approval", async () => {
    const t = convexTest(schema, modules);
    const errandId = await createProposal(t);
    await enrollOwner(t);
    await t.mutation(api.browserErrands.decide, { errandId, decision: "approved", authTokenHash: OWNER });
    const receipt = await foregroundExecutionReceipt(t, errandId);
    await t.mutation(api.browserErrands.claim, {
      errandId,
      leaseToken: LEASE,
      foregroundReceiptKey: receipt,
      workerToken: WORKER,
    });
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
