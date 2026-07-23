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
  MISSION_SUPERVISOR_MAX_DUE,
  MISSION_SUPERVISOR_POLICY_MODEL_ID,
  MISSION_SUPERVISOR_RECEIPT_WAIT_MS,
  canonicalSupervisorDigest,
  createSupervisorConvexClient,
  missionSupervisorDispatchIdentity,
  missionSupervisorLeaseOwner,
  parseMissionSupervisorTickPayload,
  runJarvisReceiptSynthesis,
  runMissionSupervisorSweep,
  runMissionSupervisorTick,
  type MissionSupervisorRunContext,
  type MissionSupervisorSweepDependencies,
  type MissionSupervisorTickDependencies,
  type MissionSupervisorTickPayload,
} from "./mission-supervisor";

const MISSION_ID = "mission-supervisor-1";
const RUN_ID = "run_supervisor_123";
const LEASE_TOKEN = "lease_token_abcdefghijklmnopqrstuvwxyz012345";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SOURCE_SHA = "d".repeat(64);

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
      status: string;
      verification: string;
      authorityDigest: string | null;
      schedulingBindingDigest: string | null;
      workOrderRevision: number | null;
      workOrderRevisionDigest: string | null;
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
          status: "succeeded",
          verification: "pass",
          authorityDigest,
          schedulingBindingDigest,
          workOrderRevision: 1,
          workOrderRevisionDigest,
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

function snapshot(jobs: SnapshotJob[] = []) {
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
      steer: null,
      steerDigest: null,
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
      lastDecisionKey: null,
      lastDecisionDigest: null,
    },
    jobs,
  };
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
    resultState: kind === "synthesize" ? "terminal" : "waiting",
    createdJobIds: kind === "delegate" ? ["job-created-1"] : [],
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
          epoch: 1,
          nextDecisionSequence: 1,
          inputRevision: 1,
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
          inputRevision: 1,
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

  it("commits a genuine network delegation with exact fences, actual Sol metadata, and fresh model instances", async () => {
    const created: Array<{ tier: string; model: LanguageModelV2 }> = [];
    const seenModels: LanguageModelV2[] = [];
    const source = snapshot();
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
          proposals: [{
            task: "Implement the exact Trigger durable re-entry contract.",
            label: "Durable Trigger re-entry",
            repo: null,
            model: "sol",
            agentId: "paul",
            readonly: true,
            approvalRequired: false,
            risk: "low",
            acceptanceCriteria: ["The focused runtime suite passes."],
          }],
          iterations: 2,
          selectedAgents: ["paul"],
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
      reasoningEffort: "max",
      supervisorPromptVersion: "mastra-supervisor-network-v1",
      triggerRunId: RUN_ID,
      deploymentVersion: "20260723.1",
      decision: {
        kind: "delegate",
        workstreams: [{
          task: "Implement the exact Trigger durable re-entry contract.",
          label: "Durable Trigger re-entry",
          model: "sol",
          agentId: "paul",
          readonly: true,
          approvalRequired: false,
          risk: "low",
          acceptanceCriteria: ["The focused runtime suite passes."],
        }],
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
            model: "sol",
            readonly: true,
            approvalRequired: true,
            risk: "consequential",
          })],
        },
      });
  });

  it("rejects any safety or model-quality weakening of an explicit workstream", async () => {
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
    const runtime = harness(source, {
      planning: async (input) => ({
        kind: "ready_to_commit",
        tickId: input.tickId,
        missionId: input.missionId,
        proposals: [{
          task,
          label: "Readonly supervisor audit",
          repo: null,
          model: "luna",
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
      }),
    });

    await expect(runMissionSupervisorTick(
      tickPayload(),
      runContext(),
      runtime.dependencies,
    )).resolves.toMatchObject({
      status: "released",
      errorCode: "planning_replaced_requested_work",
    });
    expect(runtime.calls.some(
      (call) => call.path === "missionSupervisor:commitV1",
    )).toBe(false);
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

    const excessiveProposalsRuntime = harness(snapshot(), {
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
            agentId: "atlas",
            readonly: true,
            approvalRequired: false,
            risk: "low",
            acceptanceCriteria: ["The second focused test passes."],
          },
        ],
        iterations: 2,
        selectedAgents: ["paul", "atlas"],
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
    const runtime = harness(snapshot(), {
      planning: async (input) => ({
        kind: "ready_to_commit",
        tickId: input.tickId,
        missionId: input.missionId,
        proposals: [{
          task: "Mutate a repository that was never admitted to this mission.",
          label: "Unadmitted mutation",
          repo: "daniels-project-space/not-admitted",
          model: "sol",
          agentId: "paul",
          readonly: false,
          approvalRequired: false,
          risk: "low",
          acceptanceCriteria: ["The unadmitted repository changes."],
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
      status: "released",
      errorCode: "planning_unadmitted_repo",
    });
    expect(runtime.calls.some(
      (call) => call.path === "missionSupervisor:commitV1",
    )).toBe(false);
  });

  it("commits network no-proposals as a truthful model-authored request for input", async () => {
    const runtime = harness(snapshot(), {
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
        reasoningEffort: "max",
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

  it("turns a terminal error into a deterministic request for Daniel instead of retrying or synthesizing", async () => {
    const synthesis = vi.fn();
    const runtime = harness(snapshot([job({ status: "error" })]), {
      synthesis,
    });

    await expect(runMissionSupervisorTick(
      tickPayload(),
      runContext(),
      runtime.dependencies,
    )).resolves.toMatchObject({
      status: "committed",
      kind: "request_input",
    });
    expect(synthesis).not.toHaveBeenCalled();
    expect(callFor(runtime.calls, "missionSupervisor:commitV1").args)
      .toMatchObject({
        decision: {
          kind: "request_input",
          reason: expect.stringContaining("is error"),
        },
        decisionOrigin: "policy",
        modelProvider: "deterministic-policy",
        reasoningEffort: "none",
      });
  });

  it("invokes fresh Sol receipt synthesis only when every terminal receipt matches exact authority", async () => {
    const completed = job({ status: "done" });
    const synthesis = vi.fn(async (
      input: Parameters<MissionSupervisorTickDependencies["runSynthesis"]>[0],
      options: Parameters<MissionSupervisorTickDependencies["runSynthesis"]>[1],
    ) => {
      expect(input.jobs).toHaveLength(1);
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
    const runtime = harness(snapshot([completed]), {
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
      reasoningEffort: "max",
      supervisorPromptVersion: "jarvis-receipt-synthesis-v1",
    });
    expect(commit.decision).not.toHaveProperty("evidence");
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
          reason: expect.stringContaining("not yet fully bound"),
        },
        decisionOrigin: "policy",
      });
  });

  it("aborts in-flight model work on a renew fence loss, clears the heartbeat, and releases the exact claim", async () => {
    let heartbeatCallback: (() => void) | undefined;
    const cancel = vi.fn();
    let observedSignal: AbortSignal | undefined;
    const runtime = harness(snapshot(), {
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
    const runtime = harness(snapshot(), {
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
          "if (!module.missionSupervisorTick || !module.missionSupervisorSweep) process.exit(2);",
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
  });

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
    expect(source).toContain('{ scope: "global" }');
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
