import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";

import schema from "./schema";

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>;
  }
}

const modules = import.meta.glob("./**/*.ts");
const WORKER = "mission-supervisor-handoff-worker";
const NOW = Date.parse("2026-07-23T13:00:00Z");
const completionWakeTicketV1 = makeFunctionReference<"query">(
  "missionSupervisorHandoff:completionWakeTicketV1",
);

async function seedSupervisedHandoff(
  kind: "delegate" | "recover" = "delegate",
) {
  const t = convexTest(schema, modules);
  const seeded = await t.run(async (ctx) => {
    const missionId = await ctx.db.insert("missions", {
      goal: "Prove one exact worker completion handoff.",
      mode: "supervised",
      status: "running",
      agentCount: 1,
      createdAt: NOW - 10_000,
      updatedAt: NOW - 10_000,
    });
    const decisionKey = `handoff-${kind}-decision`;
    const jobId = await ctx.db.insert("jobs", {
      task: "Complete one bounded supervised workstream.",
      status: "done",
      missionId: String(missionId),
      supervisorEpoch: 1,
      supervisorDecisionKey: decisionKey,
      supervisorJobOrdinal: 0,
      createdAt: NOW - 9_000,
      completedAt: NOW - 1,
    });
    const stateId = await ctx.db.insert("missionSupervisorState", {
      protocolVersion: 1,
      missionId,
      requestKey: `handoff-${kind}-request`,
      requestDigest: "request-digest",
      requestPayloadJson: "{}",
      state: "ready",
      epoch: 2,
      nextDecisionSequence: 4,
      inputRevision: 7,
      handledInputRevision: 6,
      dirtyJobIds: [jobId],
      nextTickAt: NOW - 1,
      leaseVersion: 3,
      totalJobs: 1,
      maxJobs: 24,
      decisionCount: 3,
      maxDecisions: 64,
      deadlineAt: NOW + 60_000,
      consecutiveFailures: 0,
      createdAt: NOW - 10_000,
      updatedAt: NOW - 1,
    });
    const decisionId = await ctx.db.insert("missionSupervisorDecisions", {
      protocolVersion: 1,
      missionId,
      epoch: 1,
      sequence: 1,
      decisionKey,
      observedInputRevision: 1,
      snapshotDigest: "snapshot-digest",
      kind,
      payloadJson: "{}",
      payloadDigest: "payload-digest",
      rationale: "Admit one exact supervised worker.",
      decisionOrigin: kind === "recover" ? "policy" : "model",
      modelProvider: kind === "recover"
        ? "deterministic-policy"
        : "codex-subscription",
      modelTier: "terra",
      modelId: kind === "recover" ? "policy-v1" : "gpt-test",
      reasoningEffort: "high",
      tierReason: "bounded handoff fixture",
      supervisorPromptVersion: "handoff-test-v1",
      leaseVersion: 1,
      triggerRunId: "handoff-trigger-run",
      createdJobIds: [jobId],
      chatMessageIds: [],
      resultState: "waiting",
      nextTickAt: NOW,
      createdAt: NOW - 9_000,
    });
    return { missionId, jobId, stateId, decisionId };
  });
  return { t, ...seeded };
}

beforeEach(() => {
  process.env.JARVIS_WORKER_TOKEN = WORKER;
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  delete process.env.JARVIS_WORKER_TOKEN;
  vi.useRealTimers();
});

describe("mission supervisor completion handoff", () => {
  it.each(["delegate", "recover"] as const)(
    "returns the exact current due ticket for a %s-created job",
    async (kind) => {
      const fixture = await seedSupervisedHandoff(kind);

      expect(await fixture.t.query(completionWakeTicketV1, {
        jobId: fixture.jobId,
        workerToken: WORKER,
      })).toEqual({
        protocolVersion: 1,
        missionId: fixture.missionId,
        expectedLeaseVersion: 3,
        expectedEpoch: 2,
        expectedDecisionSequence: 4,
        expectedInputRevision: 7,
      });
    },
  );

  it("rejects forged and ambiguous decision provenance", async () => {
    const fixture = await seedSupervisedHandoff();
    await fixture.t.run(async (ctx) => {
      await ctx.db.patch(fixture.jobId, { supervisorJobOrdinal: 1 });
    });
    expect(await fixture.t.query(completionWakeTicketV1, {
      jobId: fixture.jobId,
      workerToken: WORKER,
    })).toBeNull();

    await fixture.t.run(async (ctx) => {
      await ctx.db.patch(fixture.jobId, { supervisorJobOrdinal: 0 });
      const decision = await ctx.db.get(fixture.decisionId);
      if (!decision) throw new Error("handoff decision fixture is missing");
      const {
        _id: decisionId,
        _creationTime: decisionCreationTime,
        ...duplicate
      } = decision;
      void decisionId;
      void decisionCreationTime;
      await ctx.db.insert("missionSupervisorDecisions", duplicate);
    });
    expect(await fixture.t.query(completionWakeTicketV1, {
      jobId: fixture.jobId,
      workerToken: WORKER,
    })).toBeNull();
  });

  it("returns null when work is not due, a lease is live, or state is terminal", async () => {
    const fixture = await seedSupervisedHandoff();
    await fixture.t.run(async (ctx) => {
      await ctx.db.patch(fixture.stateId, { nextTickAt: NOW + 1 });
    });
    expect(await fixture.t.query(completionWakeTicketV1, {
      jobId: fixture.jobId,
      workerToken: WORKER,
    })).toBeNull();

    await fixture.t.run(async (ctx) => {
      await ctx.db.patch(fixture.stateId, {
        state: "leased",
        nextTickAt: undefined,
        leaseUntil: NOW + 1,
      });
    });
    expect(await fixture.t.query(completionWakeTicketV1, {
      jobId: fixture.jobId,
      workerToken: WORKER,
    })).toBeNull();

    await fixture.t.run(async (ctx) => {
      await ctx.db.patch(fixture.stateId, { leaseUntil: NOW });
    });
    expect(await fixture.t.query(completionWakeTicketV1, {
      jobId: fixture.jobId,
      workerToken: WORKER,
    })).toMatchObject({
      missionId: fixture.missionId,
      expectedLeaseVersion: 3,
    });

    await fixture.t.run(async (ctx) => {
      await ctx.db.patch(fixture.stateId, {
        state: "terminal",
        leaseUntil: undefined,
      });
    });
    expect(await fixture.t.query(completionWakeTicketV1, {
      jobId: fixture.jobId,
      workerToken: WORKER,
    })).toBeNull();
  });

  it("requires one running supervised mission and one scheduler state", async () => {
    const fixture = await seedSupervisedHandoff();
    await fixture.t.run(async (ctx) => {
      await ctx.db.patch(fixture.missionId, { status: "needs_input" });
    });
    expect(await fixture.t.query(completionWakeTicketV1, {
      jobId: fixture.jobId,
      workerToken: WORKER,
    })).toBeNull();

    await fixture.t.run(async (ctx) => {
      await ctx.db.patch(fixture.missionId, { status: "running" });
      const state = await ctx.db.get(fixture.stateId);
      if (!state) throw new Error("handoff state fixture is missing");
      const {
        _id: stateId,
        _creationTime: stateCreationTime,
        ...duplicate
      } = state;
      void stateId;
      void stateCreationTime;
      await ctx.db.insert("missionSupervisorState", {
        ...duplicate,
        requestKey: "ambiguous-handoff-state",
      });
    });
    expect(await fixture.t.query(completionWakeTicketV1, {
      jobId: fixture.jobId,
      workerToken: WORKER,
    })).toBeNull();
  });

  it("rejects non-supervised jobs and invalid worker capability", async () => {
    const fixture = await seedSupervisedHandoff();
    const legacyJobId = await fixture.t.run(async (ctx) =>
      await ctx.db.insert("jobs", {
        task: "Legacy fleet work has no supervisor provenance.",
        status: "done",
        missionId: String(fixture.missionId),
        createdAt: NOW,
      })
    );
    expect(await fixture.t.query(completionWakeTicketV1, {
      jobId: legacyJobId,
      workerToken: WORKER,
    })).toBeNull();
    await expect(fixture.t.query(completionWakeTicketV1, {
      jobId: fixture.jobId,
      workerToken: "wrong-worker-token",
    })).rejects.toThrow("Unauthorized worker capability");
  });
});
