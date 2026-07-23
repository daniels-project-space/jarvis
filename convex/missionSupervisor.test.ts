import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest, type TestConvex } from "convex-test";
import { makeFunctionReference } from "convex/server";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { testProjectSourceAdmission } from "./testSourceAdmission";
import {
  evidenceProjectSourceAdmission,
  sha256Hex,
  type ProjectSourceAdmission,
} from "../src/lib/source-admission";
import {
  ensureWorkAttempt,
  readAttemptExecutionAuthority,
} from "./controlPlane";
import {
  insertFreshTerminalWorkReceipt,
  insertTerminalWorkReceipt,
} from "./workReceiptAuthority";
import {
  MISSION_SUPERVISOR_LEASE_MS,
  MISSION_SUPERVISOR_MAX_DUE,
  MISSION_SUPERVISOR_MAX_JOBS,
  supersessionDigest,
} from "./missionSupervisor";

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>;
  }
}

const modules = import.meta.glob("./**/*.ts");
const WORKER = "mission-supervisor-test-worker";
const DISPATCHER = "mission-supervisor-test-dispatcher";
const START_AT = Date.parse("2026-07-23T12:00:00Z");
const supervisorApi = {
  startV1: makeFunctionReference<"mutation">("missionSupervisor:startV1"),
  controlV1: makeFunctionReference<"mutation">("missionSupervisor:controlV1"),
  dueV1: makeFunctionReference<"query">("missionSupervisor:dueV1"),
  claimV1: makeFunctionReference<"mutation">("missionSupervisor:claimV1"),
  renewV1: makeFunctionReference<"mutation">("missionSupervisor:renewV1"),
  releaseFailureV1: makeFunctionReference<"mutation">(
    "missionSupervisor:releaseFailureV1",
  ),
  commitV1: makeFunctionReference<"mutation">("missionSupervisor:commitV1"),
};
const jobsApi = {
  requestInput: makeFunctionReference<"mutation">("jobs:requestInput"),
  provideInput: makeFunctionReference<"mutation">("jobs:provideInput"),
  control: makeFunctionReference<"mutation">("jobs:control"),
  reapStale: makeFunctionReference<"mutation">("jobs:reapStale"),
};
const approvalsApi = {
  decide: makeFunctionReference<"mutation">("approvals:decide"),
};

type SupervisorTest = TestConvex<typeof schema>;
type WakeTicket = {
  protocolVersion: 1;
  missionId: Id<"missions">;
  expectedLeaseVersion: number;
  expectedEpoch: number;
  expectedDecisionSequence: number;
  expectedInputRevision: number;
};
type StartResult = {
  replayed: boolean;
  missionId: Id<"missions">;
  stateId: Id<"missionSupervisorState">;
  requestDigest: string;
  deadlineAt: number;
  wakeTicket: WakeTicket | null;
};
type StartOptions = {
  goal?: string;
  profile?: "short_fleet" | "durable_goal";
  context?: string;
  repo?: string;
  desiredWorkstreams?: number;
  requestedWorkstreams?: Array<{
    task: string;
    label?: string;
    repo?: string;
    model?: "luna" | "terra" | "sol";
    agentId?: "paul" | "atlas" | "iris" | "maya" | "sentry";
    readonly?: boolean;
    approvalRequired?: boolean;
    risk?: "low" | "medium" | "high" | "consequential";
    acceptanceCriteria?: string[];
  }>;
  acceptanceCriteria?: string[];
  projectAdmissions?: ProjectSourceAdmission[];
  originThreadId?: string;
  priority?: number;
  risk?: "low" | "medium" | "high" | "consequential";
  deadlineMs?: number;
};
type SuccessfulClaim = {
  claimed: true;
  missionId: Id<"missions">;
  epoch: number;
  nextDecisionSequence: number;
  inputRevision: number;
  leaseVersion: number;
  leaseUntil: number;
  snapshot: unknown;
  snapshotDigest: string;
};
type CommitMetadata = {
  decisionOrigin: "model" | "policy";
  modelProvider: "codex-subscription" | "deterministic-policy";
  modelTier: "luna" | "terra" | "sol";
  modelId: string;
  reasoningEffort: "none" | "low" | "medium" | "high" | "max";
  tierReason: string;
  supervisorPromptVersion: string;
  triggerRunId: string;
  deploymentVersion?: string;
};
type CommitDecision =
  | {
      kind: "delegate";
      workstreams: Array<{
        task: string;
        label: string;
        repo?: string;
        model: "luna" | "terra" | "sol";
        agentId: "paul" | "atlas" | "iris" | "maya" | "sentry";
        readonly: boolean;
        approvalRequired: boolean;
        risk: "low" | "medium" | "high" | "consequential";
        acceptanceCriteria: string[];
      }>;
    }
  | {
      kind: "recover";
      recoveries: Array<
        | {
            mode: "retry";
            predecessorJobId: Id<"jobs">;
            predecessorReceiptDigest: string;
          }
        | {
            mode: "remediate" | "input_revision";
            predecessorJobId: Id<"jobs">;
            predecessorReceiptDigest: string;
            task: string;
            label: string;
            model: "luna" | "terra" | "sol";
            agentId: "paul" | "atlas" | "iris" | "maya" | "sentry";
            risk: "low" | "medium" | "high" | "consequential";
            acceptanceCriteria: string[];
          }
      >;
    }
  | { kind: "wait"; delayMs: number; reason: string }
  | {
      kind: "request_input";
      question: string;
      reason: string;
      target?: {
        predecessorJobId: Id<"jobs">;
        predecessorReceiptDigest: string;
      };
    }
  | { kind: "replan"; reason: string }
  | { kind: "synthesize"; summary: string }
  | { kind: "fail"; reason: string };

const MODEL_METADATA: CommitMetadata = {
  decisionOrigin: "model",
  modelProvider: "codex-subscription",
  modelTier: "terra",
  modelId: "gpt-5.6-terra",
  reasoningEffort: "high",
  tierReason: "bounded supervisor judgment",
  supervisorPromptVersion: "mission-supervisor-v1",
  triggerRunId: "trigger-model-run-1",
  deploymentVersion: "test-deployment-1",
};
const POLICY_METADATA: CommitMetadata = {
  decisionOrigin: "policy",
  modelProvider: "deterministic-policy",
  modelTier: "luna",
  modelId: "jarvis-supervisor-policy-v1",
  reasoningEffort: "none",
  tierReason: "bounded deterministic supervisor policy",
  supervisorPromptVersion: "mission-supervisor-policy-v1",
  triggerRunId: "trigger-policy-run-1",
  deploymentVersion: "test-deployment-1",
};

beforeEach(() => {
  process.env.JARVIS_WORKER_TOKEN = WORKER;
  process.env.JARVIS_DISPATCH_TOKEN = DISPATCHER;
  vi.useFakeTimers();
  vi.setSystemTime(START_AT);
});

afterEach(() => {
  delete process.env.JARVIS_WORKER_TOKEN;
  delete process.env.JARVIS_DISPATCH_TOKEN;
  vi.useRealTimers();
});

async function start(
  t: SupervisorTest,
  requestKey: string,
  options: StartOptions = {},
): Promise<StartResult> {
  const projectAdmissions =
    options.projectAdmissions ?? [await testProjectSourceAdmission()];
  return await t.mutation(supervisorApi.startV1, {
    requestKey,
    goal: options.goal ?? `Supervise bounded request ${requestKey}`,
    projectAdmissions,
    dispatchToken: DISPATCHER,
    ...(options.profile === undefined ? {} : { profile: options.profile }),
    ...(options.context === undefined ? {} : { context: options.context }),
    ...(options.repo === undefined ? {} : { repo: options.repo }),
    ...(options.desiredWorkstreams === undefined
      ? {}
      : { desiredWorkstreams: options.desiredWorkstreams }),
    ...(options.requestedWorkstreams === undefined
      ? {}
      : { requestedWorkstreams: options.requestedWorkstreams }),
    ...(options.acceptanceCriteria === undefined
      ? {}
      : { acceptanceCriteria: options.acceptanceCriteria }),
    ...(options.originThreadId === undefined
      ? {}
      : { originThreadId: options.originThreadId }),
    ...(options.priority === undefined ? {} : { priority: options.priority }),
    ...(options.risk === undefined ? {} : { risk: options.risk }),
    ...(options.deadlineMs === undefined
      ? {}
      : { deadlineMs: options.deadlineMs }),
  }) as StartResult;
}

async function supervisorState(
  t: SupervisorTest,
  missionId: Id<"missions">,
) {
  return await t.run(async (ctx) =>
    await ctx.db
      .query("missionSupervisorState")
      .withIndex("by_mission", (q) => q.eq("missionId", missionId))
      .unique()
  );
}

async function supervisorCommand(
  t: SupervisorTest,
  missionId: Id<"missions">,
) {
  return await t.run(async (ctx) =>
    await ctx.db
      .query("missionSupervisorCommand")
      .withIndex("by_mission", (q) => q.eq("missionId", missionId))
      .unique()
  );
}

async function control(
  t: SupervisorTest,
  missionId: Id<"missions">,
  requestKey: string,
  action: "pause" | "resume" | "cancel" | "steer" | "provide_input",
  expectedInputRevision: number,
  input?: string,
) {
  return await t.mutation(supervisorApi.controlV1, {
    missionId,
    requestKey,
    action,
    expectedInputRevision,
    dispatchToken: DISPATCHER,
    ...(input === undefined ? {} : { input }),
  });
}

async function claim(
  t: SupervisorTest,
  missionId: Id<"missions">,
  expectedLeaseVersion: number,
  leaseOwner = "worker-one",
  leaseToken = `lease-token-${leaseOwner}-0001`,
) {
  return await t.mutation(supervisorApi.claimV1, {
    missionId,
    leaseOwner,
    leaseToken,
    expectedLeaseVersion,
    workerToken: WORKER,
  });
}

function exactFence(
  missionId: Id<"missions">,
  claimed: {
    epoch: number;
    nextDecisionSequence: number;
    inputRevision: number;
    leaseVersion: number;
  },
  leaseOwner = "worker-one",
  leaseToken = `lease-token-${leaseOwner}-0001`,
) {
  return {
    missionId,
    leaseOwner,
    leaseToken,
    leaseVersion: claimed.leaseVersion,
    expectedEpoch: claimed.epoch,
    expectedDecisionSequence: claimed.nextDecisionSequence,
    expectedInputRevision: claimed.inputRevision,
    workerToken: WORKER,
  };
}

async function claimSuccess(
  t: SupervisorTest,
  missionId: Id<"missions">,
  expectedLeaseVersion: number,
  leaseOwner = "worker-one",
  leaseToken = `lease-token-${leaseOwner}-0001`,
): Promise<SuccessfulClaim> {
  const result = await claim(
    t,
    missionId,
    expectedLeaseVersion,
    leaseOwner,
    leaseToken,
  );
  expect(result.claimed).toBe(true);
  return result as SuccessfulClaim;
}

function commitInput(
  missionId: Id<"missions">,
  claimed: SuccessfulClaim,
  decision: CommitDecision,
  metadata: CommitMetadata,
  rationale = "Commit one bounded supervisor transition.",
) {
  return {
    missionId,
    leaseOwner: "worker-one",
    leaseToken: "lease-token-worker-one-0001",
    leaseVersion: claimed.leaseVersion,
    expectedEpoch: claimed.epoch,
    expectedDecisionSequence: claimed.nextDecisionSequence,
    expectedInputRevision: claimed.inputRevision,
    expectedSnapshotDigest: claimed.snapshotDigest,
    decision,
    rationale,
    ...metadata,
    workerToken: WORKER,
  };
}

function delegatedWorkstream(
  overrides: Partial<Extract<CommitDecision, { kind: "delegate" }>["workstreams"][number]> = {},
): Extract<CommitDecision, { kind: "delegate" }>["workstreams"][number] {
  return {
    task: "Implement bounded supervisor authority and verify the exact behavior.",
    label: "Supervisor authority",
    model: "terra",
    agentId: "paul",
    readonly: false,
    approvalRequired: false,
    risk: "low",
    acceptanceCriteria: ["The exact bounded behavior is verified."],
    ...overrides,
  };
}

async function seedVerifiedReceipt(
  t: SupervisorTest,
  jobId: Id<"jobs">,
  options: {
    result?: string;
    note?: string;
    acceptanceEvidence?: string[];
    tamperAuthorityDigest?: boolean;
  } = {},
) {
  return await t.run(async (ctx) => {
    const job = await ctx.db.get(jobId);
    if (!job) throw new Error("Test job is missing");
    const attempt = Number(job.attempt ?? 1);
    await ensureWorkAttempt(ctx, job, attempt, "done", Date.now());
    const authority = await readAttemptExecutionAuthority(ctx, job, attempt);
    if (!authority) throw new Error("Test job authority is missing");
    const result = options.result ?? "Verified bounded supervisor result.";
    const note = options.note ?? "All acceptance checks passed.";
    const resultDigest = await sha256Hex(result);
    const evidenceDigest = await sha256Hex(note);
    const terminal = await insertTerminalWorkReceipt(ctx, job, attempt, {
      status: "succeeded",
      terminalCode: "verified_success",
      recoveryDisposition: "none",
      acceptanceEvidence: options.acceptanceEvidence
        ?? ["All acceptance checks passed."],
      artifacts: [`convex://jobs/${String(jobId)}/attempt/${attempt}/result`],
      verification: "pass",
      result,
      evidence: note,
    });
    if (options.tamperAuthorityDigest) {
      await ctx.db.patch(terminal.receiptId, {
        authorityDigest: "f".repeat(64),
      });
    }
    await ctx.db.patch(jobId, {
      status: "done",
      result,
      verificationVerdict: "pass",
      verificationNote: note,
      completedAt: Date.now(),
    });
    const runtime = await ctx.db
      .query("jobRuntime")
      .withIndex("by_job", (q) => q.eq("jobId", jobId))
      .unique();
    if (runtime) {
      await ctx.db.patch(runtime._id, {
        status: "done",
        stage: "verified",
        percent: 100,
        active: false,
        completedAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    return {
      receiptId: terminal.receiptId,
      authority,
      resultDigest,
      evidenceDigest,
    };
  });
}

async function seedRecoveryTerminal(
  t: SupervisorTest,
  jobId: Id<"jobs">,
  options: {
    status?: "failed" | "needs_input";
    terminalCode?: string;
    recoveryDisposition?: "retryable" | "remediable" | "needs_input" | "operator_stop";
  } = {},
) {
  return await t.run(async (ctx) => {
    const job = await ctx.db.get(jobId);
    if (!job) throw new Error("Test recovery job is missing");
    const attempt = Number(job.attempt ?? 1);
    const status = options.status ?? "failed";
    await ensureWorkAttempt(ctx, job, attempt, "running", Date.now());
    const terminal = await insertTerminalWorkReceipt(ctx, job, attempt, {
      status,
      terminalCode: options.terminalCode
        ?? (status === "needs_input"
          ? "agent_input_required"
          : "transient_provider_error"),
      recoveryDisposition: options.recoveryDisposition
        ?? (status === "needs_input" ? "needs_input" : "retryable"),
      acceptanceEvidence: [],
      artifacts: [
        `convex://jobs/${String(jobId)}/attempt/${attempt}/terminal`,
      ],
      verification: status === "needs_input" ? "needs_input" : "unavailable",
      result: status === "needs_input"
        ? "Which exact recovery boundary should be used?"
        : "Transient provider failure.",
      evidence: "Exact terminal fixture evidence.",
    });
    const jobStatus = status === "needs_input" ? "needs_input" : "error";
    await ctx.db.patch(jobId, {
      status: jobStatus,
      stage: jobStatus,
      completedAt: Date.now(),
    });
    const attemptRow = await ctx.db
      .query("workAttempts")
      .withIndex("by_job_attempt", (q) =>
        q.eq("jobId", jobId).eq("attempt", attempt)
      )
      .unique();
    if (attemptRow) {
      await ctx.db.patch(attemptRow._id, {
        status: jobStatus,
        completedAt: Date.now(),
      });
    }
    const runtime = await ctx.db
      .query("jobRuntime")
      .withIndex("by_job", (q) => q.eq("jobId", jobId))
      .unique();
    if (runtime) {
      await ctx.db.patch(runtime._id, {
        status: jobStatus,
        stage: jobStatus,
        active: false,
        completedAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    return terminal;
  });
}

describe("dormant mission supervisor authority", () => {
  it("starts atomically, replays one canonical request, rejects conflicts, and creates no jobs", async () => {
    const t = convexTest(schema, modules);
    const [jarvis, rentals] = await Promise.all([
      testProjectSourceAdmission("daniels-project-space/jarvis"),
      testProjectSourceAdmission("daniels-project-space/rental-manager-v2"),
    ]);
    const request = {
      requestKey: "canonical-start-1",
      goal: "Coordinate one bounded cross-project supervisor mission",
      profile: "durable_goal" as const,
      repo: "daniels-project-space/jarvis",
      desiredWorkstreams: 2,
      requestedWorkstreams: [{
        task: "Inspect the admitted Jarvis authority without changing production.",
        repo: "daniels-project-space/jarvis",
        model: "terra" as const,
        agentId: "paul" as const,
        readonly: true,
        acceptanceCriteria: ["Report exact evidence."],
      }],
      acceptanceCriteria: ["Keep all consequential actions gated."],
      projectAdmissions: [rentals, jarvis],
      dispatchToken: DISPATCHER,
    };

    const first = await t.mutation(supervisorApi.startV1, request);
    expect(first).toMatchObject({
      replayed: false,
      wakeTicket: {
        protocolVersion: 1,
        missionId: first.missionId,
        expectedLeaseVersion: 0,
        expectedEpoch: 1,
        expectedDecisionSequence: 1,
        expectedInputRevision: 1,
      },
    });
    const state = await supervisorState(t, first.missionId);
    const persisted = await t.run(async (ctx) => {
      const mission = await ctx.db.get(first.missionId);
      const runtime = await ctx.db
        .query("missionRuntime")
        .withIndex("by_mission", (q) => q.eq("missionId", first.missionId))
        .unique();
      const jobs = await ctx.db
        .query("jobs")
        .withIndex("by_mission", (q) => q.eq("missionId", String(first.missionId)))
        .collect();
      return { mission, runtime, jobs };
    });
    expect(state).toMatchObject({
      requestKey: request.requestKey,
      requestDigest: first.requestDigest,
      state: "ready",
      maxJobs: 24,
      maxDecisions: 64,
      totalJobs: 0,
      decisionCount: 0,
    });
    expect(persisted.mission).toMatchObject({
      mode: "supervised",
      status: "running",
      agentCount: 0,
    });
    expect(persisted.runtime).toMatchObject({
      missionId: first.missionId,
      mode: "supervised",
      status: "running",
    });
    expect(persisted.jobs).toEqual([]);

    vi.advanceTimersByTime(11 * 60_000);
    const replay = await t.mutation(supervisorApi.startV1, {
      ...request,
      projectAdmissions: [jarvis, rentals],
    });
    expect(replay).toMatchObject({
      replayed: true,
      missionId: first.missionId,
      stateId: first.stateId,
      requestDigest: first.requestDigest,
      wakeTicket: first.wakeTicket,
    });
    await expect(t.mutation(supervisorApi.startV1, {
      ...request,
      goal: `${request.goal} with conflicting scope`,
    })).rejects.toThrow("conflicts with a different payload");

    const counts = await t.run(async (ctx) => ({
      missions: (await ctx.db.query("missions").collect()).length,
      states: (await ctx.db.query("missionSupervisorState").collect()).length,
      jobs: (await ctx.db.query("jobs").collect()).length,
    }));
    expect(counts).toEqual({ missions: 1, states: 1, jobs: 0 });
  });

  it("maintains one exact command projection across controls, leases, release, input, and terminal commit", async () => {
    const t = convexTest(schema, modules);
    const started = await start(t, "command-transition-ledger", {
      originThreadId: "command-thread",
      priority: 87,
    });
    expect(await supervisorCommand(t, started.missionId)).toMatchObject({
      missionId: started.missionId,
      originThreadId: "command-thread",
      active: true,
      priority: 87,
      state: "ready",
      inputRevision: 1,
      steerRevision: 0,
      totalJobs: 0,
      inputTargeted: false,
    });

    expect(await control(
      t,
      started.missionId,
      "command-pause",
      "pause",
      1,
    )).toMatchObject({ applied: true, state: "paused", inputRevision: 2 });
    expect(await supervisorCommand(t, started.missionId)).toMatchObject({
      state: "paused",
      status: "paused",
      inputRevision: 2,
      inputTargeted: false,
    });

    expect(await control(
      t,
      started.missionId,
      "command-resume",
      "resume",
      2,
    )).toMatchObject({ applied: true, state: "ready", inputRevision: 3 });
    const leased = await claimSuccess(t, started.missionId, 0);
    expect(await supervisorCommand(t, started.missionId)).toMatchObject({
      state: "leased",
      inputRevision: 3,
      leaseUntil: leased.leaseUntil,
    });

    const released = await t.mutation(
      supervisorApi.releaseFailureV1,
      {
        ...exactFence(started.missionId, leased),
        errorCode: "bounded_projection_test",
      },
    );
    expect(released).toMatchObject({
      released: true,
      stale: false,
      escalated: false,
      nextTickAt: expect.any(Number),
    });
    expect(await supervisorCommand(t, started.missionId)).toMatchObject({
      state: "waiting",
      inputRevision: 3,
      nextTickAt: released.nextTickAt,
      inputTargeted: false,
    });

    vi.setSystemTime(Number(released.nextTickAt));
    const reclaimed = await claimSuccess(t, started.missionId, 1);
    const question =
      "Which exact acceptance boundary should Jarvis use for this mission?";
    expect(await t.mutation(
      supervisorApi.commitV1,
      commitInput(
        started.missionId,
        reclaimed,
        {
          kind: "request_input",
          question,
          reason: "The bounded planner needs one exact boundary.",
        },
        MODEL_METADATA,
      ),
    )).toMatchObject({
      committed: true,
      resultState: "needs_input",
    });
    expect(await supervisorCommand(t, started.missionId)).toMatchObject({
      state: "needs_input",
      status: "needs_input",
      inputRevision: 3,
      question,
      inputTargeted: false,
    });

    expect(await control(
      t,
      started.missionId,
      "command-provide-input",
      "provide_input",
      3,
      "Use the isolated backend acceptance boundary.",
    )).toMatchObject({ applied: true, state: "ready", inputRevision: 4 });
    const answered = await supervisorCommand(t, started.missionId);
    expect(answered).toMatchObject({
      state: "ready",
      status: "running",
      inputRevision: 4,
      steerRevision: 1,
      inputTargeted: false,
    });
    expect(answered).not.toHaveProperty("question");

    const finalClaim = await claimSuccess(t, started.missionId, 2);
    expect(await t.mutation(
      supervisorApi.commitV1,
      commitInput(
        started.missionId,
        finalClaim,
        {
          kind: "fail",
          reason: "Stop this bounded projection test safely.",
        },
        POLICY_METADATA,
      ),
    )).toMatchObject({
      committed: true,
      resultState: "terminal",
    });
    expect(await supervisorCommand(t, started.missionId)).toMatchObject({
      state: "terminal",
      status: "failed",
      active: false,
      inputRevision: 4,
      inputTargeted: false,
    });
  });

  it("projects a bounded claim hold as an exact input question", async () => {
    const t = convexTest(schema, modules);
    const started = await start(t, "command-deadline-hold", {
      deadlineMs: 10 * 60_000,
    });
    vi.setSystemTime(START_AT + 10 * 60_000 + 1);

    expect(await claim(t, started.missionId, 0)).toMatchObject({
      claimed: false,
      reason: "supervisor_deadline_reached",
      escalated: true,
    });
    expect(await supervisorCommand(t, started.missionId)).toMatchObject({
      state: "needs_input",
      status: "needs_input",
      active: true,
      inputTargeted: false,
      question:
        "The supervised mission reached its bounded deadline and needs Daniel to continue or stop it.",
    });
  });

  it("rejects stale, invalid, and aggregate-oversized admission payloads without partial rows", async () => {
    const t = convexTest(schema, modules);
    const authorizedAdmission = await testProjectSourceAdmission();
    await expect(t.mutation(supervisorApi.startV1, {
      requestKey: "unauthorized-start",
      goal: "This request must not create partial supervisor authority.",
      projectAdmissions: [authorizedAdmission],
      dispatchToken: "wrong-dispatcher-capability",
    })).rejects.toThrow("Authentication required");

    const stale = await evidenceProjectSourceAdmission(
      Date.now() - 10 * 60_000 - 1,
    );
    await expect(start(t, "stale-admission", {
      projectAdmissions: [stale],
    })).rejects.toThrow("requires fresh canonical project admissions");

    const fresh = await testProjectSourceAdmission();
    await expect(start(t, "invalid-admission", {
      projectAdmissions: [{
        ...fresh,
        sourceAdmissionDigest: "0".repeat(64),
      }],
    })).rejects.toThrow("requires fresh canonical project admissions");

    await expect(start(t, "short-goal", {
      goal: "too short",
      projectAdmissions: [fresh],
    })).rejects.toThrow("goal must be between 12 and 500 UTF-8 bytes");
    await expect(start(t, "short-task", {
      projectAdmissions: [fresh],
      requestedWorkstreams: [{
        task: "short",
        acceptanceCriteria: ["Return bounded evidence."],
      }],
    })).rejects.toThrow(
      "requestedWorkstreams[0].task must be between 12 and 4000 UTF-8 bytes",
    );
    await expect(start(t, "short-label", {
      projectAdmissions: [fresh],
      requestedWorkstreams: [{
        task: "Inspect this bounded workstream safely.",
        label: "ab",
        acceptanceCriteria: ["Return bounded evidence."],
      }],
    })).rejects.toThrow(
      "requestedWorkstreams[0].label must be between 3 and 80 UTF-8 bytes",
    );
    await expect(start(t, "missing-criteria", {
      projectAdmissions: [fresh],
      requestedWorkstreams: [{
        task: "Inspect this bounded workstream safely.",
      }],
    })).rejects.toThrow(
      "requestedWorkstreams[0].acceptanceCriteria must contain at least 1 item",
    );
    await expect(start(t, "undersized-durable-fleet", {
      profile: "durable_goal",
      desiredWorkstreams: 1,
      projectAdmissions: [fresh],
    })).rejects.toThrow("desiredWorkstreams must be an integer between 2 and 6");

    await expect(start(t, "oversized-payload", {
      projectAdmissions: [fresh],
      requestedWorkstreams: Array.from({ length: 6 }, (_, index) => ({
        task: `${index}:${"x".repeat(3_000)}`,
        acceptanceCriteria: ["Return bounded evidence."],
      })),
    })).rejects.toThrow("Canonical request payload exceeds");

    const counts = await t.run(async (ctx) => ({
      missions: (await ctx.db.query("missions").collect()).length,
      runtimes: (await ctx.db.query("missionRuntime").collect()).length,
      states: (await ctx.db.query("missionSupervisorState").collect()).length,
      jobs: (await ctx.db.query("jobs").collect()).length,
    }));
    expect(counts).toEqual({
      missions: 0,
      runtimes: 0,
      states: 0,
      jobs: 0,
    });
  });

  it("binds exact wake tickets, invalidates a leased model, and replays controls immutably", async () => {
    const t = convexTest(schema, modules);
    const admission = await testProjectSourceAdmission();
    const started = await start(t, "control-ticket-bindings", {
      projectAdmissions: [admission],
    });
    expect(started.wakeTicket).toEqual({
      protocolVersion: 1,
      missionId: started.missionId,
      expectedLeaseVersion: 0,
      expectedEpoch: 1,
      expectedDecisionSequence: 1,
      expectedInputRevision: 1,
    });

    const leased = await claimSuccess(t, started.missionId, 0);
    const replayedStart = await start(t, "control-ticket-bindings", {
      projectAdmissions: [admission],
    });
    expect(replayedStart).toMatchObject({
      replayed: true,
      missionId: started.missionId,
      wakeTicket: null,
    });
    await expect(t.mutation(supervisorApi.controlV1, {
      missionId: started.missionId,
      requestKey: "worker-cannot-control",
      action: "pause",
      expectedInputRevision: 1,
      dispatchToken: WORKER,
    })).rejects.toThrow("Authentication required");

    const steered = await control(
      t,
      started.missionId,
      "control-steer-1",
      "steer",
      1,
      "Prioritize the exact control fence before any further planning.",
    );
    expect(steered).toMatchObject({
      applied: true,
      replayed: false,
      noop: false,
      scope: "planning_only_zero_jobs",
      state: "ready",
      inputRevision: 2,
      wakeTicket: {
        protocolVersion: 1,
        missionId: started.missionId,
        expectedLeaseVersion: leased.leaseVersion,
        expectedEpoch: leased.epoch,
        expectedDecisionSequence: leased.nextDecisionSequence,
        expectedInputRevision: 2,
      },
    });
    expect(await t.mutation(supervisorApi.renewV1, {
      ...exactFence(started.missionId, leased),
    })).toMatchObject({
      renewed: false,
      reason: "fence_mismatch",
    });

    const replayedSteer = await control(
      t,
      started.missionId,
      "control-steer-1",
      "steer",
      1,
      "Prioritize the exact control fence before any further planning.",
    );
    expect(replayedSteer).toMatchObject({
      applied: true,
      replayed: true,
      inputRevision: 2,
      wakeTicket: steered.wakeTicket,
    });
    await expect(control(
      t,
      started.missionId,
      "control-steer-1",
      "steer",
      1,
      "A conflicting instruction must never reuse the same key.",
    )).rejects.toThrow("conflicts with a different payload");

    const stale = await control(
      t,
      started.missionId,
      "control-stale-1",
      "pause",
      1,
    );
    expect(stale).toMatchObject({
      applied: false,
      replayed: false,
      noop: false,
      reason: "stale_input_revision",
      state: "ready",
      inputRevision: 2,
      wakeTicket: null,
    });
    const paused = await control(
      t,
      started.missionId,
      "control-pause-1",
      "pause",
      2,
    );
    expect(paused).toMatchObject({
      applied: true,
      state: "paused",
      inputRevision: 3,
      wakeTicket: null,
    });
    expect(await control(
      t,
      started.missionId,
      "control-stale-1",
      "pause",
      1,
    )).toMatchObject({
      applied: false,
      replayed: true,
      reason: "stale_input_revision",
      state: "ready",
      inputRevision: 2,
    });

    const resumed = await control(
      t,
      started.missionId,
      "control-resume-1",
      "resume",
      3,
    );
    expect(resumed).toMatchObject({
      applied: true,
      state: "ready",
      inputRevision: 4,
      wakeTicket: {
        protocolVersion: 1,
        missionId: started.missionId,
        expectedLeaseVersion: leased.leaseVersion,
        expectedEpoch: leased.epoch,
        expectedDecisionSequence: leased.nextDecisionSequence,
        expectedInputRevision: 4,
      },
    });
    expect(await claim(
      t,
      started.missionId,
      resumed.wakeTicket.expectedLeaseVersion,
      "worker-two",
      "lease-token-worker-two-0001",
    )).toMatchObject({
      claimed: true,
      leaseVersion: leased.leaseVersion + 1,
      epoch: resumed.wakeTicket.expectedEpoch,
      nextDecisionSequence: resumed.wakeTicket.expectedDecisionSequence,
      inputRevision: resumed.wakeTicket.expectedInputRevision,
    });

    const persisted = await t.run(async (ctx) => ({
      state: await ctx.db.get(started.stateId),
      mission: await ctx.db.get(started.missionId),
      controls: await ctx.db
        .query("missionSupervisorControls")
        .withIndex("by_mission_created", (q) =>
          q.eq("missionId", started.missionId)
        )
        .collect(),
    }));
    expect(persisted.state).toMatchObject({
      state: "leased",
      inputRevision: 4,
      leaseVersion: 2,
    });
    expect(persisted.mission).toMatchObject({
      status: "running",
      steer:
        "Prioritize the exact control fence before any further planning.",
      steerRevision: 1,
    });
    expect(persisted.controls).toHaveLength(4);
  });

  it("keeps terminal control replay distinct from a later no-op or rejection", async () => {
    const t = convexTest(schema, modules);
    const admission = await testProjectSourceAdmission();
    const started = await start(t, "terminal-controls", {
      projectAdmissions: [admission],
    });
    const cancelled = await control(
      t,
      started.missionId,
      "control-cancel-1",
      "cancel",
      1,
    );
    expect(cancelled).toMatchObject({
      applied: true,
      replayed: false,
      state: "terminal",
      inputRevision: 2,
      wakeTicket: null,
    });
    expect(await control(
      t,
      started.missionId,
      "control-cancel-1",
      "cancel",
      1,
    )).toMatchObject({
      applied: true,
      replayed: true,
      state: "terminal",
      inputRevision: 2,
    });
    expect(await control(
      t,
      started.missionId,
      "control-cancel-terminal-noop",
      "cancel",
      2,
    )).toMatchObject({
      applied: false,
      noop: true,
      reason: "terminal_noop",
      state: "terminal",
      inputRevision: 2,
      wakeTicket: null,
    });
    expect(await control(
      t,
      started.missionId,
      "control-pause-terminal-reject",
      "pause",
      2,
    )).toMatchObject({
      applied: false,
      noop: false,
      reason: "terminal_state",
      state: "terminal",
      inputRevision: 2,
      wakeTicket: null,
    });
    expect(await start(t, "terminal-controls", {
      projectAdmissions: [admission],
    })).toMatchObject({
      replayed: true,
      wakeTicket: null,
    });
  });

  it("resumes a zero-job planning question with durable input and resolves its attention", async () => {
    const t = convexTest(schema, modules);
    const started = await start(t, "provide-planning-input");
    const leased = await claimSuccess(t, started.missionId, 0);
    const requested = await t.mutation(supervisorApi.commitV1, commitInput(
      started.missionId,
      leased,
      {
        kind: "request_input",
        question: "Which deployment boundary should this mission prioritize?",
        reason: "The admitted planning scope has two safe interpretations.",
      },
      {
        ...MODEL_METADATA,
        triggerRunId: "trigger-request-input-zero-job",
      },
    ));
    expect(requested).toMatchObject({
      committed: true,
      resultState: "needs_input",
    });
    expect(await supervisorCommand(t, started.missionId)).toMatchObject({
      state: "needs_input",
      totalJobs: 0,
      inputTargeted: false,
      question: "Which deployment boundary should this mission prioritize?",
    });

    const provided = await control(
      t,
      started.missionId,
      "control-provide-input-1",
      "provide_input",
      1,
      "Prioritize the isolated Jarvis deployment boundary first.",
    );
    expect(provided).toMatchObject({
      applied: true,
      replayed: false,
      scope: "planning_only_zero_jobs",
      state: "ready",
      inputRevision: 2,
      wakeTicket: {
        protocolVersion: 1,
        missionId: started.missionId,
        expectedLeaseVersion: leased.leaseVersion,
        expectedEpoch: leased.epoch,
        expectedDecisionSequence: leased.nextDecisionSequence + 1,
        expectedInputRevision: 2,
      },
    });
    expect(await control(
      t,
      started.missionId,
      "control-provide-input-1",
      "provide_input",
      1,
      "Prioritize the isolated Jarvis deployment boundary first.",
    )).toMatchObject({
      applied: true,
      replayed: true,
      inputRevision: 2,
      wakeTicket: provided.wakeTicket,
    });

    const persisted = await t.run(async (ctx) => ({
      state: await ctx.db.get(started.stateId),
      mission: await ctx.db.get(started.missionId),
      attention: await ctx.db
        .query("attentionItems")
        .withIndex("by_fingerprint", (q) =>
          q.eq(
            "fingerprint",
            `mission-supervisor:${String(started.missionId)}:needs-input`,
          )
        )
        .unique(),
    }));
    expect(persisted.state).toMatchObject({
      state: "ready",
      inputRevision: 2,
      nextDecisionSequence: 2,
    });
    expect(persisted.mission).toMatchObject({
      status: "running",
      phase: "planning",
      steer: "Prioritize the isolated Jarvis deployment boundary first.",
      steerRevision: 1,
    });
    expect(persisted.mission?.failureReason).toBeUndefined();
    expect(persisted.attention).toMatchObject({
      authority: "mission-supervisor",
      status: "resolved",
    });

    const nextClaim = await claimSuccess(
      t,
      started.missionId,
      provided.wakeTicket.expectedLeaseVersion,
      "worker-two",
      "lease-token-worker-two-0001",
    );
    expect(nextClaim).toMatchObject({
      epoch: provided.wakeTicket.expectedEpoch,
      nextDecisionSequence: provided.wakeTicket.expectedDecisionSequence,
      inputRevision: provided.wakeTicket.expectedInputRevision,
    });
    expect(nextClaim.snapshot).toMatchObject({
      mission: {
        steer: "Prioritize the isolated Jarvis deployment boundary first.",
        steerRevision: 1,
      },
    });
  });

  it("fails mission controls closed while existing work needs a fenced batch primitive", async () => {
    const t = convexTest(schema, modules);
    const started = await start(t, "control-active-job-gate");
    const leased = await claimSuccess(t, started.missionId, 0);
    const delegated = await t.mutation(supervisorApi.commitV1, commitInput(
      started.missionId,
      leased,
      {
        kind: "delegate",
        workstreams: [delegatedWorkstream()],
      },
      {
        ...MODEL_METADATA,
        triggerRunId: "trigger-control-active-job",
      },
    ));
    expect(delegated).toMatchObject({
      committed: true,
      resultState: "waiting",
    });
    const jobId = delegated.createdJobIds[0] as Id<"jobs">;

    for (const [requestKey, action, input] of [
      ["control-active-pause", "pause", undefined],
      [
        "control-active-steer",
        "steer",
        "Revise the live worker even though no batch authority exists.",
      ],
      ["control-active-cancel", "cancel", undefined],
      [
        "control-active-input",
        "provide_input",
        "Do not manufacture a planning-input loop around live work.",
      ],
    ] as const) {
      expect(await control(
        t,
        started.missionId,
        requestKey,
        action,
        1,
        input,
      )).toMatchObject({
        applied: false,
        replayed: false,
        noop: false,
        reason: "active_jobs_require_batch_control",
        state: "waiting",
        inputRevision: 1,
        wakeTicket: null,
      });
    }

    const persisted = await t.run(async (ctx) => ({
      state: await ctx.db.get(started.stateId),
      mission: await ctx.db.get(started.missionId),
      job: await ctx.db.get(jobId),
      controls: await ctx.db
        .query("missionSupervisorControls")
        .withIndex("by_mission_created", (q) =>
          q.eq("missionId", started.missionId)
        )
        .collect(),
    }));
    expect(persisted.state).toMatchObject({
      state: "waiting",
      inputRevision: 1,
      leaseVersion: leased.leaseVersion,
      nextDecisionSequence: 2,
    });
    expect(persisted.mission).toMatchObject({
      status: "running",
      phase: "executing",
    });
    expect(persisted.job).toMatchObject({
      status: "pending",
      steerRevision: 0,
    });
    expect(persisted.controls).toHaveLength(4);
  });

  it("returns at most eight exact ready, waiting, or expired-lease rows", async () => {
    const t = convexTest(schema, modules);
    const admission = await testProjectSourceAdmission();
    const starts: StartResult[] = [];
    for (let index = 0; index < 12; index += 1) {
      starts.push(await start(t, `due-${index}`, {
        projectAdmissions: [admission],
      }));
    }
    const now = Date.now();
    await t.run(async (ctx) => {
      const rows = [];
      for (const started of starts) {
        rows.push((await ctx.db
          .query("missionSupervisorState")
          .withIndex("by_mission", (q) => q.eq("missionId", started.missionId))
          .unique())!);
      }
      await ctx.db.patch(rows[0]._id, { state: "ready", nextTickAt: now - 9_000 });
      await ctx.db.patch(rows[1]._id, { state: "waiting", nextTickAt: now - 8_000 });
      await ctx.db.patch(rows[2]._id, {
        state: "leased",
        nextTickAt: undefined,
        leaseOwner: "old-worker",
        leaseToken: "lease-token-old-worker-0001",
        leaseUntil: now - 7_000,
      });
      await ctx.db.patch(rows[3]._id, { state: "ready", nextTickAt: undefined });
      await ctx.db.patch(rows[4]._id, { state: "waiting", nextTickAt: now + 1 });
      await ctx.db.patch(rows[5]._id, {
        state: "leased",
        nextTickAt: undefined,
        leaseOwner: "fresh-worker",
        leaseToken: "lease-token-fresh-worker-0001",
        leaseUntil: now + 1,
      });
      for (let index = 6; index < rows.length; index += 1) {
        await ctx.db.patch(rows[index]._id, {
          state: "ready",
          nextTickAt: now - (12 - index) * 1_000,
        });
      }
    });

    const due = await t.query(supervisorApi.dueV1, {
      limit: MISSION_SUPERVISOR_MAX_DUE,
      workerToken: WORKER,
    });
    expect(due).toHaveLength(MISSION_SUPERVISOR_MAX_DUE);
    expect(new Set(due.map((row: { state: string }) => row.state))).toEqual(
      new Set(["ready", "waiting", "leased"]),
    );
    const returned = new Set(
      due.map((row: { missionId: Id<"missions"> }) => String(row.missionId)),
    );
    expect(returned.has(String(starts[3].missionId))).toBe(false);
    expect(returned.has(String(starts[4].missionId))).toBe(false);
    expect(returned.has(String(starts[5].missionId))).toBe(false);
  });

  it("claims exclusively and reclaims only after the exact ten-minute lease expires", async () => {
    const t = convexTest(schema, modules);
    const started = await start(t, "exclusive-claim");
    const first = await claim(t, started.missionId, 0);
    expect(first).toMatchObject({
      claimed: true,
      missionId: started.missionId,
      leaseVersion: 1,
    });
    expect(first.leaseUntil).toBe(Date.now() + MISSION_SUPERVISOR_LEASE_MS);

    expect(await claim(
      t,
      started.missionId,
      0,
      "worker-two",
      "lease-token-worker-two-0001",
    )).toMatchObject({
      claimed: false,
      reason: "lease_version_mismatch",
    });
    expect(await claim(
      t,
      started.missionId,
      1,
      "worker-two",
      "lease-token-worker-two-0001",
    )).toMatchObject({ claimed: false, reason: "not_due" });

    vi.setSystemTime(first.leaseUntil + 1);
    const reclaimed = await claim(
      t,
      started.missionId,
      1,
      "worker-two",
      "lease-token-worker-two-0001",
    );
    expect(reclaimed).toMatchObject({
      claimed: true,
      leaseVersion: 2,
    });
  });

  it("enforces every renewal fence and releases a stale input revision", async () => {
    const t = convexTest(schema, modules);
    const started = await start(t, "renew-fences");
    const claimed = await claim(t, started.missionId, 0);
    expect(claimed.claimed).toBe(true);
    const fence = exactFence(started.missionId, claimed);

    for (const mismatch of [
      { leaseOwner: "worker-two" },
      { leaseToken: "lease-token-worker-two-0001" },
      { leaseVersion: claimed.leaseVersion + 1 },
      { expectedEpoch: claimed.epoch + 1 },
      { expectedDecisionSequence: claimed.nextDecisionSequence + 1 },
    ]) {
      expect(await t.mutation(supervisorApi.renewV1, {
        ...fence,
        ...mismatch,
      })).toMatchObject({ renewed: false, reason: "fence_mismatch" });
    }

    expect(await t.mutation(supervisorApi.releaseFailureV1, {
      ...fence,
      leaseVersion: claimed.leaseVersion + 1,
      errorCode: "bounded_worker_failure",
    })).toMatchObject({ released: false, reason: "fence_mismatch" });
    await expect(t.mutation(supervisorApi.releaseFailureV1, {
      ...fence,
      errorCode: "raw error containing secret-like text",
    })).rejects.toThrow("redacted lower-case code");
    expect(await t.mutation(supervisorApi.renewV1, fence)).toMatchObject({
      renewed: true,
      leaseVersion: claimed.leaseVersion,
    });

    await t.run(async (ctx) => {
      const state = (await ctx.db
        .query("missionSupervisorState")
        .withIndex("by_mission", (q) => q.eq("missionId", started.missionId))
        .unique())!;
      await ctx.db.patch(state._id, {
        inputRevision: state.inputRevision + 1,
        updatedAt: Date.now(),
      });
    });
    expect(await t.mutation(supervisorApi.renewV1, fence)).toMatchObject({
      renewed: false,
      reason: "input_revision_changed",
      stale: true,
      released: true,
      inputRevision: claimed.inputRevision + 1,
    });
    const releasedState = await supervisorState(t, started.missionId);
    expect(releasedState?.state).toBe("ready");
    expect(releasedState?.leaseOwner).toBeUndefined();
    expect(releasedState?.leaseToken).toBeUndefined();
    expect(releasedState?.leaseUntil).toBeUndefined();
  });

  it("keeps the authoritative snapshot digest stable across UI and heartbeat churn", async () => {
    const t = convexTest(schema, modules);
    const started = await start(t, "stable-snapshot");
    const jobId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("jobs", {
        task: "Inspect durable supervisor snapshot boundaries.",
        missionId: String(started.missionId),
        label: "snapshot boundary",
        status: "running",
        stage: "working",
        percent: 10,
        progress: "starting",
        log: "transient log one",
        checkpoint: "transient checkpoint one",
        heartbeatAt: Date.now(),
        progressAt: Date.now(),
        attempt: 1,
        maxAttempts: 2,
        createdAt: Date.now(),
      });
      const state = (await ctx.db
        .query("missionSupervisorState")
        .withIndex("by_mission", (q) => q.eq("missionId", started.missionId))
        .unique())!;
      await ctx.db.patch(state._id, {
        totalJobs: 1,
        dirtyJobIds: [id],
        updatedAt: Date.now(),
      });
      return id;
    });
    const first = await claim(t, started.missionId, 0);
    expect(first.claimed).toBe(true);

    await t.run(async (ctx) => {
      await ctx.db.patch(jobId, {
        stage: "still-working",
        percent: 91,
        progress: "transient progress changed",
        log: "transient log two",
        checkpoint: "transient checkpoint two",
        heartbeatAt: Date.now() + 100_000,
        progressAt: Date.now() + 100_000,
      });
    });
    vi.setSystemTime(first.leaseUntil + 1);
    const second = await claim(
      t,
      started.missionId,
      1,
      "worker-two",
      "lease-token-worker-two-0001",
    );
    expect(second).toMatchObject({
      claimed: true,
      snapshotDigest: first.snapshotDigest,
    });
  });

  it("fails closed when a mission exceeds its bounded job authority", async () => {
    const t = convexTest(schema, modules);
    const started = await start(t, "job-overflow");
    await t.run(async (ctx) => {
      for (let index = 0; index < MISSION_SUPERVISOR_MAX_JOBS + 1; index += 1) {
        await ctx.db.insert("jobs", {
          task: `Bounded overflow fixture ${index}`,
          missionId: String(started.missionId),
          status: "pending",
          createdAt: Date.now() + index,
        });
      }
    });

    expect(await claim(t, started.missionId, 0)).toMatchObject({
      claimed: false,
      reason: "supervisor_job_limit",
      escalated: true,
    });
    const persisted = await t.run(async (ctx) => ({
      state: await ctx.db
        .query("missionSupervisorState")
        .withIndex("by_mission", (q) => q.eq("missionId", started.missionId))
        .unique(),
      mission: await ctx.db.get(started.missionId),
      attention: await ctx.db
        .query("attentionItems")
        .withIndex("by_fingerprint", (q) =>
          q.eq(
            "fingerprint",
            `mission-supervisor:${String(started.missionId)}:needs-input`,
          )
        )
        .collect(),
    }));
    expect(persisted.state?.state).toBe("needs_input");
    expect(persisted.mission?.status).toBe("needs_input");
    expect(persisted.attention).toHaveLength(1);
  });

  it("backs off exponentially, then escalates once with a deduplicated attention item", async () => {
    const t = convexTest(schema, modules);
    const started = await start(t, "failure-backoff");
    const expectedBackoffs = [30_000, 60_000, 120_000, 240_000];

    for (let failure = 1; failure <= 5; failure += 1) {
      const claimed = await claim(t, started.missionId, failure - 1);
      expect(claimed.claimed).toBe(true);
      const released = await t.mutation(supervisorApi.releaseFailureV1, {
        ...exactFence(started.missionId, claimed),
        errorCode: "bounded_worker_failure",
      });
      if (failure < 5) {
        expect(released).toMatchObject({
          released: true,
          escalated: false,
          failures: failure,
          backoffMs: expectedBackoffs[failure - 1],
        });
        vi.setSystemTime(released.nextTickAt);
      } else {
        expect(released).toMatchObject({
          released: true,
          escalated: true,
          failures: 5,
        });
      }
    }

    const persisted = await t.run(async (ctx) => ({
      state: await ctx.db
        .query("missionSupervisorState")
        .withIndex("by_mission", (q) => q.eq("missionId", started.missionId))
        .unique(),
      mission: await ctx.db.get(started.missionId),
      runtime: await ctx.db
        .query("missionRuntime")
        .withIndex("by_mission", (q) => q.eq("missionId", started.missionId))
        .unique(),
      attention: await ctx.db
        .query("attentionItems")
        .withIndex("by_fingerprint", (q) =>
          q.eq(
            "fingerprint",
            `mission-supervisor:${String(started.missionId)}:needs-input`,
          )
        )
        .collect(),
    }));
    expect(persisted.state).toMatchObject({
      state: "needs_input",
      consecutiveFailures: 5,
      lastErrorCode: "bounded_worker_failure",
    });
    expect(persisted.mission).toMatchObject({
      status: "needs_input",
      phase: "needs_input",
    });
    expect(persisted.runtime).toMatchObject({
      status: "needs_input",
      phase: "needs_input",
    });
    expect(persisted.attention).toHaveLength(1);
  });

  it("escalates an exact failed lease at the bounded mission deadline", async () => {
    const t = convexTest(schema, modules);
    const started = await start(t, "deadline-escalation", {
      deadlineMs: 10 * 60_000,
    });
    const claimed = await claim(t, started.missionId, 0);
    expect(claimed.claimed).toBe(true);
    vi.setSystemTime(started.deadlineAt + 1);

    expect(await t.mutation(supervisorApi.releaseFailureV1, {
      ...exactFence(started.missionId, claimed),
      errorCode: "bounded_deadline_failure",
    })).toMatchObject({
      released: true,
      escalated: true,
      failures: 1,
    });
    expect(await supervisorState(t, started.missionId)).toMatchObject({
      state: "needs_input",
      consecutiveFailures: 1,
      lastErrorCode: "bounded_deadline_failure",
    });
  });

  it("commits real policy-gated jobs once with zero-based decision provenance and effect-only replay", async () => {
    const t = convexTest(schema, modules);
    const admission = await testProjectSourceAdmission(
      "daniels-project-space/jarvis",
    );
    const started = await start(t, "commit-delegate-replay", {
      repo: "daniels-project-space/jarvis",
      projectAdmissions: [admission],
    });
    const claimed = await claimSuccess(t, started.missionId, 0);
    const decision: CommitDecision = {
      kind: "delegate",
      workstreams: [
        delegatedWorkstream(),
        delegatedWorkstream({
          task: "Send a rental reply to the customer immediately.",
          label: "Consequential renter reply",
          model: "luna",
          agentId: "atlas",
          risk: "low",
          acceptanceCriteria: ["The reply remains gated for Daniel."],
        }),
      ],
    };
    const originalInput = commitInput(
      started.missionId,
      claimed,
      decision,
      MODEL_METADATA,
    );
    const committed = await t.mutation(
      supervisorApi.commitV1,
      originalInput,
    );
    expect(committed).toMatchObject({
      committed: true,
      replayed: false,
      kind: "delegate",
      resultState: "waiting",
    });
    expect(committed.createdJobIds).toHaveLength(2);

    const persisted = await t.run(async (ctx) => ({
      jobs: await ctx.db
        .query("jobs")
        .withIndex("by_mission", (q) =>
          q.eq("missionId", String(started.missionId))
        )
        .collect(),
      approvals: await ctx.db.query("approvals").collect(),
      decisions: await ctx.db
        .query("missionSupervisorDecisions")
        .withIndex("by_mission_epoch_sequence", (q) =>
          q.eq("missionId", started.missionId)
        )
        .collect(),
      state: await ctx.db.get(started.stateId),
      mission: await ctx.db.get(started.missionId),
    }));
    expect(persisted.jobs.map((job) => job.supervisorJobOrdinal)).toEqual([0, 1]);
    expect(persisted.jobs.every((job) =>
      job.supervisorEpoch === claimed.epoch
      && job.supervisorDecisionKey === committed.decisionKey
      && job.repo === "daniels-project-space/jarvis"
      && job.schedulingBound === true
      && job.dispatchReady === true
      && job.workOrderRevision === 1
      && Array.isArray(job.dependsOn)
      && job.dependsOn.length === 0
    )).toBe(true);
    expect(persisted.jobs.map((job) => job.status)).toEqual([
      "pending",
      "awaiting_approval",
    ]);
    expect(persisted.jobs.map((job) => job.approvalRequired)).toEqual([
      false,
      true,
    ]);
    expect(persisted.approvals).toHaveLength(1);
    expect(persisted.approvals[0]).toMatchObject({
      jobId: String(committed.createdJobIds[1]),
      status: "pending",
      kind: "consequential-work",
    });
    expect(persisted.decisions).toHaveLength(1);
    expect(persisted.decisions[0]).toMatchObject({
      decisionOrigin: "model",
      modelProvider: "codex-subscription",
      modelId: MODEL_METADATA.modelId,
      triggerRunId: MODEL_METADATA.triggerRunId,
      createdJobIds: committed.createdJobIds,
    });
    expect(persisted.state).toMatchObject({
      state: "waiting",
      totalJobs: 2,
      decisionCount: 1,
      nextDecisionSequence: 2,
      handledInputRevision: claimed.inputRevision,
    });
    expect(persisted.mission).toMatchObject({
      status: "running",
      phase: "executing",
      agentCount: 2,
    });

    const replay = await t.mutation(supervisorApi.commitV1, {
      ...originalInput,
      leaseVersion: claimed.leaseVersion + 999,
      rationale: "A transport retry may carry a different explanation.",
      triggerRunId: "trigger-model-run-retry",
      deploymentVersion: "test-deployment-retry",
      modelId: "gpt-5.6-terra-retry",
      tierReason: "retry metadata must not change effect identity",
    });
    expect(replay).toMatchObject({
      committed: true,
      replayed: true,
      decisionId: committed.decisionId,
      decisionKey: committed.decisionKey,
      createdJobIds: committed.createdJobIds,
    });
    await expect(t.mutation(supervisorApi.commitV1, {
      ...originalInput,
      decision: {
        ...decision,
        workstreams: [
          {
            ...decision.workstreams[0],
            label: "Conflicting immutable effect",
          },
          decision.workstreams[1],
        ],
      },
    })).rejects.toThrow(
      "decision slot conflicts with a different immutable decision",
    );
    const replayCounts = await t.run(async (ctx) => ({
      jobs: (await ctx.db
        .query("jobs")
        .withIndex("by_mission", (q) =>
          q.eq("missionId", String(started.missionId))
        )
        .collect()).length,
      decisions: (await ctx.db
        .query("missionSupervisorDecisions")
        .withIndex("by_mission_epoch_sequence", (q) =>
          q.eq("missionId", started.missionId)
        )
        .collect()).length,
      approvals: (await ctx.db.query("approvals").collect()).length,
    }));
    expect(replayCounts).toEqual({ jobs: 2, decisions: 1, approvals: 1 });
  });

  it("rejects every stale commit fence and untruthful authorship without writes", async () => {
    const t = convexTest(schema, modules);
    const started = await start(t, "commit-stale-fences");
    const other = await start(t, "commit-stale-other");
    const claimed = await claimSuccess(t, started.missionId, 0);
    const decision: CommitDecision = {
      kind: "wait",
      delayMs: 10_000,
      reason: "No authoritative input changed yet.",
    };
    const input = commitInput(
      started.missionId,
      claimed,
      decision,
      POLICY_METADATA,
    );
    const fenceCases = [
      {
        patch: { missionId: other.missionId },
        reason: "fence_mismatch",
      },
      {
        patch: { leaseOwner: "worker-two" },
        reason: "fence_mismatch",
      },
      {
        patch: { leaseToken: "lease-token-worker-two-0001" },
        reason: "fence_mismatch",
      },
      {
        patch: { leaseVersion: claimed.leaseVersion + 1 },
        reason: "fence_mismatch",
      },
      {
        patch: { expectedEpoch: claimed.epoch + 1 },
        reason: "fence_mismatch",
      },
      {
        patch: {
          expectedDecisionSequence: claimed.nextDecisionSequence + 1,
        },
        reason: "fence_mismatch",
      },
      {
        patch: { expectedInputRevision: claimed.inputRevision + 1 },
        reason: "input_revision_mismatch",
      },
      {
        patch: { expectedSnapshotDigest: "f".repeat(64) },
        reason: "snapshot_digest_mismatch",
      },
    ];
    for (const testCase of fenceCases) {
      expect(await t.mutation(supervisorApi.commitV1, {
        ...input,
        ...testCase.patch,
      })).toMatchObject({
        committed: false,
        replayed: false,
        reason: testCase.reason,
      });
    }

    await expect(t.mutation(supervisorApi.commitV1, {
      ...input,
      decisionOrigin: "model",
      modelProvider: "deterministic-policy",
      reasoningEffort: "high",
    })).rejects.toThrow("decisionOrigin and modelProvider do not match");
    await expect(t.mutation(supervisorApi.commitV1, {
      ...input,
      ...MODEL_METADATA,
    })).rejects.toThrow("wait must use deterministic policy authorship");
    await expect(t.mutation(supervisorApi.commitV1, {
      ...input,
      decision: {
        kind: "delegate",
        workstreams: [delegatedWorkstream({ readonly: true })],
      },
      ...POLICY_METADATA,
    })).rejects.toThrow("delegate must use Codex subscription authorship");

    vi.setSystemTime(claimed.leaseUntil + 1);
    expect(await t.mutation(supervisorApi.commitV1, input)).toMatchObject({
      committed: false,
      reason: "lease_expired",
    });
    const persisted = await t.run(async (ctx) => ({
      state: await ctx.db.get(started.stateId),
      decisions: await ctx.db
        .query("missionSupervisorDecisions")
        .withIndex("by_mission_epoch_sequence", (q) =>
          q.eq("missionId", started.missionId)
        )
        .collect(),
      jobs: await ctx.db
        .query("jobs")
        .withIndex("by_mission", (q) =>
          q.eq("missionId", String(started.missionId))
        )
        .collect(),
    }));
    expect(persisted.state).toMatchObject({
      state: "leased",
      leaseVersion: claimed.leaseVersion,
      decisionCount: 0,
    });
    expect(persisted.decisions).toEqual([]);
    expect(persisted.jobs).toEqual([]);
  });

  it("rolls back unadmitted, duplicate, and over-cap delegation decisions", async () => {
    const t = convexTest(schema, modules);
    const admission = await testProjectSourceAdmission(
      "daniels-project-space/jarvis",
    );
    const started = await start(t, "commit-invalid-delegate", {
      repo: "daniels-project-space/jarvis",
      projectAdmissions: [admission],
    });
    const firstClaim = await claimSuccess(t, started.missionId, 0);
    await expect(t.mutation(supervisorApi.commitV1, commitInput(
      started.missionId,
      firstClaim,
      {
        kind: "delegate",
        workstreams: [delegatedWorkstream({
          repo: "daniels-project-space/rental-manager-v2",
        })],
      },
      MODEL_METADATA,
    ))).rejects.toThrow("outside the mission project admissions");
    expect((await supervisorState(t, started.missionId))?.state).toBe("leased");

    const first = await t.mutation(supervisorApi.commitV1, commitInput(
      started.missionId,
      firstClaim,
      {
        kind: "delegate",
        workstreams: [delegatedWorkstream({
          task: "Fix  checkout",
        })],
      },
      MODEL_METADATA,
    ));
    vi.setSystemTime(first.nextTickAt);
    const secondClaim = await claimSuccess(t, started.missionId, 1);
    await expect(t.mutation(supervisorApi.commitV1, commitInput(
      started.missionId,
      secondClaim,
      {
        kind: "delegate",
        workstreams: [delegatedWorkstream({
          task: "fix checkout",
          label: "Same work under a different label",
          acceptanceCriteria: ["A differently worded criterion."],
        })],
      },
      MODEL_METADATA,
    ))).rejects.toThrow("duplicates existing mission work");
    const afterDuplicate = await t.run(async (ctx) => ({
      jobs: await ctx.db
        .query("jobs")
        .withIndex("by_mission", (q) =>
          q.eq("missionId", String(started.missionId))
        )
        .collect(),
      decisions: await ctx.db
        .query("missionSupervisorDecisions")
        .withIndex("by_mission_epoch_sequence", (q) =>
          q.eq("missionId", started.missionId)
        )
        .collect(),
      state: await ctx.db.get(started.stateId),
    }));
    expect(afterDuplicate.jobs).toHaveLength(1);
    expect(afterDuplicate.decisions).toHaveLength(1);
    expect(afterDuplicate.state).toMatchObject({
      state: "leased",
      totalJobs: 1,
      decisionCount: 1,
    });

    const capped = await start(t, "commit-job-cap");
    await t.run(async (ctx) => {
      for (let index = 0; index < MISSION_SUPERVISOR_MAX_JOBS; index += 1) {
        await ctx.db.insert("jobs", {
          task: `Existing bounded cap fixture ${index}`,
          missionId: String(capped.missionId),
          agentId: "paul",
          status: "pending",
          createdAt: Date.now() + index,
        });
      }
      await ctx.db.patch(capped.stateId, {
        totalJobs: MISSION_SUPERVISOR_MAX_JOBS,
      });
    });
    const capClaim = await claimSuccess(t, capped.missionId, 0);
    expect(await t.mutation(supervisorApi.commitV1, commitInput(
      capped.missionId,
      capClaim,
      {
        kind: "delegate",
        workstreams: [delegatedWorkstream({ readonly: true })],
      },
      MODEL_METADATA,
    ))).toMatchObject({
      committed: false,
      reason: "job_limit_reached",
    });
    expect((await supervisorState(t, capped.missionId)?.then((row) =>
      row?.decisionCount
    ))).toBe(0);
  });

  it("commits deterministic wait and replan transitions with bounded release", async () => {
    const t = convexTest(schema, modules);
    const started = await start(t, "commit-wait-replan");
    const firstClaim = await claimSuccess(t, started.missionId, 0);
    const wait = await t.mutation(supervisorApi.commitV1, commitInput(
      started.missionId,
      firstClaim,
      {
        kind: "wait",
        delayMs: 45_000,
        reason: "Wait for the next bounded observation window.",
      },
      POLICY_METADATA,
    ));
    expect(wait).toMatchObject({
      committed: true,
      kind: "wait",
      resultState: "waiting",
      nextTickAt: Date.now() + 45_000,
    });
    expect(await supervisorState(t, started.missionId)).toMatchObject({
      state: "waiting",
      epoch: 1,
      nextDecisionSequence: 2,
      decisionCount: 1,
    });

    vi.setSystemTime(wait.nextTickAt);
    const secondClaim = await claimSuccess(t, started.missionId, 1);
    const replan = await t.mutation(supervisorApi.commitV1, commitInput(
      started.missionId,
      secondClaim,
      {
        kind: "replan",
        reason: "Advance one epoch and derive a fresh bounded plan.",
      },
      {
        ...POLICY_METADATA,
        triggerRunId: "trigger-policy-run-2",
      },
    ));
    expect(replan).toMatchObject({
      committed: true,
      kind: "replan",
      resultState: "ready",
      nextTickAt: Date.now(),
    });
    const persisted = await t.run(async (ctx) => ({
      state: await ctx.db.get(started.stateId),
      mission: await ctx.db.get(started.missionId),
      decisions: await ctx.db
        .query("missionSupervisorDecisions")
        .withIndex("by_mission_epoch_sequence", (q) =>
          q.eq("missionId", started.missionId)
        )
        .collect(),
    }));
    expect(persisted.state).toMatchObject({
      state: "ready",
      epoch: 2,
      nextDecisionSequence: 3,
      decisionCount: 2,
    });
    expect(persisted.mission).toMatchObject({
      status: "running",
      phase: "planning",
    });
    expect(persisted.decisions.map((row) => row.decisionOrigin)).toEqual([
      "policy",
      "policy",
    ]);
    expect(persisted.decisions.every((row) =>
      row.modelProvider === "deterministic-policy"
      && row.modelId === "jarvis-supervisor-policy-v1"
      && row.reasoningEffort === "none"
    )).toBe(true);
  });

  it("deduplicates model request-input attention and background delivery", async () => {
    const t = convexTest(schema, modules);
    const started = await start(t, "commit-request-input", {
      originThreadId: "supervisor-thread",
    });
    const claimed = await claimSuccess(t, started.missionId, 0);
    const input = commitInput(
      started.missionId,
      claimed,
      {
        kind: "request_input",
        question: "Which product direction should the specialist prioritize now?",
        reason: "The planning network returned no safe independent proposal.",
      },
      MODEL_METADATA,
    );
    const committed = await t.mutation(supervisorApi.commitV1, input);
    expect(committed).toMatchObject({
      committed: true,
      replayed: false,
      kind: "request_input",
      resultState: "needs_input",
    });
    expect(committed.chatMessageIds).toHaveLength(1);
    expect(committed.attentionItemId).toBeTruthy();
    const replay = await t.mutation(supervisorApi.commitV1, {
      ...input,
      triggerRunId: "trigger-model-request-retry",
      rationale: "Retry metadata differs after a lost response.",
    });
    expect(replay).toMatchObject({
      committed: true,
      replayed: true,
      decisionId: committed.decisionId,
      attentionItemId: committed.attentionItemId,
      chatMessageIds: committed.chatMessageIds,
    });
    const persisted = await t.run(async (ctx) => ({
      state: await ctx.db.get(started.stateId),
      mission: await ctx.db.get(started.missionId),
      attention: await ctx.db
        .query("attentionItems")
        .withIndex("by_fingerprint", (q) =>
          q.eq(
            "fingerprint",
            `mission-supervisor:${String(started.missionId)}:needs-input`,
          )
        )
        .collect(),
      notifications: await ctx.db
        .query("chatMessages")
        .withIndex("by_thread", (q) => q.eq("threadId", "supervisor-thread"))
        .collect(),
    }));
    expect(persisted.state?.state).toBe("needs_input");
    expect(persisted.mission?.status).toBe("needs_input");
    expect(persisted.attention).toHaveLength(1);
    expect(persisted.notifications).toHaveLength(1);
    expect(persisted.notifications[0]).toMatchObject({
      role: "assistant",
      status: "done",
      delivery: "notification",
    });
  });

  it("terminalizes failure with a redacted reason, attention, and one notification", async () => {
    const t = convexTest(schema, modules);
    const started = await start(t, "commit-terminal-fail");
    const claimed = await claimSuccess(t, started.missionId, 0);
    const secret = "supersecretvalue";
    const committed = await t.mutation(supervisorApi.commitV1, commitInput(
      started.missionId,
      claimed,
      {
        kind: "fail",
        reason: `The safe boundary failed because api_key=${secret} cannot be used.`,
      },
      POLICY_METADATA,
    ));
    expect(committed).toMatchObject({
      committed: true,
      kind: "fail",
      resultState: "terminal",
    });
    const persisted = await t.run(async (ctx) => ({
      state: await ctx.db.get(started.stateId),
      mission: await ctx.db.get(started.missionId),
      decision: await ctx.db.get(committed.decisionId),
      attention: committed.attentionItemId
        ? await ctx.db.get(
            committed.attentionItemId as Id<"attentionItems">,
          )
        : null,
      notification: await ctx.db.get(
        committed.chatMessageIds[0] as Id<"chatMessages">,
      ),
    }));
    expect(persisted.state?.state).toBe("terminal");
    expect(persisted.mission).toMatchObject({
      status: "failed",
      phase: "failed",
    });
    expect(persisted.attention?.severity).toBe("high");
    expect(persisted.notification?.delivery).toBe("notification");
    const persistedText = JSON.stringify(persisted);
    expect(persistedText).not.toContain(secret);
    expect(persistedText).toContain("[REDACTED]");
  });

  it("requires exact terminal receipts and always retains receipt-derived synthesis evidence", async () => {
    const t = convexTest(schema, modules);
    const started = await start(t, "commit-receipt-synthesis");
    const firstClaim = await claimSuccess(t, started.missionId, 0);
    const delegated = await t.mutation(supervisorApi.commitV1, commitInput(
      started.missionId,
      firstClaim,
      {
        kind: "delegate",
        workstreams: [delegatedWorkstream({
          task: "Inspect the bounded synthesis receipt and return exact evidence.",
          label: "Receipt evidence",
          readonly: true,
          agentId: "iris",
        })],
      },
      MODEL_METADATA,
    ));
    const jobId = delegated.createdJobIds[0] as Id<"jobs">;
    const tampered = await seedVerifiedReceipt(t, jobId, {
      acceptanceEvidence: ["Receipt-bound verification evidence."],
      tamperAuthorityDigest: true,
    });
    vi.setSystemTime(delegated.nextTickAt);
    const tamperedClaim = await claimSuccess(t, started.missionId, 1);
    const snapshot = tamperedClaim.snapshot as {
      jobs: Array<{
        authorityDigest: string | null;
        evidenceDigest: string | null;
        resultDigest: string | null;
        receipt: null | {
          jobId: string;
          attempt: number;
          authorityDigest: string | null;
          schedulingBindingDigest: string | null;
          workOrderRevision: number | null;
          workOrderRevisionDigest: string | null;
          resultDigest: string | null;
          evidenceDigest: string | null;
          acceptanceEvidence: string[];
          artifacts: string[];
        };
      }>;
    };
    expect(snapshot.jobs[0]).toMatchObject({
      authorityDigest: tampered.authority.authorityDigest,
      evidenceDigest: tampered.evidenceDigest,
      resultDigest: tampered.resultDigest,
      receipt: {
        jobId: String(jobId),
        attempt: 1,
        authorityDigest: "f".repeat(64),
        schedulingBindingDigest: tampered.authority.schedulingBindingDigest,
        workOrderRevision: 1,
        workOrderRevisionDigest: tampered.authority.workOrderRevisionDigest,
        acceptanceEvidence: ["Receipt-bound verification evidence."],
      },
    });
    const synthesize: CommitDecision = {
      kind: "synthesize",
      summary: "S".repeat(3_990),
    };
    expect(await t.mutation(supervisorApi.commitV1, commitInput(
      started.missionId,
      tamperedClaim,
      synthesize,
      {
        ...MODEL_METADATA,
        triggerRunId: "trigger-model-synthesis-tampered",
      },
    ))).toMatchObject({
      committed: false,
      reason: "synthesis_receipt_binding_mismatch",
      jobId,
    });
    expect((await supervisorState(t, started.missionId))?.decisionCount).toBe(1);

    await t.run(async (ctx) => {
      await ctx.db.delete(tampered.receiptId);
    });
    const verified = await seedVerifiedReceipt(t, jobId, {
      acceptanceEvidence: ["Receipt-bound verification evidence."],
    });
    await t.run(async (ctx) => {
      const state = (await ctx.db.get(started.stateId))!;
      await ctx.db.patch(started.stateId, {
        inputRevision: state.inputRevision + 1,
        dirtyJobIds: [jobId],
        updatedAt: Date.now(),
      });
    });
    expect(await t.mutation(supervisorApi.renewV1, {
      ...exactFence(started.missionId, tamperedClaim),
    })).toMatchObject({
      renewed: false,
      reason: "input_revision_changed",
      stale: true,
      released: true,
    });
    const verifiedClaim = await claimSuccess(t, started.missionId, 2);
    const verifiedSnapshot = verifiedClaim.snapshot as {
      jobs: Array<{
        authorityDigest: string | null;
        receipt: null | {
          authorityDigest: string | null;
          resultDigest: string | null;
          evidenceDigest: string | null;
        };
      }>;
    };
    expect(verifiedSnapshot.jobs[0]).toMatchObject({
      authorityDigest: verified.authority.authorityDigest,
      receipt: {
        authorityDigest: verified.authority.authorityDigest,
        resultDigest: verified.resultDigest,
        evidenceDigest: verified.evidenceDigest,
      },
    });
    const committed = await t.mutation(supervisorApi.commitV1, commitInput(
      started.missionId,
      verifiedClaim,
      synthesize,
      {
        ...MODEL_METADATA,
        triggerRunId: "trigger-model-synthesis-verified",
      },
    ));
    expect(committed).toMatchObject({
      committed: true,
      kind: "synthesize",
      resultState: "terminal",
    });
    const persisted = await t.run(async (ctx) => ({
      state: await ctx.db.get(started.stateId),
      mission: await ctx.db.get(started.missionId),
      notification: await ctx.db.get(
        committed.chatMessageIds[0] as Id<"chatMessages">,
      ),
      decisions: await ctx.db
        .query("missionSupervisorDecisions")
        .withIndex("by_mission_epoch_sequence", (q) =>
          q.eq("missionId", started.missionId)
        )
        .collect(),
    }));
    expect(persisted.state).toMatchObject({
      state: "terminal",
      decisionCount: 2,
      nextDecisionSequence: 3,
      dirtyJobIds: [],
    });
    expect(persisted.mission).toMatchObject({
      status: "done",
      phase: "done",
      percent: 100,
    });
    expect(new TextEncoder().encode(persisted.mission?.summary ?? "").byteLength)
      .toBeLessThanOrEqual(4_000);
    expect(persisted.mission?.summary).toContain("Verified evidence:");
    expect(persisted.mission?.summary).toContain("receipt ");
    expect(persisted.mission?.summary).toContain(
      verified.resultDigest.slice(0, 16),
    );
    expect(persisted.notification?.delivery).toBe("notification");
    expect(persisted.decisions).toHaveLength(2);
  });

  it("replays exact receipts, clones policy retries, and never resets the two-recovery cap", async () => {
    const t = convexTest(schema, modules);
    const admission = await testProjectSourceAdmission(
      "daniels-project-space/jarvis",
    );
    const started = await start(t, "recover-policy-chain", {
      repo: admission.repository,
      projectAdmissions: [admission],
    });
    const firstClaim = await claimSuccess(t, started.missionId, 0);
    const delegated = await t.mutation(supervisorApi.commitV1, commitInput(
      started.missionId,
      firstClaim,
      {
        kind: "delegate",
        workstreams: [delegatedWorkstream({
          repo: admission.repository,
          acceptanceCriteria: [
            "The immutable retry authority remains exactly bound.",
          ],
        })],
      },
      MODEL_METADATA,
    ));
    const rootJobId = delegated.createdJobIds[0] as Id<"jobs">;
    const rootTerminal = await seedRecoveryTerminal(t, rootJobId);

    const receiptReplay = await t.run(async (ctx) => {
      const job = (await ctx.db.get(rootJobId))!;
      return await insertTerminalWorkReceipt(ctx, job, 1, {
        status: "failed",
        terminalCode: "transient_provider_error",
        recoveryDisposition: "retryable",
        acceptanceEvidence: [],
        artifacts: [`convex://jobs/${String(rootJobId)}/attempt/1/terminal`],
        verification: "unavailable",
        result: "Transient provider failure.",
        evidence: "Exact terminal fixture evidence.",
      });
    });
    expect(receiptReplay).toMatchObject({
      replayed: true,
      receiptId: rootTerminal.receiptId,
      receiptDigest: rootTerminal.receiptDigest,
    });
    await expect(t.run(async (ctx) => {
      const job = (await ctx.db.get(rootJobId))!;
      return await insertFreshTerminalWorkReceipt(ctx, job, 1, {
        status: "failed",
        terminalCode: "transient_provider_error",
        recoveryDisposition: "retryable",
        acceptanceEvidence: [],
        artifacts: [`convex://jobs/${String(rootJobId)}/attempt/1/terminal`],
        verification: "unavailable",
        result: "Transient provider failure.",
        evidence: "Exact terminal fixture evidence.",
      });
    })).rejects.toThrow("exists before terminal job transition");
    await expect(t.run(async (ctx) => {
      const job = (await ctx.db.get(rootJobId))!;
      return await insertTerminalWorkReceipt(ctx, job, 1, {
        status: "failed",
        terminalCode: "transient_network_error",
        recoveryDisposition: "retryable",
        acceptanceEvidence: [],
        artifacts: [`convex://jobs/${String(rootJobId)}/attempt/1/terminal`],
        verification: "unavailable",
        result: "Transient provider failure.",
        evidence: "Exact terminal fixture evidence.",
      });
    })).rejects.toThrow("conflicts with immutable authority");

    vi.setSystemTime(delegated.nextTickAt);
    const secondClaim = await claimSuccess(t, started.missionId, 1);
    const recoveryDecision: CommitDecision = {
      kind: "recover",
      recoveries: [{
        mode: "retry",
        predecessorJobId: rootJobId,
        predecessorReceiptDigest: rootTerminal.receiptDigest,
      }],
    };
    await expect(t.mutation(supervisorApi.commitV1, commitInput(
      started.missionId,
      secondClaim,
      recoveryDecision,
      MODEL_METADATA,
    ))).rejects.toThrow("recover must use deterministic policy authorship");
    const firstRecoveryInput = commitInput(
      started.missionId,
      secondClaim,
      recoveryDecision,
      POLICY_METADATA,
    );
    const firstRecovery = await t.mutation(
      supervisorApi.commitV1,
      firstRecoveryInput,
    );
    expect(firstRecovery).toMatchObject({
      committed: true,
      replayed: false,
      kind: "recover",
      resultState: "waiting",
    });
    expect(firstRecovery.createdJobIds).toHaveLength(1);
    expect(firstRecovery.supersessionIds).toHaveLength(1);
    const replay = await t.mutation(supervisorApi.commitV1, {
      ...firstRecoveryInput,
      leaseVersion: secondClaim.leaseVersion + 99,
      triggerRunId: "policy-recovery-replay",
      rationale: "Transport replay metadata cannot change the effect.",
    });
    expect(replay).toMatchObject({
      replayed: true,
      decisionId: firstRecovery.decisionId,
      createdJobIds: firstRecovery.createdJobIds,
      supersessionIds: firstRecovery.supersessionIds,
    });

    const firstSuccessorId = firstRecovery.createdJobIds[0] as Id<"jobs">;
    const firstPersisted = await t.run(async (ctx) => ({
      root: await ctx.db.get(rootJobId),
      successor: await ctx.db.get(firstSuccessorId),
      edge: await ctx.db.get(
        firstRecovery.supersessionIds[0] as Id<"missionSupervisorSupersessions">,
      ),
      mission: await ctx.db.get(started.missionId),
    }));
    expect(firstPersisted.successor).toMatchObject({
      task: firstPersisted.root?.task,
      policyTask: firstPersisted.root?.policyTask,
      repo: firstPersisted.root?.repo,
      readonly: firstPersisted.root?.readonly,
      agentId: firstPersisted.root?.agentId,
      model: firstPersisted.root?.model,
      reasoningEffort: firstPersisted.root?.reasoningEffort,
      acceptanceCriteria: firstPersisted.root?.acceptanceCriteria,
      maxAttempts: 4,
      attempt: 1,
      status: "pending",
    });
    expect(firstPersisted.successor?.workerBranch)
      .not.toBe(firstPersisted.root?.workerBranch);
    expect(firstPersisted.edge).toMatchObject({
      rootJobId,
      predecessorJobId: rootJobId,
      successorJobId: firstSuccessorId,
      predecessorReceiptDigest: rootTerminal.receiptDigest,
      generation: 1,
      autonomousRecoveryCount: 1,
      mode: "retry",
    });
    expect(firstPersisted.mission?.agentCount).toBe(2);

    const firstSuccessorTerminal = await seedRecoveryTerminal(
      t,
      firstSuccessorId,
    );
    vi.setSystemTime(firstRecovery.nextTickAt);
    const thirdClaim = await claimSuccess(t, started.missionId, 2);
    const secondRecovery = await t.mutation(
      supervisorApi.commitV1,
      commitInput(
        started.missionId,
        thirdClaim,
        {
          kind: "recover",
          recoveries: [{
            mode: "retry",
            predecessorJobId: firstSuccessorId,
            predecessorReceiptDigest: firstSuccessorTerminal.receiptDigest,
          }],
        },
        POLICY_METADATA,
      ),
    );
    const secondSuccessorId = secondRecovery.createdJobIds[0] as Id<"jobs">;
    const secondEdge = await t.run(async (ctx) =>
      await ctx.db.get(
        secondRecovery.supersessionIds[0] as Id<"missionSupervisorSupersessions">,
      )
    );
    expect(secondEdge).toMatchObject({
      rootJobId,
      generation: 2,
      autonomousRecoveryCount: 2,
    });

    const secondSuccessorTerminal = await seedRecoveryTerminal(
      t,
      secondSuccessorId,
    );
    vi.setSystemTime(secondRecovery.nextTickAt);
    const fourthClaim = await claimSuccess(t, started.missionId, 3);
    expect(await t.mutation(supervisorApi.commitV1, commitInput(
      started.missionId,
      fourthClaim,
      {
        kind: "recover",
        recoveries: [{
          mode: "retry",
          predecessorJobId: secondSuccessorId,
          predecessorReceiptDigest: secondSuccessorTerminal.receiptDigest,
        }],
      },
      POLICY_METADATA,
    ))).toMatchObject({
      committed: false,
      reason: "autonomous_recovery_limit_reached",
      jobId: secondSuccessorId,
    });
    const counts = await t.run(async (ctx) => ({
      jobs: (await ctx.db
        .query("jobs")
        .withIndex("by_mission", (q) =>
          q.eq("missionId", String(started.missionId))
        )
        .collect()).length,
      edges: (await ctx.db
        .query("missionSupervisorSupersessions")
        .withIndex("by_mission_created", (q) =>
          q.eq("missionId", started.missionId)
        )
        .collect()).length,
    }));
    expect(counts).toEqual({ jobs: 3, edges: 2 });
  });

  it("requires criteria-preserving model remediation, creates fresh approval, and synthesizes only the verified leaf", async () => {
    const t = convexTest(schema, modules);
    const admission = await testProjectSourceAdmission(
      "daniels-project-space/jarvis",
    );
    const rootCriterion = "The original acceptance boundary remains mandatory.";
    const started = await start(t, "recover-remediate-synthesis", {
      repo: admission.repository,
      projectAdmissions: [admission],
    });
    const firstClaim = await claimSuccess(t, started.missionId, 0);
    const delegated = await t.mutation(supervisorApi.commitV1, commitInput(
      started.missionId,
      firstClaim,
      {
        kind: "delegate",
        workstreams: [delegatedWorkstream({
          repo: admission.repository,
          acceptanceCriteria: [rootCriterion],
        })],
      },
      MODEL_METADATA,
    ));
    const rootJobId = delegated.createdJobIds[0] as Id<"jobs">;
    const terminal = await seedRecoveryTerminal(t, rootJobId, {
      terminalCode: "verification_exhausted",
      recoveryDisposition: "remediable",
    });
    vi.setSystemTime(delegated.nextTickAt);
    const secondClaim = await claimSuccess(t, started.missionId, 1);
    const revisedBase = {
      mode: "remediate" as const,
      predecessorJobId: rootJobId,
      predecessorReceiptDigest: terminal.receiptDigest,
      task: "Send a production customer reply immediately after deleting the stale record.",
      label: "Protected remediation",
      model: "terra" as const,
      agentId: "paul" as const,
      risk: "high" as const,
    };
    expect(await t.mutation(supervisorApi.commitV1, commitInput(
      started.missionId,
      secondClaim,
      {
        kind: "recover",
        recoveries: [{
          ...revisedBase,
          acceptanceCriteria: ["A weaker replacement criterion."],
        }],
      },
      MODEL_METADATA,
    ))).toMatchObject({
      committed: false,
      reason: "recovery_authority_downgrade",
      jobId: rootJobId,
    });

    const recovered = await t.mutation(supervisorApi.commitV1, commitInput(
      started.missionId,
      secondClaim,
      {
        kind: "recover",
        recoveries: [{
          ...revisedBase,
          acceptanceCriteria: [
            rootCriterion,
            "Daniel explicitly approves any consequential delivery.",
          ],
        }],
      },
      {
        ...MODEL_METADATA,
        triggerRunId: "model-remediation-valid",
      },
    ));
    const successorId = recovered.createdJobIds[0] as Id<"jobs">;
    const protectedResult = await t.run(async (ctx) => ({
      successor: await ctx.db.get(successorId),
      approvals: await ctx.db
        .query("approvals")
        .withIndex("by_job", (q) => q.eq("jobId", String(successorId)))
        .collect(),
    }));
    expect(protectedResult.successor).toMatchObject({
      status: "awaiting_approval",
      approvalRequired: true,
      approvalStatus: "pending",
      maxAttempts: 4,
      acceptanceCriteria: [
        rootCriterion,
        "Daniel explicitly approves any consequential delivery.",
      ],
    });
    expect(protectedResult.approvals).toHaveLength(1);
    expect(protectedResult.approvals[0]).toMatchObject({
      kind: "consequential-work-recovery",
      status: "pending",
      jobId: String(successorId),
    });

    const verified = await seedVerifiedReceipt(t, successorId, {
      acceptanceEvidence: ["The remediated leaf passed exact verification."],
    });
    vi.setSystemTime(recovered.nextTickAt);
    const thirdClaim = await claimSuccess(t, started.missionId, 2);
    const synthesized = await t.mutation(supervisorApi.commitV1, commitInput(
      started.missionId,
      thirdClaim,
      {
        kind: "synthesize",
        summary: "The recovered workstream completed under exact authority.",
      },
      {
        ...MODEL_METADATA,
        triggerRunId: "model-recovered-synthesis",
      },
    ));
    expect(synthesized).toMatchObject({
      committed: true,
      resultState: "terminal",
      kind: "synthesize",
    });
    const mission = await t.run(async (ctx) =>
      await ctx.db.get(started.missionId)
    );
    expect(mission).toMatchObject({ status: "done", phase: "done" });
    expect(mission?.summary).toContain("remediate recovery g1");
    expect(mission?.summary).toContain(terminal.receiptDigest.slice(0, 16));
    expect(mission?.summary).toContain(verified.resultDigest.slice(0, 16));
  });

  it("binds Daniel input to the exact requested terminal leaf before input-revision recovery", async () => {
    const t = convexTest(schema, modules);
    const admission = await testProjectSourceAdmission(
      "daniels-project-space/jarvis",
    );
    const criterion = "Daniel's exact answer remains part of the recovery boundary.";
    const started = await start(t, "recover-targeted-input", {
      repo: admission.repository,
      projectAdmissions: [admission],
    });
    const firstClaim = await claimSuccess(t, started.missionId, 0);
    const delegated = await t.mutation(supervisorApi.commitV1, commitInput(
      started.missionId,
      firstClaim,
      {
        kind: "delegate",
        workstreams: [delegatedWorkstream({
          repo: admission.repository,
          acceptanceCriteria: [criterion],
        })],
      },
      MODEL_METADATA,
    ));
    const rootJobId = delegated.createdJobIds[0] as Id<"jobs">;
    const terminal = await seedRecoveryTerminal(t, rootJobId, {
      status: "needs_input",
      terminalCode: "agent_input_required",
      recoveryDisposition: "needs_input",
    });
    vi.setSystemTime(delegated.nextTickAt);
    const secondClaim = await claimSuccess(t, started.missionId, 1);
    const inputRevisionDecision: CommitDecision = {
      kind: "recover",
      recoveries: [{
        mode: "input_revision",
        predecessorJobId: rootJobId,
        predecessorReceiptDigest: terminal.receiptDigest,
        task: "Continue with Daniel's exact selected recovery boundary.",
        label: "Daniel-directed continuation",
        model: "terra",
        agentId: "paul",
        risk: "low",
        acceptanceCriteria: [criterion],
      }],
    };
    expect(await t.mutation(supervisorApi.commitV1, commitInput(
      started.missionId,
      secondClaim,
      inputRevisionDecision,
      MODEL_METADATA,
    ))).toMatchObject({
      committed: false,
      reason: "recovery_input_control_missing_or_ambiguous",
      jobId: rootJobId,
    });
    expect(await t.mutation(supervisorApi.commitV1, commitInput(
      started.missionId,
      secondClaim,
      {
        kind: "request_input",
        question: "Which exact implementation boundary should Paul use?",
        reason: "The worker stopped at a protected ambiguity.",
      },
      MODEL_METADATA,
    ))).toMatchObject({
      committed: false,
      reason: "request_input_target_required",
    });
    const requested = await t.mutation(supervisorApi.commitV1, commitInput(
      started.missionId,
      secondClaim,
      {
        kind: "request_input",
        question: "Which exact implementation boundary should Paul use?",
        reason: "The worker stopped at a protected ambiguity.",
        target: {
          predecessorJobId: rootJobId,
          predecessorReceiptDigest: terminal.receiptDigest,
        },
      },
      {
        ...MODEL_METADATA,
        triggerRunId: "model-targeted-input-request",
      },
    ));
    expect(requested).toMatchObject({
      committed: true,
      resultState: "needs_input",
    });
    expect(await supervisorCommand(t, started.missionId)).toMatchObject({
      state: "needs_input",
      totalJobs: 1,
      inputTargeted: true,
      question: "Which exact implementation boundary should Paul use?",
    });
    const answer =
      "Use the isolated backend recovery boundary; do not alter deployment.";
    const provided = await control(
      t,
      started.missionId,
      "targeted-terminal-input",
      "provide_input",
      secondClaim.inputRevision,
      answer,
    );
    expect(provided).toMatchObject({
      applied: true,
      scope: `terminal_leaf_recovery_input:${String(rootJobId)}`,
      state: "ready",
      inputRevision: secondClaim.inputRevision + 1,
    });
    expect(provided.inputDigest).toBe(await sha256Hex(answer));
    const answeredCommand = await supervisorCommand(t, started.missionId);
    expect(answeredCommand).toMatchObject({
      state: "ready",
      inputRevision: secondClaim.inputRevision + 1,
      inputTargeted: false,
    });
    expect(answeredCommand).not.toHaveProperty("question");

    const thirdClaim = await claimSuccess(t, started.missionId, 2);
    expect(thirdClaim.snapshot).toMatchObject({
      pendingInputAuthority: {
        requestDecisionKey: requested.decisionKey,
        predecessorJobId: String(rootJobId),
        predecessorReceiptDigest: terminal.receiptDigest,
        controlReceiptId: String(provided.controlReceiptId),
        controlRequestDigest: provided.requestDigest,
        controlInputDigest: provided.inputDigest,
        controlResultInputRevision: secondClaim.inputRevision + 1,
        steerDigest: provided.inputDigest,
        steerDigestMatchesControl: true,
      },
    });
    const recovered = await t.mutation(supervisorApi.commitV1, commitInput(
      started.missionId,
      thirdClaim,
      inputRevisionDecision,
      {
        ...MODEL_METADATA,
        triggerRunId: "model-targeted-input-recovery",
      },
    ));
    expect(recovered).toMatchObject({
      committed: true,
      kind: "recover",
      resultState: "waiting",
    });
    const edge = await t.run(async (ctx) =>
      await ctx.db.get(
        recovered.supersessionIds[0] as Id<"missionSupervisorSupersessions">,
      )
    );
    expect(edge).toMatchObject({
      mode: "input_revision",
      predecessorJobId: rootJobId,
      predecessorReceiptDigest: terminal.receiptDigest,
      inputControlReceiptId: provided.controlReceiptId,
      inputControlRequestDigest: provided.requestDigest,
      inputControlDigest: provided.inputDigest,
      generation: 1,
      autonomousRecoveryCount: 0,
    });
  });

  it("writes terminal receipts and fails closed on every supervisor in-place resurrection path", async () => {
    const t = convexTest(schema, modules);
    const admission = await testProjectSourceAdmission(
      "daniels-project-space/jarvis",
    );
    const started = await start(t, "supervisor-terminal-writer-guards", {
      repo: admission.repository,
      projectAdmissions: [admission],
    });
    const claimed = await claimSuccess(t, started.missionId, 0);
    const delegated = await t.mutation(supervisorApi.commitV1, commitInput(
      started.missionId,
      claimed,
      {
        kind: "delegate",
        workstreams: [
          delegatedWorkstream({
            repo: admission.repository,
            task: "Inspect the exact input receipt terminal transition.",
            label: "Input receipt",
          }),
          delegatedWorkstream({
            repo: admission.repository,
            task: "Inspect the exact failed receipt retry guard.",
            label: "Retry guard",
          }),
          delegatedWorkstream({
            repo: admission.repository,
            task: "Send a rental reply to the customer immediately.",
            label: "Protected decline",
            agentId: "atlas",
          }),
          delegatedWorkstream({
            repo: admission.repository,
            task: "Inspect bounded stale-runner terminal recovery.",
            label: "Stale runner",
            agentId: "sentry",
          }),
          delegatedWorkstream({
            repo: admission.repository,
            task: "Inspect direct operator cancellation receipts.",
            label: "Direct cancel",
            agentId: "sentry",
          }),
        ],
      },
      MODEL_METADATA,
    ));
    const inputJobId = delegated.createdJobIds[0] as Id<"jobs">;
    const errorJobId = delegated.createdJobIds[1] as Id<"jobs">;
    const approvalJobId = delegated.createdJobIds[2] as Id<"jobs">;
    const staleJobId = delegated.createdJobIds[3] as Id<"jobs">;
    const cancelJobId = delegated.createdJobIds[4] as Id<"jobs">;
    await t.run(async (ctx) => {
      const job = (await ctx.db.get(inputJobId))!;
      await ensureWorkAttempt(ctx, job, 1, "running", Date.now());
      await ctx.db.patch(inputJobId, {
        status: "running",
        stage: "running",
        startedAt: Date.now(),
      });
      const runtime = await ctx.db
        .query("jobRuntime")
        .withIndex("by_job", (q) => q.eq("jobId", inputJobId))
        .unique();
      if (runtime) {
        await ctx.db.patch(runtime._id, {
          status: "running",
          stage: "running",
          active: true,
          updatedAt: Date.now(),
        });
      }
    });
    expect(await t.mutation(jobsApi.requestInput, {
      jobId: inputJobId,
      expectedAttempt: 1,
      question: "Which exact safe continuation should be used?",
      checkpoint: "Durable input checkpoint.",
      workerToken: WORKER,
    })).toBe(true);
    const inputReceipt = await t.run(async (ctx) =>
      await ctx.db
        .query("workReceipts")
        .withIndex("by_job_attempt", (q) =>
          q.eq("jobId", inputJobId).eq("attempt", 1)
        )
        .unique()
    );
    expect(inputReceipt).toMatchObject({
      protocolVersion: 2,
      status: "needs_input",
      terminalCode: "agent_input_required",
      recoveryDisposition: "needs_input",
    });
    expect(await t.mutation(jobsApi.provideInput, {
      jobId: inputJobId,
      answer: "Do not revive this row.",
      workerToken: WORKER,
    })).toBe(false);
    await t.run(async (ctx) => {
      await ctx.db.patch(inputReceipt!._id, {
        receiptDigest: "corrupt-input-receipt-digest",
      });
    });
    expect(await t.mutation(jobsApi.provideInput, {
      jobId: inputJobId,
      answer: "A corrupt receipt still must not revive this row.",
      workerToken: WORKER,
    })).toBe(false);
    await t.run(async (ctx) => {
      await ctx.db.delete(inputReceipt!._id);
    });
    expect(await t.mutation(jobsApi.provideInput, {
      jobId: inputJobId,
      answer: "A missing receipt still must not revive this row.",
      workerToken: WORKER,
    })).toBe(false);
    await t.run(async (ctx) => {
      const {
        _id: receiptId,
        _creationTime: receiptCreationTime,
        ...duplicate
      } = inputReceipt!;
      void receiptId;
      void receiptCreationTime;
      duplicate.receiptDigest = "ambiguous-input-receipt-digest";
      await ctx.db.insert("workReceipts", duplicate);
      await ctx.db.insert("workReceipts", duplicate);
    });
    expect(await t.mutation(jobsApi.provideInput, {
      jobId: inputJobId,
      answer: "Ambiguous receipts still must not revive this row.",
      workerToken: WORKER,
    })).toBe(false);
    expect(await t.run(async (ctx) => ctx.db.get(inputJobId))).toMatchObject({
      status: "needs_input",
      attempt: 1,
    });

    const failed = await seedRecoveryTerminal(t, errorJobId);
    const failedReceipt = await t.run(async (ctx) =>
      await ctx.db.get(failed.receiptId)
    );
    expect(await t.mutation(jobsApi.control, {
      jobId: errorJobId,
      action: "retry",
      workerToken: WORKER,
    })).toBe(false);
    expect(await t.run(async (ctx) => ctx.db.get(errorJobId))).toMatchObject({
      status: "error",
      attempt: 1,
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(failed.receiptId, {
        receiptDigest: "corrupt-terminal-receipt-digest",
      });
    });
    expect(await t.mutation(jobsApi.control, {
      jobId: errorJobId,
      action: "retry",
      workerToken: WORKER,
    })).toBe(false);
    await t.run(async (ctx) => {
      await ctx.db.delete(failed.receiptId);
    });
    expect(await t.mutation(jobsApi.control, {
      jobId: errorJobId,
      action: "retry",
      workerToken: WORKER,
    })).toBe(false);
    await t.run(async (ctx) => {
      const {
        _id: receiptId,
        _creationTime: receiptCreationTime,
        ...duplicate
      } = failedReceipt!;
      void receiptId;
      void receiptCreationTime;
      duplicate.receiptDigest = "ambiguous-terminal-receipt-digest";
      await ctx.db.insert("workReceipts", duplicate);
      await ctx.db.insert("workReceipts", duplicate);
    });
    expect(await t.mutation(jobsApi.control, {
      jobId: errorJobId,
      action: "retry",
      workerToken: WORKER,
    })).toBe(false);
    expect(await t.run(async (ctx) => ctx.db.get(errorJobId))).toMatchObject({
      status: "error",
      attempt: 1,
    });

    expect(await t.mutation(jobsApi.control, {
      jobId: cancelJobId,
      action: "cancel",
      workerToken: WORKER,
    })).toBe(true);
    const cancelledReceipt = await t.run(async (ctx) =>
      await ctx.db
        .query("workReceipts")
        .withIndex("by_job_attempt", (q) =>
          q.eq("jobId", cancelJobId).eq("attempt", 1)
        )
        .unique()
    );
    expect(cancelledReceipt).toMatchObject({
      protocolVersion: 2,
      status: "cancelled",
      terminalCode: "operator_cancelled",
      recoveryDisposition: "operator_stop",
    });

    expect(await t.mutation(approvalsApi.decide, {
      jobId: String(approvalJobId),
      decision: "declined",
      workerToken: WORKER,
    })).toBe(true);
    const declined = await t.run(async (ctx) => ({
      job: await ctx.db.get(approvalJobId),
      receipt: await ctx.db
        .query("workReceipts")
        .withIndex("by_job_attempt", (q) =>
          q.eq("jobId", approvalJobId).eq("attempt", 1)
        )
        .unique(),
    }));
    expect(declined.job).toMatchObject({
      status: "cancelled",
      approvalStatus: "declined",
    });
    expect(declined.receipt).toMatchObject({
      protocolVersion: 2,
      status: "cancelled",
      terminalCode: "approval_declined",
      recoveryDisposition: "operator_stop",
    });

    await t.run(async (ctx) => {
      const job = (await ctx.db.get(staleJobId))!;
      await ensureWorkAttempt(ctx, job, 1, "running", Date.now());
      await ctx.db.patch(staleJobId, {
        status: "running",
        stage: "running",
        maxAttempts: 1,
        heartbeatAt: Date.now() - 10 * 60_000,
      });
      const runtime = await ctx.db
        .query("jobRuntime")
        .withIndex("by_job", (q) => q.eq("jobId", staleJobId))
        .unique();
      if (runtime) {
        await ctx.db.patch(runtime._id, {
          status: "running",
          stage: "running",
          active: true,
          attempt: 1,
          maxAttempts: 1,
          heartbeatAt: Date.now() - 10 * 60_000,
          updatedAt: Date.now() - 10 * 60_000,
        });
      }
    });
    expect(await t.mutation(jobsApi.reapStale, {
      workerToken: WORKER,
    })).toMatchObject({
      abandoned: expect.arrayContaining([
        "Inspect bounded stale-runner terminal recovery.",
      ]),
    });
    const staleTerminal = await t.run(async (ctx) => ({
      job: await ctx.db.get(staleJobId),
      receipt: await ctx.db
        .query("workReceipts")
        .withIndex("by_job_attempt", (q) =>
          q.eq("jobId", staleJobId).eq("attempt", 1)
        )
        .unique(),
    }));
    expect(staleTerminal.job).toMatchObject({ status: "error", attempt: 1 });
    expect(staleTerminal.receipt).toMatchObject({
      protocolVersion: 2,
      status: "failed",
      terminalCode: "stale_runner_budget_exhausted",
      recoveryDisposition: "remediable",
    });
  });

  it("rejects forged recovery forks and cycles before considering leaf results", async () => {
    const establishRecovery = async (
      t: SupervisorTest,
      requestKey: string,
    ) => {
      const admission = await testProjectSourceAdmission(
        "daniels-project-space/jarvis",
      );
      const started = await start(t, requestKey, {
        repo: admission.repository,
        projectAdmissions: [admission],
      });
      const firstClaim = await claimSuccess(t, started.missionId, 0);
      const delegated = await t.mutation(supervisorApi.commitV1, commitInput(
        started.missionId,
        firstClaim,
        {
          kind: "delegate",
          workstreams: [delegatedWorkstream({
            repo: admission.repository,
          })],
        },
        MODEL_METADATA,
      ));
      const rootJobId = delegated.createdJobIds[0] as Id<"jobs">;
      const terminal = await seedRecoveryTerminal(t, rootJobId);
      vi.setSystemTime(delegated.nextTickAt);
      const secondClaim = await claimSuccess(t, started.missionId, 1);
      const recovered = await t.mutation(
        supervisorApi.commitV1,
        commitInput(
          started.missionId,
          secondClaim,
          {
            kind: "recover",
            recoveries: [{
              mode: "retry",
              predecessorJobId: rootJobId,
              predecessorReceiptDigest: terminal.receiptDigest,
            }],
          },
          POLICY_METADATA,
        ),
      );
      return {
        started,
        rootJobId,
        successorJobId: recovered.createdJobIds[0] as Id<"jobs">,
        edgeId:
          recovered.supersessionIds[0] as Id<"missionSupervisorSupersessions">,
        nextTickAt: recovered.nextTickAt as number,
      };
    };

    const forkTest = convexTest(schema, modules);
    const fork = await establishRecovery(forkTest, "recover-forged-fork");
    await forkTest.run(async (ctx) => {
      const edge = (await ctx.db.get(fork.edgeId))!;
      const {
        _id: _edgeId,
        _creationTime: _edgeCreated,
        supersessionDigest: _edgeDigest,
        createdAt: _edgeCreatedAt,
        ...authority
      } = edge;
      void _edgeId;
      void _edgeCreated;
      void _edgeDigest;
      void _edgeCreatedAt;
      const forged = {
        ...authority,
        supersessionKey: await sha256Hex("forged-fork-edge"),
        generation: 2,
        autonomousRecoveryCount: 2,
      };
      await ctx.db.insert("missionSupervisorSupersessions", {
        ...forged,
        supersessionDigest: await supersessionDigest(forged),
        createdAt: Date.now() + 1,
      });
    });
    vi.setSystemTime(fork.nextTickAt);
    const forkClaim = await claimSuccess(
      forkTest,
      fork.started.missionId,
      2,
    );
    expect(await forkTest.mutation(
      supervisorApi.commitV1,
      commitInput(
        fork.started.missionId,
        forkClaim,
        {
          kind: "synthesize",
          summary: "This forged fork must never be accepted.",
        },
        MODEL_METADATA,
      ),
    )).toMatchObject({
      committed: false,
      reason: "recovery_lineage_fork",
      jobId: fork.rootJobId,
    });

    const cycleTest = convexTest(schema, modules);
    const cycle = await establishRecovery(cycleTest, "recover-forged-cycle");
    const successorTerminal = await seedRecoveryTerminal(
      cycleTest,
      cycle.successorJobId,
    );
    await cycleTest.run(async (ctx) => {
      const [root, edge, state] = await Promise.all([
        ctx.db.get(cycle.rootJobId),
        ctx.db.get(cycle.edgeId),
        ctx.db
          .query("missionSupervisorState")
          .withIndex("by_mission", (q) =>
            q.eq("missionId", cycle.started.missionId)
          )
          .unique(),
      ]);
      if (
        !root
        || !edge
        || !state
        || !root.supervisorDecisionKey
        || !root.workOrderRevisionId
        || !root.workOrderRevisionDigest
        || !root.schedulingBindingDigest
        || !root.canonicalProjectId
        || !root.sourceAdmissionDigest
      ) throw new Error("Cycle fixture authority is incomplete");
      const forged = {
        protocolVersion: 1 as const,
        supersessionKey: await sha256Hex("forged-cycle-edge"),
        missionId: cycle.started.missionId,
        decisionKey: root.supervisorDecisionKey,
        decisionOrdinal: Number(root.supervisorJobOrdinal),
        mode: "retry" as const,
        rootJobId: cycle.rootJobId,
        generation: 2,
        autonomousRecoveryCount: 2,
        predecessorJobId: cycle.successorJobId,
        predecessorAttempt: 1,
        predecessorReceiptId: successorTerminal.receiptId,
        predecessorReceiptDigest: successorTerminal.receiptDigest,
        successorJobId: cycle.rootJobId,
        successorSchedulingBindingDigest: root.schedulingBindingDigest,
        successorWorkOrderRevisionId: root.workOrderRevisionId,
        successorWorkOrderRevisionDigest: root.workOrderRevisionDigest,
        successorCanonicalProjectId: root.canonicalProjectId,
        successorRepository: root.repo,
        successorSourceAdmissionDigest: root.sourceAdmissionDigest,
        observedInputRevision: state.inputRevision,
      };
      await ctx.db.insert("missionSupervisorSupersessions", {
        ...forged,
        supersessionDigest: await supersessionDigest(forged),
        createdAt: Date.now() + 1,
      });
    });
    vi.setSystemTime(cycle.nextTickAt);
    const cycleClaim = await claimSuccess(
      cycleTest,
      cycle.started.missionId,
      2,
    );
    expect(await cycleTest.mutation(
      supervisorApi.commitV1,
      commitInput(
        cycle.started.missionId,
        cycleClaim,
        {
          kind: "synthesize",
          summary: "This forged cycle must never be accepted.",
        },
        MODEL_METADATA,
      ),
    )).toMatchObject({
      committed: false,
      reason: "recovery_lineage_cycle_or_cap_reset",
    });
  });
});
