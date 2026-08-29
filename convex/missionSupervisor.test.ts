import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest, type TestConvex } from "convex-test";
import { makeFunctionReference } from "convex/server";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { testProjectSourceAdmission } from "./testSourceAdmission";
import {
  evidenceProjectSourceAdmission,
  sealProjectSourceAdmission,
  sha256Hex,
  type ProjectSourceAdmission,
  type ProjectSourceAdmissionCore,
} from "../src/lib/source-admission";
import {
  ensureWorkAttempt,
  patchJobWithRuntime,
  projectJobRuntime,
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
import { triggerClaimAuthority } from "../src/lib/trigger-machine";

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
  quarantineDisabledV1: makeFunctionReference<"mutation">(
    "missionSupervisor:quarantineDisabledV1",
  ),
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
  reserveDispatchBatch: makeFunctionReference<"mutation">(
    "jobs:reserveDispatchBatch",
  ),
  reserveSupervisorControlDispatchBatchV1:
    makeFunctionReference<"mutation">(
      "jobs:reserveSupervisorControlDispatchBatchV1",
    ),
  claimDispatched: makeFunctionReference<"mutation">("jobs:claimDispatched"),
  markDispatchLaunchUnknown: makeFunctionReference<"mutation">(
    "jobs:markDispatchLaunchUnknown",
  ),
  checkpointAndRequeue: makeFunctionReference<"mutation">(
    "jobs:checkpointAndRequeue",
  ),
  markVerifiedForDelivery: makeFunctionReference<"mutation">(
    "jobs:markVerifiedForDelivery",
  ),
  linearizeDelivery: makeFunctionReference<"mutation">(
    "jobs:linearizeDelivery",
  ),
  prepareDeliveryEffect: makeFunctionReference<"mutation">(
    "jobs:prepareDeliveryEffect",
  ),
  observeDeliveryEffect: makeFunctionReference<"mutation">(
    "jobs:observeDeliveryEffect",
  ),
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
    reasoningEffort?: "low" | "medium" | "high" | "max";
    modelReason?: string;
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
type DispatchReservation = Parameters<typeof triggerClaimAuthority>[0] & {
  jobId: Id<"jobs">;
  dispatchId: string;
};
type CommitDecision =
  | {
      kind: "delegate";
      workstreams: Array<{
        task: string;
        label: string;
        repo?: string;
        model: "luna" | "terra" | "sol";
        reasoningEffort: "low" | "medium" | "high" | "max";
        modelReason: string;
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

async function resealAdmission(
  admission: ProjectSourceAdmission,
  overrides: Partial<ProjectSourceAdmissionCore>,
): Promise<ProjectSourceAdmission> {
  return await sealProjectSourceAdmission({
    protocolVersion: admission.protocolVersion,
    canonicalProjectId: admission.canonicalProjectId,
    repository: admission.repository,
    sourceProvider: admission.sourceProvider,
    sourceBranch: admission.sourceBranch,
    sourceRef: admission.sourceRef,
    sourceHeadSha: admission.sourceHeadSha,
    sourceObservedAt: admission.sourceObservedAt,
    ...overrides,
  });
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
    reasoningEffort: "high",
    modelReason: "Test adaptive route",
    agentId: "paul",
    readonly: false,
    approvalRequired: false,
    risk: "low",
    acceptanceCriteria: ["The exact bounded behavior is verified."],
    ...overrides,
  };
}

async function startAndDelegate(
  t: SupervisorTest,
  requestKey: string,
  workstreams: Array<ReturnType<typeof delegatedWorkstream>>,
  options: StartOptions = {},
) {
  const started = await start(t, requestKey, options);
  const leased = await claimSuccess(t, started.missionId, 0);
  const delegated = await t.mutation(
    supervisorApi.commitV1,
    commitInput(
      started.missionId,
      leased,
      { kind: "delegate", workstreams },
      {
        ...MODEL_METADATA,
        triggerRunId: `trigger-${requestKey}`,
      },
    ),
  );
  expect(delegated).toMatchObject({
    committed: true,
    resultState: "waiting",
  });
  return {
    started,
    leased,
    delegated,
    jobIds: delegated.createdJobIds as Id<"jobs">[],
  };
}

async function pauseAndResumeFleet(
  t: SupervisorTest,
  requestKey: string,
  workstreams: Array<ReturnType<typeof delegatedWorkstream>>,
  options: StartOptions = {},
) {
  const fixture = await startAndDelegate(
    t,
    requestKey,
    workstreams,
    options,
  );
  const beforePause = await supervisorState(t, fixture.started.missionId);
  if (!beforePause) throw new Error("Supervisor state is missing");
  const paused = await control(
    t,
    fixture.started.missionId,
    `${requestKey}-pause`,
    "pause",
    beforePause.inputRevision,
  );
  if (!paused.applied) throw new Error("Fleet pause was not applied");
  const resumed = await control(
    t,
    fixture.started.missionId,
    `${requestKey}-resume`,
    "resume",
    paused.inputRevision,
  );
  if (!resumed.applied || !resumed.fleetWakeTicket) {
    throw new Error("Fleet resume did not return an exact wake ticket");
  }
  return { ...fixture, paused, resumed };
}

async function reserveSupervisorFleet(
  t: SupervisorTest,
  controlReceiptId: Id<"missionSupervisorControls">,
) {
  return await t.mutation(
    jobsApi.reserveSupervisorControlDispatchBatchV1,
    {
      controlReceiptId,
      workerToken: WORKER,
    },
  );
}

async function reserveUnrelatedCapacity(
  t: SupervisorTest,
  requestKey: string,
  count: number,
) {
  const jobIds: Id<"jobs">[] = [];
  let remaining = count;
  let missionOrdinal = 0;
  while (remaining > 0) {
    const batch = Math.min(6, remaining);
    const fixture = await startAndDelegate(
      t,
      `${requestKey}-${missionOrdinal}`,
      Array.from({ length: batch }, (_, index) =>
        delegatedWorkstream({
          task:
            `Hold unrelated capacity ${missionOrdinal}:${index} without touching the resumed fleet.`,
          label: `unrelated capacity ${missionOrdinal}:${index}`,
          readonly: true,
        })
      ),
      { priority: 100 },
    );
    jobIds.push(...fixture.jobIds);
    remaining -= batch;
    missionOrdinal += 1;
  }
  const reserved = await t.mutation(jobsApi.reserveDispatchBatch, {
    limit: count,
    reason: `unrelated:${requestKey}`,
    workerToken: WORKER,
  });
  expect(reserved.reservations).toHaveLength(count);
  expect(new Set(
    reserved.reservations.map((item: DispatchReservation) =>
      String(item.jobId)
    ),
  )).toEqual(new Set(jobIds.map(String)));
  return reserved.reservations as DispatchReservation[];
}

async function fleetWriteSurface(t: SupervisorTest) {
  return await t.run(async (ctx) => ({
    jobs: await ctx.db.query("jobs").collect(),
    runtimes: await ctx.db.query("jobRuntime").collect(),
    receipts: await ctx.db.query("dispatchReceipts").collect(),
    deliveries: await ctx.db.query("deliveryAttempts").collect(),
    reviews: await ctx.db.query("reviewReceipts").collect(),
    groups: await ctx.db.query("workGroupScheduling").collect(),
    scheduler: await ctx.db.query("dispatchSchedulerState").collect(),
    evidence: await ctx.db.query("workEvents").collect(),
  }));
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

    const first = await t.mutation(
      supervisorApi.startV1,
      request,
    ) as StartResult;
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
      idempotencyDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      state: "ready",
      maxJobs: 24,
      maxDecisions: 64,
      totalJobs: 0,
      decisionCount: 0,
    });
    expect(state?.requestDigest).toBe(
      await sha256Hex(state?.requestPayloadJson ?? ""),
    );
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

  it("replays resealed stable scopes while preserving exact persisted authority", async () => {
    const t = convexTest(schema, modules);
    const [jarvis, rentals] = await Promise.all([
      testProjectSourceAdmission(
        "daniels-project-space/jarvis",
        "a".repeat(40),
      ),
      testProjectSourceAdmission(
        "daniels-project-space/rental-manager-v2",
        "b".repeat(40),
      ),
    ]);
    const request = {
      requestKey: "semantic-start-replay",
      goal: "Coordinate one stable cross-project supervisor intent",
      profile: "durable_goal" as const,
      repo: "daniels-project-space/jarvis",
      desiredWorkstreams: 2,
      requestedWorkstreams: [{
        task: "Inspect the stable Jarvis scope and return exact evidence.",
        repo: "daniels-project-space/jarvis",
        model: "terra" as const,
        agentId: "paul" as const,
        readonly: true,
        acceptanceCriteria: ["Return the exact bounded evidence."],
      }],
      acceptanceCriteria: ["Keep consequential actions gated."],
      projectAdmissions: [jarvis, rentals],
      dispatchToken: DISPATCHER,
    };
    const first = await t.mutation(
      supervisorApi.startV1,
      request,
    ) as StartResult;
    const initialState = await supervisorState(t, first.missionId);
    expect(initialState?.requestDigest).toBe(
      await sha256Hex(initialState?.requestPayloadJson ?? ""),
    );

    vi.advanceTimersByTime(11 * 60_000);
    const resealed = await Promise.all([
      resealAdmission(jarvis, { sourceObservedAt: Date.now() }),
      resealAdmission(rentals, { sourceObservedAt: Date.now() }),
    ]);
    expect(resealed[0].sourceAdmissionDigest)
      .not.toBe(jarvis.sourceAdmissionDigest);
    expect(await t.mutation(supervisorApi.startV1, {
      ...request,
      projectAdmissions: [...resealed].reverse(),
    })).toMatchObject({
      replayed: true,
      missionId: first.missionId,
      stateId: first.stateId,
      requestDigest: first.requestDigest,
      wakeTicket: first.wakeTicket,
    });

    const movedJarvis = await resealAdmission(resealed[0], {
      sourceHeadSha: "c".repeat(40),
      sourceObservedAt: Date.now() + 1,
    });
    expect(await t.mutation(supervisorApi.startV1, {
      ...request,
      projectAdmissions: [movedJarvis, resealed[1]],
    })).toMatchObject({
      replayed: true,
      missionId: first.missionId,
      stateId: first.stateId,
      requestDigest: first.requestDigest,
    });

    const persisted = await t.run(async (ctx) => ({
      mission: await ctx.db.get(first.missionId),
      state: await ctx.db.get(first.stateId),
      missionCount: (await ctx.db.query("missions").collect()).length,
      stateCount:
        (await ctx.db.query("missionSupervisorState").collect()).length,
    }));
    expect(persisted.mission?.sourceHeadSha).toBe(jarvis.sourceHeadSha);
    expect(persisted.mission?.projectAdmissions).toEqual([jarvis, rentals]);
    expect(persisted.state).toMatchObject({
      requestDigest: first.requestDigest,
      idempotencyDigest: initialState?.idempotencyDigest,
      requestPayloadJson: initialState?.requestPayloadJson,
    });
    expect(persisted.state?.requestDigest).toBe(
      await sha256Hex(persisted.state?.requestPayloadJson ?? ""),
    );
    expect(persisted).toMatchObject({ missionCount: 1, stateCount: 1 });
  });

  it("rejects semantic replay conflicts and invalid resealed admissions", async () => {
    const t = convexTest(schema, modules);
    const [jarvis, rentals] = await Promise.all([
      testProjectSourceAdmission("daniels-project-space/jarvis"),
      testProjectSourceAdmission("daniels-project-space/rental-manager-v2"),
    ]);
    const request = {
      requestKey: "semantic-start-conflicts",
      goal: "Coordinate one exact cross-project supervisor boundary",
      profile: "durable_goal" as const,
      repo: "daniels-project-space/jarvis",
      desiredWorkstreams: 2,
      requestedWorkstreams: [{
        task: "Inspect the exact Jarvis boundary and return evidence.",
        repo: "daniels-project-space/jarvis",
        model: "terra" as const,
        agentId: "paul" as const,
        readonly: true,
        acceptanceCriteria: ["Return exact bounded evidence."],
      }],
      acceptanceCriteria: ["Keep consequential actions gated."],
      projectAdmissions: [jarvis, rentals],
      dispatchToken: DISPATCHER,
    };
    await t.mutation(supervisorApi.startV1, request);

    const conflicts = [
      {
        ...request,
        goal: `${request.goal} with a changed goal`,
      },
      {
        ...request,
        requestedWorkstreams: [{
          ...request.requestedWorkstreams[0],
          task: "Inspect a materially different workstream boundary.",
        }],
      },
      {
        ...request,
        repo: "daniels-project-space/rental-manager-v2",
      },
      {
        ...request,
        projectAdmissions: [
          await resealAdmission(jarvis, {
            sourceBranch: "feature/replay-boundary",
            sourceRef: "refs/heads/feature/replay-boundary",
          }),
          rentals,
        ],
      },
    ];
    for (const conflicting of conflicts) {
      await expect(
        t.mutation(supervisorApi.startV1, conflicting),
      ).rejects.toThrow("conflicts with a different payload");
    }

    await expect(t.mutation(supervisorApi.startV1, {
      ...request,
      projectAdmissions: [{
        ...jarvis,
        sourceAdmissionDigest: "0".repeat(64),
      }, rentals],
    })).rejects.toThrow(
      "replay requires valid canonical project admissions",
    );
  });

  it("backfills semantic replay authority only from an exact legacy payload", async () => {
    const t = convexTest(schema, modules);
    const exactAdmission = await testProjectSourceAdmission();
    const exactRequest = {
      requestKey: "legacy-semantic-backfill",
      goal: "Backfill one exact legacy supervisor replay safely",
      projectAdmissions: [exactAdmission],
      dispatchToken: DISPATCHER,
    };
    const exact = await t.mutation(supervisorApi.startV1, exactRequest);
    await t.run(async (ctx) => {
      await ctx.db.patch(exact.stateId, { idempotencyDigest: undefined });
    });
    expect(await t.mutation(supervisorApi.startV1, exactRequest)).toMatchObject({
      replayed: true,
      missionId: exact.missionId,
      requestDigest: exact.requestDigest,
    });
    expect(await supervisorState(t, exact.missionId)).toMatchObject({
      idempotencyDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      requestDigest: exact.requestDigest,
    });

    const volatileAdmission = await testProjectSourceAdmission();
    const volatileRequest = {
      requestKey: "legacy-semantic-reseal",
      goal: "Reject a non-exact legacy supervisor replay safely",
      projectAdmissions: [volatileAdmission],
      dispatchToken: DISPATCHER,
    };
    const volatile = await t.mutation(
      supervisorApi.startV1,
      volatileRequest,
    );
    await t.run(async (ctx) => {
      await ctx.db.patch(volatile.stateId, { idempotencyDigest: undefined });
    });
    vi.advanceTimersByTime(1_000);
    const resealed = await resealAdmission(volatileAdmission, {
      sourceObservedAt: Date.now(),
    });
    await expect(t.mutation(supervisorApi.startV1, {
      ...volatileRequest,
      projectAdmissions: [resealed],
    })).rejects.toThrow("conflicts with a different payload");
    expect((await supervisorState(t, volatile.missionId))?.idempotencyDigest)
      .toBeUndefined();
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

  it("keeps active-job cancel, steer, and input closed until their batch phases land", async () => {
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
    expect(persisted.controls).toHaveLength(3);
  });

  it("atomically pauses and resumes only its persisted cohort with replay-safe receipts", async () => {
    const t = convexTest(schema, modules);
    const fixture = await startAndDelegate(t, "control-active-pause-resume", [
      delegatedWorkstream({
        task: "Implement the queued member of atomic pause cohort coverage.",
        label: "queued member",
      }),
      delegatedWorkstream({
        task:
          "Send the protected customer message only after Daniel explicitly approves it.",
        label: "approval member",
        approvalRequired: true,
        risk: "consequential",
      }),
      delegatedWorkstream({
        task: "Implement the manually paused exclusion member of cohort coverage.",
        label: "manual pause member",
      }),
    ]);
    const [queuedId, approvalId, manualPausedId] = fixture.jobIds;

    // A resolved historical approval must not make the one current pending
    // approval ambiguous.
    await t.run(async (ctx) => {
      await ctx.db.insert("approvals", {
        jobId: String(approvalId),
        kind: "historical-protected-work",
        summary: "Previously approved authority retained for audit.",
        risk: "consequential",
        status: "approved",
        requestedAt: Date.now() - 10_000,
        resolvedAt: Date.now() - 9_000,
      });
    });
    expect(await t.mutation(jobsApi.control, {
      jobId: manualPausedId,
      action: "pause",
      workerToken: WORKER,
    })).toBe(true);
    const beforePause = await supervisorState(t, fixture.started.missionId);
    expect(beforePause).toMatchObject({
      state: "ready",
      inputRevision: 2,
      totalJobs: 3,
      nonterminalJobCount: 3,
    });

    const paused = await control(
      t,
      fixture.started.missionId,
      "control-active-pause-v1",
      "pause",
      beforePause!.inputRevision,
    );
    const expectedCohort = [queuedId, approvalId].sort((left, right) =>
      String(left).localeCompare(String(right))
    );
    expect(paused).toMatchObject({
      applied: true,
      replayed: false,
      state: "paused",
      inputRevision: 3,
      scope: "supervisor_active_job_batch",
      batchProtocolVersion: 1,
      affectedJobIds: expectedCohort,
      affectedJobCount: 2,
      batchDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      wakeTicket: null,
    });
    expect(await control(
      t,
      fixture.started.missionId,
      "control-active-pause-v1",
      "pause",
      beforePause!.inputRevision,
    )).toEqual({ ...paused, replayed: true });

    const pauseRows = await t.run(async (ctx) => ({
      state: await ctx.db.get(fixture.started.stateId),
      command: await ctx.db
        .query("missionSupervisorCommand")
        .withIndex("by_mission", (q) =>
          q.eq("missionId", fixture.started.missionId)
        )
        .unique(),
      jobs: await Promise.all(
        fixture.jobIds.map((jobId) => ctx.db.get(jobId)),
      ),
      attempts: await ctx.db.query("workAttempts").collect(),
      controls: await ctx.db
        .query("missionSupervisorControls")
        .withIndex("by_mission_created", (q) =>
          q.eq("missionId", fixture.started.missionId)
        )
        .collect(),
    }));
    expect(pauseRows.jobs.map((job) => job?.status)).toEqual([
      "paused",
      "paused",
      "paused",
    ]);
    expect(pauseRows.state).toMatchObject({
      state: "paused",
      inputRevision: 3,
      nonterminalJobCount: 3,
      pauseCohortProtocolVersion: 1,
      pauseCohortJobCount: 2,
      pauseCohortDigest: paused.batchDigest,
    });
    expect(pauseRows.state?.pauseCohortControlReceiptId)
      .toBe(paused.controlReceiptId);
    expect(pauseRows.command).toMatchObject({
      nonterminalJobCount: 3,
      activeJobControlProtocolVersion: 1,
      activeJobControlActions: ["pause", "resume"],
      controlAffordanceProtocolVersion: 1,
      supportedControlActions: ["resume"],
      pauseCohortProtocolVersion: 1,
      pauseCohortJobCount: 2,
    });
    expect(pauseRows.controls).toHaveLength(1);
    expect(pauseRows.attempts).toHaveLength(3);

    const resumed = await control(
      t,
      fixture.started.missionId,
      "control-active-resume-v1",
      "resume",
      3,
    );
    expect(resumed).toMatchObject({
      applied: true,
      replayed: false,
      state: "ready",
      inputRevision: 4,
      scope: "supervisor_active_job_batch",
      batchProtocolVersion: 1,
      affectedJobIds: expectedCohort,
      affectedJobCount: 2,
      sourcePauseControlReceiptId: paused.controlReceiptId,
      fleetWakeTicket: {
        protocolVersion: 1,
        controlReceiptId: expect.any(String),
      },
      wakeTicket: {
        expectedInputRevision: 4,
      },
    });
    expect(resumed.fleetWakeTicket.controlReceiptId)
      .toBe(resumed.controlReceiptId);
    const resumeControlReceiptId =
      resumed.controlReceiptId as Id<"missionSupervisorControls">;
    expect(await control(
      t,
      fixture.started.missionId,
      "control-active-resume-v1",
      "resume",
      3,
    )).toEqual({ ...resumed, replayed: true });
    const resumedRows = await t.run(async (ctx) => ({
      state: await ctx.db.get(fixture.started.stateId),
      command: await ctx.db
        .query("missionSupervisorCommand")
        .withIndex("by_mission", (q) =>
          q.eq("missionId", fixture.started.missionId)
        )
        .unique(),
      jobs: await Promise.all(
        fixture.jobIds.map((jobId) => ctx.db.get(jobId)),
      ),
      attempts: await ctx.db.query("workAttempts").collect(),
      receipt: await ctx.db.get(resumeControlReceiptId),
    }));
    expect(resumedRows.jobs.map((job) => job?.status)).toEqual([
      "pending",
      "awaiting_approval",
      "paused",
    ]);
    expect(resumedRows.jobs.map((job) => job?.attempt)).toEqual([1, 1, 1]);
    expect(resumedRows.attempts).toHaveLength(3);
    expect(resumedRows.receipt).toMatchObject({
      fleetManifestProtocolVersion: 1,
      fleetManifestCount: 1,
      fleetManifestDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      fleetManifest: [{
        protocolVersion: 1,
        jobId: queuedId,
        attempt: 1,
        phase: "specialist",
        memberDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      }],
    });
    expect(resumedRows.receipt?.fleetManifest?.map((member) => member.jobId))
      .toEqual([queuedId]);
    expect(resumedRows.receipt?.fleetManifest?.some(
      (member) => member.jobId === approvalId,
    )).toBe(false);
    expect(resumedRows.state).toMatchObject({
      state: "ready",
      inputRevision: 4,
      nonterminalJobCount: 3,
    });
    expect(resumedRows.state?.pauseCohortControlReceiptId).toBeUndefined();
    expect(resumedRows.command).toMatchObject({
      supportedControlActions: ["pause"],
      nonterminalJobCount: 3,
    });
    expect(resumedRows.command?.pauseCohortProtocolVersion).toBeUndefined();
  });

  it("reserves only the receipt manifest, replays byte-identically, and remains claim-compatible", async () => {
    const t = convexTest(schema, modules);
    const target = await startAndDelegate(
      t,
      "fleet-targeted-scope",
      [delegatedWorkstream({
        task: "Dispatch only this receipt-bound resumed member.",
        label: "receipt-bound member",
      })],
    );
    const targetState = await supervisorState(t, target.started.missionId);
    const paused = await control(
      t,
      target.started.missionId,
      "fleet-targeted-scope-pause",
      "pause",
      targetState!.inputRevision,
    );
    const unrelated = await startAndDelegate(
      t,
      "fleet-unrelated-expired",
      [delegatedWorkstream({
        task: "Remain outside the exact resumed fleet.",
        label: "unrelated expired member",
        readonly: true,
      })],
      { priority: 100 },
    );
    const unrelatedReservation = (await t.mutation(
      jobsApi.reserveDispatchBatch,
      {
        limit: 1,
        reason: "unrelated expired reservation",
        workerToken: WORKER,
      },
    )).reservations[0] as DispatchReservation;
    expect(unrelatedReservation.jobId).toBe(unrelated.jobIds[0]);
    await t.run(async (ctx) => {
      const job = await ctx.db.get(unrelated.jobIds[0]);
      if (!job?.dispatchReceiptId) {
        throw new Error("Unrelated dispatch receipt is missing");
      }
      const runtime = await ctx.db
        .query("jobRuntime")
        .withIndex("by_job", (q) =>
          q.eq("jobId", unrelated.jobIds[0])
        )
        .unique();
      await ctx.db.patch(job.dispatchReceiptId, {
        leaseUntil: Date.now() - 1,
      });
      await ctx.db.patch(job._id, {
        dispatchLeaseUntil: Date.now() - 1,
      });
      if (runtime) {
        await ctx.db.patch(runtime._id, {
          dispatchLeaseUntil: Date.now() - 1,
        });
      }
    });

    const resumed = await control(
      t,
      target.started.missionId,
      "fleet-targeted-scope-resume",
      "resume",
      paused.inputRevision,
    );
    const first = await reserveSupervisorFleet(
      t,
      resumed.controlReceiptId,
    );
    expect(first).toMatchObject({
      protocolVersion: 1,
      status: "reserved",
      reservations: [{
        jobId: target.jobIds[0],
        attempt: 1,
        dispatchGeneration: 1,
        dispatchPhase: "specialist",
      }],
    });
    expect(first.reservations).toHaveLength(1);
    const replayed = await reserveSupervisorFleet(
      t,
      resumed.controlReceiptId,
    );
    expect(replayed).toEqual(first);

    const persisted = await t.run(async (ctx) => {
      const targetJob = await ctx.db.get(target.jobIds[0]);
      const unrelatedJob = await ctx.db.get(unrelated.jobIds[0]);
      const sourceReceipts = await ctx.db
        .query("dispatchReceipts")
        .withIndex("by_supervisor_control_member", (q) =>
          q
            .eq(
              "sourceSupervisorControlReceiptId",
              resumed.controlReceiptId,
            )
            .eq("jobId", target.jobIds[0])
        )
        .collect();
      return {
        targetJob,
        unrelatedJob,
        sourceReceipts,
        unrelatedReceipt: unrelatedJob?.dispatchReceiptId
          ? await ctx.db.get(unrelatedJob.dispatchReceiptId)
          : null,
      };
    });
    expect(persisted.sourceReceipts).toHaveLength(1);
    expect(persisted.sourceReceipts[0]).toMatchObject({
      sourceSupervisorControlReceiptId: resumed.controlReceiptId,
      sourceSupervisorFleetDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      sourceSupervisorMemberDigest: expect.stringMatching(
        /^[0-9a-f]{64}$/,
      ),
      generation: 1,
      status: "reserved",
    });
    expect(persisted.unrelatedReceipt).toMatchObject({
      status: "reserved",
      leaseUntil: START_AT - 1,
    });
    expect(persisted.unrelatedReceipt?.sourceSupervisorControlReceiptId)
      .toBeUndefined();
    expect(JSON.stringify(first.reservations)).not.toContain(
      "sourceSupervisor",
    );
    expect(persisted.sourceReceipts[0].payloadJson).not.toContain(
      "sourceSupervisor",
    );
    expect(persisted.sourceReceipts[0].payloadJson).not.toContain(
      String(resumed.controlReceiptId),
    );
    expect(persisted.sourceReceipts[0].payloadJson).not.toContain(
      persisted.sourceReceipts[0].sourceSupervisorFleetDigest!,
    );
    expect(persisted.sourceReceipts[0].payloadJson).not.toContain(
      persisted.sourceReceipts[0].sourceSupervisorMemberDigest!,
    );

    const reservation = first.reservations[0] as DispatchReservation;
    expect(await t.mutation(jobsApi.claimDispatched, {
      jobId: reservation.jobId,
      dispatchId: reservation.dispatchId,
      ...triggerClaimAuthority(reservation),
      workerRunId: "receipt-bound-worker",
      workerToken: WORKER,
    })).toMatchObject({
      workerRunId: "receipt-bound-worker",
      dispatchGeneration: 1,
      dispatchPhase: "specialist",
    });
  });

  it("quarantines a supervisor dispatch with a missing receipt without launching a replacement", async () => {
    const t = convexTest(schema, modules);
    const fixture = await pauseAndResumeFleet(
      t,
      "fleet-invalid-dispatch-quarantine",
      [delegatedWorkstream({
        task: "Keep unprovable worker reservations out of capacity.",
        label: "invalid receipt quarantine",
      })],
    );
    const offered = await reserveSupervisorFleet(
      t,
      fixture.resumed.controlReceiptId,
    );
    const reservation = offered.reservations[0] as DispatchReservation;
    await t.run(async (ctx) => {
      const job = await ctx.db.get(fixture.jobIds[0]);
      if (!job?.dispatchReceiptId) throw new Error("supervisor dispatch receipt was not persisted");
      await ctx.db.delete(job.dispatchReceiptId);
    });

    vi.advanceTimersByTime(2 * 60_000 + 1);
    expect(await t.mutation(jobsApi.reapStale, { workerToken: WORKER }))
      .toMatchObject({
        quarantinedDispatches: ["Keep unprovable worker reservations out of capacity."],
      });
    const first = await t.run(async (ctx) => ({
      job: await ctx.db.get(fixture.jobIds[0]),
      runtime: await ctx.db.query("jobRuntime")
        .withIndex("by_job", (q) => q.eq("jobId", fixture.jobIds[0])).first(),
      attempt: await ctx.db.query("workAttempts")
        .withIndex("by_job_attempt", (q) => q.eq("jobId", fixture.jobIds[0]).eq("attempt", 1)).first(),
      receipts: await ctx.db.query("workReceipts")
        .withIndex("by_job_attempt", (q) => q.eq("jobId", fixture.jobIds[0]).eq("attempt", 1)).collect(),
      events: await ctx.db.query("workEvents")
        .withIndex("by_job", (q) => q.eq("jobId", String(fixture.jobIds[0]))).collect(),
      attention: (await ctx.db.query("attentionItems").collect())
        .filter((item) => item.jobId === String(fixture.jobIds[0])),
    }));
    expect(first.job).toMatchObject({ status: "needs_input", providerRunState: "quarantined" });
    expect(first.job?.dispatchId).toBeUndefined();
    expect(first.runtime?.status).toBe("needs_input");
    expect(first.attempt).toMatchObject({ status: "needs_input" });
    expect(first.receipts).toMatchObject([{
      protocolVersion: 2,
      status: "needs_input",
      terminalCode: "dispatch_authority_invalid",
      recoveryDisposition: "needs_input",
    }]);
    expect(first.events.filter((event) => event.type === "dispatch_quarantined")).toHaveLength(1);
    expect(first.attention).toHaveLength(1);
    expect(await t.mutation(jobsApi.claimDispatched, {
      jobId: reservation.jobId,
      dispatchId: reservation.dispatchId,
      ...triggerClaimAuthority(reservation),
      workerRunId: "must-not-launch-after-quarantine",
      workerToken: WORKER,
    })).toMatchObject({ executable: false, held: true });

    expect(await t.mutation(jobsApi.reapStale, { workerToken: WORKER }))
      .toMatchObject({ quarantinedDispatches: [] });
    const second = await t.run(async (ctx) => ({
      receipts: await ctx.db.query("workReceipts")
        .withIndex("by_job_attempt", (q) => q.eq("jobId", fixture.jobIds[0]).eq("attempt", 1)).collect(),
      events: await ctx.db.query("workEvents")
        .withIndex("by_job", (q) => q.eq("jobId", String(fixture.jobIds[0]))).collect(),
      attention: (await ctx.db.query("attentionItems").collect())
        .filter((item) => item.jobId === String(fixture.jobIds[0])),
    }));
    expect(second.receipts).toHaveLength(1);
    expect(second.events.filter((event) => event.type === "dispatch_quarantined")).toHaveLength(1);
    expect(second.attention).toHaveLength(1);
  });

  it("skips an expired source offer until the minute fallback reoffers its exact bytes", async () => {
    const t = convexTest(schema, modules);
    const fixture = await pauseAndResumeFleet(
      t,
      "fleet-expired-source-fallback",
      [delegatedWorkstream({
        task: "Preserve exact Trigger loss reconciliation.",
        label: "expired source offer",
      })],
    );
    const offered = await reserveSupervisorFleet(
      t,
      fixture.resumed.controlReceiptId,
    );
    const reservation = offered.reservations[0] as DispatchReservation;
    expect(await t.mutation(jobsApi.markDispatchLaunchUnknown, {
      jobId: reservation.jobId,
      dispatchId: reservation.dispatchId,
      dispatchGeneration: reservation.dispatchGeneration,
      dispatchPhase: reservation.dispatchPhase,
      dispatchReceiptDigest: reservation.dispatchReceiptDigest,
      dispatchPayloadDigest: reservation.dispatchPayloadDigest,
      reason: "Trigger response was lost after acceptance",
      workerToken: WORKER,
    })).toBe(true);
    vi.advanceTimersByTime(31_000);
    const beforeTargetedRetry = await fleetWriteSurface(t);
    expect(await reserveSupervisorFleet(
      t,
      fixture.resumed.controlReceiptId,
    )).toMatchObject({
      protocolVersion: 1,
      status: "fallback_pending",
      reservations: [],
      fallbackSkippedCount: 1,
    });
    expect(await fleetWriteSurface(t)).toEqual(beforeTargetedRetry);

    await t.mutation(jobsApi.reapStale, { workerToken: WORKER });
    const fallback = await t.mutation(jobsApi.reserveDispatchBatch, {
      limit: 1,
      reason: "minute fallback exact retry",
      workerToken: WORKER,
    });
    expect(fallback.reservations).toEqual([reservation]);
    const rows = await t.run(async (ctx) =>
      await ctx.db
        .query("dispatchReceipts")
        .withIndex("by_supervisor_control_member", (q) =>
          q
            .eq(
              "sourceSupervisorControlReceiptId",
              fixture.resumed.controlReceiptId,
            )
            .eq("jobId", fixture.jobIds[0])
        )
        .collect()
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "reserved",
      generation: reservation.dispatchGeneration,
      receiptDigest: reservation.dispatchReceiptDigest,
      payloadDigest: reservation.dispatchPayloadDigest,
    });
  });

  it("treats a generic scheduler race as one already-inflight receipt", async () => {
    const t = convexTest(schema, modules);
    const fixture = await pauseAndResumeFleet(
      t,
      "fleet-generic-race",
      [delegatedWorkstream({
        task: "Allow only one dispatch receipt across scheduler races.",
        label: "generic race member",
      })],
    );
    const generic = await t.mutation(jobsApi.reserveDispatchBatch, {
      limit: 1,
      reason: "generic scheduler won",
      workerToken: WORKER,
    });
    expect(generic.reservations).toHaveLength(1);
    expect(await reserveSupervisorFleet(
      t,
      fixture.resumed.controlReceiptId,
    )).toMatchObject({
      protocolVersion: 1,
      status: "already_inflight",
      reservations: [],
      alreadyInflightCount: 1,
    });
    const receipts = await t.run(async (ctx) =>
      await ctx.db
        .query("dispatchReceipts")
        .withIndex("by_job_generation", (q) =>
          q.eq("jobId", fixture.jobIds[0])
        )
        .collect()
    );
    expect(receipts).toHaveLength(1);
    expect(receipts[0].sourceSupervisorControlReceiptId).toBeUndefined();
  });

  it("makes corrupt, stale, and duplicate source authority read-only failures", async () => {
    const corrupt = convexTest(schema, modules);
    const corruptFixture = await pauseAndResumeFleet(
      corrupt,
      "fleet-corrupt-manifest",
      [delegatedWorkstream()],
    );
    await corrupt.run(async (ctx) => {
      const receipt = await ctx.db.get(
        corruptFixture.resumed
          .controlReceiptId as Id<"missionSupervisorControls">,
      );
      if (!receipt?.fleetManifest?.[0]) {
        throw new Error("Corrupt manifest fixture is missing");
      }
      await ctx.db.patch(receipt._id, {
        fleetManifest: [{
          ...receipt.fleetManifest[0],
          priority: receipt.fleetManifest[0].priority + 1,
        }],
      });
    });
    const corruptBefore = await fleetWriteSurface(corrupt);
    expect(await reserveSupervisorFleet(
      corrupt,
      corruptFixture.resumed.controlReceiptId,
    )).toMatchObject({
      status: "invalid_manifest",
      reservations: [],
    });
    expect(await fleetWriteSurface(corrupt)).toEqual(corruptBefore);

    const stale = convexTest(schema, modules);
    const staleFixture = await pauseAndResumeFleet(
      stale,
      "fleet-stale-member",
      [delegatedWorkstream()],
    );
    await stale.run(async (ctx) => {
      await ctx.db.patch(staleFixture.jobIds[0], {
        nextRunAt: Date.now() + 60_000,
      });
    });
    const staleBefore = await fleetWriteSurface(stale);
    expect(await reserveSupervisorFleet(
      stale,
      staleFixture.resumed.controlReceiptId,
    )).toMatchObject({
      status: "stale_manifest",
      reservations: [],
    });
    expect(await fleetWriteSurface(stale)).toEqual(staleBefore);

    const duplicate = convexTest(schema, modules);
    const duplicateFixture = await pauseAndResumeFleet(
      duplicate,
      "fleet-duplicate-source",
      [delegatedWorkstream()],
    );
    await reserveSupervisorFleet(
      duplicate,
      duplicateFixture.resumed.controlReceiptId,
    );
    await duplicate.run(async (ctx) => {
      const rows = await ctx.db
        .query("dispatchReceipts")
        .withIndex("by_supervisor_control_member", (q) =>
          q
            .eq(
              "sourceSupervisorControlReceiptId",
              duplicateFixture.resumed.controlReceiptId,
            )
            .eq("jobId", duplicateFixture.jobIds[0])
        )
        .collect();
      if (rows.length !== 1) {
        throw new Error("Duplicate source fixture is missing");
      }
      const { _id, _creationTime, ...copy } = rows[0];
      void _id;
      void _creationTime;
      await ctx.db.insert("dispatchReceipts", copy);
    });
    const duplicateBefore = await fleetWriteSurface(duplicate);
    expect(await reserveSupervisorFleet(
      duplicate,
      duplicateFixture.resumed.controlReceiptId,
    )).toMatchObject({
      status: "stale_manifest",
      reservations: [],
    });
    expect(await fleetWriteSurface(duplicate)).toEqual(duplicateBefore);
  });

  it("reports capacity-limited when inflight and advanced peers accompany a blocked candidate", async () => {
    const t = convexTest(schema, modules);
    const target = await startAndDelegate(
      t,
      "fleet-mixed-capacity-status",
      Array.from({ length: 3 }, (_, index) =>
        delegatedWorkstream({
          task: `Preserve mixed capacity member ${index}.`,
          label: `mixed capacity ${index}`,
          readonly: true,
        })
      ),
    );
    const state = await supervisorState(t, target.started.missionId);
    const paused = await control(
      t,
      target.started.missionId,
      "fleet-mixed-capacity-pause",
      "pause",
      state!.inputRevision,
    );
    await reserveUnrelatedCapacity(t, "fleet-capacity-holder", 7);
    const resumed = await control(
      t,
      target.started.missionId,
      "fleet-mixed-capacity-resume",
      "resume",
      paused.inputRevision,
    );
    const initial = await reserveSupervisorFleet(
      t,
      resumed.controlReceiptId,
    );
    expect(initial.reservations).toHaveLength(1);
    const inflightReservation =
      initial.reservations[0] as DispatchReservation;
    expect(await t.mutation(jobsApi.claimDispatched, {
      jobId: inflightReservation.jobId,
      dispatchId: inflightReservation.dispatchId,
      ...triggerClaimAuthority(inflightReservation),
      workerRunId: "mixed-capacity-running",
      workerToken: WORKER,
    })).toMatchObject({
      workerRunId: "mixed-capacity-running",
    });
    const remaining = target.jobIds.filter(
      (jobId) => jobId !== inflightReservation.jobId,
    );
    await seedVerifiedReceipt(t, remaining[0]);

    expect(await reserveSupervisorFleet(
      t,
      resumed.controlReceiptId,
    )).toMatchObject({
      protocolVersion: 1,
      status: "capacity_limited",
      reservations: [],
      alreadyInflightCount: 1,
      alreadyAdvancedCount: 1,
      capacityLimitedCount: 1,
    });
    const blocked = await t.run(async (ctx) =>
      await ctx.db.get(remaining[1])
    );
    expect(blocked).toMatchObject({
      status: "pending",
    });
    expect(blocked).not.toHaveProperty("dispatchId");
  });

  it("caps one resumed work group at six and reoffers only those exact receipts", async () => {
    const t = convexTest(schema, modules);
    const firstWave = await startAndDelegate(
      t,
      "fleet-work-group-cap",
      Array.from({ length: 6 }, (_, index) =>
        delegatedWorkstream({
          task: `Execute bounded same-group member ${index}.`,
          label: `same group ${index}`,
          readonly: true,
        })
      ),
    );
    const waiting = await supervisorState(
      t,
      firstWave.started.missionId,
    );
    await t.run(async (ctx) => {
      await ctx.db.patch(firstWave.started.stateId, {
        state: "ready",
        nextTickAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    const secondLease = await claimSuccess(
      t,
      firstWave.started.missionId,
      waiting!.leaseVersion,
    );
    const secondWave = await t.mutation(
      supervisorApi.commitV1,
      commitInput(
        firstWave.started.missionId,
        secondLease,
        {
          kind: "delegate",
          workstreams: [delegatedWorkstream({
            task: "Execute bounded same-group member six.",
            label: "same group 6",
            readonly: true,
          })],
        },
        {
          ...MODEL_METADATA,
          triggerRunId: "trigger-fleet-work-group-cap-second-wave",
        },
      ),
    );
    expect(secondWave).toMatchObject({
      committed: true,
      resultState: "waiting",
    });
    const allJobIds = [
      ...firstWave.jobIds,
      ...(secondWave.createdJobIds as Id<"jobs">[]),
    ];
    expect(allJobIds).toHaveLength(7);
    const beforePause = await supervisorState(
      t,
      firstWave.started.missionId,
    );
    const paused = await control(
      t,
      firstWave.started.missionId,
      "fleet-work-group-cap-pause",
      "pause",
      beforePause!.inputRevision,
    );
    const resumed = await control(
      t,
      firstWave.started.missionId,
      "fleet-work-group-cap-resume",
      "resume",
      paused.inputRevision,
    );
    const first = await reserveSupervisorFleet(
      t,
      resumed.controlReceiptId,
    );
    expect(first).toMatchObject({
      protocolVersion: 1,
      status: "reserved",
      capacityLimitedCount: 1,
    });
    expect(first.reservations).toHaveLength(6);

    const afterFirst = await t.run(async (ctx) => ({
      jobs: await Promise.all(allJobIds.map((jobId) => ctx.db.get(jobId))),
      sourceReceipts: await ctx.db
        .query("dispatchReceipts")
        .withIndex("by_supervisor_control_member", (q) =>
          q.eq(
            "sourceSupervisorControlReceiptId",
            resumed.controlReceiptId,
          )
        )
        .collect(),
    }));
    expect(afterFirst.jobs.filter((job) => job?.status === "dispatching"))
      .toHaveLength(6);
    expect(afterFirst.jobs.filter((job) => job?.status === "pending"))
      .toHaveLength(1);
    expect(afterFirst.sourceReceipts).toHaveLength(6);

    const replay = await reserveSupervisorFleet(
      t,
      resumed.controlReceiptId,
    );
    expect(replay).toMatchObject({
      protocolVersion: 1,
      status: "capacity_limited",
      capacityLimitedCount: 1,
    });
    expect(replay.reservations).toEqual(first.reservations);
    const sourceCount = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("dispatchReceipts")
          .withIndex("by_supervisor_control_member", (q) =>
            q.eq(
              "sourceSupervisorControlReceiptId",
              resumed.controlReceiptId,
            )
          )
          .collect()
      ).length
    );
    expect(sourceCount).toBe(6);
  });

  it("does not let exact terminal attempt advancement stale a pending sibling", async () => {
    const t = convexTest(schema, modules);
    const target = await startAndDelegate(
      t,
      "fleet-terminal-attempt-advance",
      [
        delegatedWorkstream({
          task: "Advance through one exact continuation before terminal proof.",
          label: "advanced terminal member",
          readonly: true,
        }),
        delegatedWorkstream({
          task: "Remain pending while the advanced peer is validated.",
          label: "pending sibling",
          readonly: true,
        }),
      ],
    );
    const state = await supervisorState(t, target.started.missionId);
    const paused = await control(
      t,
      target.started.missionId,
      "fleet-terminal-attempt-pause",
      "pause",
      state!.inputRevision,
    );
    await reserveUnrelatedCapacity(t, "fleet-terminal-capacity", 7);
    const resumed = await control(
      t,
      target.started.missionId,
      "fleet-terminal-attempt-resume",
      "resume",
      paused.inputRevision,
    );
    const first = await reserveSupervisorFleet(
      t,
      resumed.controlReceiptId,
    );
    expect(first.reservations).toHaveLength(1);
    const advancedReservation =
      first.reservations[0] as DispatchReservation;
    const claimed = await t.mutation(jobsApi.claimDispatched, {
      jobId: advancedReservation.jobId,
      dispatchId: advancedReservation.dispatchId,
      ...triggerClaimAuthority(advancedReservation),
      workerRunId: "advanced-terminal-worker",
      workerToken: WORKER,
    });
    expect(await t.mutation(jobsApi.checkpointAndRequeue, {
      jobId: advancedReservation.jobId,
      expectedAttempt: 1,
      authorityDigest: advancedReservation.authorityDigest,
      checkpoint: "Exact attempt one completed before continuation.",
      nextStatus: "pending",
      workerRunId: "advanced-terminal-worker",
      workerToken: WORKER,
    })).toMatchObject({
      requeued: true,
      exhausted: false,
      stale: false,
    });
    expect(claimed).toMatchObject({ workerRunId: "advanced-terminal-worker" });
    await seedVerifiedReceipt(t, advancedReservation.jobId);

    const sibling = target.jobIds.find(
      (jobId) => jobId !== advancedReservation.jobId,
    )!;
    const result = await reserveSupervisorFleet(
      t,
      resumed.controlReceiptId,
    );
    expect(result).toMatchObject({
      protocolVersion: 1,
      status: "reserved",
      reservations: [{ jobId: sibling }],
      alreadyAdvancedCount: 1,
    });
    const advancedJob = await t.run(async (ctx) =>
      await ctx.db.get(advancedReservation.jobId)
    );
    expect(advancedJob).toMatchObject({
      status: "done",
      attempt: 2,
    });
  });

  it("pauses a fresh pending attempt after its predecessor checkpoint closed the old dispatch", async () => {
    const t = convexTest(schema, modules);
    const fixture = await startAndDelegate(
      t,
      "control-pause-after-checkpoint-requeue",
      [delegatedWorkstream({
        task: "Checkpoint once, then remain safely pausable before redispatch.",
        label: "checkpointed pause member",
        readonly: true,
      })],
    );
    const reservation = (await t.mutation(jobsApi.reserveDispatchBatch, {
      limit: 1,
      reason: "checkpoint before mission pause",
      workerToken: WORKER,
    })).reservations[0] as DispatchReservation;
    const claimed = await t.mutation(jobsApi.claimDispatched, {
      jobId: reservation.jobId,
      dispatchId: reservation.dispatchId,
      ...triggerClaimAuthority(reservation),
      workerRunId: "checkpoint-before-pause-worker",
      workerToken: WORKER,
    });
    expect(await t.mutation(jobsApi.checkpointAndRequeue, {
      jobId: reservation.jobId,
      expectedAttempt: 1,
      authorityDigest: claimed.authorityDigest,
      checkpoint: "Attempt one stopped at a durable provider boundary.",
      result: "The provider is temporarily unavailable.",
      delayMs: 60_000,
      workerRunId: "checkpoint-before-pause-worker",
      workerToken: WORKER,
    })).toMatchObject({
      requeued: true,
      exhausted: false,
      stale: false,
    });
    const pending = await t.run(async (ctx) =>
      await ctx.db.get(reservation.jobId)
    );
    expect(pending).toMatchObject({ status: "pending", attempt: 2 });
    expect(pending?.dispatchReceiptId).toBeUndefined();
    expect(pending?.dispatchReceiptDigest).toBeUndefined();
    expect(pending?.dispatchPayloadDigest).toBeUndefined();
    expect(pending?.dispatchGeneration).toBeUndefined();
    expect(pending?.dispatchPhase).toBeUndefined();

    const state = await supervisorState(t, fixture.started.missionId);
    expect(await control(
      t,
      fixture.started.missionId,
      "control-pause-after-checkpoint-requeue-apply",
      "pause",
      state!.inputRevision,
    )).toMatchObject({
      applied: true,
      state: "paused",
      affectedJobCount: 1,
      affectedJobIds: [reservation.jobId],
    });
    expect(await t.run(async (ctx) =>
      await ctx.db.get(reservation.jobId)
    )).toMatchObject({ status: "paused", attempt: 2 });
  });

  it("holds one claimed supervisor worker for input with an exact terminal receipt and no retry", async () => {
    const t = convexTest(schema, modules);
    const fixture = await startAndDelegate(
      t,
      "worker-input-hold-exact-dispatch",
      [delegatedWorkstream({
        task: "Stop at one durable provider configuration boundary.",
        label: "provider input hold",
        readonly: true,
      })],
    );
    const reservation = (await t.mutation(jobsApi.reserveDispatchBatch, {
      limit: 1,
      reason: "exact provider input hold",
      workerToken: WORKER,
    })).reservations[0] as DispatchReservation;
    const claimed = await t.mutation(jobsApi.claimDispatched, {
      jobId: reservation.jobId,
      dispatchId: reservation.dispatchId,
      ...triggerClaimAuthority(reservation),
      workerRunId: "provider-input-hold-worker",
      workerToken: WORKER,
    });
    expect(await t.mutation(jobsApi.requestInput, {
      jobId: reservation.jobId,
      expectedAttempt: 1,
      authorityDigest: claimed.authorityDigest,
      workerRunId: "provider-input-hold-worker",
      question: "Configure an attested cloud workspace provider before resuming.",
      checkpoint: "No repository or specialist process was started.",
      workerToken: WORKER,
    })).toBe(true);

    const held = await t.run(async (ctx) => ({
      job: await ctx.db.get(reservation.jobId),
      attempts: await ctx.db
        .query("workAttempts")
        .withIndex("by_job_attempt", (q) =>
          q.eq("jobId", reservation.jobId)
        )
        .collect(),
      receipt: await ctx.db
        .query("workReceipts")
        .withIndex("by_job_attempt", (q) =>
          q.eq("jobId", reservation.jobId).eq("attempt", 1)
        )
        .unique(),
      dispatch: await ctx.db
        .query("dispatchReceipts")
        .withIndex("by_job_generation", (q) =>
          q.eq("jobId", reservation.jobId).eq("generation", 1)
        )
        .unique(),
      state: await ctx.db.get(fixture.started.stateId),
    }));
    expect(held.job).toMatchObject({ status: "needs_input", attempt: 1 });
    expect(held.job?.nextRunAt).toBeUndefined();
    expect(held.attempts).toHaveLength(1);
    expect(held.attempts[0]).toMatchObject({ status: "needs_input" });
    expect(held.receipt).toMatchObject({
      protocolVersion: 2,
      attempt: 1,
      status: "needs_input",
      terminalCode: "agent_input_required",
      recoveryDisposition: "needs_input",
      verification: "needs_input",
      authorityDigest: claimed.authorityDigest,
    });
    expect(held.dispatch).toMatchObject({ status: "closed" });
    expect(held.state).toMatchObject({
      state: "ready",
      totalJobs: 1,
      nonterminalJobCount: 0,
    });
  });

  it("preflights the full ledger before writing any earlier pause member", async () => {
    const t = convexTest(schema, modules);
    const fixture = await startAndDelegate(t, "control-pause-atomic-reject", [
      delegatedWorkstream({
        task: "Implement the valid earlier member before atomic rejection.",
        label: "valid earlier member",
      }),
      delegatedWorkstream({
        task: "Implement the invalid later integration member for rejection.",
        label: "invalid later integration",
      }),
    ]);
    await t.run(async (ctx) => {
      await ctx.db.patch(fixture.jobIds[1], {
        integrationState: "provider_waiting",
      });
    });

    expect(await control(
      t,
      fixture.started.missionId,
      "control-pause-integration-reject",
      "pause",
      1,
    )).toMatchObject({
      applied: false,
      replayed: false,
      reason: "supervisor_integration_requires_reconciliation",
      state: "waiting",
      inputRevision: 1,
    });
    const persisted = await t.run(async (ctx) => ({
      state: await ctx.db.get(fixture.started.stateId),
      mission: await ctx.db.get(fixture.started.missionId),
      jobs: await Promise.all(
        fixture.jobIds.map((jobId) => ctx.db.get(jobId)),
      ),
      attempts: await ctx.db.query("workAttempts").collect(),
      controls: await ctx.db
        .query("missionSupervisorControls")
        .withIndex("by_mission_created", (q) =>
          q.eq("missionId", fixture.started.missionId)
        )
        .collect(),
    }));
    expect(persisted.state).toMatchObject({
      state: "waiting",
      inputRevision: 1,
      nonterminalJobCount: 2,
    });
    expect(persisted.mission).toMatchObject({
      status: "running",
      phase: "executing",
    });
    expect(persisted.jobs.map((job) => job?.status)).toEqual([
      "pending",
      "pending",
    ]);
    expect(persisted.attempts).toHaveLength(0);
    expect(persisted.controls).toHaveLength(1);
  });

  it("rejects an unresolved provider effect before any pause write", async () => {
    const t = convexTest(schema, modules);
    const repository = "daniels-project-space/jarvis";
    const admission = await testProjectSourceAdmission(repository);
    const fixture = await startAndDelegate(
      t,
      "control-pause-unresolved-provider",
      [delegatedWorkstream({
        task: "Implement verified repository delivery effect pause coverage.",
        label: "provider effect pause",
        repo: repository,
      })],
      {
        repo: repository,
        projectAdmissions: [admission],
      },
    );
    const jobId = fixture.jobIds[0];
    const specialistReservation = (await t.mutation(
      jobsApi.reserveDispatchBatch,
      {
        limit: 1,
        reason: "provider effect specialist",
        workerToken: WORKER,
      },
    )).reservations[0];
    const specialist = await t.mutation(jobsApi.claimDispatched, {
      jobId,
      dispatchId: specialistReservation.dispatchId,
      ...triggerClaimAuthority(specialistReservation),
      workerRunId: "provider-effect-specialist",
      workerToken: WORKER,
    });
    const head = "a".repeat(40);
    const base = "b".repeat(40);
    const tree = "c".repeat(40);
    const diff = "d".repeat(64);
    const result = "Specialist completed the exact repository change.";
    const note = "The exact diff passed supervisor verification.";
    const reviewReceiptJson = JSON.stringify({
      version: 2,
      jobId: String(jobId),
      attempt: 1,
      workOrderRevisionDigest: specialist.workOrderRevisionDigest,
      repository: specialist.projectRepository,
      branch: String(specialist.workerBranch ?? specialist.branch ?? ""),
      baseSha: base,
      baseTreeSha: tree,
      headSha: head,
      headTreeSha: tree,
      diffSha256: diff,
      agentEvidenceSha256: "e".repeat(64),
    });
    expect(await t.mutation(jobsApi.markVerifiedForDelivery, {
      jobId,
      expectedAttempt: 1,
      authorityDigest: specialist.authorityDigest,
      specialistRunId: "provider-effect-specialist",
      result,
      verificationNote: note,
      reviewReceiptJson,
      reviewReceiptSignature: "f".repeat(64),
      reviewReceiptKeyId: "current-test-key",
      reviewDiffSha256: diff,
      resultDigest: await sha256Hex(result),
      evidenceDigest: await sha256Hex(note),
      workerToken: WORKER,
    })).toBe(true);
    const controllerReservation = (await t.mutation(
      jobsApi.reserveDispatchBatch,
      {
        limit: 1,
        reason: "provider effect controller",
        workerToken: WORKER,
      },
    )).reservations[0];
    const controller = await t.mutation(jobsApi.claimDispatched, {
      jobId,
      dispatchId: controllerReservation.dispatchId,
      ...triggerClaimAuthority(controllerReservation),
      workerRunId: "provider-effect-controller",
      workerToken: WORKER,
    });
    const lease = await t.mutation(jobsApi.linearizeDelivery, {
      jobId,
      expectedAttempt: 1,
      authorityDigest: specialist.authorityDigest,
      sourceWorkAttempt: 1,
      deliveryGeneration: 1,
      deliveryRunId: "provider-effect-controller",
      deliveryAttemptId: controller.activeDeliveryAttemptId,
      deliveryLeaseOwner: "provider-effect-owner",
      deliveryLeaseToken: "provider-effect-lease-token",
      workerToken: WORKER,
    });
    expect(lease).not.toBeNull();
    const deliveryFence = {
      jobId,
      expectedAttempt: 1,
      authorityDigest: specialist.authorityDigest,
      sourceWorkAttempt: 1,
      deliveryGeneration: 1,
      deliveryRunId: "provider-effect-controller",
      deliveryAttemptId: controller.activeDeliveryAttemptId,
      deliveryLeaseOwner: "provider-effect-owner",
      deliveryLeaseToken: "provider-effect-lease-token",
      deliveryLeaseVersion: lease.version,
      workerToken: WORKER,
    };
    expect(await t.mutation(jobsApi.prepareDeliveryEffect, {
      ...deliveryFence,
      effectId: "pr:unresolved-pause",
      effectKind: "create_pr",
      reviewedHeadSha: head,
      reviewedBaseSha: base,
    })).toMatchObject({ replay: false });

    const beforePause = await supervisorState(t, fixture.started.missionId);
    expect(await control(
      t,
      fixture.started.missionId,
      "control-unresolved-provider-pause",
      "pause",
      beforePause!.inputRevision,
    )).toMatchObject({
      applied: false,
      reason: "unresolved_provider_effect",
      state: beforePause!.state,
      inputRevision: beforePause!.inputRevision,
    });
    const rejectedRows = await t.run(async (ctx) => ({
      state: await ctx.db.get(fixture.started.stateId),
      job: await ctx.db.get(jobId),
      delivery: await ctx.db.get(
        controller.activeDeliveryAttemptId as Id<"deliveryAttempts">,
      ),
    }));
    expect(rejectedRows.state).toEqual(beforePause);
    expect(rejectedRows.job).toMatchObject({
      status: "running",
      deliveryRunId: "provider-effect-controller",
    });
    expect(rejectedRows.delivery).toMatchObject({
      status: "running",
      preparedEffectId: "pr:unresolved-pause",
    });
    expect(rejectedRows.delivery?.providerObservation).toBeUndefined();

    expect(await t.mutation(jobsApi.observeDeliveryEffect, {
      ...deliveryFence,
      effectId: "pr:unresolved-pause",
      observation: "not_applied",
    })).toBe(true);
    const resolvedPause = await control(
      t,
      fixture.started.missionId,
      "control-resolved-provider-pause",
      "pause",
      beforePause!.inputRevision,
    );
    expect(resolvedPause).toMatchObject({
      applied: true,
      reason: "applied",
      state: "paused",
      inputRevision: beforePause!.inputRevision + 1,
      affectedJobCount: 1,
    });
    const resumed = await control(
      t,
      fixture.started.missionId,
      "control-resolved-provider-resume",
      "resume",
      resolvedPause.inputRevision,
    );
    expect(resumed).toMatchObject({
      applied: true,
      state: "ready",
      affectedJobIds: [jobId],
      fleetWakeTicket: {
        protocolVersion: 1,
        controlReceiptId: expect.any(String),
      },
    });
    const resumedAuthority = await t.run(async (ctx) => {
      const receipt = await ctx.db.get(
        resumed.controlReceiptId as Id<"missionSupervisorControls">,
      );
      const job = await ctx.db.get(jobId);
      return {
        receipt,
        job,
        delivery: job?.activeDeliveryAttemptId
          ? await ctx.db.get(job.activeDeliveryAttemptId)
          : null,
        review: job?.reviewReceiptId
          ? await ctx.db.get(job.reviewReceiptId)
          : null,
      };
    });
    expect(resumedAuthority.job).toMatchObject({
      status: "pending",
      verificationVerdict: "pass",
      deliveryGeneration: 2,
    });
    expect(resumedAuthority.receipt).toMatchObject({
      fleetManifestCount: 1,
      fleetManifest: [{
        jobId,
        phase: "delivery",
        attempt: 1,
        deliveryAttemptId: resumedAuthority.job?.activeDeliveryAttemptId,
        deliverySourceWorkAttempt: 1,
        deliveryGeneration: 2,
        reviewReceiptId: resumedAuthority.job?.reviewReceiptId,
        reviewReceiptDigest: resumedAuthority.job?.reviewReceiptDigest,
      }],
    });
    expect(resumedAuthority.delivery).toMatchObject({
      status: "checkpointed",
      sourceWorkAttempt: 1,
      generation: 2,
      reviewReceiptId: resumedAuthority.review?._id,
      reviewReceiptDigest: resumedAuthority.review?.receiptDigest,
    });
    const deliveryOffer = await reserveSupervisorFleet(
      t,
      resumed.controlReceiptId,
    );
    expect(deliveryOffer).toMatchObject({
      protocolVersion: 1,
      status: "reserved",
      reservations: [{
        jobId,
        expectedAttempt: 1,
        dispatchPhase: "delivery",
      }],
    });
    expect(deliveryOffer.reservations).toHaveLength(1);

    await t.run(async (ctx) => {
      const job = await ctx.db.get(jobId);
      if (!job?.activeDeliveryAttemptId || !job.reviewReceiptId) {
        throw new Error("Resumed delivery authority is missing");
      }
      await ctx.db.patch(job.activeDeliveryAttemptId, {
        schedulingBindingDigest: "e".repeat(64),
      });
      await ctx.db.patch(job.reviewReceiptId, {
        workOrderRevisionDigest: "f".repeat(64),
      });
    });
    const beforeTamperedReplay = await fleetWriteSurface(t);
    expect(await reserveSupervisorFleet(
      t,
      resumed.controlReceiptId,
    )).toMatchObject({
      status: "stale_manifest",
      reservations: [],
    });
    expect(await fleetWriteSurface(t)).toEqual(beforeTamperedReplay);
  });

  it("rejects a terminalized cohort member without v2 authority, then skips it once exact", async () => {
    const t = convexTest(schema, modules);
    const fixture = await startAndDelegate(t, "control-resume-terminal-cohort", [
      delegatedWorkstream({
        task: "Implement the earlier resume cohort member atomically.",
        label: "resume earlier member",
      }),
      delegatedWorkstream({
        task: "Implement the later terminalized resume cohort member.",
        label: "terminal later member",
      }),
    ]);
    const paused = await control(
      t,
      fixture.started.missionId,
      "control-terminal-cohort-pause",
      "pause",
      1,
    );
    expect(paused).toMatchObject({
      applied: true,
      inputRevision: 2,
      affectedJobCount: 2,
    });
    const [, terminalJobId] = fixture.jobIds;
    await t.run(async (ctx) => {
      const job = await ctx.db.get(terminalJobId);
      if (!job) throw new Error("terminal cohort fixture missing");
      await patchJobWithRuntime(ctx, job, {
        status: "done",
        stage: "verified",
        result: "A forged terminal projection without its receipt.",
        verificationVerdict: "pass",
        completedAt: Date.now(),
      });
    });
    const beforeRejectedResume = await t.run(async (ctx) => ({
      state: await ctx.db.get(fixture.started.stateId),
      firstJob: await ctx.db.get(fixture.jobIds[0]),
      firstAttempt: await ctx.db
        .query("workAttempts")
        .withIndex("by_job_attempt", (q) =>
          q.eq("jobId", fixture.jobIds[0]).eq("attempt", 1)
        )
        .unique(),
    }));
    expect(beforeRejectedResume.state).toMatchObject({
      state: "paused",
      inputRevision: 3,
      nonterminalJobCount: 1,
      pauseCohortJobCount: 2,
    });

    expect(await control(
      t,
      fixture.started.missionId,
      "control-terminal-cohort-invalid-resume",
      "resume",
      3,
    )).toMatchObject({
      applied: false,
      reason: "invalid_terminal_authority",
      state: "paused",
      inputRevision: 3,
    });
    const afterRejectedResume = await t.run(async (ctx) => ({
      state: await ctx.db.get(fixture.started.stateId),
      firstJob: await ctx.db.get(fixture.jobIds[0]),
      firstAttempt: await ctx.db
        .query("workAttempts")
        .withIndex("by_job_attempt", (q) =>
          q.eq("jobId", fixture.jobIds[0]).eq("attempt", 1)
        )
        .unique(),
    }));
    expect(afterRejectedResume).toEqual(beforeRejectedResume);

    await t.run(async (ctx) => {
      const job = await ctx.db.get(terminalJobId);
      if (!job) throw new Error("terminal cohort fixture missing");
      await insertFreshTerminalWorkReceipt(ctx, job, 1, {
        status: "succeeded",
        terminalCode: "verified_success",
        recoveryDisposition: "none",
        acceptanceEvidence: ["Exact terminal cohort evidence."],
        artifacts: [
          `convex://jobs/${String(terminalJobId)}/attempt/1/result`,
        ],
        verification: "pass",
        terminalEventKey: "terminalized-cohort:1",
        result: String(job.result ?? ""),
        evidence: "Exact terminal cohort evidence.",
      });
      const attempt = await ctx.db
        .query("workAttempts")
        .withIndex("by_job_attempt", (q) =>
          q.eq("jobId", terminalJobId).eq("attempt", 1)
        )
        .unique();
      if (!attempt) throw new Error("terminal cohort attempt missing");
      await ctx.db.patch(attempt._id, {
        status: "done",
        completedAt: Date.now(),
        lastEventAt: Date.now(),
      });
    });
    const resumed = await control(
      t,
      fixture.started.missionId,
      "control-terminal-cohort-valid-resume",
      "resume",
      3,
    );
    expect(resumed).toMatchObject({
      applied: true,
      state: "ready",
      inputRevision: 4,
      affectedJobIds: [fixture.jobIds[0]],
      affectedJobCount: 1,
      sourcePauseControlReceiptId: paused.controlReceiptId,
    });
    const finalRows = await t.run(async (ctx) => ({
      state: await ctx.db.get(fixture.started.stateId),
      jobs: await Promise.all(
        fixture.jobIds.map((jobId) => ctx.db.get(jobId)),
      ),
    }));
    expect(finalRows.jobs.map((job) => job?.status)).toEqual([
      "pending",
      "done",
    ]);
    expect(finalRows.state).toMatchObject({
      state: "ready",
      nonterminalJobCount: 1,
      inputRevision: 4,
    });
  });

  it("preserves one claimed binding for the worker's final paused checkpoint", async () => {
    const t = convexTest(schema, modules);
    const fixture = await startAndDelegate(
      t,
      "control-pause-final-checkpoint",
      [delegatedWorkstream({
        task: "Persist the one exact final checkpoint after supervisor pause.",
        label: "final pause checkpoint",
      })],
    );
    const reservation = (await t.mutation(jobsApi.reserveDispatchBatch, {
      limit: 1,
      reason: "final paused checkpoint",
      workerToken: WORKER,
    })).reservations[0] as DispatchReservation;
    const claimed = await t.mutation(jobsApi.claimDispatched, {
      jobId: reservation.jobId,
      dispatchId: reservation.dispatchId,
      ...triggerClaimAuthority(reservation),
      workerRunId: "final-paused-checkpoint-worker",
      workerToken: WORKER,
    });
    const runningState = await supervisorState(t, fixture.started.missionId);
    const paused = await control(
      t,
      fixture.started.missionId,
      "control-final-checkpoint-pause",
      "pause",
      runningState!.inputRevision,
    );
    expect(paused).toMatchObject({
      applied: true,
      state: "paused",
      affectedJobCount: 1,
    });
    expect(await t.mutation(jobsApi.checkpointAndRequeue, {
      jobId: reservation.jobId,
      expectedAttempt: 1,
      authorityDigest: claimed.authorityDigest,
      checkpoint: "Exact final branch checkpoint persisted after pause.",
      result: "Worker observed the pause fence and stopped.",
      nextStatus: "paused",
      workerRunId: "final-paused-checkpoint-worker",
      workerToken: WORKER,
    })).toEqual({
      requeued: false,
      exhausted: false,
      stale: false,
    });
    const checkpointed = await t.run(async (ctx) => ({
      state: await ctx.db.get(fixture.started.stateId),
      job: await ctx.db.get(reservation.jobId),
      attempt: await ctx.db
        .query("workAttempts")
        .withIndex("by_job_attempt", (q) =>
          q.eq("jobId", reservation.jobId).eq("attempt", 1)
        )
        .unique(),
      receipt: await ctx.db
        .query("dispatchReceipts")
        .withIndex("by_job_generation", (q) =>
          q.eq("jobId", reservation.jobId).eq("generation", 1)
        )
        .unique(),
    }));
    expect(checkpointed.job).toMatchObject({
      status: "paused",
      checkpoint: "Exact final branch checkpoint persisted after pause.",
    });
    expect(checkpointed.attempt).toMatchObject({
      status: "paused",
      completedAt: expect.any(Number),
    });
    expect(checkpointed.receipt).toMatchObject({ status: "closed" });
    expect(await control(
      t,
      fixture.started.missionId,
      "control-final-checkpoint-resume",
      "resume",
      checkpointed.state!.inputRevision,
    )).toMatchObject({
      applied: true,
      state: "ready",
      affectedJobCount: 1,
    });
    expect(await t.run(async (ctx) =>
      await ctx.db.get(reservation.jobId)
    )).toMatchObject({
      status: "pending",
      attempt: 2,
      checkpoint: "Exact final branch checkpoint persisted after pause.",
    });
  });

  it("reconciles only exact stale paused claims without starvation, then resumes fresh attempts", async () => {
    const t = convexTest(schema, modules);
    const fixture = await startAndDelegate(t, "control-pause-claimed-reaper", [
      delegatedWorkstream({
        task: "Implement the first claimed worker pause checkpoint race.",
        label: "claimed worker one",
      }),
      delegatedWorkstream({
        task: "Implement the second claimed worker pause checkpoint race.",
        label: "claimed worker two",
      }),
    ]);
    const dispatch = await t.mutation(jobsApi.reserveDispatchBatch, {
      limit: 2,
      reason: "claimed pause race",
      workerToken: WORKER,
    });
    expect(dispatch.reservations).toHaveLength(2);
    const reservations = dispatch.reservations as DispatchReservation[];
    const workerIds = ["paused-claimed-worker-one", "paused-claimed-worker-two"];
    for (let index = 0; index < reservations.length; index += 1) {
      const reservation = reservations[index];
      expect(await t.mutation(jobsApi.claimDispatched, {
        jobId: reservation.jobId,
        dispatchId: reservation.dispatchId,
        ...triggerClaimAuthority(reservation),
        workerRunId: workerIds[index],
        workerToken: WORKER,
      })).toMatchObject({
        jobId: reservation.jobId,
        workerRunId: workerIds[index],
      });
    }
    const runningState = await supervisorState(t, fixture.started.missionId);
    expect(runningState).toMatchObject({
      state: "ready",
      inputRevision: 5,
      nonterminalJobCount: 2,
    });
    const paused = await control(
      t,
      fixture.started.missionId,
      "control-claimed-workers-pause",
      "pause",
      runningState!.inputRevision,
    );
    expect(paused).toMatchObject({
      applied: true,
      state: "paused",
      inputRevision: 6,
      affectedJobCount: 2,
    });
    expect(await control(
      t,
      fixture.started.missionId,
      "control-claimed-workers-resume-too-soon",
      "resume",
      6,
    )).toMatchObject({
      applied: false,
      reason: "pause_checkpoint_pending",
      inputRevision: 6,
    });
    expect(await t.mutation(jobsApi.reapStale, {
      workerToken: WORKER,
    })).toMatchObject({
      reconciledPausedClaims: [],
    });

    const secondClaim = await t.run(async (ctx) => {
      const job = await ctx.db.get(reservations[1].jobId);
      const receipt = job?.dispatchReceiptId
        ? await ctx.db.get(job.dispatchReceiptId)
        : null;
      if (!job || !receipt) throw new Error("claimed pause receipt missing");
      await ctx.db.patch(receipt._id, {
        workerRunId: "mismatched-stale-worker",
      });
      return {
        receiptId: receipt._id,
        expectedWorkerRunId: job.workerRunId,
      };
    });

    vi.advanceTimersByTime(6 * 60_000);
    await t.run(async (ctx) => {
      const old = Date.now() - 20 * 60_000;
      const dummyId = await ctx.db.insert("jobs", {
        task: "Irrelevant manually paused history.",
        status: "paused",
        stage: "paused",
        attempt: 1,
        maxAttempts: 12,
        heartbeatAt: old,
        createdAt: old,
      });
      const dummy = await ctx.db.get(dummyId);
      if (!dummy) throw new Error("dummy paused history missing");
      const runtime = projectJobRuntime(dummy);
      expect(runtime.pauseCheckpointPending).toBeUndefined();
      for (let index = 0; index < 101; index += 1) {
        await ctx.db.insert("jobRuntime", {
          ...runtime,
          heartbeatAt: old - index,
          createdAt: old - index,
          updatedAt: old - index,
        });
      }
    });

    const firstReap = await t.mutation(jobsApi.reapStale, {
      workerToken: WORKER,
    });
    expect(firstReap.reconciledPausedClaims).toHaveLength(1);
    let pausedRows = await t.run(async (ctx) =>
      await Promise.all(
        reservations.map((reservation) =>
          ctx.db.get(reservation.jobId)
        ),
      )
    );
    expect(pausedRows.filter((job) => job?.workerRunId)).toHaveLength(1);

    await t.run(async (ctx) => {
      await ctx.db.patch(secondClaim.receiptId, {
        workerRunId: secondClaim.expectedWorkerRunId,
      });
    });
    const secondReap = await t.mutation(jobsApi.reapStale, {
      workerToken: WORKER,
    });
    expect(secondReap.reconciledPausedClaims).toHaveLength(1);
    pausedRows = await t.run(async (ctx) =>
      await Promise.all(
        reservations.map((reservation) =>
          ctx.db.get(reservation.jobId)
        ),
      )
    );
    expect(pausedRows.every((job) =>
      job?.status === "paused"
      && job.workerRunId === undefined
      && job.dispatchId === undefined
    )).toBe(true);

    const resumed = await control(
      t,
      fixture.started.missionId,
      "control-claimed-workers-resume-after-reap",
      "resume",
      6,
    );
    expect(resumed).toMatchObject({
      applied: true,
      state: "ready",
      inputRevision: 7,
      affectedJobCount: 2,
    });
    const finalRows = await t.run(async (ctx) => ({
      state: await ctx.db.get(fixture.started.stateId),
      jobs: await Promise.all(
        reservations.map((reservation) =>
          ctx.db.get(reservation.jobId)
        ),
      ),
      attempts: await ctx.db.query("workAttempts").collect(),
      dispatches: await ctx.db.query("dispatchReceipts").collect(),
    }));
    expect(finalRows.state).toMatchObject({
      state: "ready",
      inputRevision: 7,
    });
    expect(finalRows.jobs.every((job) =>
      job?.status === "pending" && job.attempt === 2
    )).toBe(true);
    expect(finalRows.attempts.filter((attempt) =>
      attempt.attempt === 1
      && attempt.status === "paused"
      && attempt.completedAt
    )).toHaveLength(2);
    expect(finalRows.attempts.filter((attempt) =>
      attempt.attempt === 2 && attempt.status === "pending"
    )).toHaveLength(2);
    expect(finalRows.dispatches.every((receipt) =>
      receipt.status === "closed"
    )).toBe(true);
  });

  it.each([
    `_${"a".repeat(42)}`,
    `-${"b".repeat(42)}`,
  ])("accepts a complete base64url lease-token alphabet (%s)", async (leaseToken) => {
    const t = convexTest(schema, modules);
    const started = await start(t, `base64url-lease-${leaseToken[0]}`);
    expect(await claim(
      t,
      started.missionId,
      0,
      "trigger-base64url-worker",
      leaseToken,
    )).toMatchObject({
      claimed: true,
      missionId: started.missionId,
      leaseVersion: 1,
    });
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

  it("quarantines active supervised states when the supervisor rollout is disabled", async () => {
    const t = convexTest(schema, modules);
    const admission = await testProjectSourceAdmission();
    const ready = await start(t, "rollout-quarantine-ready", { projectAdmissions: [admission] });
    const waiting = await start(t, "rollout-quarantine-waiting", { projectAdmissions: [admission] });
    const leased = await start(t, "rollout-quarantine-leased", { projectAdmissions: [admission] });
    const paused = await start(t, "rollout-quarantine-paused", { projectAdmissions: [admission] });
    const active = [ready, waiting, leased];
    const now = Date.now();

    await t.run(async (ctx) => {
      const rows = await Promise.all(active.map(async (started) =>
        (await ctx.db
          .query("missionSupervisorState")
          .withIndex("by_mission", (q) => q.eq("missionId", started.missionId))
          .unique())!
      ));
      const pausedRow = (await ctx.db
        .query("missionSupervisorState")
        .withIndex("by_mission", (q) => q.eq("missionId", paused.missionId))
        .unique())!;
      await ctx.db.patch(rows[0]._id, { state: "ready", nextTickAt: now + 60_000 });
      await ctx.db.patch(rows[1]._id, { state: "waiting", nextTickAt: now + 120_000 });
      await ctx.db.patch(rows[2]._id, {
        state: "leased",
        nextTickAt: undefined,
        leaseOwner: "disabled-rollout-worker",
        leaseToken: "lease-token-disabled-rollout-worker-0001",
        leaseHeartbeatAt: now,
        leaseUntil: now + 180_000,
      });
      await ctx.db.patch(pausedRow._id, { state: "paused", nextTickAt: undefined });
    });

    await expect(t.mutation(supervisorApi.quarantineDisabledV1, {
      limit: MISSION_SUPERVISOR_MAX_DUE,
      workerToken: WORKER,
    })).resolves.toEqual({ examined: 3, quarantined: 3 });

    for (const started of active) {
      const [state, mission, command] = await Promise.all([
        supervisorState(t, started.missionId),
        t.run(async (ctx) => await ctx.db.get(started.missionId)),
        supervisorCommand(t, started.missionId),
      ]);
      expect(state).toMatchObject({
        state: "needs_input",
        lastErrorCode: "supervisor_rollout_disabled",
      });
      expect(state?.nextTickAt).toBeUndefined();
      expect(state?.leaseOwner).toBeUndefined();
      expect(state?.leaseToken).toBeUndefined();
      expect(state?.leaseUntil).toBeUndefined();
      expect(mission).toMatchObject({ status: "needs_input", phase: "needs_input" });
      expect(command).toMatchObject({ state: "needs_input", question: expect.stringContaining("disabled") });
    }
    expect(await supervisorState(t, paused.missionId)).toMatchObject({ state: "paused" });
    const persisted = await t.run(async (ctx) => ({
      attention: await ctx.db.query("attentionItems").collect(),
      jobs: await ctx.db.query("jobs").collect(),
    }));
    expect(persisted.jobs).toEqual([]);
    expect(persisted.attention.filter((item) =>
      item.evidence?.includes("supervisor_rollout_disabled")
    )).toHaveLength(3);
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
        delegatedWorkstream({
          model: "terra",
          reasoningEffort: "max",
          modelReason: "Adaptive test route retained end to end",
        }),
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
      runtime: await ctx.db.query("jobRuntime").collect(),
      workOrders: await ctx.db.query("workOrderRevisions").collect(),
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
    expect(persisted.jobs[0]).toMatchObject({
      model: "terra",
      reasoningEffort: "max",
      modelReason: "Adaptive test route retained end to end",
    });
    expect(persisted.runtime.find((row) =>
      row.jobId === persisted.jobs[0]._id
    )).toMatchObject({
      model: "terra",
      reasoningEffort: "max",
      modelReason: "Adaptive test route retained end to end",
    });
    expect(persisted.workOrders.find((row) =>
      row.jobId === persisted.jobs[0]._id
    )).toMatchObject({
      minimumModel: "terra",
      minimumReasoningEffort: "max",
    });
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
    })).rejects.toThrow("Deterministic policy delegation does not match the admitted request");

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

  it("rejects deterministic delegation that lowers an admitted effort floor", async () => {
    const t = convexTest(schema, modules);
    const task = "Implement the exact admitted high-effort supervisor boundary.";
    const criterion = "The high-effort floor remains immutable.";
    const started = await start(t, "policy-effort-floor", {
      desiredWorkstreams: 1,
      requestedWorkstreams: [{
        task,
        reasoningEffort: "max",
        acceptanceCriteria: [criterion],
      }],
    });
    const claimed = await claimSuccess(t, started.missionId, 0);

    await expect(t.mutation(supervisorApi.commitV1, commitInput(
      started.missionId,
      claimed,
      {
        kind: "delegate",
        workstreams: [delegatedWorkstream({
          task,
          reasoningEffort: "high",
          acceptanceCriteria: [criterion],
        })],
      },
      POLICY_METADATA,
    ))).rejects.toThrow(
      "Deterministic policy delegation does not match the admitted request",
    );
    expect(await t.run(async (ctx) =>
      ctx.db.query("jobs").withIndex("by_mission", (q) =>
        q.eq("missionId", String(started.missionId))
      ).collect()
    )).toEqual([]);
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
      modelReason: firstPersisted.root?.modelReason,
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
    const secondPersisted = await t.run(async (ctx) => ({
      predecessor: await ctx.db.get(firstSuccessorId),
      successor: await ctx.db.get(secondSuccessorId),
    }));
    expect(secondPersisted.successor).toMatchObject({
      model: secondPersisted.predecessor?.model,
      reasoningEffort: secondPersisted.predecessor?.reasoningEffort,
      modelReason: secondPersisted.predecessor?.modelReason,
    });
    expect(secondPersisted.successor?.modelReason).not.toContain(
      "evidenced quality failures",
    );

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

  it("escalates only repeated exact verification failures and preserves the recovery route audit", async () => {
    const t = convexTest(schema, modules);
    const admission = await testProjectSourceAdmission(
      "daniels-project-space/jarvis",
    );
    const criterion = "The exact verification boundary passes before completion.";
    const initialReason = "Luna medium is sufficient until repeated exact quality evidence exists";
    const started = await start(t, "recover-quality-route", {
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
          model: "luna",
          reasoningEffort: "medium",
          modelReason: initialReason,
          acceptanceCriteria: [criterion],
        })],
      },
      MODEL_METADATA,
    ));
    const rootJobId = delegated.createdJobIds[0] as Id<"jobs">;
    const firstTerminal = await seedRecoveryTerminal(t, rootJobId, {
      terminalCode: "verification_exhausted",
      recoveryDisposition: "remediable",
    });

    vi.setSystemTime(delegated.nextTickAt);
    const secondClaim = await claimSuccess(t, started.missionId, 1);
    const firstRecovery = await t.mutation(
      supervisorApi.commitV1,
      commitInput(
        started.missionId,
        secondClaim,
        {
          kind: "recover",
          recoveries: [{
            mode: "remediate",
            predecessorJobId: rootJobId,
            predecessorReceiptDigest: firstTerminal.receiptDigest,
            task: "Repair the first exact verification failure without broadening scope.",
            label: "Repair first verification failure",
            model: "luna",
            agentId: "paul",
            risk: "low",
            acceptanceCriteria: [criterion],
          }],
        },
        MODEL_METADATA,
      ),
    );
    const firstSuccessorId = firstRecovery.createdJobIds[0] as Id<"jobs">;
    const firstRoute = await t.run(async (ctx) => ({
      job: await ctx.db.get(firstSuccessorId),
      runtime: await ctx.db
        .query("jobRuntime")
        .withIndex("by_job", (q) => q.eq("jobId", firstSuccessorId))
        .unique(),
      order: await ctx.db
        .query("workOrderRevisions")
        .withIndex("by_job_revision", (q) =>
          q.eq("jobId", firstSuccessorId).eq("revision", 1)
        )
        .unique(),
    }));
    expect(firstRoute.job).toMatchObject({
      model: "luna",
      reasoningEffort: "medium",
      modelReason: initialReason,
    });
    expect(firstRoute.runtime).toMatchObject({
      model: "luna",
      reasoningEffort: "medium",
      modelReason: initialReason,
    });
    expect(firstRoute.order).toMatchObject({
      minimumModel: "luna",
      minimumReasoningEffort: "medium",
    });

    const secondTerminal = await seedRecoveryTerminal(t, firstSuccessorId, {
      terminalCode: "verification_exhausted",
      recoveryDisposition: "remediable",
    });
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
            mode: "remediate",
            predecessorJobId: firstSuccessorId,
            predecessorReceiptDigest: secondTerminal.receiptDigest,
            task: "Repair the repeated exact verification failure with stronger reasoning.",
            label: "Repair repeated verification failure",
            model: "luna",
            agentId: "paul",
            risk: "low",
            acceptanceCriteria: [criterion],
          }],
        },
        MODEL_METADATA,
      ),
    );
    const secondSuccessorId = secondRecovery.createdJobIds[0] as Id<"jobs">;
    const escalatedRoute = await t.run(async (ctx) => ({
      job: await ctx.db.get(secondSuccessorId),
      runtime: await ctx.db
        .query("jobRuntime")
        .withIndex("by_job", (q) => q.eq("jobId", secondSuccessorId))
        .unique(),
      order: await ctx.db
        .query("workOrderRevisions")
        .withIndex("by_job_revision", (q) =>
          q.eq("jobId", secondSuccessorId).eq("revision", 1)
        )
        .unique(),
    }));
    expect(escalatedRoute.job).toMatchObject({
      model: "terra",
      reasoningEffort: "xhigh",
      modelReason: expect.stringContaining(
        "after 2 evidenced quality failures",
      ),
    });
    expect(escalatedRoute.runtime).toMatchObject({
      model: "terra",
      reasoningEffort: "xhigh",
      modelReason: escalatedRoute.job?.modelReason,
    });
    expect(escalatedRoute.order).toMatchObject({
      minimumModel: "terra",
      minimumReasoningEffort: "xhigh",
    });
  });

  it("requires criteria-preserving model remediation, creates fresh approval, and policy-synthesizes the recovered leaf", async () => {
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
        ...POLICY_METADATA,
        triggerRunId: "policy-recovered-synthesis",
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

    const cancelledCheckpoint =
      "Cloud workspace blocked before the operator cancelled the fresh attempt.";
    await t.run(async (ctx) => {
      await ctx.db.patch(cancelJobId, {
        result: cancelledCheckpoint,
        checkpoint: cancelledCheckpoint,
      });
    });
    expect(await t.mutation(jobsApi.control, {
      jobId: cancelJobId,
      action: "cancel",
      workerToken: WORKER,
    })).toBe(true);
    const cancelled = await t.run(async (ctx) => ({
      job: await ctx.db.get(cancelJobId),
      receipts: await ctx.db
        .query("workReceipts")
        .withIndex("by_job_attempt", (q) =>
          q.eq("jobId", cancelJobId).eq("attempt", 1)
        )
        .collect(),
    }));
    expect(cancelled.receipts).toHaveLength(1);
    expect(cancelled.receipts[0]).toMatchObject({
      protocolVersion: 2,
      status: "cancelled",
      terminalCode: "operator_cancelled",
      recoveryDisposition: "operator_stop",
      resultDigest: await sha256Hex("Daniel cancelled the work."),
      evidenceDigest: await sha256Hex(cancelledCheckpoint),
    });
    expect(cancelled.job).toMatchObject({
      status: "cancelled",
      result: "Daniel cancelled the work.",
      verificationNote: cancelledCheckpoint,
    });

    // Reproduce the live protocol-2 projection skew: an older worker result
    // survived after the exact operator receipt was sealed. Repeating Cancel
    // repairs only the mutable projection after validating the receipt.
    await t.run(async (ctx) => {
      await ctx.db.patch(cancelJobId, {
        result: "Cloud workspace provider was not configured.",
        verificationNote: undefined,
      });
    });
    expect(await t.mutation(jobsApi.control, {
      jobId: cancelJobId,
      action: "cancel",
      workerToken: WORKER,
    })).toBe(true);
    const repairedCancellation = await t.run(async (ctx) => ({
      job: await ctx.db.get(cancelJobId),
      receipts: await ctx.db
        .query("workReceipts")
        .withIndex("by_job_attempt", (q) =>
          q.eq("jobId", cancelJobId).eq("attempt", 1)
        )
        .collect(),
    }));
    expect(repairedCancellation.job).toMatchObject({
      result: "Daniel cancelled the work.",
      verificationNote: cancelledCheckpoint,
    });
    expect(repairedCancellation.receipts).toHaveLength(1);

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
      result: "Daniel declined the protected recovery.",
      verificationNote: "",
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

  it("preserves legacy partial output when cancellation has no receipt projection", async () => {
    const t = convexTest(schema, modules);
    const jobId = await t.run(async (ctx) =>
      await ctx.db.insert("jobs", {
        task: "Preserve this legacy partial result during cancellation.",
        status: "pending",
        result: "Useful partial legacy output.",
        verificationNote: "Useful partial legacy evidence.",
        checkpoint: "Legacy checkpoint.",
        createdAt: Date.now(),
      })
    );

    expect(await t.mutation(jobsApi.control, {
      jobId,
      action: "cancel",
      workerToken: WORKER,
    })).toBe(true);
    expect(await t.run(async (ctx) => ctx.db.get(jobId))).toMatchObject({
      status: "cancelled",
      result: "Useful partial legacy output.",
      verificationNote: "Useful partial legacy evidence.",
    });
    expect(await t.run(async (ctx) =>
      await ctx.db
        .query("workReceipts")
        .withIndex("by_job_attempt", (q) =>
          q.eq("jobId", jobId).eq("attempt", 1)
        )
        .collect()
    )).toHaveLength(0);
  });

  it("rejects corrupt or incomplete recovery lineage before control or synthesis writes", async () => {
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

    const digestTest = convexTest(schema, modules);
    const digest = await establishRecovery(
      digestTest,
      "recover-control-corrupt-digest",
    );
    await digestTest.run(async (ctx) => {
      await ctx.db.patch(digest.edgeId, {
        supersessionDigest: "f".repeat(64),
      });
    });
    const digestState = await supervisorState(
      digestTest,
      digest.started.missionId,
    );
    expect(await control(
      digestTest,
      digest.started.missionId,
      "recover-control-corrupt-digest-pause",
      "pause",
      digestState!.inputRevision,
    )).toMatchObject({
      applied: false,
      reason: "invalid_terminal_authority",
      inputRevision: digestState!.inputRevision,
    });
    expect(await digestTest.run(async (ctx) =>
      await ctx.db
        .query("workAttempts")
        .withIndex("by_job_attempt", (q) =>
          q.eq("jobId", digest.successorJobId).eq("attempt", 1)
        )
        .take(2)
    )).toHaveLength(0);

    const missingTest = convexTest(schema, modules);
    const missing = await establishRecovery(
      missingTest,
      "recover-control-missing-successor",
    );
    await missingTest.run(async (ctx) => {
      const runtime = await ctx.db
        .query("jobRuntime")
        .withIndex("by_job", (q) => q.eq("jobId", missing.successorJobId))
        .unique();
      if (runtime) await ctx.db.delete(runtime._id);
      await ctx.db.delete(missing.successorJobId);
      await ctx.db.patch(missing.started.stateId, {
        totalJobs: 1,
        nonterminalJobCount: 0,
      });
    });
    const missingState = await supervisorState(
      missingTest,
      missing.started.missionId,
    );
    expect(await control(
      missingTest,
      missing.started.missionId,
      "recover-control-missing-successor-pause",
      "pause",
      missingState!.inputRevision,
    )).toMatchObject({
      applied: false,
      reason: "invalid_terminal_authority",
      inputRevision: missingState!.inputRevision,
    });

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
