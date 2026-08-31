import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2StreamPart,
  LanguageModelV2Usage,
} from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  MISSION_SUPERVISOR_ACTIVE_WAIT_MS,
  MISSION_SUPERVISOR_CONCURRENCY_LIMIT,
  MISSION_SUPERVISOR_MAX_DUE,
  MISSION_SUPERVISOR_POLICY_MODEL_ID,
  MISSION_SUPERVISOR_QUEUE,
  MISSION_SUPERVISOR_RECEIPT_WAIT_MS,
  canonicalSupervisorDigest,
  createSupervisorConvexClient,
  handoffCreatedSupervisorJobs,
  missionSupervisorDispatchIdentity,
  missionSupervisorLeaseOwner,
  parseMissionSupervisorTickPayload,
  runJarvisRecovery,
  runJarvisReceiptSynthesis,
  runMissionSupervisorDeadmanSweep,
  runMissionSupervisorSweep,
  runMissionSupervisorTick,
  runMissionSupervisorTickForRollout,
  type MissionSupervisorRunContext,
  type MissionSupervisorSweepDependencies,
  type MissionSupervisorTickDependencies,
  type MissionSupervisorTickPayload,
} from "./mission-supervisor";

describe("mission supervisor rollout runtime gates", () => {
  it.each(["dormant", "rollback"])("skips queued ticks and quarantines active missions for %s", async (mode) => {
    const prior = process.env.JARVIS_MISSION_SUPERVISOR_ROLLOUT;
    process.env.JARVIS_MISSION_SUPERVISOR_ROLLOUT = mode;
    const tickDependenciesFactory = vi.fn(() => { throw new Error("must not construct tick dependencies"); });
    const sweepDependencies: MissionSupervisorSweepDependencies = {
      convex: vi.fn().mockResolvedValue({ examined: 3, quarantined: 3 }),
      dispatchTick: vi.fn().mockResolvedValue({ id: "must-not-dispatch" }),
    };
    const sweepDependenciesFactory = vi.fn(() => sweepDependencies);
    try {
      await expect(runMissionSupervisorTickForRollout(
        {
          protocolVersion: 1,
          missionId: "mission-gated",
          expectedLeaseVersion: 0,
          expectedEpoch: 0,
          expectedDecisionSequence: 0,
          expectedInputRevision: 0,
        },
        { runId: "run-gated", signal: new AbortController().signal },
        tickDependenciesFactory,
      )).resolves.toMatchObject({ status: "disabled", mode, missionId: "mission-gated" });
      await expect(runMissionSupervisorDeadmanSweep(sweepDependenciesFactory))
        .resolves.toMatchObject({ skipped: true, mode, examined: 3, quarantined: 3, due: 0 });
      expect(tickDependenciesFactory).not.toHaveBeenCalled();
      expect(sweepDependenciesFactory).toHaveBeenCalledOnce();
      expect(sweepDependencies.convex).toHaveBeenCalledWith(
        "mutation",
        "missionSupervisor:quarantineDisabledV1",
        { limit: MISSION_SUPERVISOR_MAX_DUE },
      );
      expect(sweepDependencies.dispatchTick).not.toHaveBeenCalled();
    } finally {
      if (prior === undefined) delete process.env.JARVIS_MISSION_SUPERVISOR_ROLLOUT;
      else process.env.JARVIS_MISSION_SUPERVISOR_ROLLOUT = prior;
    }
  });
});

describe("mission supervisor worker handoff", () => {
  it("immediately wakes the bounded specialist fan-out after a committed delegation", async () => {
    const wakeFleet = vi.fn().mockResolvedValue(true);
    await expect(handoffCreatedSupervisorJobs({
      status: "committed",
      missionId: "mission-immediate",
      kind: "delegate",
      replayed: false,
      decisionId: "decision-1",
      decisionKey: "decision-key-1",
      resultState: "waiting",
      createdJobIds: ["job-1", "job-2"],
    }, wakeFleet)).resolves.toMatchObject({
      status: "committed",
      fleetWoken: true,
    });
    expect(wakeFleet).toHaveBeenCalledOnce();
    expect(wakeFleet).toHaveBeenCalledWith(
      "mission-supervisor:mission-immediate",
      2,
    );
  });

  it("keeps the deadman fallback authoritative when an immediate wake is ambiguous", async () => {
    const wakeFleet = vi.fn().mockRejectedValue(new Error("transport ambiguous"));
    await expect(handoffCreatedSupervisorJobs({
      status: "committed",
      missionId: "mission-fallback",
      kind: "delegate",
      replayed: true,
      decisionId: "decision-2",
      decisionKey: "decision-key-2",
      resultState: "waiting",
      createdJobIds: ["job-3"],
    }, wakeFleet)).resolves.toMatchObject({
      status: "committed",
      fleetWoken: false,
    });
  });

  it("does not touch the fleet when no runnable jobs were created", async () => {
    const wakeFleet = vi.fn();
    await expect(handoffCreatedSupervisorJobs({
      status: "not_claimed",
      missionId: "mission-stale",
      reason: "lease_not_due",
    }, wakeFleet)).resolves.toEqual({
      status: "not_claimed",
      missionId: "mission-stale",
      reason: "lease_not_due",
    });
    expect(wakeFleet).not.toHaveBeenCalled();
  });
});

const MISSION_ID = "mission-supervisor-1";
const RUN_ID = "run_supervisor_123";
const LEASE_TOKEN = "lease_token_abcdefghijklmnopqrstuvwxyz012345";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SOURCE_SHA = "d".repeat(64);
const SHA_E = "e".repeat(64);
const SHA_F = "f".repeat(64);

const usage: LanguageModelV2Usage = {
  inputTokens: 1,
  outputTokens: 1,
  totalTokens: 2,
};

type Snapshot = ReturnType<typeof snapshot>;
type SnapshotJob = ReturnType<typeof job>;
type ConvexCall = {
  kind: "query" | "mutation";
  path: string;
  args: Readonly<Record<string, unknown>>;
};

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requestPayload(goal: string) {
  return {
    protocolVersion: 1 as const,
    goal,
    profile: "short_fleet" as const,
    desiredWorkstreams: 1,
    requestedWorkstreams: [],
    acceptanceCriteria: ["All work returns exact durable evidence."],
    projectAdmissions: [{
      protocolVersion: 2 as const,
      canonicalProjectId: "evidence",
      sourceProvider: "none" as const,
      sourceObservedAt: 1_700_000_000_000,
      sourceAdmissionDigest: SOURCE_SHA,
    }],
    originThreadId: "main",
    priority: 80,
    risk: "low" as const,
    deadlineMs: 86_400_000,
  };
}

function job(
  overrides: Partial<{
    jobId: string;
    status:
      | "pending"
      | "queued"
      | "dispatching"
      | "running"
      | "checkpointed"
      | "paused"
      | "steering"
      | "steered"
      | "awaiting_approval"
      | "needs_input"
      | "stalled"
      | "blocked"
      | "done"
      | "error"
      | "failed"
      | "cancelled";
    receipt: null | {
      jobId: string;
      attempt: number;
      protocolVersion: 2 | null;
      receiptDigest: string | null;
      terminalCode: string | null;
      recoveryDisposition:
        | "none"
        | "retryable"
        | "remediable"
        | "needs_input"
        | "operator_stop"
        | null;
      observedInputRevision: number | null;
      status: string;
      verification: string;
      authorityDigest: string | null;
      schedulingBindingDigest: string | null;
      workOrderRevisionId: string | null;
      workOrderRevision: number | null;
      workOrderRevisionDigest: string | null;
      canonicalProjectId: string | null;
      repository: string | null;
      resultDigest: string | null;
      evidenceDigest: string | null;
      acceptanceEvidence: string[];
      artifacts: string[];
      reviewReceiptDigest: string | null;
    };
  }> = {},
) {
  const jobId = overrides.jobId ?? "job-1";
  const status = overrides.status ?? "running";
  const done = status === "done";
  const result = done ? "The bounded implementation and focused checks passed." : null;
  const verificationNote = done
    ? "Focused tests and immutable completion checks passed."
    : null;
  const authorityDigest = done ? SHA_A : null;
  const schedulingBindingDigest = done ? SHA_B : null;
  const workOrderRevisionDigest = done ? SHA_C : null;
  const resultDigest = result ? sha(result) : null;
  const evidenceDigest = verificationNote ? sha(verificationNote) : null;
  const receipt = overrides.receipt === undefined
    ? done
      ? {
          jobId,
          attempt: 1,
          protocolVersion: 2 as const,
          receiptDigest: SHA_E,
          terminalCode: "verified_success",
          recoveryDisposition: "none" as const,
          observedInputRevision: 1,
          status: "succeeded",
          verification: "pass",
          authorityDigest,
          schedulingBindingDigest,
          workOrderRevisionId: "work-order-revision-1",
          workOrderRevision: 1,
          workOrderRevisionDigest,
          canonicalProjectId: "evidence",
          repository: null,
          resultDigest,
          evidenceDigest,
          acceptanceEvidence: ["Focused tests passed."],
          artifacts: [`convex://jobs/${jobId}/attempt/1/result`],
          reviewReceiptDigest: null,
        }
      : null
    : overrides.receipt;
  const task = "Implement a bounded durable supervisor workstream.";
  const criteria = ["Focused tests pass."];
  return {
    jobId,
    supervisorEpoch: 1,
    supervisorDecisionKey: SHA_A,
    supervisorJobOrdinal: 0,
    label: "Bounded workstream",
    task,
    taskDigest: sha(task),
    repo: null,
    status,
    readonly: true,
    agentId: "paul",
    model: "sol",
    reasoningEffort: "max",
    risk: "low",
    priority: 80,
    approvalRequired: false,
    approvalStatus: null,
    approvalReason: null,
    attempt: 1,
    maxAttempts: 12,
    steer: null,
    steerDigest: null,
    steerRevision: 0,
    dependsOn: [],
    dependsOnDigest: canonicalSupervisorDigest([]),
    acceptanceCriteria: criteria,
    acceptanceCriteriaDigest: canonicalSupervisorDigest(criteria),
    authorityDigest,
    workOrderRevision: done ? 1 : null,
    workOrderRevisionDigest,
    schedulingBindingDigest,
    sourceAdmissionDigest: SOURCE_SHA,
    sourceHeadSha: null,
    integrationState: "not_applicable",
    deliveryStatus: null,
    reviewReceiptDigest: null,
    result,
    resultDigest,
    evidenceDigest,
    verificationVerdict: done ? "pass" : null,
    verificationNote,
    evidenceSummary: null,
    evidenceSummaryDigest: null,
    stallReason: status === "stalled" ? "No causal progress." : null,
    completedAt: done ? 1_700_000_050_000 : null,
    receipt,
  };
}

function recoveryJob(options: {
  jobId?: string;
  status?: "error" | "needs_input" | "cancelled";
  recoveryDisposition:
    | "retryable"
    | "remediable"
    | "needs_input"
    | "operator_stop";
  terminalCode?: string;
  observedInputRevision?: number;
}): SnapshotJob {
  const jobId = options.jobId ?? "job-recovery-1";
  const status = options.status ?? "error";
  const result = status === "needs_input"
    ? "Which exact boundary should the recovery use?"
    : "The bounded workstream reached a terminal failure.";
  const verificationNote = "Exact terminal failure evidence.";
  const authorityDigest = sha(`authority:${jobId}`);
  const schedulingBindingDigest = sha(`scheduling:${jobId}`);
  const workOrderRevisionDigest = sha(`work-order:${jobId}`);
  const resultDigest = sha(result);
  const evidenceDigest = sha(verificationNote);
  const receiptDigest = sha(`receipt:${jobId}:${status}`);
  return {
    ...job({ jobId, status, receipt: null }),
    authorityDigest,
    schedulingBindingDigest,
    workOrderRevision: 1,
    workOrderRevisionDigest,
    result,
    resultDigest,
    verificationNote,
    evidenceDigest,
    completedAt: status === "needs_input" ? null : 1_700_000_050_000,
    receipt: {
      jobId,
      attempt: 1,
      protocolVersion: 2,
      receiptDigest,
      terminalCode: options.terminalCode
        ?? (status === "needs_input"
          ? "agent_input_required"
          : status === "cancelled"
            ? "operator_cancelled"
            : "transient_provider_error"),
      recoveryDisposition: options.recoveryDisposition,
      observedInputRevision: options.observedInputRevision ?? 1,
      status: status === "error"
        ? "failed"
        : status,
      verification: status === "needs_input" ? "needs_input" : "unavailable",
      authorityDigest,
      schedulingBindingDigest,
      workOrderRevisionId: `work-order-revision-${jobId}`,
      workOrderRevision: 1,
      workOrderRevisionDigest,
      canonicalProjectId: "evidence",
      repository: null,
      resultDigest,
      evidenceDigest,
      acceptanceEvidence: [],
      artifacts: [`convex://jobs/${jobId}/attempt/1/terminal`],
      reviewReceiptDigest: null,
    },
  };
}

function admittedSuccessor(
  options: {
    jobId?: string;
    status?: "running" | "done";
    decisionKey?: string;
    ordinal?: number;
  } = {},
): SnapshotJob {
  const jobId = options.jobId ?? "job-successor-1";
  const status = options.status ?? "running";
  const decisionKey = options.decisionKey ?? SHA_F;
  const schedulingBindingDigest = sha(`successor-scheduling:${jobId}`);
  const workOrderRevisionDigest = sha(`successor-work-order:${jobId}`);
  const base = job({ jobId, status });
  const completed = status === "done"
    ? {
        ...base,
        receipt: {
          ...base.receipt!,
          receiptDigest: sha(`successor-receipt:${jobId}`),
          schedulingBindingDigest,
          workOrderRevisionId: `successor-work-order-revision-${jobId}`,
          workOrderRevisionDigest,
        },
      }
    : base;
  return {
    ...completed,
    supervisorDecisionKey: decisionKey,
    supervisorJobOrdinal: options.ordinal ?? 0,
    schedulingBindingDigest,
    workOrderRevision: 1,
    workOrderRevisionDigest,
    sourceAdmissionDigest: SOURCE_SHA,
  };
}

function supersession(
  predecessor: SnapshotJob,
  successor: SnapshotJob,
  options: {
    mode?: "retry" | "remediate" | "input_revision";
    generation?: number;
    autonomousRecoveryCount?: number;
    rootJobId?: string;
    observedInputRevision?: number;
  } = {},
) {
  if (!predecessor.receipt?.receiptDigest) {
    throw new Error("Supersession predecessor receipt is missing");
  }
  if (
    !successor.schedulingBindingDigest ||
    !successor.workOrderRevisionDigest
  ) {
    throw new Error("Supersession successor authority is missing");
  }
  const mode = options.mode ?? "retry";
  return {
    supersessionId: `supersession-${predecessor.jobId}-${successor.jobId}`,
    supersessionKey: sha(`supersession-key:${predecessor.jobId}`),
    supersessionDigest: sha(`supersession-digest:${predecessor.jobId}`),
    decisionKey: successor.supervisorDecisionKey!,
    decisionOrdinal: successor.supervisorJobOrdinal!,
    mode,
    rootJobId: options.rootJobId ?? predecessor.jobId,
    generation: options.generation ?? 1,
    autonomousRecoveryCount: options.autonomousRecoveryCount
      ?? (mode === "input_revision" ? 0 : 1),
    predecessorJobId: predecessor.jobId,
    predecessorAttempt: predecessor.attempt,
    predecessorReceiptDigest: predecessor.receipt.receiptDigest,
    successorJobId: successor.jobId,
    successorSchedulingBindingDigest: successor.schedulingBindingDigest,
    successorWorkOrderRevisionId:
      successor.receipt?.workOrderRevisionId
      ?? `successor-work-order-revision-${successor.jobId}`,
    successorWorkOrderRevisionDigest: successor.workOrderRevisionDigest,
    successorCanonicalProjectId:
      successor.receipt?.canonicalProjectId ?? "evidence",
    successorRepository: successor.repo,
    successorSourceAdmissionDigest: successor.sourceAdmissionDigest!,
    observedInputRevision: options.observedInputRevision ?? 1,
    inputControlReceiptId: mode === "input_revision" ? "control-receipt-1" : null,
    inputControlRequestDigest: mode === "input_revision" ? SHA_A : null,
    inputControlDigest: mode === "input_revision" ? SHA_B : null,
  };
}

function snapshot(
  jobs: SnapshotJob[] = [],
  supersessions: Array<{
    supersessionId: string;
    supersessionKey: string;
    supersessionDigest: string;
    decisionKey: string;
    decisionOrdinal: number;
    mode: "retry" | "remediate" | "input_revision";
    rootJobId: string;
    generation: number;
    autonomousRecoveryCount: number;
    predecessorJobId: string;
    predecessorAttempt: number;
    predecessorReceiptDigest: string;
    successorJobId: string;
    successorSchedulingBindingDigest: string;
    successorWorkOrderRevisionId: string;
    successorWorkOrderRevisionDigest: string;
    successorCanonicalProjectId: string;
    successorRepository: string | null;
    successorSourceAdmissionDigest: string;
    observedInputRevision: number;
    inputControlReceiptId: string | null;
    inputControlRequestDigest: string | null;
    inputControlDigest: string | null;
  }> = [],
  pendingInputAuthority: null | {
    requestDecisionKey: string;
    requestObservedInputRevision: number;
    predecessorJobId: string;
    predecessorAttempt: number;
    predecessorReceiptId: string;
    predecessorReceiptDigest: string;
    terminalCode: string | null;
    recoveryDisposition:
      | "retryable"
      | "remediable"
      | "needs_input"
      | "operator_stop"
      | null;
    controlReceiptId: string | null;
    controlRequestDigest: string | null;
    controlInputDigest: string | null;
    controlExpectedInputRevision: number | null;
    controlResultInputRevision: number | null;
    steerDigest: string | null;
    steerDigestMatchesControl: boolean;
  } = null,
) {
  const goal = "Build a durable and evidence-bound mission supervisor.";
  const request = requestPayload(goal);
  const requestPayloadJson = JSON.stringify(request);
  return {
    protocolVersion: 1 as const,
    mission: {
      missionId: MISSION_ID,
      goal,
      mode: "supervised" as const,
      status: "running" as const,
      originThreadId: "main",
      priority: 80,
      risk: "low" as const,
      acceptanceCriteria: request.acceptanceCriteria,
      acceptanceCriteriaDigest: canonicalSupervisorDigest(
        request.acceptanceCriteria,
      ),
      projectAdmissions: request.projectAdmissions,
      controlRequested: null,
      steer: null as string | null,
      steerDigest: null as string | null,
      steerRevision: 0,
      failureReason: null,
      failureReasonDigest: null,
    },
    supervisor: {
      requestDigest: sha(requestPayloadJson),
      requestPayloadJson,
      epoch: 1,
      nextDecisionSequence: 1,
      inputRevision: 1,
      handledInputRevision: 0,
      dirtyJobIds: [],
      totalJobs: jobs.length,
      maxJobs: 24,
      decisionCount: 0,
      maxDecisions: 64,
      deadlineAt: 1_800_000_000_000,
      lastDecisionKey: null as string | null,
      lastDecisionDigest: null as string | null,
    },
    jobs,
    pendingInputAuthority,
    supersessions,
  };
}

function withRequestPatch(
  source: ReturnType<typeof snapshot>,
  patch: Record<string, unknown>,
) {
  const request = JSON.parse(source.supervisor.requestPayloadJson) as Record<string, unknown>;
  Object.assign(request, patch);
  source.supervisor.requestPayloadJson = JSON.stringify(request);
  source.supervisor.requestDigest = sha(source.supervisor.requestPayloadJson);
  return source;
}

function bindPendingInput(
  authoritative: Snapshot,
  target: SnapshotJob,
  input: string,
  overrides: Partial<NonNullable<Snapshot["pendingInputAuthority"]>> = {},
): Snapshot {
  if (!target.receipt?.receiptDigest || !target.receipt.terminalCode) {
    throw new Error("Pending input target lacks an exact receipt");
  }
  if (
    !["retryable", "remediable", "needs_input", "operator_stop"].includes(
      target.receipt.recoveryDisposition ?? "",
    )
  ) {
    throw new Error("Pending input target has no recoverable disposition");
  }
  const inputDigest = sha(input);
  authoritative.mission.steer = input;
  authoritative.mission.steerDigest = inputDigest;
  authoritative.mission.steerRevision = 1;
  authoritative.supervisor.handledInputRevision = 1;
  authoritative.supervisor.inputRevision = 2;
  authoritative.supervisor.lastDecisionKey = SHA_F;
  authoritative.pendingInputAuthority = {
    requestDecisionKey: SHA_F,
    requestObservedInputRevision: 1,
    predecessorJobId: target.jobId,
    predecessorAttempt: target.attempt,
    predecessorReceiptId: `receipt-row-${target.jobId}`,
    predecessorReceiptDigest: target.receipt.receiptDigest,
    terminalCode: target.receipt.terminalCode,
    recoveryDisposition: target.receipt.recoveryDisposition as
      | "retryable"
      | "remediable"
      | "needs_input"
      | "operator_stop",
    controlReceiptId: `control-row-${target.jobId}`,
    controlRequestDigest: sha(`control-request:${target.jobId}`),
    controlInputDigest: inputDigest,
    controlExpectedInputRevision: 1,
    controlResultInputRevision: 2,
    steerDigest: inputDigest,
    steerDigestMatchesControl: true,
    ...overrides,
  };
  return authoritative;
}

function tickPayload(
  overrides: Partial<MissionSupervisorTickPayload> = {},
): MissionSupervisorTickPayload {
  return {
    protocolVersion: 1,
    missionId: MISSION_ID,
    expectedLeaseVersion: 0,
    expectedEpoch: 1,
    expectedDecisionSequence: 1,
    expectedInputRevision: 1,
    ...overrides,
  };
}

function runContext(signal = new AbortController().signal): MissionSupervisorRunContext {
  return {
    runId: RUN_ID,
    deploymentVersion: "20260723.1",
    signal,
  };
}

function fakeModel(id: string): LanguageModelV2 {
  return {
    specificationVersion: "v2",
    provider: "subscription-test",
    modelId: id,
    supportedUrls: {},
    async doGenerate() {
      throw new Error("Unexpected model generation");
    },
    async doStream() {
      throw new Error("Unexpected model stream");
    },
  };
}

function commitResult(kind: string) {
  return {
    committed: true as const,
    replayed: false,
    decisionId: `decision-${kind}`,
    decisionKey: SHA_C,
    kind,
    resultState: ["synthesize", "fail"].includes(kind) ? "terminal" : "waiting",
    createdJobIds: ["delegate", "recover"].includes(kind)
      ? ["job-created-1"]
      : [],
    supersessionIds: kind === "recover" ? ["supersession-created-1"] : [],
    chatMessageIds: [],
  };
}

function harness(
  authoritative: Snapshot,
  options: {
    claim?: unknown;
    renew?: (count: number) => unknown | Promise<unknown>;
    commit?: (args: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>;
    release?: (args: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>;
    planning?: MissionSupervisorTickDependencies["runPlanningNetwork"];
    recovery?: MissionSupervisorTickDependencies["runRecovery"];
    synthesis?: MissionSupervisorTickDependencies["runSynthesis"];
    createModel?: MissionSupervisorTickDependencies["createLanguageModel"];
    schedule?: MissionSupervisorTickDependencies["scheduleHeartbeat"];
    cancel?: MissionSupervisorTickDependencies["cancelHeartbeat"];
  } = {},
) {
  const calls: ConvexCall[] = [];
  let renewCount = 0;
  const snapshotDigest = canonicalSupervisorDigest(authoritative);
  const dependencies: MissionSupervisorTickDependencies = {
    async convex(kind, path, args) {
      calls.push({ kind, path, args });
      if (path === "missionSupervisor:claimV1") {
        return options.claim ?? {
          claimed: true,
          missionId: MISSION_ID,
          epoch: authoritative.supervisor.epoch,
          nextDecisionSequence:
            authoritative.supervisor.nextDecisionSequence,
          inputRevision: authoritative.supervisor.inputRevision,
          leaseVersion: 1,
          leaseUntil: 1_800_000_000_000,
          snapshot: authoritative,
          snapshotDigest,
        };
      }
      if (path === "missionSupervisor:renewV1") {
        renewCount += 1;
        return options.renew?.(renewCount) ?? {
          renewed: true,
          leaseVersion: 1,
          leaseUntil: 1_800_000_000_000,
          inputRevision: authoritative.supervisor.inputRevision,
        };
      }
      if (path === "missionSupervisor:commitV1") {
        const decision = args.decision as { kind?: string };
        return await (options.commit?.(args) ??
          commitResult(String(decision.kind)));
      }
      if (path === "missionSupervisor:releaseFailureV1") {
        return await (options.release?.(args) ?? {
          released: true,
          stale: false,
          escalated: false,
          failures: 1,
          errorCode: args.errorCode,
          backoffMs: 30_000,
          nextTickAt: 1_700_000_030_000,
        });
      }
      throw new Error(`Unexpected Convex call ${path}`);
    },
    createLeaseToken: () => LEASE_TOKEN,
    createLanguageModel:
      options.createModel ?? ((tier) => fakeModel(`fresh-${tier}`)),
    runPlanningNetwork: options.planning ?? (async (input) => ({
      kind: "ready_to_commit",
      tickId: input.tickId,
      missionId: input.missionId,
      proposals: [{
        task: "Implement the bounded durable supervisor Trigger worker.",
        label: "Build Trigger supervisor",
        repo: null,
        model: "sol",
        reasoningEffort: "max",
        modelReason: "Test supervisor route",
        agentId: "paul",
        readonly: true,
        approvalRequired: false,
        risk: "low",
        acceptanceCriteria: ["Focused Trigger tests pass."],
      }],
      iterations: 1,
      selectedAgents: ["paul"],
      terminalReason: "desired_proposals_reached",
      networkStatus: "success",
    })),
    runRecovery: options.recovery ?? (async () => {
      throw new Error("Unexpected recovery model invocation");
    }),
    runSynthesis: options.synthesis ?? (async () => ({
      summary: "Every delegated workstream completed with exact verified evidence.",
      evidence: ["Focused tests passed."],
    })),
    scheduleHeartbeat:
      options.schedule ?? (() => ({ heartbeat: true })),
    cancelHeartbeat: options.cancel ?? (() => undefined),
  };
  return { calls, dependencies, snapshotDigest };
}

function callFor(
  calls: readonly ConvexCall[],
  path: string,
): ConvexCall {
  const call = calls.find((candidate) => candidate.path === path);
  if (!call) throw new Error(`Missing Convex call ${path}`);
  return call;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("mission supervisor Trigger sweep", () => {
  it("reads at most eight due fences and dispatches every child concurrently with isolated deterministic keys", async () => {
    const due = Array.from({ length: MISSION_SUPERVISOR_MAX_DUE }, (_, index) => ({
      missionId: `mission-${index}`,
      state: "ready" as const,
      epoch: 2,
      nextDecisionSequence: index + 1,
      inputRevision: 4,
      expectedLeaseVersion: index,
      nextTickAt: 1_700_000_000_000,
    }));
    const started: string[] = [];
    let releaseDispatches: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseDispatches = resolve;
    });
    const convex = vi.fn(async () => due);
    const dispatches: Array<{
      payload: MissionSupervisorTickPayload;
      options: Parameters<MissionSupervisorSweepDependencies["dispatchTick"]>[1];
    }> = [];
    const dependencies: MissionSupervisorSweepDependencies = {
      convex,
      dispatchTick: async (payload, options) => {
        started.push(payload.missionId);
        dispatches.push({ payload, options });
        await gate;
        if (payload.missionId === "mission-1") {
          throw new Error("isolated launch failure");
        }
        return { id: `run-${payload.missionId}` };
      },
    };

    const pending = runMissionSupervisorSweep(dependencies);
    await flush();
    expect(started).toEqual(
      Array.from(
        { length: MISSION_SUPERVISOR_MAX_DUE },
        (_, index) => `mission-${index}`,
      ),
    );
    releaseDispatches?.();
    const result = await pending;

    expect(convex).toHaveBeenCalledWith(
      "query",
      "missionSupervisor:dueV1",
      { limit: MISSION_SUPERVISOR_MAX_DUE },
    );
    expect(result).toMatchObject({
      due: MISSION_SUPERVISOR_MAX_DUE,
      dispatched: MISSION_SUPERVISOR_MAX_DUE - 1,
      failed: 1,
    });
    expect(result.launches[1]).toEqual({
      missionId: "mission-1",
      dispatched: false,
    });
    expect(new Set(dispatches.map(({ options }) => options.idempotencyKey)).size)
      .toBe(MISSION_SUPERVISOR_MAX_DUE);
    expect(new Set(dispatches.map(({ options }) => options.concurrencyKey)).size)
      .toBe(MISSION_SUPERVISOR_MAX_DUE);
    for (const dispatch of dispatches) {
      expect(dispatch.options).toEqual(
        missionSupervisorDispatchIdentity(dispatch.payload),
      );
    }
  });

  it("uses a one-minute recovery TTL so a pre-claim platform failure retries on the next sweep", async () => {
    const due = [{
      missionId: "mission-recoverable",
      state: "ready" as const,
      epoch: 1,
      nextDecisionSequence: 1,
      inputRevision: 1,
      expectedLeaseVersion: 0,
      nextTickAt: 1_700_000_000_000,
    }];
    const observed: Parameters<
      MissionSupervisorSweepDependencies["dispatchTick"]
    >[1][] = [];
    let attempt = 0;
    const dependencies: MissionSupervisorSweepDependencies = {
      convex: async () => due,
      dispatchTick: async (_payload, options) => {
        observed.push(options);
        attempt += 1;
        if (attempt === 1) throw new Error("Trigger failed before claim");
        return { id: "run-recovered" };
      },
    };

    await expect(runMissionSupervisorSweep(dependencies)).resolves
      .toMatchObject({ due: 1, dispatched: 0, failed: 1 });
    await expect(runMissionSupervisorSweep(dependencies)).resolves
      .toMatchObject({ due: 1, dispatched: 1, failed: 0 });
    expect(observed).toHaveLength(2);
    expect(observed[0]).toEqual(observed[1]);
    expect(observed[0].idempotencyKeyTTL).toBe("1m");
  });

  it("passes an explicit activation cutoff to the durable due query", async () => {
    const convex = vi.fn(async () => []);
    const dependencies: MissionSupervisorSweepDependencies = {
      convex,
      dispatchTick: vi.fn(async () => ({ id: "unused" })),
    };

    await expect(runMissionSupervisorSweep(dependencies, 1_788_170_000_000)).resolves
      .toMatchObject({ due: 0, dispatched: 0 });
    expect(convex).toHaveBeenCalledWith("query", "missionSupervisor:dueV1", {
      limit: MISSION_SUPERVISOR_MAX_DUE,
      createdAtFloor: 1_788_170_000_000,
    });
  });
});

describe("mission supervisor Trigger tick", () => {
  it("rejects unbounded payloads before calling Convex and treats a lost claim as non-work", async () => {
    const invalidHarness = harness(snapshot());
    await expect(runMissionSupervisorTick(
      { ...tickPayload(), extra: "not allowed" },
      runContext(),
      invalidHarness.dependencies,
    )).rejects.toThrow("tick payload is invalid");
    expect(invalidHarness.calls).toHaveLength(0);

    const lost = harness(snapshot(), {
      claim: { claimed: false, reason: "lease_version_mismatch" },
    });
    await expect(runMissionSupervisorTick(
      tickPayload(),
      runContext(),
      lost.dependencies,
    )).resolves.toEqual({
      status: "not_claimed",
      missionId: MISSION_ID,
      reason: "lease_version_mismatch",
    });
    expect(lost.calls.map((call) => call.path)).toEqual([
      "missionSupervisor:claimV1",
    ]);
  });

  it("uses the genuine network only for a multi-workstream delegation and commits exact model metadata", async () => {
    const created: Array<{ tier: string; model: LanguageModelV2 }> = [];
    const seenModels: LanguageModelV2[] = [];
    const source = withRequestPatch(snapshot(), { desiredWorkstreams: 2 });
    const runtime = harness(source, {
      createModel: (tier) => {
        const model = fakeModel(`${tier}-${created.length}`);
        created.push({ tier, model });
        return model;
      },
      planning: async (input, options) => {
        seenModels.push(
          options.modelFor("sol"),
          options.modelFor("terra"),
          options.modelFor("terra"),
        );
        return {
          kind: "ready_to_commit",
          tickId: input.tickId,
          missionId: input.missionId,
          proposals: [
            {
              task: "Implement the exact Trigger durable re-entry contract.",
              label: "Durable Trigger re-entry",
              repo: null,
              model: "sol",
              reasoningEffort: "max",
              modelReason: "Test supervisor route",
              agentId: "paul",
              readonly: true,
              approvalRequired: false,
              risk: "low",
              acceptanceCriteria: ["The focused runtime suite passes."],
            },
            {
              task: "Verify the independent durable recovery contract.",
              label: "Recovery verification",
              repo: null,
              model: "terra",
              reasoningEffort: "high",
              modelReason: "Test supervisor route",
              agentId: "sentry",
              readonly: true,
              approvalRequired: false,
              risk: "low",
              acceptanceCriteria: ["The recovery contract is independently verified."],
            },
          ],
          iterations: 2,
          selectedAgents: ["paul", "sentry"],
          terminalReason: "desired_proposals_reached",
          networkStatus: "success",
        };
      },
    });

    const result = await runMissionSupervisorTick(
      tickPayload(),
      runContext(),
      runtime.dependencies,
    );

    expect(result).toMatchObject({
      status: "committed",
      kind: "delegate",
      replayed: false,
      createdJobIds: ["job-created-1"],
    });
    expect(created.map(({ tier }) => tier)).toEqual(["sol", "terra", "terra"]);
    expect(seenModels[1]).not.toBe(seenModels[2]);
    const claim = callFor(runtime.calls, "missionSupervisor:claimV1");
    expect(claim.args).toEqual({
      missionId: MISSION_ID,
      leaseOwner: missionSupervisorLeaseOwner(RUN_ID),
      leaseToken: LEASE_TOKEN,
      expectedLeaseVersion: 0,
    });
    const commit = callFor(runtime.calls, "missionSupervisor:commitV1");
    expect(commit.args).toMatchObject({
      missionId: MISSION_ID,
      leaseOwner: missionSupervisorLeaseOwner(RUN_ID),
      leaseToken: LEASE_TOKEN,
      leaseVersion: 1,
      expectedEpoch: 1,
      expectedDecisionSequence: 1,
      expectedInputRevision: 1,
      expectedSnapshotDigest: runtime.snapshotDigest,
      decisionOrigin: "model",
      modelProvider: "codex-subscription",
      modelTier: "sol",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
      supervisorPromptVersion: "mastra-supervisor-network-v1",
      triggerRunId: RUN_ID,
      deploymentVersion: "20260723.1",
      decision: {
        kind: "delegate",
        workstreams: [
          {
            task: "Implement the exact Trigger durable re-entry contract.",
            label: "Durable Trigger re-entry",
            model: "sol",
            reasoningEffort: "max",
            modelReason: "Test supervisor route",
            agentId: "paul",
            readonly: true,
            approvalRequired: false,
            risk: "low",
            acceptanceCriteria: ["The focused runtime suite passes."],
          },
          {
            task: "Verify the independent durable recovery contract.",
            label: "Recovery verification",
            model: "terra",
            reasoningEffort: "high",
            modelReason: "Test supervisor route",
            agentId: "sentry",
            readonly: true,
            approvalRequired: false,
            risk: "low",
            acceptanceCriteria: ["The recovery contract is independently verified."],
          },
        ],
      },
    });
    expect(runtime.calls.some(
      (call) => call.path === "missionSupervisor:releaseFailureV1",
    )).toBe(false);
  });

  it("feeds explicit foreground workstreams, mission criteria, and every admitted project into planning without replacement", async () => {
    const source = snapshot();
    const explicitTask =
      "Preserve this exact foreground decomposition in the durable Trigger worker.";
    const latestDanielInput =
      "Prioritise the durable lease path before any presentation work.";
    Object.assign(source.mission, {
      steer: latestDanielInput,
      steerDigest: sha(latestDanielInput),
      steerRevision: 2,
    });
    const request = JSON.parse(
      source.supervisor.requestPayloadJson,
    ) as Record<string, unknown>;
    request.requestedWorkstreams = [{
      task: explicitTask,
      label: "Exact foreground slice",
      model: "terra",
      agentId: "atlas",
      readonly: true,
      approvalRequired: false,
      risk: "low",
      acceptanceCriteria: ["The explicit workstream remains unchanged."],
    }];
    request.desiredWorkstreams = 1;
    source.supervisor.requestPayloadJson = JSON.stringify(request);
    source.supervisor.requestDigest = sha(
      source.supervisor.requestPayloadJson,
    );
    const runtime = harness(source, {
      planning: async (input) => {
        const context = JSON.parse(String(input.context)) as {
          missionAcceptanceCriteria: string[];
          danielLatestInput: {
            text: string;
            revision: number;
            digest: string;
          };
          admittedProjects: Array<{
            canonicalProjectId: string;
            repository: string | null;
            sourceProvider: string;
          }>;
          requestedWorkstreams: Array<{ task: string }>;
        };
        expect(context.missionAcceptanceCriteria).toEqual(
          source.mission.acceptanceCriteria,
        );
        expect(context.danielLatestInput).toEqual({
          text: latestDanielInput,
          revision: 2,
          digest: sha(latestDanielInput),
        });
        expect(context.admittedProjects).toEqual([{
          canonicalProjectId: "evidence",
          repository: null,
          sourceProvider: "none",
        }]);
        expect(context.requestedWorkstreams).toEqual([
          expect.objectContaining({ task: explicitTask }),
        ]);
        return {
          kind: "ready_to_commit",
          tickId: input.tickId,
          missionId: input.missionId,
          proposals: [{
            task: explicitTask,
            label: "Exact foreground slice",
            repo: null,
            model: "terra",
            reasoningEffort: "high",
            modelReason: "Test supervisor route",
            agentId: "atlas",
            readonly: true,
            approvalRequired: false,
            risk: "low",
            acceptanceCriteria: [
              "The explicit workstream remains unchanged.",
            ],
          }],
          iterations: 1,
          selectedAgents: ["atlas"],
          terminalReason: "desired_proposals_reached",
          networkStatus: "success",
        };
      },
    });

    await expect(runMissionSupervisorTick(
      tickPayload(),
      runContext(),
      runtime.dependencies,
    )).resolves.toMatchObject({
      status: "committed",
      kind: "delegate",
    });
    expect(callFor(runtime.calls, "missionSupervisor:commitV1").args)
      .toMatchObject({
        decision: {
          kind: "delegate",
          workstreams: [expect.objectContaining({ task: explicitTask })],
        },
      });
  });

  it("preserves explicit work while allowing only monotonic safety and model-quality strengthening", async () => {
    const source = snapshot();
    const task =
      "Draft a rental reply for Daniel to review without sending it automatically.";
    const request = JSON.parse(
      source.supervisor.requestPayloadJson,
    ) as Record<string, unknown>;
    request.requestedWorkstreams = [{
      task,
      label: "Draft guarded rental reply",
      model: "luna",
      agentId: "paul",
      readonly: false,
      approvalRequired: false,
      risk: "low",
      acceptanceCriteria: ["Daniel receives a draft and nothing is sent."],
    }];
    source.supervisor.requestPayloadJson = JSON.stringify(request);
    source.supervisor.requestDigest = sha(
      source.supervisor.requestPayloadJson,
    );
    const runtime = harness(source, {
      planning: async (input) => ({
        kind: "ready_to_commit",
        tickId: input.tickId,
        missionId: input.missionId,
        proposals: [{
          task,
          label: "Draft guarded rental reply",
          repo: null,
          model: "sol",
          reasoningEffort: "max",
          modelReason: "Test supervisor route",
          agentId: "paul",
          readonly: true,
          approvalRequired: true,
          risk: "consequential",
          acceptanceCriteria: [
            "Daniel receives a draft and nothing is sent.",
            "No outbound messaging tool is available.",
          ],
        }],
        iterations: 1,
        selectedAgents: ["paul"],
        terminalReason: "desired_proposals_reached",
        networkStatus: "success",
      }),
    });

    await expect(runMissionSupervisorTick(
      tickPayload(),
      runContext(),
      runtime.dependencies,
    )).resolves.toMatchObject({
      status: "committed",
      kind: "delegate",
    });
    expect(callFor(runtime.calls, "missionSupervisor:commitV1").args)
      .toMatchObject({
        decision: {
          kind: "delegate",
          workstreams: [expect.objectContaining({
            task,
            model: "terra",
            readonly: true,
            approvalRequired: true,
            risk: "consequential",
          })],
        },
      });
  });

  it("preserves explicit safety and quality floors without paying for a planning model", async () => {
    const source = snapshot();
    const task =
      "Prepare a high-confidence readonly audit of the durable supervisor.";
    const request = JSON.parse(
      source.supervisor.requestPayloadJson,
    ) as Record<string, unknown>;
    request.requestedWorkstreams = [{
      task,
      label: "Readonly supervisor audit",
      model: "sol",
      agentId: "sentry",
      readonly: true,
      approvalRequired: true,
      risk: "high",
      acceptanceCriteria: ["The audit remains read-only and evidence-bound."],
    }];
    source.supervisor.requestPayloadJson = JSON.stringify(request);
    source.supervisor.requestDigest = sha(
      source.supervisor.requestPayloadJson,
    );
    const planning = vi.fn<MissionSupervisorTickDependencies["runPlanningNetwork"]>(async (
      input,
    ) => ({
        kind: "ready_to_commit",
        tickId: input.tickId,
        missionId: input.missionId,
        proposals: [{
          task,
          label: "Readonly supervisor audit",
          repo: null,
          model: "luna",
          reasoningEffort: "low",
          modelReason: "Test supervisor route",
          agentId: "sentry",
          readonly: false,
          approvalRequired: false,
          risk: "low",
          acceptanceCriteria: [
            "The audit remains read-only and evidence-bound.",
          ],
        }],
        iterations: 1,
        selectedAgents: ["sentry"],
        terminalReason: "desired_proposals_reached",
        networkStatus: "success",
      }));
    const runtime = harness(source, { planning });

    await expect(runMissionSupervisorTick(
      tickPayload(),
      runContext(),
      runtime.dependencies,
    )).resolves.toMatchObject({ status: "committed", kind: "delegate" });
    expect(planning).not.toHaveBeenCalled();
    expect(callFor(runtime.calls, "missionSupervisor:commitV1").args)
      .toMatchObject({
        decisionOrigin: "policy",
        modelProvider: "deterministic-policy",
        decision: {
          kind: "delegate",
          workstreams: [{
            task,
            model: "sol",
            reasoningEffort: "xhigh",
            readonly: true,
            approvalRequired: true,
            risk: "consequential",
          }],
        },
      });
  });

  it("fails closed when explicit slices or model proposals exceed desiredWorkstreams", async () => {
    const invalidRequestSource = snapshot();
    const invalidRequest = JSON.parse(
      invalidRequestSource.supervisor.requestPayloadJson,
    ) as Record<string, unknown>;
    invalidRequest.requestedWorkstreams = [
      {
        task: "Preserve the first exact foreground slice for this mission.",
        acceptanceCriteria: ["The first slice is preserved."],
      },
      {
        task: "Preserve the second exact foreground slice for this mission.",
        acceptanceCriteria: ["The second slice is preserved."],
      },
    ];
    invalidRequestSource.supervisor.requestPayloadJson =
      JSON.stringify(invalidRequest);
    invalidRequestSource.supervisor.requestDigest = sha(
      invalidRequestSource.supervisor.requestPayloadJson,
    );
    const invalidRequestRuntime = harness(invalidRequestSource);

    await expect(runMissionSupervisorTick(
      tickPayload(),
      runContext(),
      invalidRequestRuntime.dependencies,
    )).resolves.toMatchObject({
      status: "released",
      errorCode: "invalid_snapshot",
    });

    const excessiveProposalsRuntime = harness(
      withRequestPatch(snapshot(), { desiredWorkstreams: 2 }),
      {
      planning: async (input) => ({
        kind: "ready_to_commit",
        tickId: input.tickId,
        missionId: input.missionId,
        proposals: [
          {
            task: "Implement the first bounded supervisor proposal safely.",
            label: "First bounded proposal",
            repo: null,
            model: "sol",
            reasoningEffort: "max",
            modelReason: "Test supervisor route",
            agentId: "paul",
            readonly: true,
            approvalRequired: false,
            risk: "low",
            acceptanceCriteria: ["The first focused test passes."],
          },
          {
            task: "Implement the second bounded supervisor proposal safely.",
            label: "Second bounded proposal",
            repo: null,
            model: "sol",
            reasoningEffort: "max",
            modelReason: "Test supervisor route",
            agentId: "atlas",
            readonly: true,
            approvalRequired: false,
            risk: "low",
            acceptanceCriteria: ["The second focused test passes."],
          },
          {
            task: "Verify a third bounded supervisor proposal safely.",
            label: "Third bounded proposal",
            repo: null,
            model: "terra",
            reasoningEffort: "high",
            modelReason: "Test supervisor route",
            agentId: "sentry",
            readonly: true,
            approvalRequired: false,
            risk: "low",
            acceptanceCriteria: ["The third focused test passes."],
          },
        ],
        iterations: 3,
        selectedAgents: ["paul", "atlas", "sentry"],
        terminalReason: "desired_proposals_reached",
        networkStatus: "success",
      }),
    });

    await expect(runMissionSupervisorTick(
      tickPayload(),
      runContext(),
      excessiveProposalsRuntime.dependencies,
    )).resolves.toMatchObject({
      status: "released",
      errorCode: "planning_invalid",
    });
    expect(excessiveProposalsRuntime.calls.some(
      (call) => call.path === "missionSupervisor:commitV1",
    )).toBe(false);
  });

  it("releases rather than committing a network proposal outside the full admitted project set", async () => {
    const runtime = harness(withRequestPatch(snapshot(), { desiredWorkstreams: 2 }), {
      planning: async (input) => ({
        kind: "ready_to_commit",
        tickId: input.tickId,
        missionId: input.missionId,
        proposals: [
          {
            task: "Mutate a repository that was never admitted to this mission.",
            label: "Unadmitted mutation",
            repo: "daniels-project-space/not-admitted",
            model: "sol",
            reasoningEffort: "max",
            modelReason: "Test supervisor route",
            agentId: "paul",
            readonly: false,
            approvalRequired: false,
            risk: "low",
            acceptanceCriteria: ["The unadmitted repository changes."],
          },
          {
            task: "Verify the admitted evidence-only mission boundary.",
            label: "Admitted boundary verification",
            repo: null,
            model: "terra",
            reasoningEffort: "high",
            modelReason: "Test supervisor route",
            agentId: "sentry",
            readonly: true,
            approvalRequired: false,
            risk: "low",
            acceptanceCriteria: ["The admitted boundary remains intact."],
          },
        ],
        iterations: 2,
        selectedAgents: ["paul", "sentry"],
        terminalReason: "desired_proposals_reached",
        networkStatus: "success",
      }),
    });

    await expect(runMissionSupervisorTick(
      tickPayload(),
      runContext(),
      runtime.dependencies,
    )).resolves.toMatchObject({
      status: "released",
      errorCode: "planning_unadmitted_repo",
    });
    expect(runtime.calls.some(
      (call) => call.path === "missionSupervisor:commitV1",
    )).toBe(false);
  });

  it("commits network no-proposals as a truthful model-authored request for input", async () => {
    const runtime = harness(withRequestPatch(snapshot(), { desiredWorkstreams: 2 }), {
      planning: async (input, options) => {
        options.modelFor("sol");
        return {
          kind: "no_proposals",
          tickId: input.tickId,
          missionId: input.missionId,
          proposals: [],
          iterations: 1,
          selectedAgents: [],
          terminalReason: "primitive_cap_reached",
          networkStatus: "success",
        };
      },
    });

    await expect(runMissionSupervisorTick(
      tickPayload(),
      runContext(),
      runtime.dependencies,
    )).resolves.toMatchObject({
      status: "committed",
      kind: "request_input",
    });
    expect(callFor(runtime.calls, "missionSupervisor:commitV1").args)
      .toMatchObject({
        decision: {
          kind: "request_input",
          reason: "The bounded Mastra planning network returned no proposals.",
        },
        decisionOrigin: "model",
        modelProvider: "codex-subscription",
        modelTier: "sol",
        modelId: "gpt-5.6-sol",
        reasoningEffort: "xhigh",
      });
  });

  it("turns a bounded partial fleet into model-authored input rather than committing permanent underscope", async () => {
    const source = snapshot();
    const request = JSON.parse(
      source.supervisor.requestPayloadJson,
    ) as Record<string, unknown>;
    request.profile = "durable_goal";
    request.desiredWorkstreams = 3;
    source.supervisor.requestPayloadJson = JSON.stringify(request);
    source.supervisor.requestDigest = sha(
      source.supervisor.requestPayloadJson,
    );
    const runtime = harness(source, {
      planning: async (input) => ({
        kind: "ready_to_commit",
        tickId: input.tickId,
        missionId: input.missionId,
        proposals: [{
          task: "Implement only the first of three required durable workstreams.",
          label: "First partial slice",
          repo: null,
          model: "sol",
          reasoningEffort: "max",
          modelReason: "Test supervisor route",
          agentId: "paul",
          readonly: true,
          approvalRequired: false,
          risk: "low",
          acceptanceCriteria: ["The first focused check passes."],
        }],
        iterations: 1,
        selectedAgents: ["paul"],
        terminalReason: "primitive_cap_reached",
        networkStatus: "success",
      }),
    });

    await expect(runMissionSupervisorTick(
      tickPayload(),
      runContext(),
      runtime.dependencies,
    )).resolves.toMatchObject({
      status: "committed",
      kind: "request_input",
      createdJobIds: [],
    });
    expect(callFor(runtime.calls, "missionSupervisor:commitV1").args)
      .toMatchObject({
        decisionOrigin: "model",
        modelProvider: "codex-subscription",
        modelTier: "sol",
        decision: {
          kind: "request_input",
          question: expect.stringContaining("only 1 of 3"),
        },
      });
  });

  it("uses a 15-minute policy dead-man wait for active work without invoking a model", async () => {
    const createModel = vi.fn(() => fakeModel("unexpected"));
    const planning = vi.fn();
    const synthesis = vi.fn();
    const cancel = vi.fn();
    const runtime = harness(snapshot([job({ status: "running" })]), {
      createModel,
      planning,
      synthesis,
      cancel,
    });

    await expect(runMissionSupervisorTick(
      tickPayload(),
      runContext(),
      runtime.dependencies,
    )).resolves.toMatchObject({ status: "committed", kind: "wait" });
    expect(createModel).not.toHaveBeenCalled();
    expect(planning).not.toHaveBeenCalled();
    expect(synthesis).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(callFor(runtime.calls, "missionSupervisor:commitV1").args)
      .toMatchObject({
        decision: {
          kind: "wait",
          delayMs: MISSION_SUPERVISOR_ACTIVE_WAIT_MS,
        },
        decisionOrigin: "policy",
        modelProvider: "deterministic-policy",
        modelTier: "luna",
        modelId: MISSION_SUPERVISOR_POLICY_MODEL_ID,
        reasoningEffort: "none",
      });
  });

  it("retries an exact retryable terminal leaf with canonical policy metadata and no model", async () => {
    const failed = recoveryJob({
      recoveryDisposition: "retryable",
      terminalCode: "transient_provider_error",
    });
    const recovery = vi.fn();
    const synthesis = vi.fn();
    const createModel = vi.fn(() => fakeModel("unexpected"));
    const runtime = harness(snapshot([failed]), {
      recovery,
      synthesis,
      createModel,
    });

    await expect(runMissionSupervisorTick(
      tickPayload(),
      runContext(),
      runtime.dependencies,
    )).resolves.toMatchObject({
      status: "committed",
      kind: "recover",
      createdJobIds: ["job-created-1"],
    });
    expect(createModel).not.toHaveBeenCalled();
    expect(recovery).not.toHaveBeenCalled();
    expect(synthesis).not.toHaveBeenCalled();
    expect(callFor(runtime.calls, "missionSupervisor:commitV1").args)
      .toMatchObject({
        decision: {
          kind: "recover",
          recoveries: [{
            mode: "retry",
            predecessorJobId: failed.jobId,
            predecessorReceiptDigest: failed.receipt?.receiptDigest,
          }],
        },
        decisionOrigin: "policy",
        modelProvider: "deterministic-policy",
        modelTier: "luna",
        modelId: MISSION_SUPERVISOR_POLICY_MODEL_ID,
        reasoningEffort: "none",
      });
  });

  it("batches at most four deterministic retries and never mixes model recovery", async () => {
    const failed = Array.from({ length: 5 }, (_, index) =>
      recoveryJob({
        jobId: `job-retry-batch-${index}`,
        recoveryDisposition: "retryable",
        terminalCode: "transient_network_error",
      })
    );
    const recovery = vi.fn();
    const runtime = harness(snapshot(failed), { recovery });

    await expect(runMissionSupervisorTick(
      tickPayload(),
      runContext(),
      runtime.dependencies,
    )).resolves.toMatchObject({ status: "committed", kind: "recover" });
    expect(recovery).not.toHaveBeenCalled();
    const commit = callFor(
      runtime.calls,
      "missionSupervisor:commitV1",
    ).args;
    expect(commit).toMatchObject({
      decisionOrigin: "policy",
      modelProvider: "deterministic-policy",
      decision: { kind: "recover" },
    });
    const decision = commit.decision as {
      recoveries: Array<{ mode: string; predecessorJobId: string }>;
    };
    expect(decision.recoveries).toHaveLength(4);
    expect(decision.recoveries.every((item) => item.mode === "retry")).toBe(true);
    expect(decision.recoveries.map((item) => item.predecessorJobId)).toEqual(
      failed.slice(0, 4).map((item) => item.jobId),
    );
  });

  it("uses one fresh Codex subscription model to remediate exact leaves without weakening authority", async () => {
    const failed = recoveryJob({
      recoveryDisposition: "remediable",
      terminalCode: "verification_exhausted",
    });
    const created: LanguageModelV2[] = [];
    const recovery = vi.fn(async (
      input: Parameters<MissionSupervisorTickDependencies["runRecovery"]>[0],
      options: Parameters<MissionSupervisorTickDependencies["runRecovery"]>[1],
    ) => {
      expect(input.candidates).toHaveLength(1);
      expect(input.candidates[0]).toMatchObject({
        mode: "remediate",
        jobId: failed.jobId,
        terminalCode: "verification_exhausted",
        recoveryDisposition: "remediable",
        model: "sol",
        agentId: "paul",
        risk: "low",
        targetedInput: null,
      });
      expect(options.model.modelId).toBe("sol-recovery-0");
      expect(options.abortSignal.aborted).toBe(false);
      return {
        revisions: [{
          candidateId: input.candidates[0].candidateId,
          mode: "remediate" as const,
          task:
            "Rework the bounded implementation around the failed verification boundary.",
          label: "Repair verification boundary",
          model: "sol" as const,
          agentId: "paul" as const,
          risk: "low" as const,
          acceptanceCriteria: failed.acceptanceCriteria,
        }],
        rationale:
          "The revised task directly repairs the exact failed verification boundary.",
      };
    });
    const runtime = harness(snapshot([failed]), {
      createModel: (tier) => {
        const model = fakeModel(`${tier}-recovery-${created.length}`);
        created.push(model);
        return model;
      },
      recovery,
    });

    await expect(runMissionSupervisorTick(
      tickPayload(),
      runContext(),
      runtime.dependencies,
    )).resolves.toMatchObject({
      status: "committed",
      kind: "recover",
    });
    expect(created).toHaveLength(1);
    expect(recovery).toHaveBeenCalledOnce();
    expect(callFor(runtime.calls, "missionSupervisor:commitV1").args)
      .toMatchObject({
        decision: {
          kind: "recover",
          recoveries: [{
            mode: "remediate",
            predecessorJobId: failed.jobId,
            predecessorReceiptDigest: failed.receipt?.receiptDigest,
            task:
              "Rework the bounded implementation around the failed verification boundary.",
            model: "sol",
            agentId: "paul",
            risk: "low",
            acceptanceCriteria: failed.acceptanceCriteria,
          }],
        },
        decisionOrigin: "model",
        modelProvider: "codex-subscription",
        modelTier: "sol",
        modelId: "gpt-5.6-sol",
        reasoningEffort: "xhigh",
        supervisorPromptVersion: "jarvis-mission-recovery-v1",
      });
  });

  it("rejects a model-authored remediation downgrade before commit", async () => {
    const failed = recoveryJob({
      recoveryDisposition: "remediable",
      terminalCode: "verification_exhausted",
    });
    const runtime = harness(snapshot([failed]), {
      recovery: async (input) => ({
        revisions: [{
          candidateId: input.candidates[0].candidateId,
          mode: "remediate",
          task: "Attempt a weaker recovery path for the failed boundary.",
          label: "Weaker recovery",
          model: "luna",
          agentId: "paul",
          risk: "low",
          acceptanceCriteria: failed.acceptanceCriteria,
        }],
        rationale:
          "This deliberately weak fixture must be rejected before durable commit.",
      }),
    });

    await expect(runMissionSupervisorTick(
      tickPayload(),
      runContext(),
      runtime.dependencies,
    )).resolves.toMatchObject({
      status: "released",
      errorCode: "recovery_authority_downgrade",
    });
    expect(runtime.calls.some(
      (call) => call.path === "missionSupervisor:commitV1",
    )).toBe(false);
  });

  it("validates supersession lineage first and waits on only the active leaf", async () => {
    const predecessor = recoveryJob({
      jobId: "job-predecessor-active",
      recoveryDisposition: "retryable",
    });
    const successor = admittedSuccessor({
      jobId: "job-active-leaf",
      status: "running",
    });
    const edge = supersession(predecessor, successor);
    const recovery = vi.fn();
    const runtime = harness(snapshot(
      [predecessor, successor],
      [edge],
    ), { recovery });

    await expect(runMissionSupervisorTick(
      tickPayload(),
      runContext(),
      runtime.dependencies,
    )).resolves.toMatchObject({ status: "committed", kind: "wait" });
    expect(recovery).not.toHaveBeenCalled();
    expect(callFor(runtime.calls, "missionSupervisor:commitV1").args)
      .toMatchObject({
        decision: {
          kind: "wait",
          delayMs: MISSION_SUPERVISOR_ACTIVE_WAIT_MS,
        },
      });
  });

  it("fails a forked recovery lineage closed before policy or model decisions", async () => {
    const predecessor = recoveryJob({
      jobId: "job-fork-root",
      recoveryDisposition: "retryable",
    });
    const first = admittedSuccessor({ jobId: "job-fork-a" });
    const second = admittedSuccessor({
      jobId: "job-fork-b",
      decisionKey: sha("fork-b-decision"),
    });
    const recovery = vi.fn();
    const runtime = harness(snapshot(
      [predecessor, first, second],
      [
        supersession(predecessor, first),
        {
          ...supersession(predecessor, second),
          supersessionId: "supersession-fork-second",
          supersessionKey: sha("supersession-fork-second"),
          supersessionDigest: sha("supersession-fork-second-digest"),
        },
      ],
    ), { recovery });

    await expect(runMissionSupervisorTick(
      tickPayload(),
      runContext(),
      runtime.dependencies,
    )).resolves.toMatchObject({
      status: "released",
      errorCode: "invalid_recovery_lineage",
    });
    expect(recovery).not.toHaveBeenCalled();
    expect(runtime.calls.some(
      (call) => call.path === "missionSupervisor:commitV1",
    )).toBe(false);
  });

  it("requests exact targeted input at the autonomous cap instead of reviving a terminal leaf", async () => {
    const root = recoveryJob({
      jobId: "job-cap-root",
      recoveryDisposition: "retryable",
    });
    const middle = {
      ...recoveryJob({
        jobId: "job-cap-middle",
        recoveryDisposition: "retryable",
      }),
      supervisorDecisionKey: SHA_F,
      supervisorJobOrdinal: 0,
    };
    const leafDecisionKey = sha("job-cap-leaf-decision");
    const leaf = {
      ...recoveryJob({
        jobId: "job-cap-leaf",
        recoveryDisposition: "retryable",
      }),
      supervisorDecisionKey: leafDecisionKey,
      supervisorJobOrdinal: 0,
    };
    const first = supersession(root, middle);
    const second = supersession(middle, leaf, {
      rootJobId: root.jobId,
      generation: 2,
      autonomousRecoveryCount: 2,
    });
    const recovery = vi.fn();
    const runtime = harness(snapshot(
      [root, middle, leaf],
      [first, second],
    ), { recovery });

    await expect(runMissionSupervisorTick(
      tickPayload(),
      runContext(),
      runtime.dependencies,
    )).resolves.toMatchObject({
      status: "committed",
      kind: "request_input",
    });
    expect(recovery).not.toHaveBeenCalled();
    expect(callFor(runtime.calls, "missionSupervisor:commitV1").args)
      .toMatchObject({
        decision: {
          kind: "request_input",
          question: expect.stringContaining("autonomous recovery cap"),
          target: {
            predecessorJobId: leaf.jobId,
            predecessorReceiptDigest: leaf.receipt?.receiptDigest,
          },
        },
        decisionOrigin: "policy",
      });
  });

  it("requests answerable input against the exact needs-input receipt", async () => {
    const blocked = recoveryJob({
      jobId: "job-needs-input",
      status: "needs_input",
      recoveryDisposition: "needs_input",
      terminalCode: "agent_input_required",
    });
    const recovery = vi.fn();
    const runtime = harness(snapshot([blocked]), { recovery });

    await expect(runMissionSupervisorTick(
      tickPayload(),
      runContext(),
      runtime.dependencies,
    )).resolves.toMatchObject({
      status: "committed",
      kind: "request_input",
    });
    expect(recovery).not.toHaveBeenCalled();
    expect(callFor(runtime.calls, "missionSupervisor:commitV1").args)
      .toMatchObject({
        decision: {
          kind: "request_input",
          question: expect.stringContaining(blocked.result!),
          target: {
            predecessorJobId: blocked.jobId,
            predecessorReceiptDigest: blocked.receipt?.receiptDigest,
          },
        },
        decisionOrigin: "policy",
      });
  });

  it("uses exact pending input authority for one model-authored input revision", async () => {
    const blocked = recoveryJob({
      jobId: "job-input-revision",
      status: "needs_input",
      recoveryDisposition: "needs_input",
      terminalCode: "agent_input_required",
    });
    const danielInput =
      "Keep the existing scope, but use the receipt-bound fallback dataset.";
    const authoritative = bindPendingInput(
      snapshot([blocked]),
      blocked,
      danielInput,
    );
    const recovery = vi.fn(async (
      input: Parameters<MissionSupervisorTickDependencies["runRecovery"]>[0],
    ) => {
      expect(input.candidates).toHaveLength(1);
      expect(input.candidates[0]).toMatchObject({
        mode: "input_revision",
        jobId: blocked.jobId,
        targetedInput: danielInput,
      });
      return {
        revisions: [{
          candidateId: input.candidates[0].candidateId,
          mode: "input_revision" as const,
          task:
            "Complete the existing scope using Daniel's receipt-bound fallback dataset.",
          label: "Use fallback dataset",
          model: "sol" as const,
          agentId: "paul" as const,
          risk: "low" as const,
          acceptanceCriteria: blocked.acceptanceCriteria,
        }],
        rationale:
          "Daniel's exact receipt-bound input resolves the agent's missing dataset decision.",
      };
    });
    const runtime = harness(authoritative, { recovery });

    await expect(runMissionSupervisorTick(
      tickPayload({ expectedInputRevision: 2 }),
      runContext(),
      runtime.dependencies,
    )).resolves.toMatchObject({
      status: "committed",
      kind: "recover",
    });
    expect(recovery).toHaveBeenCalledOnce();
    expect(callFor(runtime.calls, "missionSupervisor:commitV1").args)
      .toMatchObject({
        expectedInputRevision: 2,
        decision: {
          kind: "recover",
          recoveries: [{
            mode: "input_revision",
            predecessorJobId: blocked.jobId,
            predecessorReceiptDigest: blocked.receipt?.receiptDigest,
            task:
              "Complete the existing scope using Daniel's receipt-bound fallback dataset.",
          }],
        },
        decisionOrigin: "model",
        modelProvider: "codex-subscription",
        supervisorPromptVersion: "jarvis-mission-recovery-v1",
      });
  });

  it("allows exact Daniel-directed input to supersede an operator-stop error without reviving it", async () => {
    const stopped = recoveryJob({
      jobId: "job-operator-stop-revision",
      status: "error",
      recoveryDisposition: "operator_stop",
      terminalCode: "delivery_blocked",
    });
    const danielInput =
      "Create a fresh read-only successor that diagnoses the delivery boundary only.";
    const authoritative = bindPendingInput(
      snapshot([stopped]),
      stopped,
      danielInput,
    );
    const recovery = vi.fn(async (
      input: Parameters<MissionSupervisorTickDependencies["runRecovery"]>[0],
    ) => ({
      revisions: [{
        candidateId: input.candidates[0].candidateId,
        mode: "input_revision" as const,
        task:
          "Create a fresh read-only diagnosis of the exact blocked delivery boundary.",
        label: "Diagnose delivery boundary",
        model: "sol" as const,
        agentId: "paul" as const,
        risk: "low" as const,
        acceptanceCriteria: stopped.acceptanceCriteria,
      }],
      rationale:
        "Daniel explicitly narrowed the operator-stop outcome to a safe read-only diagnosis.",
    }));
    const runtime = harness(authoritative, { recovery });

    await expect(runMissionSupervisorTick(
      tickPayload({ expectedInputRevision: 2 }),
      runContext(),
      runtime.dependencies,
    )).resolves.toMatchObject({
      status: "committed",
      kind: "recover",
      createdJobIds: ["job-created-1"],
    });
    expect(recovery).toHaveBeenCalledOnce();
    expect(callFor(runtime.calls, "missionSupervisor:commitV1").args)
      .toMatchObject({
        decision: {
          kind: "recover",
          recoveries: [{
            mode: "input_revision",
            predecessorJobId: stopped.jobId,
            predecessorReceiptDigest: stopped.receipt?.receiptDigest,
          }],
        },
      });
  });

  it("fails closed when pending input revisions do not match the control fence", async () => {
    const blocked = recoveryJob({
      jobId: "job-input-mismatch",
      status: "needs_input",
      recoveryDisposition: "needs_input",
    });
    const authoritative = bindPendingInput(
      snapshot([blocked]),
      blocked,
      "Use the exact bounded fallback.",
      { controlExpectedInputRevision: 0 },
    );
    const recovery = vi.fn();
    const runtime = harness(authoritative, { recovery });

    await expect(runMissionSupervisorTick(
      tickPayload({ expectedInputRevision: 2 }),
      runContext(),
      runtime.dependencies,
    )).resolves.toMatchObject({
      status: "released",
      errorCode: "invalid_pending_input_authority",
    });
    expect(recovery).not.toHaveBeenCalled();
    expect(runtime.calls.some(
      (call) => call.path === "missionSupervisor:commitV1",
    )).toBe(false);
  });

  it("never revives a cancelled leaf even when it has an operator-stop receipt", async () => {
    const cancelled = recoveryJob({
      jobId: "job-cancelled",
      status: "cancelled",
      recoveryDisposition: "operator_stop",
      terminalCode: "operator_cancelled",
    });
    const recovery = vi.fn();
    const runtime = harness(snapshot([cancelled]), { recovery });

    await expect(runMissionSupervisorTick(
      tickPayload(),
      runContext(),
      runtime.dependencies,
    )).resolves.toMatchObject({
      status: "committed",
      kind: "fail",
    });
    expect(recovery).not.toHaveBeenCalled();
    expect(callFor(runtime.calls, "missionSupervisor:commitV1").args)
      .toMatchObject({
        decision: {
          kind: "fail",
          reason: expect.stringContaining("cancelled"),
        },
      });
  });

  it("rejects a cancelled projection whose result is not bound to its exact receipt", async () => {
    const cancelled = recoveryJob({
      jobId: "job-cancelled-projection-skew",
      status: "cancelled",
      recoveryDisposition: "operator_stop",
      terminalCode: "operator_cancelled",
    });
    cancelled.result = "Cloud workspace provider was not configured.";
    cancelled.resultDigest = sha(cancelled.result);
    const runtime = harness(snapshot([cancelled]));

    await expect(runMissionSupervisorTick(
      tickPayload(),
      runContext(),
      runtime.dependencies,
    )).resolves.toMatchObject({
      status: "released",
      errorCode: "invalid_terminal_receipt",
    });
    expect(runtime.calls.some(
      (call) => call.path === "missionSupervisor:commitV1",
    )).toBe(false);
  });

  it("invokes fresh Sol synthesis only when multiple terminal receipts match exact authority", async () => {
    const completed = job({ status: "done" });
    const second = job({ jobId: "job-2", status: "done" });
    second.supervisorJobOrdinal = 1;
    const synthesis = vi.fn(async (
      input: Parameters<MissionSupervisorTickDependencies["runSynthesis"]>[0],
      options: Parameters<MissionSupervisorTickDependencies["runSynthesis"]>[1],
    ) => {
      expect(input.jobs).toHaveLength(2);
      expect(input.jobs[0].receipt).toMatchObject({
        jobId: completed.jobId,
        status: "succeeded",
        verification: "pass",
        authorityDigest: completed.authorityDigest,
        schedulingBindingDigest: completed.schedulingBindingDigest,
        workOrderRevisionDigest: completed.workOrderRevisionDigest,
        resultDigest: completed.resultDigest,
        evidenceDigest: completed.evidenceDigest,
      });
      expect(options.abortSignal.aborted).toBe(false);
      expect(options.model.modelId).toBe("sol-fresh-0");
      return {
        summary:
          "The durable Trigger supervisor completed with exact receipt-bound evidence.",
        evidence: ["Focused tests passed."],
      };
    });
    const created: LanguageModelV2[] = [];
    const runtime = harness(snapshot([completed, second]), {
      createModel: (tier) => {
        const model = fakeModel(`${tier}-fresh-${created.length}`);
        created.push(model);
        return model;
      },
      synthesis,
    });

    await expect(runMissionSupervisorTick(
      tickPayload(),
      runContext(),
      runtime.dependencies,
    )).resolves.toMatchObject({
      status: "committed",
      kind: "synthesize",
    });
    expect(created).toHaveLength(1);
    expect(synthesis).toHaveBeenCalledOnce();
    const commit = callFor(runtime.calls, "missionSupervisor:commitV1").args;
    expect(commit).toMatchObject({
      decision: {
        kind: "synthesize",
        summary:
          "The durable Trigger supervisor completed with exact receipt-bound evidence.",
      },
      decisionOrigin: "model",
      modelProvider: "codex-subscription",
      modelTier: "sol",
      modelId: "gpt-5.6-sol",
        reasoningEffort: "xhigh",
      supervisorPromptVersion: "jarvis-receipt-synthesis-v1",
    });
    expect(commit.decision).not.toHaveProperty("evidence");
  });

  it("projects one verified leaf deterministically and excludes superseded failure prose", async () => {
    const predecessor = recoveryJob({
      jobId: "job-synthesis-predecessor",
      recoveryDisposition: "retryable",
      terminalCode: "transient_network_error",
    });
    const successor = admittedSuccessor({
      jobId: "job-synthesis-leaf",
      status: "done",
    });
    const edge = supersession(predecessor, successor);
    const synthesis = vi.fn();
    const createModel = vi.fn(() => fakeModel("unexpected"));
    const runtime = harness(snapshot(
      [predecessor, successor],
      [edge],
    ), { synthesis, createModel });

    await expect(runMissionSupervisorTick(
      tickPayload(),
      runContext(),
      runtime.dependencies,
    )).resolves.toMatchObject({
      status: "committed",
      kind: "synthesize",
    });
    expect(synthesis).not.toHaveBeenCalled();
    expect(createModel).not.toHaveBeenCalled();
    expect(callFor(runtime.calls, "missionSupervisor:commitV1").args)
      .toMatchObject({
        decisionOrigin: "policy",
        modelProvider: "deterministic-policy",
        decision: {
          kind: "synthesize",
          summary: expect.stringContaining(String(successor.result)),
        },
      });
    expect(JSON.stringify(
      callFor(runtime.calls, "missionSupervisor:commitV1").args.decision,
    )).not.toContain(String(predecessor.result));
  });

  it("waits briefly instead of synthesizing when a done job lacks an exact receipt binding", async () => {
    const unbound = job({ status: "done", receipt: null });
    const synthesis = vi.fn();
    const createModel = vi.fn(() => fakeModel("unexpected"));
    const runtime = harness(snapshot([unbound]), {
      synthesis,
      createModel,
    });

    await expect(runMissionSupervisorTick(
      tickPayload(),
      runContext(),
      runtime.dependencies,
    )).resolves.toMatchObject({ status: "committed", kind: "wait" });
    expect(synthesis).not.toHaveBeenCalled();
    expect(createModel).not.toHaveBeenCalled();
    expect(callFor(runtime.calls, "missionSupervisor:commitV1").args)
      .toMatchObject({
        decision: {
          kind: "wait",
          delayMs: MISSION_SUPERVISOR_RECEIPT_WAIT_MS,
          reason: expect.stringContaining("not yet available"),
        },
        decisionOrigin: "policy",
      });
  });

  it("aborts in-flight model work on a renew fence loss, clears the heartbeat, and releases the exact claim", async () => {
    let heartbeatCallback: (() => void) | undefined;
    const cancel = vi.fn();
    let observedSignal: AbortSignal | undefined;
    const runtime = harness(withRequestPatch(snapshot(), { desiredWorkstreams: 2 }), {
      renew: (count) => count === 1
        ? {
            renewed: true,
            leaseVersion: 1,
            leaseUntil: 1_800_000_000_000,
            inputRevision: 1,
          }
        : {
            renewed: false,
            reason: "fence_mismatch",
          },
      schedule: (callback) => {
        heartbeatCallback = callback;
        return "heartbeat-handle";
      },
      cancel,
      planning: async (_input, options) => {
        observedSignal = options.abortSignal;
        return await new Promise((resolve, reject) => {
          options.abortSignal?.addEventListener(
            "abort",
            () => reject(options.abortSignal?.reason),
            { once: true },
          );
        });
      },
    });

    const pending = runMissionSupervisorTick(
      tickPayload(),
      runContext(),
      runtime.dependencies,
    );
    await vi.waitFor(() => expect(heartbeatCallback).toBeTypeOf("function"));
    heartbeatCallback?.();
    const result = await pending;

    expect(observedSignal?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledWith("heartbeat-handle");
    expect(result).toMatchObject({
      status: "released",
      errorCode: "lease_lost",
      released: true,
    });
    expect(callFor(runtime.calls, "missionSupervisor:releaseFailureV1").args)
      .toEqual({
        missionId: MISSION_ID,
        leaseOwner: missionSupervisorLeaseOwner(RUN_ID),
        leaseToken: LEASE_TOKEN,
        leaseVersion: 1,
        expectedEpoch: 1,
        expectedDecisionSequence: 1,
        expectedInputRevision: 1,
        errorCode: "lease_lost",
      });
    expect(runtime.calls.some(
      (call) => call.path === "missionSupervisor:commitV1",
    )).toBe(false);
  });

  it("propagates Trigger cancellation into model work and still clears and releases the exact lease", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    let started: (() => void) | undefined;
    const modelStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const runtime = harness(withRequestPatch(snapshot(), { desiredWorkstreams: 2 }), {
      cancel,
      planning: async (_input, options) => {
        started?.();
        return await new Promise((resolve, reject) => {
          options.abortSignal?.addEventListener(
            "abort",
            () => reject(options.abortSignal?.reason),
            { once: true },
          );
        });
      },
    });

    const pending = runMissionSupervisorTick(
      tickPayload(),
      runContext(controller.signal),
      runtime.dependencies,
    );
    await modelStarted;
    controller.abort(new Error("Trigger run cancelled"));
    await expect(pending).resolves.toMatchObject({
      status: "released",
      errorCode: "task_cancelled",
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(callFor(runtime.calls, "missionSupervisor:releaseFailureV1").args)
      .toMatchObject({ errorCode: "task_cancelled" });
  });

  it("never reports success when commit loses its fence and attempts the exact release", async () => {
    const runtime = harness(snapshot([job({ status: "running" })]), {
      commit: async () => ({
        committed: false,
        replayed: false,
        reason: "fence_mismatch",
      }),
      release: async () => ({
        released: false,
        reason: "fence_mismatch",
      }),
    });

    await expect(runMissionSupervisorTick(
      tickPayload(),
      runContext(),
      runtime.dependencies,
    )).resolves.toEqual({
      status: "stale",
      missionId: MISSION_ID,
      errorCode: "commit_rejected",
      released: false,
      releaseReason: "fence_mismatch",
    });
    expect(runtime.calls.filter(
      (call) => call.path === "missionSupervisor:releaseFailureV1",
    )).toHaveLength(1);
  });

  it("fails a digest-valid snapshot with unknown fields closed and records one bounded release", async () => {
    const invalid = {
      ...snapshot(),
      health: { heartbeat: "not authority" },
    };
    const runtime = harness(invalid as Snapshot);

    await expect(runMissionSupervisorTick(
      tickPayload(),
      runContext(),
      runtime.dependencies,
    )).resolves.toMatchObject({
      status: "released",
      errorCode: "invalid_snapshot",
    });
    expect(runtime.calls.map((call) => call.path)).toEqual([
      "missionSupervisor:claimV1",
      "missionSupervisor:releaseFailureV1",
    ]);
  });

  it("rejects request-to-mission authority drift before invoking a model", async () => {
    const drifted = snapshot();
    drifted.mission.priority = 79;
    const planning = vi.fn();
    const runtime = harness(drifted, { planning });

    await expect(runMissionSupervisorTick(
      tickPayload(),
      runContext(),
      runtime.dependencies,
    )).resolves.toMatchObject({
      status: "released",
      errorCode: "invalid_snapshot",
    });
    expect(planning).not.toHaveBeenCalled();
    expect(runtime.calls.map((call) => call.path)).toEqual([
      "missionSupervisor:claimV1",
      "missionSupervisor:releaseFailureV1",
    ]);
  });

  it("rejects more than sixteen project admissions before invoking a model", async () => {
    const oversized = snapshot();
    const request = JSON.parse(
      oversized.supervisor.requestPayloadJson,
    ) as ReturnType<typeof requestPayload>;
    const admissions = Array.from({ length: 17 }, (_, index) => ({
      ...request.projectAdmissions[0],
      canonicalProjectId: `project-${index}`,
    }));
    request.projectAdmissions = admissions;
    oversized.mission.projectAdmissions = admissions;
    oversized.supervisor.requestPayloadJson = JSON.stringify(request);
    oversized.supervisor.requestDigest = sha(
      oversized.supervisor.requestPayloadJson,
    );
    const planning = vi.fn();
    const runtime = harness(oversized, { planning });

    await expect(runMissionSupervisorTick(
      tickPayload(),
      runContext(),
      runtime.dependencies,
    )).resolves.toMatchObject({
      status: "released",
      errorCode: "invalid_snapshot",
    });
    expect(planning).not.toHaveBeenCalled();
  });
});

describe("tool-less receipt synthesis and Convex transport", () => {
  it("runs isolated mission supervisors with bounded parallelism outside the foreground queue", () => {
    expect(MISSION_SUPERVISOR_QUEUE).toBe("jarvis-mission-supervisor");
    expect(MISSION_SUPERVISOR_CONCURRENCY_LIMIT).toBe(4);

    const supervisorSource = readFileSync(
      new URL("./mission-supervisor.ts", import.meta.url),
      "utf8",
    );
    expect(supervisorSource).toContain("name: MISSION_SUPERVISOR_QUEUE");
    expect(supervisorSource).toContain(
      "concurrencyLimit: MISSION_SUPERVISOR_CONCURRENCY_LIMIT",
    );

    const foregroundPolicySource = readFileSync(
      new URL("./foreground-policy.ts", import.meta.url),
      "utf8",
    );
    expect(foregroundPolicySource).toContain(
      'FOREGROUND_QUEUE = "jarvis-foreground"',
    );
    expect(MISSION_SUPERVISOR_QUEUE).not.toBe("jarvis-foreground");
  });

  // A cold tsx child import takes ~4.5s in isolation and can cross Vitest's 5s
  // default while the full 200-file suite is compiling in parallel. Keep this
  // real-process regression bounded without making the suite resource-flaky.
  it("loads the real Trigger module in a fresh Node process without a server-only mock", () => {
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--eval",
        [
          "import('./src/trigger/mission-supervisor.ts').then((loaded) => {",
          "const module = loaded.default ?? loaded;",
          "if (!module.missionSupervisorTick || !module.runMissionSupervisorDeadmanSweep) process.exit(2);",
          "process.stdout.write('loaded');",
          "})",
        ].join(""),
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: process.env,
      },
    );

    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toBe("loaded");
    expect(child.stderr).not.toContain("server-only");
  }, 15_000);

  it("uses a real tool-less Mastra Agent with bounded structured output and exact offered evidence", async () => {
    const completed = job({ status: "done" });
    if (!completed.receipt) throw new Error("Fixture receipt missing");
    const calls: LanguageModelV2CallOptions[] = [];
    const model: LanguageModelV2 = {
      specificationVersion: "v2",
      provider: "subscription-test",
      modelId: "sol-test",
      supportedUrls: {},
      async doGenerate(options) {
        calls.push(options);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              summary:
                "The mission completed with bounded and exact receipt evidence.",
              evidence: ["Focused tests passed."],
            }),
          }],
          finishReason: "stop",
          usage,
          warnings: [],
        };
      },
      async doStream(options) {
        calls.push(options);
        const text = JSON.stringify({
          summary: "The mission completed with bounded and exact receipt evidence.",
          evidence: ["Focused tests passed."],
        });
        return {
          stream: new ReadableStream<LanguageModelV2StreamPart>({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              controller.enqueue({ type: "text-start", id: "summary" });
              controller.enqueue({
                type: "text-delta",
                id: "summary",
                delta: text,
              });
              controller.enqueue({ type: "text-end", id: "summary" });
              controller.enqueue({
                type: "finish",
                finishReason: "stop",
                usage,
              });
              controller.close();
            },
          }),
        };
      },
    };

    const output = await runJarvisReceiptSynthesis(
      {
        missionId: MISSION_ID,
        goal: "Build a durable and evidence-bound mission supervisor.",
        acceptanceCriteria: ["All exact receipts pass."],
        jobs: [{
          ...completed,
          receipt: completed.receipt,
        }],
      },
      { model, abortSignal: new AbortController().signal },
    );

    expect(output).toEqual({
      summary: "The mission completed with bounded and exact receipt evidence.",
      evidence: ["Focused tests passed."],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].tools ?? []).toEqual([]);
    expect(calls[0].toolChoice).toBeUndefined();
    expect(calls[0].responseFormat?.type).toBe("json");
  });

  it("uses a real tool-less Mastra recovery Agent with bounded candidate identities", async () => {
    const calls: LanguageModelV2CallOptions[] = [];
    const model: LanguageModelV2 = {
      specificationVersion: "v2",
      provider: "subscription-test",
      modelId: "sol-recovery-test",
      supportedUrls: {},
      async doGenerate(options) {
        calls.push(options);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              revisions: [{
                candidateId: SHA_A,
                mode: "remediate",
                task:
                  "Repair the exact verification boundary with stronger focused checks.",
                label: "Repair verification",
                model: "sol",
                agentId: "paul",
                risk: "low",
                acceptanceCriteria: ["Focused checks pass."],
              }],
              rationale:
                "The revised work directly addresses the exact failed verification boundary.",
            }),
          }],
          finishReason: "stop",
          usage,
          warnings: [],
        };
      },
      async doStream(options) {
        calls.push(options);
        throw new Error("Unexpected recovery stream");
      },
    };

    const output = await runJarvisRecovery(
      {
        missionId: MISSION_ID,
        goal: "Recover one exact terminal mission workstream safely.",
        acceptanceCriteria: ["Every recovery remains receipt-bound."],
        candidates: [{
          candidateId: SHA_A,
          mode: "remediate",
          jobId: "job-recovery-agent",
          label: "Failed verification",
          task: "Implement the exact bounded verification behavior.",
          repo: null,
          model: "sol",
          agentId: "paul",
          risk: "low",
          acceptanceCriteria: ["Focused checks pass."],
          terminalCode: "verification_exhausted",
          recoveryDisposition: "remediable",
          result: "Verification failed.",
          verificationNote: "One exact assertion failed.",
          evidenceSummary: null,
          generation: 0,
          autonomousRecoveryCount: 0,
          targetedInput: null,
        }],
      },
      { model, abortSignal: new AbortController().signal },
    );

    expect(output.revisions[0]).toMatchObject({
      candidateId: SHA_A,
      mode: "remediate",
      model: "sol",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].tools ?? []).toEqual([]);
    expect(calls[0].toolChoice).toBeUndefined();
    expect(calls[0].responseFormat?.type).toBe("json");
  });

  it("rejects Convex HTTP failures without returning an undefined value", async () => {
    const fetcher = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        void input;
        void init;
        return new Response(
          JSON.stringify({ status: "error", errorMessage: "denied" }),
          {
            status: 500,
            headers: { "content-type": "application/json" },
          },
        );
      },
    );
    const client = createSupervisorConvexClient({
      url: "https://convex.example",
      workerToken: "worker-capability",
      fetcher,
    });

    await expect(client(
      "query",
      "missionSupervisor:dueV1",
      { limit: 8 },
    )).rejects.toThrow("Convex query missionSupervisor:dueV1 rejected");
    const init = fetcher.mock.calls[0][1];
    expect(JSON.parse(String(init?.body))).toEqual({
      path: "missionSupervisor:dueV1",
      args: { limit: 8, workerToken: "worker-capability" },
      format: "json",
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("fails closed without an explicit Convex origin and contains no metered API-key route", () => {
    vi.stubEnv("CONVEX_URL", "");
    vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "");
    vi.stubEnv("JARVIS_WORKER_TOKEN", "worker-capability");
    try {
      expect(() => createSupervisorConvexClient()).toThrow(
        "CONVEX_URL is not configured",
      );
    } finally {
      vi.unstubAllEnvs();
    }

    const source = readFileSync(
      new URL("./mission-supervisor.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(
      /OPENAI_API_KEY|CODEX_API_KEY|api\.openai\.com|provider[_ -]?router/i,
    );
    expect(source).not.toContain("tangible-goose-318");
    expect(source).toContain("scope: idempotencyKeyScope");
    const dispatchSource = readFileSync(
      new URL("../lib/mission-supervisor-dispatch.ts", import.meta.url),
      "utf8",
    );
    expect(dispatchSource).toContain(
      'MISSION_SUPERVISOR_IDEMPOTENCY_KEY_SCOPE = "global"',
    );
  });

  it("keeps payload parsing and dispatch identities exact and stable", () => {
    const payload = tickPayload();
    expect(parseMissionSupervisorTickPayload(payload)).toEqual(payload);
    expect(missionSupervisorDispatchIdentity(payload)).toEqual(
      missionSupervisorDispatchIdentity({ ...payload }),
    );
    expect(missionSupervisorDispatchIdentity(payload).idempotencyKeyTTL)
      .toBe("1m");
    expect(missionSupervisorLeaseOwner(RUN_ID)).toMatch(
      /^trigger:run_supervisor_123:[0-9a-f]{16}$/,
    );
  });
});
