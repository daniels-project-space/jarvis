import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest, type TestConvex } from "convex-test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import schema from "../../convex/schema";
import { testMissionAdmission } from "../../convex/testSourceAdmission";
import { workGroupAuthority } from "../lib/work-scheduler";
import { canonicalWorkspaceCheckpoint } from "../lib/workspace-checkpoint";
import { CloudWorkspaceError, type CloudWorkspace } from "./cloud-workspace";
import type { CloudWorkspaceCleanupProvider } from "./cloud-workspace-providers";

/* eslint-disable @typescript-eslint/no-explicit-any -- the Trigger task registration and convex-test bridge expose dynamic production handler boundaries */

vi.mock("server-only", () => ({}));

declare global {
  interface ImportMeta { glob(pattern: string): Record<string, () => Promise<unknown>>; }
}

const trigger = vi.hoisted(() => {
  const definitions = new Map<string, any>();
  const metadata = {
    set: vi.fn(),
    flush: vi.fn(async () => undefined),
  } as any;
  metadata.set.mockImplementation(() => metadata);
  return {
    definitions,
    metadata,
    batchTrigger: vi.fn(async () => ({ batchId: "unexpected-batch" })),
    createIdempotencyKey: vi.fn(async () => "global-test-key"),
  };
});
const boundaries = vi.hoisted(() => ({
  resolveSubscriptionAgentBin: vi.fn<() => string | null>(() => null),
  configuredCloudWorkspaceProvider: vi.fn(() => {
    throw new Error("cloud provider must not be reached by this authority harness");
  }),
  configuredCloudWorkspaceCleanupProvider: vi.fn<() => CloudWorkspaceCleanupProvider>(() => {
    throw new Error("cloud cleanup provider must not be reached by this authority harness");
  }),
}));
const notifications = vi.hoisted(() => ({
  sendPush: vi.fn(async () => true),
}));

vi.mock("@trigger.dev/sdk/v3", () => ({
  metadata: trigger.metadata,
  task: (definition: any) => {
    trigger.definitions.set(definition.id, definition);
    return definition;
  },
  schedules: {
    task: (definition: any) => {
      trigger.definitions.set(definition.id, definition);
      return definition;
    },
  },
  tasks: { batchTrigger: trigger.batchTrigger },
  idempotencyKeys: { create: trigger.createIdempotencyKey },
  timeout: { None: "none" },
}));

vi.mock("./subscription-runtime", async (importOriginal) => ({
  ...await importOriginal<typeof import("./subscription-runtime")>(),
  resolveSubscriptionAgentBin: boundaries.resolveSubscriptionAgentBin,
}));

vi.mock("./cloud-workspace-providers", async (importOriginal) => ({
  ...await importOriginal<typeof import("./cloud-workspace-providers")>(),
  configuredCloudWorkspaceProvider: boundaries.configuredCloudWorkspaceProvider,
  configuredCloudWorkspaceCleanupProvider: boundaries.configuredCloudWorkspaceCleanupProvider,
}));

vi.mock("./push-send", () => ({ sendPush: notifications.sendPush }));

import {
  AGENT_WORKER_CHECKPOINT_MARGIN_MS,
  AGENT_WORKER_MAX_DURATION_SECONDS,
  AGENT_WORKER_SOFT_DEADLINE_MS,
  CLOUD_WORKSPACE_CLEANUP_BATCH_SIZE,
  CLOUD_WORKSPACE_CLEANUP_TIMEOUT_MS,
  awaitCloudWorkspaceCleanup,
  agentWorker,
  createProductionAgentRunnerDependencies,
  handoffCompletedAgentWorker,
  novitaSourceFilesForTask,
  runAgentMaintenance,
  runAgentHarness,
  type AgentRunnerBoundaryObservation,
  type AgentRunnerDependencies,
  type AgentRunnerEffectBoundary,
  type AgentWorkerPayload,
} from "./agent-runner";

const modules = import.meta.glob("../../convex/**/*.ts");
const WORKER = "production-runner-authority-worker";
const REPO = "daniels-project-space/jarvis";
type HarnessConvex = TestConvex<typeof schema>;

type MutationTrace = { path: string; args: Record<string, unknown> };

function bridgeProductionRunnerToConvex(
  t: HarnessConvex,
  beforeCall?: (call: MutationTrace) => Promise<void>,
  afterCall?: (call: MutationTrace, value: unknown) => Promise<void>,
) {
  const trace: MutationTrace[] = [];
  const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as MutationTrace;
    trace.push({ path: body.path, args: body.args });
    await beforeCall?.(body);
    let value: unknown;
    switch (body.path) {
      case "jobs:claimDispatched":
        value = await t.mutation(api.jobs.claimDispatched, body.args as any);
        break;
      case "jobs:authorizeExecutionBoundary":
        value = await t.mutation(api.jobs.authorizeExecutionBoundary, body.args as any);
        break;
      case "jobs:checkpointAndRequeue":
        value = await t.mutation(api.jobs.checkpointAndRequeue, body.args as any);
        break;
      case "jobs:noteCloudWorkspaceBlock":
        value = await t.mutation(api.jobs.noteCloudWorkspaceBlock, body.args as any);
        break;
      case "jobs:requestInput":
        value = await t.mutation(api.jobs.requestInput, body.args as any);
        break;
      case "jobs:reserveDispatchBatch":
        value = await t.mutation(api.jobs.reserveDispatchBatch, body.args as any);
        break;
      case "jobs:bindWorkspaceSource":
        value = await t.mutation(api.jobs.bindWorkspaceSource, body.args as any);
        break;
      case "jobs:cloudCheckpointForReplay":
        value = await t.query(api.jobs.cloudCheckpointForReplay, body.args as any);
        break;
      case "jobs:recordCloudReplayDecision":
        value = await t.mutation(api.jobs.recordCloudReplayDecision, body.args as any);
        break;
      case "jobs:bindCloudWorkspace":
        value = await t.mutation(api.jobs.bindCloudWorkspace, body.args as any);
        break;
      case "jobs:prepareCloudCodexTurn":
        value = await t.mutation(api.jobs.prepareCloudCodexTurn, body.args as any);
        break;
      case "jobs:recordCloudCodexTurnPhase":
        value = await t.mutation(api.jobs.recordCloudCodexTurnPhase, body.args as any);
        break;
      case "jobs:recordCloudCheckpoint":
        value = await t.mutation(api.jobs.recordCloudCheckpoint, body.args as any);
        break;
      case "jobs:markCloudWorkspaceTerminated":
        value = await t.mutation(api.jobs.markCloudWorkspaceTerminated, body.args as any);
        break;
      case "jobs:touchHeartbeat":
        value = await t.mutation(api.jobs.touchHeartbeat, body.args as any);
        break;
      case "jobs:updateProgress":
        value = await t.mutation(api.jobs.updateProgress, body.args as any);
        break;
      case "jobs:linearizeDelivery":
        value = await t.mutation(api.jobs.linearizeDelivery, body.args as any);
        break;
      case "jobs:markVerifiedForDelivery":
        value = await t.mutation(api.jobs.markVerifiedForDelivery, body.args as any);
        break;
      case "jobs:reviewReceipt":
        value = await t.query(api.jobs.reviewReceipt, body.args as any);
        break;
      case "jobs:prepareDeliveryEffect":
        value = await t.mutation(api.jobs.prepareDeliveryEffect, body.args as any);
        break;
      case "jobs:observeDeliveryEffect":
        value = await t.mutation(api.jobs.observeDeliveryEffect, body.args as any);
        break;
      case "jobs:setDelivery":
        value = await t.mutation(api.jobs.setDelivery, body.args as any);
        break;
      case "jobs:finalize":
        value = await t.mutation(api.jobs.finalize, body.args as any);
        break;
      case "missionSupervisorHandoff:completionWakeTicketV1":
        value = null;
        break;
      case "goalMode:externalPending":
        value = [];
        break;
      case "goalMode:claimAdvance":
      case "missions:claimReady":
        value = null;
        break;
      default:
        throw new Error(`Unexpected production runner Convex call: ${body.path}`);
    }
    await afterCall?.(body, value);
    return new Response(JSON.stringify({ status: "success", value }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { trace, fetchMock };
}

async function reservedWritableJob(
  t: HarnessConvex,
  key: string,
  reasoningEffort?: string,
  options: Readonly<{ task?: string; model?: "luna" | "terra" | "sol" }> = {},
) {
  const mission = await testMissionAdmission(t, { key, workerToken: WORKER, repository: REPO });
  const jobId = await t.mutation(api.jobs.enqueueV2, {
    task: options.task ?? "Implement the exact production runner authority fixture and stop before any untrusted checkout.",
    repo: REPO,
    readonly: false,
    reasoningEffort,
    ...(options.model ? { model: options.model } : {}),
    missionId: String(mission.missionId),
    label: "identical mutable runner label",
    workerToken: WORKER,
  }) as Id<"jobs">;
  const batch = await t.mutation(api.jobs.reserveDispatchBatch, { limit: 1, workerToken: WORKER });
  const reservation = batch.reservations[0];
  if (!reservation) throw new Error("runner authority fixture was not reserved");
  return { jobId, reservation };
}

async function invokeProductionWorker(payload: Record<string, unknown>, runId: string) {
  const definition = agentWorker as unknown as {
    run: (payload: Record<string, unknown>, context: any) => Promise<Record<string, unknown>>;
  };
  return await definition.run(payload, {
    ctx: {
      run: { id: runId },
      attempt: { number: 1 },
      machine: { name: payload.triggerMachinePreset ?? "medium-2x" },
      deployment: { version: "trigger-test-deployment" },
    },
  });
}

function workerPayload(reservation: any): AgentWorkerPayload {
  return {
    jobId: String(reservation.jobId),
    dispatchId: String(reservation.dispatchId),
    expectedAttempt: Number(reservation.attempt),
    dispatchGeneration: Number(reservation.dispatchGeneration),
    dispatchPhase: reservation.dispatchPhase,
    dispatchReceiptDigest: String(reservation.dispatchReceiptDigest),
    dispatchPayloadDigest: String(reservation.dispatchPayloadDigest),
    authorityDigest: String(reservation.authorityDigest),
    workOrderRevisionDigest: String(reservation.workOrderRevisionDigest),
    triggerMachinePreset: reservation.triggerMachinePreset,
    triggerMachineReason: reservation.triggerMachineReason,
    triggerObservedMachinePreset: reservation.triggerMachinePreset,
    triggerPlatformAttempt: 1,
  };
}

async function invokeHarness(
  reservation: any,
  runId: string,
  dependencies: AgentRunnerDependencies,
  workerDeadlineAt?: number,
) {
  return await runAgentHarness({
    reservation: { ...workerPayload(reservation), workerRunId: runId },
    runtimeAttestation: { triggerDeploymentVersion: "runner-authority-test" },
    dependencies,
    workerDeadlineAt,
  });
}

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const SOURCE_SHA = "a".repeat(40);
const TREE_SHA = "b".repeat(40);
const CHECKPOINT_SHA = "c".repeat(64);

type BoundaryTrace = {
  effect: AgentRunnerEffectBoundary;
  authority: AgentRunnerBoundaryObservation;
};

function injectedRunnerDependencies(options: {
  boundaries?: BoundaryTrace[];
  providerEffect?: ReturnType<typeof vi.fn>;
  runProcess?: ReturnType<typeof vi.fn>;
  runGit?: ReturnType<typeof vi.fn>;
  providerFetch?: typeof fetch;
  cleanupSubscriptionHome?: (env: Readonly<Record<string, string | undefined>>) => boolean;
} = {}): AgentRunnerDependencies {
  const codexHome = "/tmp/work/jarvis-runner-authority-codex-home";
  mkdirSync(codexHome, { recursive: true });
  const workspace = {
    provider: "cloudflare" as const,
    providerWorkspaceId: "fake-cloud-workspace",
    providerSessionId: "fake-cloud-session",
    root: "/workspace/repository",
    createdAt: Date.now(),
  };
  const provider = {
    name: "cloudflare" as const,
    createWorkspace: vi.fn(async () => workspace),
    uploadCredentiallessArchive: vi.fn(async () => undefined),
    run: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
    checkpoint: vi.fn(),
    restore: vi.fn(),
    exportPatch: vi.fn(async () => ({
      baseSha: SOURCE_SHA,
      patch: new Uint8Array(),
      sha256: sha256(new Uint8Array()),
      byteCount: 0,
    })),
    terminate: vi.fn(async () => undefined),
  };
  const runGit = options.runGit ?? vi.fn(async (_cmd: string, args: string[]) => {
    const command = args.join(" ");
    if (command.includes("rev-parse refs/remotes/origin/jarvis-admitted-source")) return { code: 0, out: SOURCE_SHA };
    if (command.includes("rev-parse refs/remotes/origin/jarvis-admitted-worker")) return { code: 0, out: SOURCE_SHA };
    if (command.includes("rev-parse --is-shallow-repository")) return { code: 0, out: "false" };
    if (command.includes("ls-remote")) return { code: 0, out: `${SOURCE_SHA}\trefs/heads/worker` };
    if (command.includes("rev-parse HEAD^{tree}") || command.includes(`rev-parse ${SOURCE_SHA}^{tree}`)) return { code: 0, out: TREE_SHA };
    if (command.includes("rev-parse HEAD")) return { code: 0, out: SOURCE_SHA };
    if (command.includes("branch --show-current")) return { code: 0, out: args.at(-1) ?? "" };
    if (command.includes("rev-list --count")) return { code: 0, out: "0" };
    return { code: 0, out: "" };
  });
  const runProcess = options.runProcess ?? vi.fn(async (input: any) => {
    expect(input.controllerEnv.GITHUB_TOKEN).toBeUndefined();
    expect(input.controllerEnv.JARVIS_WORKER_TOKEN).toBeUndefined();
    await input.turnReceipt.beforeRequest();
    input.turnReceipt.requestWritten();
    await input.turnReceipt.accepted();
    await input.turnReceipt.completed();
    return {
      text: "Production runner completed the bounded fake repository work.",
      timedOut: false,
      stopped: null,
      checkpointLog: "fake process completed",
      commands: [],
    };
  });
  const defaults = createProductionAgentRunnerDependencies();
  return {
    ...defaults,
    onAuthorityBoundary: (effect, authority) => {
      options.boundaries?.push({ effect, authority });
    },
    resolveSubscriptionAgentBin: vi.fn(() => "/fake/subscription/codex"),
    prepareSubscriptionEnv: vi.fn(async () => ({
      env: {
        PATH: process.env.PATH,
        CODEX_HOME: codexHome,
        CODEX_API_KEY: "must-not-reach-child",
      } as unknown as NodeJS.ProcessEnv,
    })),
    cleanupSubscriptionHome: options.cleanupSubscriptionHome ?? vi.fn(() => true),
    verifyCodexSubscriptionPreflight: vi.fn(() => ({})),
    missingSubscriptionTools: vi.fn(() => []),
    configuredCloudWorkspaceProvider: vi.fn(() => provider as any),
    runCommand: runGit as any,
    readGitObject: vi.fn(async () => Buffer.from("")),
    createCredentiallessGitArchive: vi.fn(async (_checkout, baseSha) => ({
      baseSha,
      bytes: new Uint8Array([1]),
      sha256: sha256(new Uint8Array([1])),
    })),
    createR2CheckpointStore: vi.fn(async () => ({ put: vi.fn(), get: vi.fn() }) as any),
    replayCloudWorkspaceExecution: vi.fn(async () => {
      throw new Error("first attempt must hydrate, not replay");
    }),
    prepareCloudWorkspaceExecution: vi.fn(async (input: any) => {
      if (!await input.bindWorkspace(workspace)) throw new Error("fake workspace binding rejected");
      return { provider, workspace, archive: await input.hydrateArchive() };
    }) as any,
    runCloudWorkspaceAgent: runProcess as any,
    persistPortableCheckpoint: vi.fn(async (input: any) => {
      const manifest = {
        version: 2 as const,
        jobId: input.jobId,
        attempt: input.attempt,
        provider: "cloudflare" as const,
        providerWorkspaceId: workspace.providerWorkspaceId,
        providerSessionId: workspace.providerSessionId,
        baseSha: input.baseSha,
        sourceArchiveSha256: input.sourceArchiveSha256,
        sourceArchiveBytes: input.sourceArchiveBytes,
        archiveSha256: CHECKPOINT_SHA,
        archiveBytes: 1,
        runtime: input.runtime,
        lockfileDigest: input.lockfileDigest,
        template: input.template,
        attemptKey: input.attemptKey,
        causationId: input.causationId,
        createdAt: Date.now(),
      };
      const canonicalManifest = canonicalWorkspaceCheckpoint(manifest);
      return {
        manifest,
        ref: `sandbox-checkpoints/sha256/${CHECKPOINT_SHA}`,
        digest: CHECKPOINT_SHA,
        byteCount: 1,
        canonicalManifest,
        manifestDigest: sha256(canonicalManifest),
      };
    }),
    applyValidatedPatchToControllerCheckout: vi.fn(async () => undefined),
    buildGitReviewReceipt: vi.fn(async (input: any) => {
      const evidenceDigest = sha256(input.agentEvidence);
      const receipt = {
        version: 2 as const,
        jobId: input.jobId,
        attempt: input.attempt,
        workOrderRevisionDigest: input.workOrderRevisionDigest,
        repository: input.repository,
        branch: input.expectedBranch,
        baseSha: input.baseSha,
        baseTreeSha: TREE_SHA,
        headSha: SOURCE_SHA,
        headTreeSha: TREE_SHA,
        parentShas: [] as string[],
        historyComplete: true as const,
        baseIsAncestor: true as const,
        commitCount: 0,
        commits: "",
        clean: true as const,
        diffStat: "",
        changedPaths: "",
        diffPatch: "",
        diffSha256: sha256(""),
        diffChars: 0,
        agentEvidenceSha256: evidenceDigest,
        commands: [],
      };
      return {
        ok: true as const,
        receipt,
        binding: {
          jobId: input.jobId,
          attempt: input.attempt,
          workOrderRevisionDigest: input.workOrderRevisionDigest,
          repository: input.repository,
          branch: input.expectedBranch,
          baseSha: input.baseSha,
          agentEvidenceSha256: evidenceDigest,
          headSha: SOURCE_SHA,
        },
      };
    }),
    verifyWork: vi.fn(async () => ({ verdict: "pass" as const, note: "fake review passed", answer: "" })),
    branchHasChanges: vi.fn(async () => true),
    providerFetch: options.providerFetch ?? (vi.fn(async () => {
      throw new Error("provider transport was not expected");
    }) as unknown as typeof fetch),
    syncExternalGoalRuns: vi.fn(async () => ({ checked: 0, updated: 0, blocked: 0, wake: false })),
    createExecutionLeaseControl: vi.fn(() => ({
      status: vi.fn(async () => "running"),
      close: vi.fn(),
    })),
  };
}

function configureFakeControllerAuthority() {
  process.env.GITHUB_TOKEN = "fake-controller-github-transport";
  process.env.JARVIS_GIT_REVIEW_RECEIPT_KEYRING = JSON.stringify({
    current: { keyId: "runner-authority-v2", secret: "fixed-test-only-receipt-secret-at-least-32-bytes" },
    previous: [],
  });
}

function fakeGitHubDeliveryTransport(providerEffects: string[]) {
  let pullExists = false;
  let merged = false;
  const pull = {
    number: 42,
    html_url: "https://github.test/daniels-project-space/jarvis/pull/42",
    node_id: "PR_fake_42",
    draft: false,
    state: "open",
    merged: false,
    mergeable: true,
    mergeable_state: "clean",
    head: { sha: SOURCE_SHA },
    base: { sha: SOURCE_SHA },
  };
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/pulls?state=open")) {
      return new Response(JSON.stringify(pullExists ? [pull] : []), { status: 200 });
    }
    if (url.includes("/git/ref/heads/")) {
      return new Response(JSON.stringify({ object: { sha: SOURCE_SHA } }), { status: 200 });
    }
    if (url === `https://api.github.com/repos/${REPO}`) {
      return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
    }
    if (url === `https://api.github.com/repos/${REPO}/pulls/42` && init?.method !== "PUT") {
      return new Response(JSON.stringify({
        ...pull,
        state: merged ? "closed" : "open",
        merged,
        merge_commit_sha: merged ? "d".repeat(40) : undefined,
      }), { status: 200 });
    }
    if (url === `https://api.github.com/repos/${REPO}/pulls` && init?.method === "POST") {
      providerEffects.push("create_pr");
      pullExists = true;
      return new Response(JSON.stringify(pull), { status: 201 });
    }
    if (url === `https://api.github.com/repos/${REPO}/pulls/42/merge` && init?.method === "PUT") {
      providerEffects.push("merge_pr");
      merged = true;
      return new Response(JSON.stringify({ merged: true, sha: "d".repeat(40) }), { status: 200 });
    }
    throw new Error(`Unexpected fake GitHub request: ${String(init?.method ?? "GET")} ${url}`);
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  process.env.JARVIS_WORKER_TOKEN = WORKER;
  process.env.JARVIS_MISSION_SUPERVISOR_ROLLOUT = "dormant";
  boundaries.resolveSubscriptionAgentBin.mockReset();
  boundaries.resolveSubscriptionAgentBin.mockReturnValue(null);
  boundaries.configuredCloudWorkspaceProvider.mockClear();
  boundaries.configuredCloudWorkspaceCleanupProvider.mockReset();
  boundaries.configuredCloudWorkspaceCleanupProvider.mockImplementation(() => {
    throw new Error("cloud cleanup provider must not be reached by this authority harness");
  });
  trigger.batchTrigger.mockClear();
  trigger.metadata.set.mockClear();
  trigger.metadata.flush.mockClear();
  notifications.sendPush.mockClear();
});

afterEach(() => {
  delete process.env.JARVIS_WORKER_TOKEN;
  delete process.env.JARVIS_MISSION_SUPERVISOR_ROLLOUT;
  delete process.env.GITHUB_TOKEN;
  delete process.env.JARVIS_GIT_REVIEW_RECEIPT_KEYRING;
  vi.unstubAllGlobals();
});

describe("production Trigger worker authority harness", () => {
  it("uses a finite worker envelope, a checkpoint margin, and a minute recovery sweep", () => {
    expect(AGENT_WORKER_MAX_DURATION_SECONDS).toBe(30 * 60);
    expect(AGENT_WORKER_CHECKPOINT_MARGIN_MS).toBe(2 * 60_000);
    expect(AGENT_WORKER_SOFT_DEADLINE_MS).toBe(28 * 60_000);
    expect(trigger.definitions.get("jarvis-agent-worker").maxDuration).toBe(AGENT_WORKER_MAX_DURATION_SECONDS);
    expect(trigger.definitions.get("jarvis-agent-fleet-supervisor").cron).toBe("*/1 * * * *");
  });

  it("turns a hung cloud-workspace cleanup into a typed timeout", async () => {
    vi.useFakeTimers();
    try {
      const cleanup = awaitCloudWorkspaceCleanup(new Promise<void>(() => {}), "sandbox0", 25);
      const timedOut = expect(cleanup).rejects.toMatchObject({ provider: "sandbox0", code: "timeout" });
      await vi.advanceTimersByTimeAsync(25);
      await timedOut;
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds and times out concurrent orphan cleanup so a hung teardown cannot starve routine maintenance", async () => {
    expect(CLOUD_WORKSPACE_CLEANUP_BATCH_SIZE).toBe(2);
    expect(CLOUD_WORKSPACE_CLEANUP_TIMEOUT_MS).toBe(20_000);
    const started: string[] = [];
    const terminate = vi.fn((workspace: CloudWorkspace) => {
      started.push(workspace.providerWorkspaceId);
      if (workspace.providerWorkspaceId === "workspace-blocked") {
        return new Promise<void>(() => {});
      }
      return Promise.resolve();
    });
    const cleanupProvider: CloudWorkspaceCleanupProvider = { name: "sandbox0", terminate };
    const requests: MutationTrace[] = [];
    boundaries.configuredCloudWorkspaceCleanupProvider.mockReturnValue(cleanupProvider);
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) as MutationTrace : null;
      if (!body) {
        return new Response(JSON.stringify({ status: "success", value: null }), { status: 200 });
      }
      requests.push(body);
      const value = (() => {
        switch (body.path) {
          case "jobs:migrateControlPlane":
            return { steps: 0, complete: true, phase: null };
          case "jobs:reapStale":
            return { requeued: [], releasedDispatches: [], abandoned: [], expiredCloudWorkspaceHolds: [], quarantinedDispatches: [] };
          case "controllerSession:status":
            return { state: "clear" };
          case "incidents:claimForRepair":
            return { claims: [], escalations: [] };
          case "jobs:cloudWorkspaceOrphans":
            return [
              { jobId: "job-blocked", attempt: 1, providerName: "sandbox0", providerWorkspaceId: "workspace-blocked", providerSessionId: "session-blocked" },
              { jobId: "job-fast", attempt: 1, providerName: "sandbox0", providerWorkspaceId: "workspace-fast", providerSessionId: "session-fast" },
              { jobId: "job-outside-batch", attempt: 1, providerName: "sandbox0", providerWorkspaceId: "workspace-outside-batch", providerSessionId: "session-outside-batch" },
            ];
          case "reminders:due":
            return [];
          default:
            return null;
        }
      })();
      return new Response(JSON.stringify({ status: "success", value }), { status: 200 });
    }));

    vi.useFakeTimers();
    try {
      const maintenance = runAgentMaintenance();
      await vi.waitFor(() => {
        expect(started).toEqual(expect.arrayContaining(["workspace-blocked", "workspace-fast"]));
      }, { interval: 10, timeout: 300 });
      expect(started).not.toContain("workspace-outside-batch");
      await vi.advanceTimersByTimeAsync(CLOUD_WORKSPACE_CLEANUP_TIMEOUT_MS);
      await maintenance;

      expect(terminate).toHaveBeenCalledTimes(CLOUD_WORKSPACE_CLEANUP_BATCH_SIZE);
      expect(requests).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "jobs:noteCloudWorkspaceCleanupBlocked", args: expect.objectContaining({ jobId: "job-blocked", code: "timeout" }) }),
        expect.objectContaining({ path: "jobs:markCloudWorkspaceTerminated", args: expect.objectContaining({ jobId: "job-fast" }) }),
        expect.objectContaining({ path: "reminders:due" }),
      ]));
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not spend a new incident-repair worker while controller-session repair is held", async () => {
    const requests: MutationTrace[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as MutationTrace;
      requests.push(body);
      const value = (() => {
        switch (body.path) {
          case "jobs:migrateControlPlane":
            return { steps: 0, complete: true, phase: null };
          case "jobs:reapStale":
            return { requeued: [], releasedDispatches: [], abandoned: [], expiredCloudWorkspaceHolds: [], quarantinedDispatches: [] };
          case "controllerSession:status":
            return { state: "repair_required", code: "rotation_uncertain" };
          case "jobs:cloudWorkspaceOrphans":
          case "reminders:due":
            return [];
          default:
            return null;
        }
      })();
      return new Response(JSON.stringify({ status: "success", value }), { status: 200 });
    }));

    await expect(runAgentMaintenance()).resolves.toMatchObject({
      repairs: 0,
      controllerSession: "repair_required",
    });
    expect(requests.map((request) => request.path)).not.toContain("incidents:claimForRepair");
    expect(requests.map((request) => request.path)).not.toContain("jobs:enqueue");
  });

  it("checkpoints an expired worker watchdog instead of leaving its lease running", async () => {
    configureFakeControllerAuthority();
    const t = convexTest(schema, modules);
    const { jobId, reservation } = await reservedWritableJob(t, "runner-worker-watchdog");
    bridgeProductionRunnerToConvex(t);
    const runProcess = vi.fn(async (input: any) => {
      expect(await input.executionState()).toBe("stalled");
      await input.turnReceipt.beforeRequest();
      input.turnReceipt.requestWritten();
      await input.turnReceipt.accepted();
      await input.turnReceipt.completed();
      return {
        text: "Worker watchdog preserved this bounded repository pass.",
        timedOut: false,
        stopped: "stalled",
        checkpointLog: "watchdog checkpoint",
        commands: [],
      };
    });
    const dependencies = injectedRunnerDependencies({ runProcess });

    expect(await invokeHarness(
      reservation,
      "worker-watchdog-run",
      dependencies,
      Date.now() - 1,
    )).toEqual({ processed: 1 });

    const state = await t.run(async (ctx) => ({
      job: await ctx.db.get(jobId),
      attempts: await ctx.db.query("workAttempts")
        .withIndex("by_job_attempt", (q) => q.eq("jobId", jobId).eq("attempt", 1))
        .first(),
    }));
    expect(state.job).toMatchObject({ status: "pending", attempt: 2 });
    expect(state.attempts).toMatchObject({ status: "checkpointed", workerRunId: "worker-watchdog-run" });
    expect(String(state.job?.checkpoint)).toContain("finite Trigger worker watchdog");
  });

  it.each(["dormant", "rollback"] as const)(
    "does not read supervisor authority during %s completion handoff",
    async (mode) => {
      process.env.JARVIS_MISSION_SUPERVISOR_ROLLOUT = mode;
      const query = vi.fn(async () => null);
      const dispatchWakeTicket = vi.fn(async () => ({ dispatched: true }));
      const wakeFleet = vi.fn(async () => true);

      await expect(handoffCompletedAgentWorker(`job-${mode}`, {
        query,
        dispatchWakeTicket,
        wakeFleet,
      })).resolves.toEqual({ supervisorContinued: false, continued: true });

      expect(query).not.toHaveBeenCalled();
      expect(dispatchWakeTicket).not.toHaveBeenCalled();
      expect(wakeFleet).toHaveBeenCalledWith(`worker-complete:job-${mode}`);
    },
  );

  it.each(["active", "canary"] as const)(
    "dispatches the exact completion wake ticket during %s rollout",
    async (mode) => {
      process.env.JARVIS_MISSION_SUPERVISOR_ROLLOUT = mode;
      const jobId = `job-${mode}`;
      const ticket = {
        protocolVersion: 1,
        missionId: `mission-${mode}`,
        expectedLeaseVersion: 2,
        expectedEpoch: 3,
        expectedDecisionSequence: 4,
        expectedInputRevision: 5,
      };
      const query = vi.fn(async () => ticket);
      const dispatchWakeTicket = vi.fn(async () => ({ dispatched: true }));
      const wakeFleet = vi.fn(async () => true);

      await expect(handoffCompletedAgentWorker(jobId, {
        query,
        dispatchWakeTicket,
        wakeFleet,
      })).resolves.toEqual({ supervisorContinued: true, continued: true });

      expect(query).toHaveBeenCalledWith(
        "missionSupervisorHandoff:completionWakeTicketV1",
        { jobId },
      );
      expect(dispatchWakeTicket).toHaveBeenCalledWith(ticket);
      expect(wakeFleet).toHaveBeenCalledWith(`worker-complete:${jobId}`);
    },
  );

  it("fails a wrong-repository ledger injection before subscription, provider, clone, or tools", async () => {
    const t = convexTest(schema, modules);
    const { jobId, reservation } = await reservedWritableJob(t, "runner-wrong-repository");
    await t.run(async (ctx) => {
      const job = await ctx.db.get(jobId);
      const injected = "daniels-project-space/dropship-ai";
      const forged = workGroupAuthority({
        _id: jobId,
        missionId: job?.missionId,
        repo: injected,
        canonicalProjectId: "dropship-ai",
      });
      await ctx.db.patch(jobId, { repo: injected, ...forged });
    });
    const bridge = bridgeProductionRunnerToConvex(t);

    const result = await invokeProductionWorker({
      ...workerPayload(reservation),
      reason: "same human label",
      repo: "daniels-project-space/dropship-ai",
      branch: "latest",
    }, "trigger-wrong-repository");

    expect(result).toMatchObject({ processed: 0, stale: true, continued: false, runtime: "trigger" });
    expect(bridge.trace.map((entry) => entry.path)).toEqual([
      "jobs:claimDispatched",
      "jobs:reserveDispatchBatch",
    ]);
    expect(boundaries.resolveSubscriptionAgentBin).not.toHaveBeenCalled();
    expect(boundaries.configuredCloudWorkspaceProvider).not.toHaveBeenCalled();
    expect(trigger.batchTrigger).not.toHaveBeenCalled();
    const state = await t.run(async (ctx) => ({
      job: await ctx.db.get(jobId),
      runtime: await ctx.db.query("jobRuntime").withIndex("by_job", (q) => q.eq("jobId", jobId)).first(),
      attempt: await ctx.db.query("workAttempts").withIndex("by_job_attempt", (q) => q.eq("jobId", jobId).eq("attempt", 1)).first(),
    }));
    expect(state.job).toMatchObject({ repo: "daniels-project-space/dropship-ai", status: "dispatching" });
    expect(state.runtime).toMatchObject({ schedulingBound: false, status: "dispatching" });
    expect(state.attempt?.workerRunId).toBeUndefined();
  });

  it("fails a forged background execution profile before subscription, provider, clone, or tools", async () => {
    const t = convexTest(schema, modules);
    const { jobId, reservation } = await reservedWritableJob(t, "runner-forged-background-profile");
    await t.run(async (ctx) => {
      const job = await ctx.db.get(jobId);
      const profile = job?.backgroundExecutionProfile;
      if (!profile) throw new Error("fixture is missing its derived execution profile");
      await ctx.db.patch(jobId, {
        // Deliberately violate the schema-shaped profile at the test fixture
        // boundary; production writes cannot express this forged value.
        backgroundExecutionProfile: {
          ...profile,
          modelTier: profile.modelTier === "sol" ? "terra" : "sol",
        } as never,
      });
    });
    const bridge = bridgeProductionRunnerToConvex(t);

    const result = await invokeProductionWorker(workerPayload(reservation), "trigger-forged-background-profile");

    expect(result).toMatchObject({ processed: 0, stale: true, continued: false, runtime: "trigger" });
    expect(bridge.trace.map((entry) => entry.path)).toEqual([
      "jobs:claimDispatched",
      "jobs:reserveDispatchBatch",
    ]);
    expect(boundaries.resolveSubscriptionAgentBin).not.toHaveBeenCalled();
    expect(boundaries.configuredCloudWorkspaceProvider).not.toHaveBeenCalled();
    expect(trigger.batchTrigger).not.toHaveBeenCalled();
  });

  it("ignores forged payload authority and binds the actual Trigger run to the immutable claim", async () => {
    const t = convexTest(schema, modules);
    const { jobId, reservation } = await reservedWritableJob(t, "runner-payload-forgery");
    const before = await t.run(async (ctx) => ctx.db.get(jobId));
    const bridge = bridgeProductionRunnerToConvex(t);

    const result = await invokeProductionWorker({
      ...workerPayload(reservation),
      reason: "identical mutable runner label",
      repo: "daniels-project-space/dropship-ai",
      branch: "latest-selected-branch",
      missionGroupId: "latest-mission",
      workspaceLineage: "shared-workspace",
    }, "trigger-authoritative-run");

    expect(result).toMatchObject({
      processed: 1,
      error: "no codex binary",
      continued: false,
      runtime: "trigger",
      runId: "trigger-authoritative-run",
    });
    expect(bridge.trace.map((entry) => entry.path)).toEqual([
      "jobs:claimDispatched",
      "jobs:checkpointAndRequeue",
      "jobs:reserveDispatchBatch",
    ]);
    const claim = bridge.trace[0];
    expect(claim.args).toMatchObject({
      jobId: String(jobId),
      dispatchId: reservation.dispatchId,
      workerRunId: "trigger-authoritative-run",
      expectedAttempt: 1,
      authorityDigest: reservation.authorityDigest,
      workOrderRevisionDigest: reservation.workOrderRevisionDigest,
      triggerMachinePreset: "medium-2x",
      triggerMachineReason: "admitted_write_or_hard",
      triggerObservedMachinePreset: "medium-2x",
      triggerPlatformAttempt: 1,
      workerToken: WORKER,
    });
    expect(boundaries.resolveSubscriptionAgentBin).toHaveBeenCalledWith("codex");
    expect(boundaries.configuredCloudWorkspaceProvider).not.toHaveBeenCalled();
    expect(trigger.batchTrigger).not.toHaveBeenCalled();
    const state = await t.run(async (ctx) => ({
      job: await ctx.db.get(jobId),
      attempts: await Promise.all([1, 2].map((attempt) => ctx.db.query("workAttempts")
        .withIndex("by_job_attempt", (q) => q.eq("jobId", jobId).eq("attempt", attempt)).first())),
    }));
    expect(state.job).toMatchObject({
      repo: REPO,
      status: "pending",
      attempt: 2,
      workerBranch: before?.workerBranch,
      workspaceLineage: before?.workspaceLineage,
    });
    expect(state.attempts).toHaveLength(2);
    expect(state.attempts[0]).toMatchObject({
      attempt: 1,
      workerRunId: "trigger-authoritative-run",
      status: "checkpointed",
    });
    expect(state.attempts[1]).toMatchObject({ attempt: 2, status: "pending" });
    expect(state.attempts[1]?.workerRunId).toBeUndefined();
  });

  it("returns a typed hold for a realistic legacy Trigger delivery before subscription or provider startup", async () => {
    const t = convexTest(schema, modules);
    const jobId = await t.mutation(api.jobs.enqueue, {
      task: "legacy work admitted before protocol v2",
      repo: REPO,
      workerToken: WORKER,
    }) as Id<"jobs">;
    const dispatchId = "legacy-dispatch-from-old-production";
    await t.run(async (ctx) => ctx.db.patch(jobId, {
      status: "dispatching",
      stage: "dispatching",
      dispatchId,
      dispatchLeaseUntil: Date.now() + 60_000,
    }));
    const bridge = bridgeProductionRunnerToConvex(t);

    const result = await invokeProductionWorker({ jobId: String(jobId), dispatchId }, "legacy-trigger-replay");

    expect(result).toMatchObject({
      processed: 0,
      executable: false,
      held: true,
      code: "protocol_v1_admission_held",
      runtime: "trigger",
    });
    expect(bridge.trace.map((entry) => entry.path)).toEqual([
      "jobs:claimDispatched",
      "jobs:reserveDispatchBatch",
    ]);
    expect(boundaries.resolveSubscriptionAgentBin).not.toHaveBeenCalled();
    expect(boundaries.configuredCloudWorkspaceProvider).not.toHaveBeenCalled();
  });

  it("does not report subscription acquisition when the production worker has no Codex binary", async () => {
    const t = convexTest(schema, modules);
    const { jobId, reservation } = await reservedWritableJob(t, "runner-source-head-race");
    const bridge = bridgeProductionRunnerToConvex(t);

    const result = await invokeProductionWorker({
      ...workerPayload(reservation),
    }, "trigger-source-head-race");

    expect(result).toMatchObject({
      processed: 1,
      error: "no codex binary",
      runtime: "trigger",
    });
    expect(bridge.trace.map((entry) => entry.path)).toEqual([
      "jobs:claimDispatched",
      "jobs:checkpointAndRequeue",
      "jobs:reserveDispatchBatch",
    ]);
    expect(boundaries.resolveSubscriptionAgentBin).toHaveBeenCalledWith("codex");
    expect(boundaries.configuredCloudWorkspaceProvider).not.toHaveBeenCalled();
    expect(trigger.batchTrigger).not.toHaveBeenCalled();
    const state = await t.run(async (ctx) => ({
      job: await ctx.db.get(jobId),
      attempt: await ctx.db.query("workAttempts")
        .withIndex("by_job_attempt", (q) => q.eq("jobId", jobId).eq("attempt", 1)).first(),
    }));
    expect(state.job).toMatchObject({ status: "pending", attempt: 2 });
    expect(state.attempt).toMatchObject({ status: "checkpointed", workerRunId: "trigger-source-head-race" });
  });

  it("uses only the immutable Terra/Codex route when a delivery forges a model or provider", async () => {
    configureFakeControllerAuthority();
    const t = convexTest(schema, modules);
    const { jobId, reservation } = await reservedWritableJob(
      t,
      "runner-forged-routing-payload",
      undefined,
      {
        task: "Implement a small typed fixture in the admitted repository.",
        model: "terra",
      },
    );
    const sealedBeforeRun = await t.run(async (ctx) => ({
      job: await ctx.db.get(jobId),
      order: await ctx.db.query("workOrderRevisions")
        .withIndex("by_job_revision", (q) => q.eq("jobId", jobId).eq("revision", 1))
        .unique(),
    }));
    expect(sealedBeforeRun.job).toMatchObject({ model: "terra", reasoningEffort: "medium" });
    expect(sealedBeforeRun.order).toMatchObject({
      minimumModel: "terra",
      minimumReasoningEffort: "medium",
      backgroundExecutionProfile: {
        provider: "codex-subscription",
        modelTier: "terra",
      },
    });

    const bridge = bridgeProductionRunnerToConvex(t);
    const trace: BoundaryTrace[] = [];
    const dependencies = injectedRunnerDependencies({ boundaries: trace });
    // Trigger payloads are transport metadata, not routing authority. Simulate
    // a malformed/redelivered payload that attempts to spend a higher tier or
    // switch the runner to an arbitrary provider; neither field exists in the
    // admitted AgentWorkerPayload contract.
    const forgedReservation = {
      ...reservation,
      model: "sol",
      reasoningEffort: "max",
      backgroundExecutionProfile: {
        version: 2,
        provider: "untrusted-provider",
        modelTier: "sol",
        readonly: false,
        authority: { external: true, apps: true, secrets: true, network: true },
        repositoryCapabilities: ["repository_exec"],
      },
    } as any;

    expect(await invokeHarness(
      forgedReservation,
      "forged-routing-authority-run",
      dependencies,
    )).toEqual({ processed: 1 });
    expect(dependencies.runCloudWorkspaceAgent).toHaveBeenCalledWith(
      expect.objectContaining({ model: "terra", reasoningEffort: "medium" }),
    );
    const executionBoundaries = trace.filter((item) => [
      "source_checkout",
      "provider_create",
      "codex_process",
      "review_receipt",
    ].includes(item.effect));
    expect(executionBoundaries).not.toHaveLength(0);
    expect(executionBoundaries.every(({ authority }) =>
      authority.backgroundExecutionProfile?.provider === "codex-subscription"
      && authority.backgroundExecutionProfile.modelTier === "terra"
    )).toBe(true);
    // The post-specialist review is separately authority-fenced, so an
    // untrusted specialist/Novita response cannot promote itself to delivery.
    expect(trace.map((item) => item.effect)).toContain("review_receipt");
    expect(bridge.trace.filter((call) => call.path === "jobs:markVerifiedForDelivery")).toHaveLength(1);
  });

  it("runs the real specialist and delivery lifecycle with exact server authority and reconciles a lost observation response", async () => {
    configureFakeControllerAuthority();
    const t = convexTest(schema, modules);
    const { jobId, reservation } = await reservedWritableJob(
      t,
      "runner-full-authority-lifecycle",
      "max",
    );
    const trace: BoundaryTrace[] = [];
    const specialistBridge = bridgeProductionRunnerToConvex(t);
    const cleanup = vi.fn((consumerEnv: Readonly<Record<string, string | undefined>>) => {
      void consumerEnv;
      return true;
    });
    const specialistDependencies = injectedRunnerDependencies({
      boundaries: trace,
      cleanupSubscriptionHome: cleanup,
    });

    const specialist = await invokeHarness(reservation, "specialist-authority-run", specialistDependencies);

    expect(specialist).toEqual({ processed: 1 });
    expect(specialistDependencies.runCloudWorkspaceAgent).toHaveBeenCalledWith(
      expect.objectContaining({ reasoningEffort: "max" }),
    );
    const sealed = await t.run(async (ctx) => ({
      job: await ctx.db.get(jobId),
      attempt: await ctx.db.query("workAttempts")
        .withIndex("by_job_attempt", (q) => q.eq("jobId", jobId).eq("attempt", 1)).first(),
      reviews: await ctx.db.query("reviewReceipts")
        .withIndex("by_job_attempt_digest", (q) => q.eq("jobId", jobId).eq("attempt", 1)).collect(),
    }));
    expect(sealed.job).toMatchObject({
      status: "pending",
      reasoningEffort: "max",
      verificationVerdict: "pass",
      reviewReceiptId: sealed.reviews[0]?._id,
      reviewReceiptDigest: sealed.reviews[0]?.receiptDigest,
    });
    expect(sealed.attempt).toMatchObject({
      workerRunId: "specialist-authority-run",
      checkpointDigest: CHECKPOINT_SHA,
      providerWorkspaceId: "fake-cloud-workspace",
      providerSessionId: "fake-cloud-session",
      codexTurnReceiptPhase: "completed",
    });
    const turnPhases = specialistBridge.trace
      .filter((call) => call.path === "jobs:recordCloudCodexTurnPhase");
    expect(turnPhases.map((call) => call.args.phase)).toEqual([
      "request_intent", "request_written", "accepted", "completed",
    ]);
    expect(turnPhases.every((call) =>
      call.args.authorityDigest === sealed.attempt?.authorityDigest
      && call.args.workOrderRevisionDigest === sealed.attempt?.workOrderRevisionDigest
    )).toBe(true);
    expect(cleanup).toHaveBeenCalled();
    expect(new Set(cleanup.mock.calls.map(([consumerEnv]) => consumerEnv)).size).toBe(cleanup.mock.calls.length);
    expect(trace.map((item) => item.effect)).toEqual([
      "source_checkout",
      "provider_create",
      "subscription_acquire",
      "codex_process",
      "checkpoint_persist",
      "review_receipt",
      "subscription_acquire",
      "codex_process",
    ]);
    for (const { authority } of trace) {
      expect(authority).toMatchObject({
        authorityDigest: sealed.attempt?.authorityDigest,
        schedulingBindingDigest: sealed.attempt?.schedulingBindingDigest,
        workOrderRevisionId: sealed.attempt?.workOrderRevisionId,
        workOrderRevision: sealed.attempt?.workOrderRevision,
        workOrderRevisionDigest: sealed.attempt?.workOrderRevisionDigest,
        repository: REPO,
        sourceBranch: sealed.attempt?.sourceBranch,
        sourceHeadSha: sealed.attempt?.sourceHeadSha,
      });
    }
    expect(specialistBridge.trace.filter((call) => call.path === "jobs:markVerifiedForDelivery")).toHaveLength(1);

    const firstControllerBatch = await t.mutation(api.jobs.reserveDispatchBatch, { limit: 1, workerToken: WORKER });
    const firstControllerReservation = firstControllerBatch.reservations[0];
    expect(firstControllerReservation).toBeTruthy();
    const providerEffects: string[] = [];
    const providerFetch = fakeGitHubDeliveryTransport(providerEffects);
    let loseObservationResponse = true;
    const firstControllerBridge = bridgeProductionRunnerToConvex(t, undefined, async (call) => {
      if (call.path === "jobs:observeDeliveryEffect" && loseObservationResponse) {
        loseObservationResponse = false;
        throw new Error("simulated response loss after durable provider observation");
      }
    });
    const firstControllerTrace: BoundaryTrace[] = [];
    const firstControllerDependencies = injectedRunnerDependencies({
      boundaries: firstControllerTrace,
      providerFetch,
    });

    expect(await invokeHarness(
      firstControllerReservation,
      "delivery-controller-run-1",
      firstControllerDependencies,
    )).toEqual({ processed: 1 });
    expect(providerEffects).toEqual(["create_pr"]);
    expect(firstControllerTrace.map((item) => item.effect)).toEqual(["delivery_effect"]);
    expect((firstControllerDependencies.runCloudWorkspaceAgent as any)).not.toHaveBeenCalled();
    expect(firstControllerBridge.trace.filter((call) => call.path === "jobs:prepareDeliveryEffect")).toHaveLength(1);
    expect(firstControllerBridge.trace.filter((call) => call.path === "jobs:observeDeliveryEffect")).toHaveLength(1);

    await t.run(async (ctx) => ctx.db.patch(jobId, { nextRunAt: Date.now() }));
    const replayBatch = await t.mutation(api.jobs.reserveDispatchBatch, { limit: 1, workerToken: WORKER });
    const replayReservation = replayBatch.reservations[0];
    expect(replayReservation).toBeTruthy();
    const replayTrace: BoundaryTrace[] = [];
    const replayBridge = bridgeProductionRunnerToConvex(t);
    const replayDependencies = injectedRunnerDependencies({ boundaries: replayTrace, providerFetch });

    expect(await invokeHarness(
      replayReservation,
      "delivery-controller-run-2",
      replayDependencies,
    )).toEqual({ processed: 1 });
    expect(providerEffects).toEqual(["create_pr", "merge_pr"]);
    expect((replayDependencies.runCloudWorkspaceAgent as any)).not.toHaveBeenCalled();
    expect(replayTrace.map((item) => item.effect)).toEqual(["delivery_effect"]);
    const finished = await t.run(async (ctx) => ({
      job: await ctx.db.get(jobId),
      attempt: await ctx.db.query("workAttempts")
        .withIndex("by_job_attempt", (q) => q.eq("jobId", jobId).eq("attempt", 1)).first(),
      reviews: await ctx.db.query("reviewReceipts")
        .withIndex("by_job_attempt_digest", (q) => q.eq("jobId", jobId).eq("attempt", 1)).collect(),
      deliveries: await ctx.db.query("deliveryAttempts")
        .withIndex("by_job_source_generation", (q) => q.eq("jobId", jobId).eq("sourceWorkAttempt", 1)).collect(),
      workReceipts: await ctx.db.query("workReceipts")
        .withIndex("by_job_attempt", (q) => q.eq("jobId", jobId).eq("attempt", 1)).collect(),
      integrations: await ctx.db.query("integrationAttempts").collect(),
    }));
    expect({
      status: finished.job?.status,
      deliveryStatus: finished.job?.deliveryStatus,
      pullRequestUrl: finished.job?.pullRequestUrl,
    }).toMatchObject({
      status: "done",
      deliveryStatus: "merged",
      pullRequestUrl: "https://github.test/daniels-project-space/jarvis/pull/42",
    });
    expect(finished.reviews).toHaveLength(1);
    expect(finished.deliveries).toHaveLength(2);
    expect(finished.deliveries.map((delivery) => delivery.generation)).toEqual([1, 2]);
    expect(finished.workReceipts).toHaveLength(1);
    expect(finished.integrations).toHaveLength(0);
    expect(finished.attempt?.checkpointDigest).toBe(CHECKPOINT_SHA);
    expect(new Set(finished.deliveries.flatMap((delivery) =>
      (delivery.effects ?? []).map((effect: any) => effect.effectId),
    ))).toEqual(new Set([
      `pr:ready:${sealed.job?.workerBranch}:${SOURCE_SHA}:${SOURCE_SHA}`,
      `merge:42:${SOURCE_SHA}:${SOURCE_SHA}`,
    ]));
    expect(finished.deliveries.every((delivery) =>
      delivery.authorityDigest === sealed.attempt?.authorityDigest
      && delivery.schedulingBindingDigest === sealed.attempt?.schedulingBindingDigest
      && delivery.workOrderRevisionId === sealed.attempt?.workOrderRevisionId
      && delivery.workOrderRevisionDigest === sealed.attempt?.workOrderRevisionDigest
      && delivery.reviewReceiptId === sealed.reviews[0]?._id
      && delivery.reviewReceiptDigest === sealed.reviews[0]?.receiptDigest
    )).toBe(true);
    expect(replayBridge.trace.filter((call) => call.path === "jobs:prepareDeliveryEffect")).toHaveLength(1);
    expect(replayBridge.trace.filter((call) => call.path === "jobs:observeDeliveryEffect")).toHaveLength(1);
    expect(replayBridge.trace.filter((call) => call.path === "jobs:markVerifiedForDelivery")).toHaveLength(0);
  });

  it("does not start any injected transport when the immutable claim is stale", async () => {
    configureFakeControllerAuthority();
    const t = convexTest(schema, modules);
    const { reservation } = await reservedWritableJob(t, "runner-no-effect-before-claim");
    const bridge = bridgeProductionRunnerToConvex(t);
    const boundariesSeen: BoundaryTrace[] = [];
    const dependencies = injectedRunnerDependencies({ boundaries: boundariesSeen });

    const result = await invokeHarness({
      ...reservation,
      dispatchId: `${reservation.dispatchId}-stale`,
    }, "stale-claim-run", dependencies);

    expect(result).toEqual({
      processed: 0,
      executable: false,
      held: true,
      code: "trigger_launch_authority_held",
    });
    expect(boundariesSeen).toEqual([]);
    expect((dependencies.resolveSubscriptionAgentBin as any)).not.toHaveBeenCalled();
    expect((dependencies.configuredCloudWorkspaceProvider as any)).not.toHaveBeenCalled();
    expect((dependencies.runCommand as any)).not.toHaveBeenCalled();
    expect((dependencies.runCloudWorkspaceAgent as any)).not.toHaveBeenCalled();
    expect((dependencies.persistPortableCheckpoint as any)).not.toHaveBeenCalled();
    expect((dependencies.buildGitReviewReceipt as any)).not.toHaveBeenCalled();
    expect((dependencies.providerFetch as any)).not.toHaveBeenCalled();
    expect(bridge.trace.map((call) => call.path)).toEqual(["jobs:claimDispatched"]);
    const effects = await t.run(async (ctx) => ({
      reviews: await ctx.db.query("reviewReceipts").collect(),
      deliveries: await ctx.db.query("deliveryAttempts").collect(),
      integrations: await ctx.db.query("integrationAttempts").collect(),
      receipts: await ctx.db.query("workReceipts").collect(),
    }));
    expect(effects).toEqual({ reviews: [], deliveries: [], integrations: [], receipts: [] });
  });

  it("rejects a new steering work order before the next source checkout transport", async () => {
    configureFakeControllerAuthority();
    const t = convexTest(schema, modules);
    const { jobId, reservation } = await reservedWritableJob(t, "runner-steering-boundary");
    let steered = false;
    bridgeProductionRunnerToConvex(t, async (call) => {
      if (call.path !== "jobs:authorizeExecutionBoundary"
        || call.args.phase !== "source_checkout"
        || steered) return;
      steered = true;
      await t.mutation(api.jobs.control, {
        jobId,
        action: "steer",
        input: "Use the newly admitted work-order revision.",
        workerToken: WORKER,
      });
    });
    const trace: BoundaryTrace[] = [];
    const dependencies = injectedRunnerDependencies({ boundaries: trace });

    expect(await invokeHarness(reservation, "steered-between-boundaries", dependencies)).toEqual({ processed: 1 });
    expect(trace.map((item) => item.effect)).toEqual([]);
    expect((dependencies.resolveSubscriptionAgentBin as any)).toHaveBeenCalledTimes(1);
    expect((dependencies.runCommand as any)).not.toHaveBeenCalled();
    expect((dependencies.configuredCloudWorkspaceProvider as any)).toHaveBeenCalledTimes(1);
    expect((dependencies.runCloudWorkspaceAgent as any)).not.toHaveBeenCalled();
    const state = await t.run(async (ctx) => ctx.db.get(jobId));
    expect(state).toMatchObject({ status: "pending", attempt: 2, steerRevision: 1 });
    expect(state?.workOrderRevision).toBeGreaterThan(1);
  });

  it("does not observe acquisition or call Codex when subscription preflight fails", async () => {
    configureFakeControllerAuthority();
    const t = convexTest(schema, modules);
    const { reservation } = await reservedWritableJob(t, "runner-preflight-failure");
    bridgeProductionRunnerToConvex(t);
    const trace: BoundaryTrace[] = [];
    const dependencies = injectedRunnerDependencies({ boundaries: trace });
    (dependencies.verifyCodexSubscriptionPreflight as any).mockReturnValue({
      error: "subscription snapshot was rejected",
    });

    expect(await invokeHarness(reservation, "preflight-failure-run", dependencies)).toEqual({ processed: 1 });
    expect(trace.map((item) => item.effect)).toEqual(["source_checkout", "provider_create"]);
    expect((dependencies.prepareSubscriptionEnv as any)).toHaveBeenCalledTimes(1);
    expect((dependencies.runCloudWorkspaceAgent as any)).not.toHaveBeenCalled();
  });

  it("holds an unavailable controller session for operator repair without queuing another paid worker", async () => {
    configureFakeControllerAuthority();
    const t = convexTest(schema, modules);
    const { jobId, reservation } = await reservedWritableJob(t, "runner-session-repair-hold");
    const bridge = bridgeProductionRunnerToConvex(t);
    const dependencies = injectedRunnerDependencies();
    const operatorSignal =
      "JARVIS_CODEX_SESSION_UNAVAILABLE[rotation_uncertain]: re-enrol the controller-managed ChatGPT session; do not add an API key";
    (dependencies.prepareSubscriptionEnv as any).mockResolvedValue({
      env: { PATH: process.env.PATH, CODEX_HOME: "/tmp/jarvis-session-repair-hold" },
      error: operatorSignal,
    });

    expect(await invokeHarness(reservation, "session-repair-hold-run", dependencies)).toEqual({ processed: 1 });
    expect((dependencies.runCloudWorkspaceAgent as any)).not.toHaveBeenCalled();
    expect(bridge.trace.map((call) => call.path)).toContain("jobs:requestInput");
    expect(bridge.trace.map((call) => call.path)).not.toContain("jobs:checkpointAndRequeue");

    const state = await t.run(async (ctx) => ({
      job: await ctx.db.get(jobId),
      attempt: await ctx.db.query("workAttempts")
        .withIndex("by_job_attempt", (q) => q.eq("jobId", jobId).eq("attempt", 1)).first(),
      attention: await ctx.db.query("attentionItems")
        .withIndex("by_jobId", (q) => q.eq("jobId", String(jobId))).first(),
      retry: await ctx.db.query("workAttempts")
        .withIndex("by_job_attempt", (q) => q.eq("jobId", jobId).eq("attempt", 2)).first(),
    }));
    expect(state.job).toMatchObject({ status: "needs_input", attempt: 1 });
    expect(state.attempt).toMatchObject({ status: "needs_input" });
    expect(state.retry).toBeNull();
    expect(state.attention?.detail).toContain("rotation_uncertain");
  });

  it.each(["prepare", "preflight"] as const)(
    "does not emit a local subscription acquisition when supervisor %s fails before Codex",
    async (failurePoint) => {
      configureFakeControllerAuthority();
      const t = convexTest(schema, modules);
      const { jobId, reservation } = await reservedWritableJob(t, `runner-local-${failurePoint}-failure`);
      bridgeProductionRunnerToConvex(t);
      const trace: BoundaryTrace[] = [];
      const dependencies = injectedRunnerDependencies({ boundaries: trace });
      let prepareCalls = 0;
      (dependencies.prepareSubscriptionEnv as any).mockImplementation(async () => {
        prepareCalls += 1;
        return {
          env: {
            PATH: process.env.PATH,
            CODEX_HOME: `/tmp/jarvis-local-subscription-${failurePoint}-${prepareCalls}`,
          },
          ...(failurePoint === "prepare" && prepareCalls === 2
            ? { error: "local subscription preparation failed" }
            : {}),
        };
      });
      let preflightCalls = 0;
      (dependencies.verifyCodexSubscriptionPreflight as any).mockImplementation(() => {
        preflightCalls += 1;
        return failurePoint === "preflight" && preflightCalls === 2
          ? { error: "local subscription preflight failed" }
          : {};
      });

      expect(await invokeHarness(reservation, `local-${failurePoint}-failure-run`, dependencies))
        .toEqual({ processed: 1 });
      expect((dependencies.prepareSubscriptionEnv as any)).toHaveBeenCalledTimes(2);
      expect((dependencies.verifyCodexSubscriptionPreflight as any))
        .toHaveBeenCalledTimes(failurePoint === "prepare" ? 1 : 2);
      expect((dependencies.runCloudWorkspaceAgent as any)).toHaveBeenCalledTimes(1);
      expect(trace.filter((item) => item.effect === "subscription_acquire")).toHaveLength(1);
      expect(trace.map((item) => item.effect)).toEqual([
        "source_checkout",
        "provider_create",
        "subscription_acquire",
        "codex_process",
        "checkpoint_persist",
        "review_receipt",
      ]);
      const state = await t.run(async (ctx) => ctx.db.get(jobId));
      expect(state).toMatchObject({ status: "pending", attempt: 2 });
    },
  );

  it.each([
    { disposition: "blocked" as const, code: "missing_configuration" as const },
    { disposition: "rejected" as const, code: "checkpoint_tampered" as const },
  ])(
    "holds a $disposition cloud authority failure for automatic system recovery without spending another attempt",
    async ({ disposition, code }) => {
      configureFakeControllerAuthority();
      const t = convexTest(schema, modules);
      const { jobId, reservation } = await reservedWritableJob(
        t,
        `runner-provider-${disposition}`,
      );
      const bridge = bridgeProductionRunnerToConvex(t);
      const dependencies = injectedRunnerDependencies();
      (dependencies.configuredCloudWorkspaceProvider as any).mockImplementation(
        () => {
          throw new CloudWorkspaceError(
            "vercel",
            code,
            `Provider ${disposition} requires operator action`,
            disposition,
          );
        },
      );

      expect(await invokeHarness(
        reservation,
        `provider-${disposition}-run`,
        dependencies,
      )).toEqual({
        processed: 1,
        blocked: true,
        provider: "vercel",
        code,
      });
      const state = await t.run(async (ctx) => ({
        job: await ctx.db.get(jobId),
        attempts: await ctx.db
          .query("workAttempts")
          .withIndex("by_job_attempt", (q) => q.eq("jobId", jobId))
          .collect(),
        dispatchReceipts: await ctx.db
          .query("dispatchReceipts")
          .withIndex("by_job_generation", (q) => q.eq("jobId", jobId))
          .collect(),
        runtime: await ctx.db
          .query("jobRuntime")
          .withIndex("by_job", (q) => q.eq("jobId", jobId))
          .unique(),
        attention: await ctx.db.query("attentionItems").collect(),
      }));
      expect(state.job).toMatchObject({
        status: "paused",
        attempt: 1,
        providerRunState: "blocked",
        cloudWorkspaceBlockCode: code,
      });
      expect(state.job?.nextRunAt).toBeUndefined();
      expect(state.runtime).toMatchObject({
        status: "paused",
        attempt: 1,
      });
      expect(state.attempts).toHaveLength(1);
      expect(state.attempts[0]).toMatchObject({
        attempt: 1,
        status: "paused",
      });
      expect(state.dispatchReceipts).toHaveLength(1);
      expect(state.dispatchReceipts[0]).toMatchObject({ status: "closed" });
      expect(state.attention).toHaveLength(0);
      expect(bridge.trace.map((call) => call.path)).toContain(
        "jobs:noteCloudWorkspaceBlock",
      );
      expect(bridge.trace.map((call) => call.path)).not.toContain(
        "jobs:requestInput",
      );
      expect(bridge.trace.map((call) => call.path)).toContain(
        "jobs:checkpointAndRequeue",
      );
      expect((dependencies.runCloudWorkspaceAgent as any)).not.toHaveBeenCalled();
      expect((dependencies.prepareSubscriptionEnv as any)).not.toHaveBeenCalled();

      expect(await t.mutation(api.jobs.resumeCloudWorkspaceBlocks, {
        limit: 8,
        workerToken: WORKER,
      })).toEqual({ resumed: [String(jobId)] });
      const resumed = await t.run(async (ctx) => ctx.db.get(jobId));
      expect(resumed).toMatchObject({
        status: "pending",
        attempt: 2,
        providerRunState: "queued",
        progress: "Secure worker ready · continuing automatically",
      });
    },
  );

  it("expires only a verified stale missing-configuration hold after no workspace was created", async () => {
    configureFakeControllerAuthority();
    const t = convexTest(schema, modules);
    const { jobId, reservation } = await reservedWritableJob(t, "runner-expired-cloud-config");
    const bridge = bridgeProductionRunnerToConvex(t);
    const dependencies = injectedRunnerDependencies();
    (dependencies.configuredCloudWorkspaceProvider as any).mockImplementation(() => {
      throw new CloudWorkspaceError(
        "vercel",
        "missing_configuration",
        "Provider setup is incomplete",
        "blocked",
      );
    });

    await invokeHarness(reservation, "expired-cloud-config-run", dependencies);
    await t.run(async (ctx) => {
      const job: any = await ctx.db.get(jobId);
      const runtime: any = await ctx.db.query("jobRuntime")
        .withIndex("by_job", (q) => q.eq("jobId", jobId))
        .unique();
      const observedAt = Date.now() - 61 * 60_000;
      // Production already has historical holds created before the exact
      // reason field existed. Their signed checkpoint is the only permitted
      // compatibility selector; broad progress text is never parsed.
      await ctx.db.patch(jobId, { providerObservedAt: observedAt, cloudWorkspaceBlockCode: undefined });
      await ctx.db.patch(runtime._id, { providerObservedAt: observedAt, cloudWorkspaceBlockCode: undefined });
    });

    expect(await t.mutation(api.jobs.reapStale, { workerToken: WORKER }))
      .toMatchObject({ expiredCloudWorkspaceHolds: [expect.any(String)] });
    const state = await t.run(async (ctx) => ({
      job: await ctx.db.get(jobId),
      runtime: await ctx.db.query("jobRuntime")
        .withIndex("by_job", (q) => q.eq("jobId", jobId))
        .unique(),
      attempt: await ctx.db.query("workAttempts")
        .withIndex("by_job_attempt", (q) => q.eq("jobId", jobId).eq("attempt", 1))
        .unique(),
    }));
    expect(state.job).toMatchObject({
      status: "error",
      stage: "configuration error",
      providerRunState: "expired",
    });
    expect(state.runtime).toMatchObject({ status: "error", active: false });
    expect(state.attempt).toMatchObject({ status: "error" });
    expect((dependencies.runCloudWorkspaceAgent as any)).not.toHaveBeenCalled();
    expect(bridge.trace.map((call) => call.path)).not.toContain("jobs:bindCloudWorkspace");

    expect(await t.mutation(api.jobs.reapStale, { workerToken: WORKER }))
      .toMatchObject({ expiredCloudWorkspaceHolds: [] });
  });

  it("does not expire a configuration hold that resumed before the reaper reads it", async () => {
    configureFakeControllerAuthority();
    const t = convexTest(schema, modules);
    const { jobId, reservation } = await reservedWritableJob(t, "runner-resumed-cloud-config");
    bridgeProductionRunnerToConvex(t);
    const dependencies = injectedRunnerDependencies();
    (dependencies.configuredCloudWorkspaceProvider as any).mockImplementation(() => {
      throw new CloudWorkspaceError(
        "vercel",
        "missing_configuration",
        "Provider setup is incomplete",
        "blocked",
      );
    });

    await invokeHarness(reservation, "resumed-cloud-config-run", dependencies);
    await t.run(async (ctx) => {
      const runtime: any = await ctx.db.query("jobRuntime")
        .withIndex("by_job", (q) => q.eq("jobId", jobId))
        .unique();
      const observedAt = Date.now() - 61 * 60_000;
      await ctx.db.patch(jobId, { providerObservedAt: observedAt });
      await ctx.db.patch(runtime._id, { providerObservedAt: observedAt });
    });
    expect(await t.mutation(api.jobs.resumeCloudWorkspaceBlocks, {
      limit: 1,
      workerToken: WORKER,
    })).toEqual({ resumed: [String(jobId)] });
    expect(await t.mutation(api.jobs.reapStale, { workerToken: WORKER }))
      .toMatchObject({ expiredCloudWorkspaceHolds: [] });
    expect(await t.run(async (ctx) => ctx.db.get(jobId)))
      .toMatchObject({ status: "pending", providerRunState: "queued" });
  });

  it("does not notify when a verified input hold loses its authority race", async () => {
    configureFakeControllerAuthority();
    const t = convexTest(schema, modules);
    const { jobId, reservation } = await reservedWritableJob(
      t,
      "runner-stale-input-hold",
    );
    let retired = false;
    const bridge = bridgeProductionRunnerToConvex(t, async (call) => {
      if (call.path !== "jobs:requestInput" || retired) return;
      retired = true;
      const result = await t.mutation(api.jobs.checkpointAndRequeue, {
        jobId,
        expectedAttempt: Number(call.args.expectedAttempt),
        authorityDigest: String(call.args.authorityDigest),
        workerRunId: String(call.args.workerRunId),
        workerToken: WORKER,
        checkpoint: "A concurrent controller continuation retired this worker.",
        result: "The stale worker must not notify.",
        delayMs: 0,
      });
      expect(result).toMatchObject({ requeued: true, stale: false });
    });
    const dependencies = injectedRunnerDependencies();
    (dependencies.verifyWork as any).mockResolvedValue({
      verdict: "needs_input",
      note: "Choose the consequential production option.",
      answer: "",
    });

    expect(await invokeHarness(
      reservation,
      "stale-input-hold-run",
      dependencies,
    )).toEqual({ processed: 1 });
    const state = await t.run(async (ctx) => ctx.db.get(jobId));
    expect(state).toMatchObject({ status: "pending", attempt: 2 });
    expect(bridge.trace.map((call) => call.path)).toContain("jobs:requestInput");
    expect(bridge.trace.map((call) => call.path)).not.toContain(
      "chatQueue:postAssistant",
    );
    expect(notifications.sendPush).not.toHaveBeenCalled();
  });

  it("durably checkpoints and requeues a provider startup timeout instead of leaving the attempt running", async () => {
    configureFakeControllerAuthority();
    const t = convexTest(schema, modules);
    const { jobId, reservation } = await reservedWritableJob(t, "runner-provider-startup-timeout");
    const bridge = bridgeProductionRunnerToConvex(t);
    const dependencies = injectedRunnerDependencies();
    (dependencies.prepareCloudWorkspaceExecution as any).mockImplementation(async (input: any) => {
      await input.onStage("provider_list");
      await input.onStage("provider_create");
      throw new CloudWorkspaceError("vercel", "timeout", "Vercel Sandbox creation exceeded its controller deadline", "deferred");
    });

    expect(await invokeHarness(reservation, "provider-startup-timeout-run", dependencies))
      .toEqual({ processed: 1 });
    const state = await t.run(async (ctx) => ({
      job: await ctx.db.get(jobId),
      attempts: await Promise.all([1, 2].map((attempt) => ctx.db.query("workAttempts")
        .withIndex("by_job_attempt", (q) => q.eq("jobId", jobId).eq("attempt", attempt))
        .first())),
      runtime: await ctx.db.query("jobRuntime")
        .withIndex("by_job", (q) => q.eq("jobId", jobId))
        .first(),
    }));
    expect(state.job).toMatchObject({ status: "pending", attempt: 2 });
    expect(state.runtime).toMatchObject({ status: "pending", attempt: 2 });
    expect(state.attempts.find((attempt) => attempt?.attempt === 1)).toMatchObject({
      status: "checkpointed",
      workerRunId: "provider-startup-timeout-run",
    });
    expect(state.attempts.find((attempt) => attempt?.attempt === 2)).toMatchObject({
      status: "pending",
    });
    expect(String(state.job?.checkpoint)).toContain("Vercel Sandbox creation exceeded its controller deadline");
    expect(bridge.trace
      .filter((call) => call.path === "jobs:updateProgress")
      .map((call) => call.args.stage)).toEqual([
      "source clone",
      "checkpoint store",
      "source archive",
      "workspace hydrate",
      "provider list",
      "provider create",
    ]);
  });

  it.each([
    "sandbox file read acquisition",
    "sandbox file read iteration",
    "sandbox network policy relock",
  ])("requeues a stalled %s before any Codex boundary", async (operation) => {
    configureFakeControllerAuthority();
    const t = convexTest(schema, modules);
    const suffix = operation.replace(/\s+/g, "-");
    const { jobId, reservation } = await reservedWritableJob(t, `runner-${suffix}-timeout`);
    const bridge = bridgeProductionRunnerToConvex(t);
    const trace: BoundaryTrace[] = [];
    const dependencies = injectedRunnerDependencies({ boundaries: trace });
    (dependencies.prepareCloudWorkspaceExecution as any).mockImplementation(async (input: any) => {
      await input.onStage("provider_list");
      await input.onStage("provider_create");
      await input.onStage("source_upload");
      await input.onStage("dependency_hydration");
      throw new CloudWorkspaceError("vercel", "timeout", `Vercel Sandbox ${operation} exceeded its controller deadline`, "deferred");
    });

    expect(await invokeHarness(reservation, `${suffix}-run`, dependencies))
      .toEqual({ processed: 1 });
    const state = await t.run(async (ctx) => ({
      job: await ctx.db.get(jobId),
      attempts: await Promise.all([1, 2].map((attempt) => ctx.db.query("workAttempts")
        .withIndex("by_job_attempt", (q) => q.eq("jobId", jobId).eq("attempt", attempt))
        .first())),
    }));
    expect(state.job).toMatchObject({ status: "pending", attempt: 2 });
    expect(state.attempts.find((attempt) => attempt?.attempt === 1)).toMatchObject({
      status: "checkpointed",
      workerRunId: `${suffix}-run`,
    });
    expect(state.attempts.find((attempt) => attempt?.attempt === 2)).toMatchObject({ status: "pending" });
    expect(String(state.job?.checkpoint)).toContain(operation);
    expect((dependencies.runCloudWorkspaceAgent as any)).not.toHaveBeenCalled();
    expect((dependencies.prepareSubscriptionEnv as any)).not.toHaveBeenCalled();
    expect(trace.map((item) => item.effect)).toEqual(["source_checkout", "provider_create"]);
    expect(bridge.trace
      .filter((call) => call.path === "jobs:updateProgress")
      .map((call) => call.args.stage)).toEqual([
      "source clone",
      "checkpoint store",
      "source archive",
      "workspace hydrate",
      "provider list",
      "provider create",
      "source upload",
      "dependency hydrate",
    ]);
  });

  it.each([
    {
      phase: "provider_create",
      occurrence: 1,
      effects: ["source_checkout"],
      prepareWorkspace: 0,
      process: 0,
      checkpoint: 0,
      review: 0,
    },
    {
      phase: "codex_start",
      occurrence: 2,
      effects: ["source_checkout", "provider_create", "subscription_acquire"],
      prepareWorkspace: 1,
      process: 0,
      checkpoint: 0,
      review: 0,
    },
    {
      phase: "checkpoint",
      occurrence: 1,
      effects: ["source_checkout", "provider_create", "subscription_acquire", "codex_process"],
      prepareWorkspace: 1,
      process: 1,
      checkpoint: 0,
      review: 0,
    },
    {
      phase: "review_receipt",
      occurrence: 1,
      effects: ["source_checkout", "provider_create", "subscription_acquire", "codex_process", "checkpoint_persist"],
      prepareWorkspace: 1,
      process: 1,
      checkpoint: 1,
      review: 0,
    },
  ])("fences a new work order before the $phase effect", async (fixture) => {
    configureFakeControllerAuthority();
    const t = convexTest(schema, modules);
    const { jobId, reservation } = await reservedWritableJob(t, `runner-stale-${fixture.phase}`);
    let occurrences = 0;
    let steered = false;
    bridgeProductionRunnerToConvex(t, async (call) => {
      if (call.path !== "jobs:authorizeExecutionBoundary" || call.args.phase !== fixture.phase) return;
      occurrences += 1;
      if (occurrences !== fixture.occurrence || steered) return;
      steered = true;
      await t.mutation(api.jobs.control, {
        jobId,
        action: "steer",
        input: `Replace authority immediately before ${fixture.phase}.`,
        workerToken: WORKER,
      });
    });
    const trace: BoundaryTrace[] = [];
    const dependencies = injectedRunnerDependencies({ boundaries: trace });

    expect(await invokeHarness(reservation, `stale-${fixture.phase}-run`, dependencies)).toEqual({ processed: 1 });
    expect(trace.map((item) => item.effect)).toEqual(fixture.effects);
    expect((dependencies.prepareCloudWorkspaceExecution as any)).toHaveBeenCalledTimes(fixture.prepareWorkspace);
    expect((dependencies.runCloudWorkspaceAgent as any)).toHaveBeenCalledTimes(fixture.process);
    expect((dependencies.persistPortableCheckpoint as any)).toHaveBeenCalledTimes(fixture.checkpoint);
    expect((dependencies.buildGitReviewReceipt as any)).toHaveBeenCalledTimes(fixture.review);
    expect((dependencies.providerFetch as any)).not.toHaveBeenCalled();
    const state = await t.run(async (ctx) => ctx.db.get(jobId));
    expect(state).toMatchObject({ status: "pending", attempt: 2, steerRevision: 1 });
  });

  it("does not send a named source file when it contains a controller secret", () => {
    const repo = mkdtempSync("/tmp/jarvis-novita-source-");
    const secret = "outbound-secret-value";
    const previous = process.env.JARVIS_OUTBOUND_SECRET;
    process.env.JARVIS_OUTBOUND_SECRET = secret;
    try {
      mkdirSync(join(repo, "src"));
      writeFileSync(join(repo, "src", "example.ts"), `export const credential = "${secret}";\n`);
      expect(novitaSourceFilesForTask(
        repo,
        "Fix the typo in src/example.ts.",
        12_000,
      )).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.JARVIS_OUTBOUND_SECRET;
      else process.env.JARVIS_OUTBOUND_SECRET = previous;
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
