import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";

import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { patchJobWithRuntime } from "./controlPlane";
import {
  signalMissionSupervisorForJobPatch,
  supervisorAuthoritativePatchChanges,
} from "./missionSupervisorWake";

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>;
  }
}

const modules = import.meta.glob("./**/*.ts");

type WakeContext = Parameters<typeof signalMissionSupervisorForJobPatch>[0];
type WakeJob = Parameters<typeof signalMissionSupervisorForJobPatch>[1];

type Read = {
  table: string;
  index?: string;
  equalities: Record<string, unknown>;
  limit?: number;
};

type Write = {
  id: string;
  patch: Record<string, unknown>;
};

function jobId(value: string): Id<"jobs"> {
  return value as Id<"jobs">;
}

function missionId(value: string): Id<"missions"> {
  return value as Id<"missions">;
}

function stateId(value: string): Id<"missionSupervisorState"> {
  return value as Id<"missionSupervisorState">;
}

function supervisorJob(
  overrides: Record<string, unknown> = {},
): WakeJob {
  return {
    _id: jobId("job-supervised"),
    _creationTime: 1,
    task: "Implement one bounded supervisor-owned workstream.",
    status: "running",
    missionId: "mission-supervised",
    supervisorEpoch: 3,
    supervisorDecisionKey: "decision-supervised-3",
    supervisorJobOrdinal: 0,
    acceptanceCriteria: ["Provide exact evidence."],
    dependsOn: ["job-a", "job-b"],
    createdAt: 1,
    ...overrides,
  } as WakeJob;
}

function decision(
  job: WakeJob,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    protocolVersion: 1,
    kind: "delegate",
    missionId: missionId(String(job.missionId)),
    epoch: job.supervisorEpoch,
    decisionKey: job.supervisorDecisionKey,
    createdJobIds: [job._id],
    ...overrides,
  };
}

function supervisorState(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    _id: stateId("state-supervised"),
    missionId: missionId("mission-supervised"),
    state: "ready",
    inputRevision: 7,
    dirtyJobIds: [],
    maxJobs: 4,
    nextTickAt: 9_000,
    updatedAt: 1,
    ...overrides,
  };
}

function ioHarness(options: {
  decisions?: Array<Record<string, unknown>>;
  states?: Array<Record<string, unknown>>;
} = {}) {
  const decisions = options.decisions ?? [];
  const states = options.states ?? [];
  const reads: Read[] = [];
  const writes: Write[] = [];

  const db = {
    normalizeId(table: string, value: string) {
      return table === "missions" && value.startsWith("mission-")
        ? missionId(value)
        : null;
    },
    query(table: string) {
      const read: Read = { table, equalities: {} };
      reads.push(read);
      const builder = {
        withIndex(
          index: string,
          apply: (query: {
            eq(field: string, value: unknown): unknown;
          }) => unknown,
        ) {
          read.index = index;
          const query = {
            eq(field: string, value: unknown) {
              read.equalities[field] = value;
              return query;
            },
          };
          apply(query);
          return builder;
        },
        async take(limit: number) {
          read.limit = limit;
          const source =
            table === "missionSupervisorDecisions"
              ? decisions
              : table === "missionSupervisorState"
                ? states
                : [];
          return source.slice(0, limit);
        },
      };
      return builder;
    },
    async patch(id: unknown, patch: Record<string, unknown>) {
      writes.push({ id: String(id), patch: { ...patch } });
      const state = states.find((candidate) => String(candidate._id) === String(id));
      if (state) Object.assign(state, patch);
    },
  };

  return {
    ctx: { db } as unknown as WakeContext,
    reads,
    writes,
    decisions,
    states,
  };
}

describe("mission supervisor authoritative job wake", () => {
  it("performs zero IO for legacy and heartbeat/UI-only patches", async () => {
    const legacy = ioHarness();
    expect(await signalMissionSupervisorForJobPatch(
      legacy.ctx,
      supervisorJob({
        supervisorEpoch: undefined,
        supervisorDecisionKey: undefined,
        supervisorJobOrdinal: undefined,
      }),
      { status: "done" },
    )).toEqual({
      signaled: false,
      reason: "legacy_or_invalid_provenance",
    });
    expect(legacy.reads).toEqual([]);
    expect(legacy.writes).toEqual([]);

    const uiOnly = ioHarness();
    expect(await signalMissionSupervisorForJobPatch(
      uiOnly.ctx,
      supervisorJob(),
      {
        heartbeatAt: 101,
        progressAt: 102,
        percent: 73,
        progress: "still working",
        stage: "testing",
        log: "transient log",
        checkpoint: "transient checkpoint",
        workerRunId: "worker-clock",
        providerObservedAt: 103,
        providerRunState: "running",
        sourceObservedAt: 104,
        updatedAt: 105,
      },
    )).toEqual({ signaled: false, reason: "unchanged_snapshot" });
    expect(uiOnly.reads).toEqual([]);
    expect(uiOnly.writes).toEqual([]);
  });

  it("compares authoritative arrays by canonical content", async () => {
    const job = supervisorJob();
    expect(supervisorAuthoritativePatchChanges(
      job as unknown as Record<string, unknown>,
      {
        acceptanceCriteria: ["Provide exact evidence."],
        dependsOn: ["job-b", "job-a"],
      },
    )).toBe(false);

    const harness = ioHarness();
    expect(await signalMissionSupervisorForJobPatch(
      harness.ctx,
      job,
      {
        acceptanceCriteria: ["Provide exact evidence."],
        dependsOn: ["job-b", "job-a"],
      },
    )).toEqual({ signaled: false, reason: "unchanged_snapshot" });
    expect(harness.reads).toEqual([]);
    expect(harness.writes).toEqual([]);
  });

  it("detects digest-only tail changes in full authoritative content", () => {
    const dependencyPrefix = Array.from(
      { length: 16 },
      (_, index) => `job-${String(index).padStart(2, "0")}`,
    );
    const criteriaPrefix = Array.from(
      { length: 8 },
      (_, index) => `criterion-${index}`,
    );
    const longNotePrefix = "n".repeat(500);
    const job = supervisorJob({
      dependsOn: [...dependencyPrefix, "job-tail-before"],
      acceptanceCriteria: [...criteriaPrefix, "criterion-tail-before"],
      verificationNote: `${longNotePrefix}before`,
    });

    expect(supervisorAuthoritativePatchChanges(
      job as unknown as Record<string, unknown>,
      { dependsOn: [...dependencyPrefix, "job-tail-after"] },
    )).toBe(true);
    expect(supervisorAuthoritativePatchChanges(
      job as unknown as Record<string, unknown>,
      { acceptanceCriteria: [...criteriaPrefix, "criterion-tail-after"] },
    )).toBe(true);
    expect(supervisorAuthoritativePatchChanges(
      job as unknown as Record<string, unknown>,
      { verificationNote: `${longNotePrefix}after` },
    )).toBe(true);
  });

  it("uses one bounded indexed decision/state path and never duplicates a dirty job", async () => {
    const job = supervisorJob();
    const state = supervisorState({
      dirtyJobIds: [jobId("job-old"), jobId("job-old")],
    });
    const harness = ioHarness({
      decisions: [decision(job)],
      states: [state],
    });

    expect(await signalMissionSupervisorForJobPatch(
      harness.ctx,
      job,
      { status: "done" },
      1_000,
    )).toEqual({
      signaled: true,
      reason: "authoritative_change",
      inputRevision: 8,
      state: "ready",
    });
    expect(harness.reads).toEqual([
      {
        table: "missionSupervisorDecisions",
        index: "by_key",
        equalities: { decisionKey: "decision-supervised-3" },
        limit: 2,
      },
      {
        table: "missionSupervisorState",
        index: "by_mission",
        equalities: { missionId: missionId("mission-supervised") },
        limit: 2,
      },
    ]);
    expect(harness.writes).toEqual([
      {
        id: "state-supervised",
        patch: {
          inputRevision: 8,
          dirtyJobIds: [jobId("job-old"), job._id],
          updatedAt: 1_000,
          state: "ready",
          nextTickAt: 1_000,
        },
      },
    ]);

    const changedJob = { ...job, status: "done" } as WakeJob;
    expect(await signalMissionSupervisorForJobPatch(
      harness.ctx,
      changedJob,
      { result: "Verified terminal evidence." },
      1_001,
    )).toMatchObject({
      signaled: true,
      inputRevision: 9,
    });
    expect(harness.writes[1]?.patch).toMatchObject({
      inputRevision: 9,
      dirtyJobIds: [jobId("job-old"), job._id],
    });
    expect(new Set(
      (harness.writes[1]?.patch.dirtyJobIds as Id<"jobs">[]).map(String),
    ).size).toBe(2);
  });

  it("invalidates a leased input fence without releasing or mutating its lease", async () => {
    const job = supervisorJob();
    const state = supervisorState({
      state: "leased",
      leaseOwner: "worker-one",
      leaseToken: "lease-token-worker-one-0001",
      leaseVersion: 4,
      leaseHeartbeatAt: 500,
      leaseUntil: 5_000,
      nextTickAt: undefined,
    });
    const harness = ioHarness({
      decisions: [decision(job)],
      states: [state],
    });

    const result = await signalMissionSupervisorForJobPatch(
      harness.ctx,
      job,
      { result: "New evidence arrived while the model lease was active." },
      1_500,
    );
    expect(result).toMatchObject({
      signaled: true,
      inputRevision: 8,
      state: "leased",
    });
    expect(harness.writes).toHaveLength(1);
    expect(harness.writes[0]?.patch).toEqual({
      inputRevision: 8,
      dirtyJobIds: [job._id],
      updatedAt: 1_500,
    });
    expect(state).toMatchObject({
      state: "leased",
      inputRevision: 8,
      leaseOwner: "worker-one",
      leaseToken: "lease-token-worker-one-0001",
      leaseVersion: 4,
      leaseHeartbeatAt: 500,
      leaseUntil: 5_000,
    });
    expect(state.inputRevision).not.toBe(7);
  });

  it.each(["paused", "needs_input"] as const)(
    "records dirty authoritative input while preserving %s",
    async (stateName) => {
      const job = supervisorJob();
      const state = supervisorState({
        state: stateName,
        nextTickAt: undefined,
      });
      const harness = ioHarness({
        decisions: [decision(job)],
        states: [state],
      });

      expect(await signalMissionSupervisorForJobPatch(
        harness.ctx,
        job,
        { verificationVerdict: "passed" },
        2_000,
      )).toMatchObject({
        signaled: true,
        inputRevision: 8,
        state: stateName,
      });
      expect(harness.writes[0]?.patch).toEqual({
        inputRevision: 8,
        dirtyJobIds: [job._id],
        updatedAt: 2_000,
      });
      expect(state.state).toBe(stateName);
      expect(state.nextTickAt).toBeUndefined();
    },
  );

  it("does not patch a terminal supervisor state", async () => {
    const job = supervisorJob();
    const harness = ioHarness({
      decisions: [decision(job)],
      states: [supervisorState({ state: "terminal", nextTickAt: undefined })],
    });

    expect(await signalMissionSupervisorForJobPatch(
      harness.ctx,
      job,
      { completedAt: 3_000 },
      3_000,
    )).toEqual({ signaled: false, reason: "terminal_state" });
    expect(harness.reads.map((read) => [read.table, read.index, read.limit])).toEqual([
      ["missionSupervisorDecisions", "by_key", 2],
      ["missionSupervisorState", "by_mission", 2],
    ]);
    expect(harness.writes).toEqual([]);
  });

  it("does not wake from plausible optional provenance without its exact zero-based receipt", async () => {
    const job = supervisorJob({ supervisorJobOrdinal: 1 });
    const harness = ioHarness({
      decisions: [
        decision(job, {
          createdJobIds: [job._id, jobId("different-job")],
        }),
      ],
      states: [supervisorState()],
    });

    expect(await signalMissionSupervisorForJobPatch(
      harness.ctx,
      job,
      { approvalStatus: "approved" },
    )).toEqual({ signaled: false, reason: "provenance_mismatch" });
    expect(harness.reads).toEqual([
      {
        table: "missionSupervisorDecisions",
        index: "by_key",
        equalities: { decisionKey: "decision-supervised-3" },
        limit: 2,
      },
    ]);
    expect(harness.writes).toEqual([]);
  });

  it("does not trust createdJobIds from a non-delegate decision receipt", async () => {
    const job = supervisorJob();
    const harness = ioHarness({
      decisions: [decision(job, { kind: "continue" })],
      states: [supervisorState()],
    });

    expect(await signalMissionSupervisorForJobPatch(
      harness.ctx,
      job,
      { result: "Plausible but unbound authority." },
    )).toEqual({ signaled: false, reason: "provenance_mismatch" });
    expect(harness.reads.map((read) => read.table)).toEqual([
      "missionSupervisorDecisions",
    ]);
    expect(harness.writes).toEqual([]);
  });

  it("signals through the real patchJobWithRuntime transaction", async () => {
    const t = convexTest(schema, modules);
    const seeded = await t.run(async (ctx) => {
      const mission = await ctx.db.insert("missions", {
        goal: "Run one supervised integration patch.",
        mode: "supervised",
        status: "running",
        agentCount: 1,
        createdAt: 1,
        updatedAt: 1,
      });
      const job = await ctx.db.insert("jobs", {
        task: "Implement the supervised integration patch.",
        status: "running",
        missionId: String(mission),
        supervisorEpoch: 1,
        supervisorDecisionKey: "decision-integration-1",
        supervisorJobOrdinal: 0,
        createdAt: 1,
      });
      const state = await ctx.db.insert("missionSupervisorState", {
        protocolVersion: 1,
        missionId: mission,
        requestKey: "request-integration",
        requestDigest: "request-digest",
        requestPayloadJson: "{}",
        state: "waiting",
        epoch: 1,
        nextDecisionSequence: 2,
        inputRevision: 4,
        handledInputRevision: 4,
        dirtyJobIds: [],
        nextTickAt: 9_000,
        leaseVersion: 0,
        totalJobs: 1,
        maxJobs: 4,
        decisionCount: 1,
        maxDecisions: 64,
        deadlineAt: 99_000,
        consecutiveFailures: 0,
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("missionSupervisorDecisions", {
        protocolVersion: 1,
        missionId: mission,
        epoch: 1,
        sequence: 1,
        decisionKey: "decision-integration-1",
        observedInputRevision: 4,
        snapshotDigest: "snapshot-digest",
        kind: "delegate",
        payloadJson: "{}",
        payloadDigest: "payload-digest",
        rationale: "Delegate one bounded job.",
        decisionOrigin: "model",
        modelProvider: "codex-subscription",
        modelTier: "terra",
        modelId: "gpt-test",
        reasoningEffort: "high",
        tierReason: "bounded test",
        supervisorPromptVersion: "test-v1",
        leaseVersion: 1,
        triggerRunId: "trigger-test",
        createdJobIds: [job],
        chatMessageIds: [],
        resultState: "waiting",
        nextTickAt: 9_000,
        createdAt: 1,
      });
      return { mission, job, state };
    });

    await t.run(async (ctx) => {
      const job = await ctx.db.get(seeded.job);
      if (!job) throw new Error("seeded job missing");
      await patchJobWithRuntime(ctx, job, {
        result: "New authoritative evidence.",
      });
    });

    const persisted = await t.run(async (ctx) => ({
      state: await ctx.db.get(seeded.state),
      job: await ctx.db.get(seeded.job),
      runtime: await ctx.db
        .query("jobRuntime")
        .withIndex("by_job", (q) => q.eq("jobId", seeded.job))
        .unique(),
    }));
    expect(persisted.state).toMatchObject({
      state: "ready",
      inputRevision: 5,
      dirtyJobIds: [seeded.job],
    });
    expect(persisted.state?.nextTickAt).toBeTypeOf("number");
    expect(persisted.job?.result).toBe("New authoritative evidence.");
    expect(persisted.runtime?.status).toBe("running");
  });
});
