import { createHash, randomBytes } from "node:crypto";

import type { LanguageModelV2 } from "@ai-sdk/provider";
import { Agent } from "@mastra/core/agent";
import {
  idempotencyKeys,
  schedules,
  task,
  tasks,
} from "@trigger.dev/sdk/v3";
import { z } from "zod";

import {
  MISSION_SUPERVISOR_TICK_TASK_ID,
  missionSupervisorDispatchIdentity,
  parseMissionSupervisorTickPayload,
  type MissionSupervisorDispatchOptions,
  type MissionSupervisorTickPayload,
} from "../lib/mission-supervisor-dispatch";
import {
  SUPERVISOR_PLANNING_CONTEXT_MAX_BYTES,
  runSupervisorPlanningNetwork,
  type SupervisorPlanningTickInput,
  type SupervisorPlanningTickResult,
} from "../mastra/mission-supervisor-network";
import { createCodexSubscriptionLanguageModel } from "../mastra/codex-subscription-model";
import { TEAM_BY_SLUG, type ModelTier } from "../mastra/team";
import { codexModelFor } from "./model-policy";

export {
  MISSION_SUPERVISOR_TICK_TASK_ID,
  missionSupervisorDispatchIdentity,
  parseMissionSupervisorTickPayload,
  type MissionSupervisorDispatchOptions,
  type MissionSupervisorTickPayload,
} from "../lib/mission-supervisor-dispatch";

export const MISSION_SUPERVISOR_SWEEP_TASK_ID = "jarvis-mission-supervisor-sweep";
export const MISSION_SUPERVISOR_MAX_DUE = 8;
export const MISSION_SUPERVISOR_ACTIVE_WAIT_MS = 15 * 60_000;
export const MISSION_SUPERVISOR_RECEIPT_WAIT_MS = 30_000;
export const MISSION_SUPERVISOR_HEARTBEAT_MS = 60_000;
export const MISSION_SUPERVISOR_MODEL_TIMEOUT_MS = 240_000;
export const MISSION_SUPERVISOR_PROMPT_VERSION = "jarvis-mission-supervisor-v1";
export const MISSION_SUPERVISOR_POLICY_MODEL_ID = "jarvis-supervisor-policy-v1";

const MAX_JOBS = 24;
const MAX_SNAPSHOT_BYTES = 96 * 1_024;
const MAX_REQUEST_BYTES = 16 * 1_024;
const MAX_SYNTHESIS_PROMPT_BYTES = 80 * 1_024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const ACTIVE_JOB_STATUSES = new Set([
  "pending",
  "queued",
  "dispatching",
  "running",
  "checkpointed",
  "paused",
  "steering",
  "steered",
  "awaiting_approval",
]);
const ATTENTION_JOB_STATUSES = new Set([
  "error",
  "failed",
  "cancelled",
  "needs_input",
  "stalled",
  "blocked",
]);

type JsonRecord = Record<string, unknown>;
type ConvexKind = "query" | "mutation";
type SupervisorDecisionKind =
  | "delegate"
  | "wait"
  | "request_input"
  | "replan"
  | "synthesize"
  | "fail";
type PolicyMetadata = {
  decisionOrigin: "policy";
  modelProvider: "deterministic-policy";
  modelTier: "luna";
  modelId: typeof MISSION_SUPERVISOR_POLICY_MODEL_ID;
  reasoningEffort: "none";
  tierReason: string;
  supervisorPromptVersion: string;
};
type ModelMetadata = {
  decisionOrigin: "model";
  modelProvider: "codex-subscription";
  modelTier: ModelTier;
  modelId: string;
  reasoningEffort: "low" | "medium" | "high" | "max";
  tierReason: string;
  supervisorPromptVersion: string;
};
type DecisionMetadata = PolicyMetadata | ModelMetadata;

export type MissionSupervisorRunContext = {
  runId: string;
  deploymentVersion?: string;
  signal: AbortSignal;
};

type SupervisorLeaseFence = {
  missionId: string;
  leaseOwner: string;
  leaseToken: string;
  leaseVersion: number;
  expectedEpoch: number;
  expectedDecisionSequence: number;
  expectedInputRevision: number;
};

type SupervisorDecision =
  | {
      kind: "delegate";
      workstreams: Array<{
        task: string;
        label: string;
        repo?: string;
        model: ModelTier;
        agentId: "paul" | "atlas" | "iris" | "maya" | "sentry";
        readonly: boolean;
        approvalRequired: boolean;
        risk: "low" | "medium" | "high" | "consequential";
        acceptanceCriteria: string[];
      }>;
    }
  | { kind: "wait"; delayMs: number; reason: string }
  | { kind: "request_input"; question: string; reason: string }
  | { kind: "replan"; reason: string }
  | { kind: "synthesize"; summary: string }
  | { kind: "fail"; reason: string };

type PreparedDecision = {
  decision: SupervisorDecision;
  rationale: string;
  metadata: DecisionMetadata;
};

type SynthesisOutput = {
  summary: string;
  evidence: string[];
};

type SynthesisInput = {
  missionId: string;
  goal: string;
  acceptanceCriteria: string[];
  jobs: ReceiptReadyJob[];
};

export interface MissionSupervisorTickDependencies {
  convex(
    kind: ConvexKind,
    path: string,
    args: Readonly<JsonRecord>,
  ): Promise<unknown>;
  createLeaseToken(): string;
  createLanguageModel(tier: ModelTier, turnTimeoutMs: number): LanguageModelV2;
  runPlanningNetwork(
    input: SupervisorPlanningTickInput,
    options: {
      modelFor: (tier: ModelTier) => LanguageModelV2;
      abortSignal?: AbortSignal;
    },
  ): Promise<SupervisorPlanningTickResult>;
  runSynthesis(
    input: SynthesisInput,
    options: { model: LanguageModelV2; abortSignal: AbortSignal },
  ): Promise<SynthesisOutput>;
  scheduleHeartbeat(callback: () => void, delayMs: number): unknown;
  cancelHeartbeat(handle: unknown): void;
}

export interface MissionSupervisorSweepDependencies {
  convex(
    kind: ConvexKind,
    path: string,
    args: Readonly<JsonRecord>,
  ): Promise<unknown>;
  dispatchTick(
    payload: MissionSupervisorTickPayload,
    options: MissionSupervisorDispatchOptions,
  ): Promise<{ id: string }>;
}

class SupervisorRuntimeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SupervisorRuntimeError";
    this.code = code;
  }
}

const nonNegativeInteger = z.number().int().nonnegative().safe();
const positiveInteger = z.number().int().positive().safe();
const digest = z.string().regex(DIGEST);
const nullableDigest = digest.nullable();
const boundedString = (maximum: number) => z.string().max(maximum);

const projectAdmissionSchema = z.object({
  protocolVersion: z.literal(2),
  canonicalProjectId: boundedString(120),
  repository: boundedString(120).optional(),
  sourceProvider: z.enum(["github", "none"]),
  sourceBranch: boundedString(240).optional(),
  sourceRef: boundedString(500).optional(),
  sourceHeadSha: boundedString(80).optional(),
  sourceObservedAt: nonNegativeInteger,
  sourceAdmissionDigest: digest,
}).strict();

const requestedWorkstreamSchema = z.object({
  task: boundedString(4_000),
  label: boundedString(80).optional(),
  repo: boundedString(120).optional(),
  model: z.enum(["luna", "terra", "sol"]).optional(),
  agentId: z.enum(["paul", "atlas", "iris", "maya", "sentry"]).optional(),
  readonly: z.boolean().optional(),
  approvalRequired: z.boolean().optional(),
  risk: z.enum(["low", "medium", "high", "consequential"]).optional(),
  acceptanceCriteria: z.array(boundedString(500)).min(1).max(8),
}).strict();

const requestPayloadSchema = z.object({
  protocolVersion: z.literal(1),
  goal: boundedString(500).min(12),
  profile: z.enum(["short_fleet", "durable_goal"]),
  context: boundedString(8_000).optional(),
  repo: boundedString(120).optional(),
  desiredWorkstreams: z.number().int().min(1).max(6),
  requestedWorkstreams: z.array(requestedWorkstreamSchema).max(6),
  acceptanceCriteria: z.array(boundedString(500)).max(8),
  projectAdmissions: z.array(projectAdmissionSchema).min(1).max(16),
  originThreadId: boundedString(120),
  priority: z.number().int().min(0).max(100),
  risk: z.enum(["low", "medium", "high", "consequential"]),
  deadlineMs: positiveInteger,
}).strict().superRefine((request, context) => {
  if (request.requestedWorkstreams.length > request.desiredWorkstreams) {
    context.addIssue({
      code: "custom",
      path: ["requestedWorkstreams"],
      message:
        "Explicit requested workstreams cannot exceed desiredWorkstreams",
    });
  }
});

const workReceiptSchema = z.object({
  jobId: boundedString(160),
  attempt: positiveInteger,
  status: boundedString(40),
  verification: boundedString(40),
  authorityDigest: nullableDigest,
  schedulingBindingDigest: nullableDigest,
  workOrderRevision: nonNegativeInteger.nullable(),
  workOrderRevisionDigest: nullableDigest,
  resultDigest: nullableDigest,
  evidenceDigest: nullableDigest,
  acceptanceEvidence: z.array(boundedString(500)).max(8),
  artifacts: z.array(boundedString(500)).max(8),
  reviewReceiptDigest: nullableDigest,
}).strict();

const snapshotJobSchema = z.object({
  jobId: boundedString(160),
  supervisorEpoch: nonNegativeInteger.nullable(),
  supervisorDecisionKey: boundedString(200).nullable(),
  supervisorJobOrdinal: nonNegativeInteger.nullable(),
  label: boundedString(80).nullable(),
  task: boundedString(600),
  taskDigest: digest,
  repo: boundedString(120).nullable(),
  status: z.enum([
    "pending",
    "queued",
    "dispatching",
    "running",
    "checkpointed",
    "paused",
    "steering",
    "steered",
    "awaiting_approval",
    "needs_input",
    "stalled",
    "blocked",
    "done",
    "error",
    "failed",
    "cancelled",
  ]),
  readonly: z.boolean().nullable(),
  agentId: boundedString(40).nullable(),
  model: boundedString(24).nullable(),
  reasoningEffort: boundedString(24).nullable(),
  risk: boundedString(24).nullable(),
  priority: z.number().min(0).max(100).nullable(),
  approvalRequired: z.boolean().nullable(),
  approvalStatus: boundedString(32).nullable(),
  approvalReason: boundedString(300).nullable(),
  attempt: positiveInteger,
  maxAttempts: positiveInteger,
  steer: boundedString(500).nullable(),
  steerDigest: nullableDigest,
  steerRevision: nonNegativeInteger,
  dependsOn: z.array(boundedString(160)).max(16),
  dependsOnDigest: digest,
  acceptanceCriteria: z.array(boundedString(500)).max(8),
  acceptanceCriteriaDigest: digest,
  authorityDigest: nullableDigest,
  workOrderRevision: nonNegativeInteger.nullable(),
  workOrderRevisionDigest: nullableDigest,
  schedulingBindingDigest: nullableDigest,
  sourceAdmissionDigest: nullableDigest,
  sourceHeadSha: boundedString(80).nullable(),
  integrationState: boundedString(40).nullable(),
  deliveryStatus: boundedString(32).nullable(),
  reviewReceiptDigest: nullableDigest,
  result: boundedString(2_000).nullable(),
  resultDigest: nullableDigest,
  evidenceDigest: nullableDigest,
  verificationVerdict: boundedString(32).nullable(),
  verificationNote: boundedString(500).nullable(),
  evidenceSummary: boundedString(500).nullable(),
  evidenceSummaryDigest: nullableDigest,
  stallReason: boundedString(400).nullable(),
  completedAt: nonNegativeInteger.nullable(),
  receipt: workReceiptSchema.nullable(),
}).strict();

const authoritativeSnapshotSchema = z.object({
  protocolVersion: z.literal(1),
  mission: z.object({
    missionId: boundedString(160),
    goal: boundedString(500).min(12),
    mode: z.literal("supervised"),
    status: z.literal("running"),
    originThreadId: boundedString(120),
    priority: z.number().min(0).max(100),
    risk: z.enum(["low", "medium", "high", "consequential"]),
    acceptanceCriteria: z.array(boundedString(500)).max(8),
    acceptanceCriteriaDigest: digest,
    projectAdmissions: z.array(projectAdmissionSchema).min(1).max(16),
    controlRequested: boundedString(80).nullable(),
    steer: boundedString(2_000).nullable(),
    steerDigest: nullableDigest,
    steerRevision: nonNegativeInteger,
    failureReason: boundedString(600).nullable(),
    failureReasonDigest: nullableDigest,
  }).strict(),
  supervisor: z.object({
    requestDigest: digest,
    requestPayloadJson: boundedString(MAX_REQUEST_BYTES),
    epoch: positiveInteger,
    nextDecisionSequence: positiveInteger,
    inputRevision: nonNegativeInteger,
    handledInputRevision: nonNegativeInteger,
    dirtyJobIds: z.array(boundedString(160)).max(MAX_JOBS),
    totalJobs: nonNegativeInteger,
    maxJobs: positiveInteger.max(MAX_JOBS),
    decisionCount: nonNegativeInteger,
    maxDecisions: positiveInteger,
    deadlineAt: positiveInteger,
    lastDecisionKey: boundedString(240).nullable(),
    lastDecisionDigest: nullableDigest,
  }).strict(),
  jobs: z.array(snapshotJobSchema).max(MAX_JOBS),
}).strict();

type AuthoritativeSnapshot = z.infer<typeof authoritativeSnapshotSchema>;
type SnapshotJob = z.infer<typeof snapshotJobSchema>;
type RequestPayload = z.infer<typeof requestPayloadSchema>;

type ReceiptReadyJob = SnapshotJob & {
  receipt: z.infer<typeof workReceiptSchema>;
};

const dueEntrySchema = z.object({
  missionId: boundedString(160).regex(SAFE_ID),
  state: z.enum(["ready", "waiting", "leased"]),
  epoch: positiveInteger,
  nextDecisionSequence: positiveInteger,
  inputRevision: nonNegativeInteger,
  expectedLeaseVersion: nonNegativeInteger,
  nextTickAt: nonNegativeInteger.optional(),
  leaseUntil: nonNegativeInteger.optional(),
}).strict();

const claimSuccessSchema = z.object({
  claimed: z.literal(true),
  missionId: boundedString(160),
  epoch: positiveInteger,
  nextDecisionSequence: positiveInteger,
  inputRevision: nonNegativeInteger,
  leaseVersion: positiveInteger,
  leaseUntil: positiveInteger,
  snapshot: z.unknown(),
  snapshotDigest: digest,
}).strict();

const claimFailureSchema = z.object({
  claimed: z.literal(false),
  reason: boundedString(120),
  escalated: z.boolean().optional(),
  attentionItemId: boundedString(160).optional(),
}).strict();

const renewSuccessSchema = z.object({
  renewed: z.literal(true),
  leaseVersion: positiveInteger,
  leaseUntil: positiveInteger,
  inputRevision: nonNegativeInteger,
}).strict();

const renewFailureSchema = z.object({
  renewed: z.literal(false),
  reason: boundedString(120),
  stale: z.boolean().optional(),
  released: z.boolean().optional(),
  inputRevision: nonNegativeInteger.optional(),
}).strict();

const releaseResultSchema = z.union([
  z.object({
    released: z.literal(false),
    reason: boundedString(120),
  }).strict(),
  z.object({
    released: z.literal(true),
    stale: z.boolean(),
    escalated: z.boolean(),
    failures: positiveInteger.optional(),
    errorCode: boundedString(80).optional(),
    attentionItemId: boundedString(160).optional(),
    backoffMs: positiveInteger.optional(),
    nextTickAt: positiveInteger.optional(),
    reason: boundedString(120).optional(),
    inputRevision: nonNegativeInteger.optional(),
  }).strict(),
]);

const commitSuccessSchema = z.object({
  committed: z.literal(true),
  replayed: z.boolean(),
  decisionId: boundedString(160),
  decisionKey: boundedString(240),
  kind: z.enum([
    "delegate",
    "wait",
    "request_input",
    "replan",
    "synthesize",
    "fail",
  ]),
  resultState: boundedString(80),
  nextTickAt: positiveInteger.optional(),
  createdJobIds: z.array(boundedString(160)).max(6),
  attentionItemId: boundedString(160).optional(),
  chatMessageIds: z.array(boundedString(160)).max(4),
}).strict();

const commitFailureSchema = z.object({
  committed: z.literal(false),
  replayed: z.literal(false),
  reason: boundedString(120),
  jobId: boundedString(160).optional(),
}).strict();

const planningWorkstreamSchema = z.object({
  task: boundedString(4_000).min(12),
  label: boundedString(80).min(3),
  repo: boundedString(120).nullable(),
  model: z.enum(["luna", "terra", "sol"]),
  agentId: z.enum(["paul", "atlas", "iris", "maya", "sentry"]),
  readonly: z.boolean(),
  approvalRequired: z.boolean(),
  risk: z.enum(["low", "medium", "high", "consequential"]),
  acceptanceCriteria: z.array(boundedString(1_000)).min(1).max(8),
}).strict();

const planningResultSchema = z.object({
  kind: z.enum(["ready_to_commit", "no_proposals"]),
  tickId: boundedString(160),
  missionId: boundedString(160),
  proposals: z.array(planningWorkstreamSchema).max(6),
  iterations: positiveInteger.max(6),
  selectedAgents: z.array(
    z.enum(["paul", "atlas", "iris", "maya", "sentry"]),
  ).max(5),
  terminalReason: z.enum([
    "desired_proposals_reached",
    "primitive_cap_reached",
  ]),
  networkStatus: z.literal("success"),
}).strict();

const synthesisOutputSchema = z.object({
  summary: boundedString(4_000).min(12),
  evidence: z.array(boundedString(500).min(1)).min(1).max(MAX_JOBS),
}).strict();

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function safeBoundedText(
  value: string,
  maximumBytes: number,
  fallback: string,
): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) return fallback;
  if (utf8Bytes(normalized) <= maximumBytes) return normalized;
  let result = "";
  for (const character of normalized) {
    if (utf8Bytes(result + character) > maximumBytes) break;
    result += character;
  }
  return result || fallback;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new SupervisorRuntimeError(
        "invalid_snapshot",
        "Snapshot contains a non-finite number",
      );
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as JsonRecord;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new SupervisorRuntimeError(
    "invalid_snapshot",
    "Snapshot contains an unsupported value",
  );
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalSupervisorDigest(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

function parseWithCode<T>(
  schema: z.ZodType<T>,
  value: unknown,
  code: string,
  message: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new SupervisorRuntimeError(code, message);
  return parsed.data;
}

function parseRequestPayload(snapshot: AuthoritativeSnapshot): RequestPayload {
  const json = snapshot.supervisor.requestPayloadJson;
  if (
    utf8Bytes(json) > MAX_REQUEST_BYTES ||
    sha256Hex(json) !== snapshot.supervisor.requestDigest
  ) {
    throw new SupervisorRuntimeError(
      "invalid_snapshot",
      "Supervisor request digest does not match",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new SupervisorRuntimeError(
      "invalid_snapshot",
      "Supervisor request payload is not valid JSON",
    );
  }
  const request = parseWithCode(
    requestPayloadSchema,
    value,
    "invalid_snapshot",
    "Supervisor request payload is invalid",
  );
  if (
    request.goal !== snapshot.mission.goal ||
    request.originThreadId !== snapshot.mission.originThreadId ||
    request.priority !== snapshot.mission.priority ||
    request.risk !== snapshot.mission.risk ||
    canonicalJson(request.acceptanceCriteria) !==
      canonicalJson(snapshot.mission.acceptanceCriteria) ||
    canonicalJson(request.projectAdmissions) !==
      canonicalJson(snapshot.mission.projectAdmissions)
  ) {
    throw new SupervisorRuntimeError(
      "invalid_snapshot",
      "Supervisor request does not bind the mission",
    );
  }
  if (
    snapshot.mission.acceptanceCriteriaDigest !==
      canonicalSupervisorDigest(snapshot.mission.acceptanceCriteria) ||
    snapshot.jobs.some(
      (job) =>
        job.acceptanceCriteriaDigest !==
          canonicalSupervisorDigest(job.acceptanceCriteria) ||
        job.dependsOnDigest !== canonicalSupervisorDigest(job.dependsOn),
    )
  ) {
    throw new SupervisorRuntimeError(
      "invalid_snapshot",
      "Supervisor snapshot contains an inconsistent bounded digest",
    );
  }
  return request;
}

function parseAuthoritativeSnapshot(
  claim: z.infer<typeof claimSuccessSchema>,
  payload: MissionSupervisorTickPayload,
): { snapshot: AuthoritativeSnapshot; request: RequestPayload } {
  const encoded = canonicalJson(claim.snapshot);
  if (
    utf8Bytes(encoded) > MAX_SNAPSHOT_BYTES ||
    sha256Hex(encoded) !== claim.snapshotDigest
  ) {
    throw new SupervisorRuntimeError(
      "invalid_snapshot",
      "Authoritative snapshot digest does not match",
    );
  }
  const snapshot = parseWithCode(
    authoritativeSnapshotSchema,
    claim.snapshot,
    "invalid_snapshot",
    "Authoritative snapshot is invalid",
  );
  if (
    snapshot.mission.missionId !== payload.missionId ||
    claim.missionId !== payload.missionId ||
    snapshot.supervisor.epoch !== claim.epoch ||
    snapshot.supervisor.nextDecisionSequence !== claim.nextDecisionSequence ||
    snapshot.supervisor.inputRevision !== claim.inputRevision ||
    claim.epoch !== payload.expectedEpoch ||
    claim.nextDecisionSequence !== payload.expectedDecisionSequence ||
    claim.inputRevision !== payload.expectedInputRevision ||
    snapshot.supervisor.totalJobs !== snapshot.jobs.length
  ) {
    throw new SupervisorRuntimeError(
      "invalid_snapshot",
      "Authoritative snapshot fences do not match",
    );
  }
  return { snapshot, request: parseRequestPayload(snapshot) };
}

export function missionSupervisorLeaseOwner(runId: string): string {
  const run = runId.trim();
  if (!run || run.length > 500) {
    throw new SupervisorRuntimeError(
      "invalid_run_context",
      "Trigger run identity is invalid",
    );
  }
  const readable = run.replace(/[^A-Za-z0-9._/-]/g, "-").slice(0, 120);
  return `trigger:${readable}:${sha256Hex(run).slice(0, 16)}`;
}

function freshLeaseToken(): string {
  return randomBytes(32).toString("base64url");
}

function policyMetadata(reason: string): PolicyMetadata {
  return {
    decisionOrigin: "policy",
    modelProvider: "deterministic-policy",
    modelTier: "luna",
    modelId: MISSION_SUPERVISOR_POLICY_MODEL_ID,
    reasoningEffort: "none",
    tierReason: safeBoundedText(reason, 500, "Deterministic supervisor policy"),
    supervisorPromptVersion: MISSION_SUPERVISOR_PROMPT_VERSION,
  };
}

function modelMetadata(reason: string, promptVersion: string): ModelMetadata {
  const selection = codexModelFor("sol");
  return {
    decisionOrigin: "model",
    modelProvider: "codex-subscription",
    modelTier: "sol",
    modelId: selection.model,
    reasoningEffort: selection.effort,
    tierReason: safeBoundedText(reason, 500, "Subscription supervisor decision"),
    supervisorPromptVersion: promptVersion,
  };
}

function exactFence(
  payload: MissionSupervisorTickPayload,
  claim: z.infer<typeof claimSuccessSchema>,
  leaseOwner: string,
  leaseToken: string,
): SupervisorLeaseFence {
  return {
    missionId: payload.missionId,
    leaseOwner,
    leaseToken,
    leaseVersion: claim.leaseVersion,
    expectedEpoch: claim.epoch,
    expectedDecisionSequence: claim.nextDecisionSequence,
    expectedInputRevision: claim.inputRevision,
  };
}

function receiptReady(job: SnapshotJob): job is ReceiptReadyJob {
  const receipt = job.receipt;
  if (
    job.status !== "done" ||
    job.verificationVerdict !== "pass" ||
    !job.result ||
    !job.completedAt ||
    !job.authorityDigest ||
    !job.schedulingBindingDigest ||
    job.workOrderRevision === null ||
    !job.workOrderRevisionDigest ||
    !job.resultDigest ||
    !job.evidenceDigest ||
    !receipt
  ) {
    return false;
  }
  return receipt.jobId === job.jobId
    && receipt.attempt === job.attempt
    && receipt.status === "succeeded"
    && receipt.verification === "pass"
    && receipt.authorityDigest === job.authorityDigest
    && receipt.schedulingBindingDigest === job.schedulingBindingDigest
    && receipt.workOrderRevision === job.workOrderRevision
    && receipt.workOrderRevisionDigest === job.workOrderRevisionDigest
    && receipt.resultDigest === job.resultDigest
    && receipt.evidenceDigest === job.evidenceDigest
    && receipt.acceptanceEvidence.length > 0
    && receipt.artifacts.length > 0
    && (job.repo === null
      ? receipt.reviewReceiptDigest === job.reviewReceiptDigest
      : Boolean(
          job.reviewReceiptDigest
          && receipt.reviewReceiptDigest === job.reviewReceiptDigest
        ));
}

function allowedSynthesisEvidence(jobs: readonly ReceiptReadyJob[]): Set<string> {
  return new Set(
    jobs.flatMap((job) => [
      ...job.receipt.acceptanceEvidence,
      ...job.receipt.artifacts,
    ]),
  );
}

export async function runJarvisReceiptSynthesis(
  input: SynthesisInput,
  options: { model: LanguageModelV2; abortSignal: AbortSignal },
): Promise<SynthesisOutput> {
  const evidence = allowedSynthesisEvidence(input.jobs);
  if (evidence.size === 0) {
    throw new SupervisorRuntimeError(
      "receipt_not_ready",
      "No receipt-bound synthesis evidence is available",
    );
  }
  const promptPayload = {
    protocolVersion: 1,
    missionId: input.missionId,
    goal: input.goal,
    acceptanceCriteria: input.acceptanceCriteria,
    jobs: input.jobs.map((job) => ({
      jobId: job.jobId,
      label: job.label,
      task: job.task,
      result: job.result,
      verificationNote: job.verificationNote,
      receipt: job.receipt,
    })),
  };
  const promptJson = canonicalJson(promptPayload);
  if (utf8Bytes(promptJson) > MAX_SYNTHESIS_PROMPT_BYTES) {
    throw new SupervisorRuntimeError(
      "synthesis_input_too_large",
      "Receipt-bound synthesis input is too large",
    );
  }
  const jarvis = new Agent({
    id: "jarvis-mission-supervisor-synthesis",
    name: TEAM_BY_SLUG.jarvis.name,
    description: TEAM_BY_SLUG.jarvis.description,
    instructions: `${TEAM_BY_SLUG.jarvis.instructions}

Synthesize only the supplied immutable successful work receipts. You have no tools.
Return a concise factual summary and select evidence strings verbatim from receipt acceptanceEvidence or artifacts.
Do not claim work, delivery, or verification that is absent from those receipts.`,
    model: options.model,
  });
  const generated = await jarvis.generate(promptJson, {
    abortSignal: options.abortSignal,
    structuredOutput: { schema: synthesisOutputSchema },
  });
  if (generated.error) throw generated.error;
  const output = parseWithCode(
    synthesisOutputSchema,
    generated.object,
    "synthesis_invalid",
    "Jarvis synthesis output is invalid",
  );
  if (
    utf8Bytes(output.summary) > 4_000 ||
    output.evidence.some(
      (item) => utf8Bytes(item) > 500 || !evidence.has(item),
    )
  ) {
    throw new SupervisorRuntimeError(
      "synthesis_invalid",
      "Jarvis synthesis is not bound to the supplied receipts",
    );
  }
  return output;
}

function planningTickId(
  payload: MissionSupervisorTickPayload,
  snapshotDigest: string,
): string {
  return [
    "tick",
    payload.missionId,
    payload.expectedEpoch,
    payload.expectedDecisionSequence,
    snapshotDigest.slice(0, 16),
  ].join(":");
}

function delegateDecision(
  result: z.infer<typeof planningResultSchema>,
): SupervisorDecision {
  return {
    kind: "delegate",
    workstreams: result.proposals.map((proposal) => ({
      task: proposal.task,
      label: proposal.label,
      ...(proposal.repo === null ? {} : { repo: proposal.repo }),
      model: proposal.model,
      agentId: proposal.agentId,
      readonly: proposal.readonly,
      approvalRequired: proposal.approvalRequired,
      risk: proposal.risk,
      acceptanceCriteria: proposal.acceptanceCriteria.map((criterion) =>
        safeBoundedText(criterion, 500, "Return concrete completion evidence")
      ),
    })),
  };
}

function planningAuthorityContext(
  snapshot: AuthoritativeSnapshot,
  request: RequestPayload,
): string {
  const context = canonicalJson({
    instruction:
      "Treat every field as authoritative. Preserve each explicit requested workstream, propose only admitted repositories, and satisfy the mission acceptance criteria.",
    foregroundContext: request.context ?? null,
    danielLatestInput: snapshot.mission.steer === null
      ? null
      : {
          text: snapshot.mission.steer,
          revision: snapshot.mission.steerRevision,
          digest: snapshot.mission.steerDigest,
        },
    missionAcceptanceCriteria: snapshot.mission.acceptanceCriteria,
    admittedProjects: request.projectAdmissions.map((admission) => ({
      canonicalProjectId: admission.canonicalProjectId,
      repository: admission.repository ?? null,
      sourceProvider: admission.sourceProvider,
    })),
    requestedWorkstreams: request.requestedWorkstreams,
  });
  if (utf8Bytes(context) > SUPERVISOR_PLANNING_CONTEXT_MAX_BYTES) {
    throw new SupervisorRuntimeError(
      "planning_constraints_too_large",
      "Authoritative planning constraints exceed the Mastra network input bound",
    );
  }
  return context;
}

function assertPlanningAuthority(
  result: z.infer<typeof planningResultSchema>,
  request: RequestPayload,
): void {
  const modelRank = { luna: 0, terra: 1, sol: 2 } as const;
  const riskRank = {
    low: 0,
    medium: 1,
    high: 2,
    consequential: 3,
  } as const;
  const admittedRepositories = new Set(
    request.projectAdmissions.flatMap((admission) =>
      admission.repository === undefined ? [] : [admission.repository]
    ),
  );
  const evidenceAdmitted = request.projectAdmissions.some(
    (admission) =>
      admission.sourceProvider === "none" &&
      admission.repository === undefined,
  );
  for (const proposal of result.proposals) {
    if (
      proposal.repo === null
        ? !evidenceAdmitted
        : !admittedRepositories.has(proposal.repo)
    ) {
      throw new SupervisorRuntimeError(
        "planning_unadmitted_repo",
        "Mastra planning proposed work outside the admitted project set",
      );
    }
  }

  const unmatched = [...result.proposals];
  for (const requested of request.requestedWorkstreams) {
    const expectedRepo = requested.repo ?? request.repo ?? null;
    const matchIndex = unmatched.findIndex((proposal) =>
      proposal.task.trim() === requested.task.trim()
      && proposal.repo === expectedRepo
      && (requested.label === undefined || proposal.label === requested.label)
      && (requested.model === undefined
        || modelRank[proposal.model] >= modelRank[requested.model])
      && (requested.agentId === undefined || proposal.agentId === requested.agentId)
      && (requested.readonly !== true || proposal.readonly === true)
      && (requested.approvalRequired === undefined
        || requested.approvalRequired === false
        || proposal.approvalRequired === true)
      && (requested.risk === undefined
        || riskRank[proposal.risk] >= riskRank[requested.risk])
      && requested.acceptanceCriteria.every((criterion) =>
        proposal.acceptanceCriteria.includes(criterion)
      )
    );
    if (matchIndex < 0) {
      throw new SupervisorRuntimeError(
        "planning_replaced_requested_work",
        "Mastra planning did not preserve an explicit requested workstream",
      );
    }
    unmatched.splice(matchIndex, 1);
  }
}

async function planEmptyMission(
  payload: MissionSupervisorTickPayload,
  snapshotDigest: string,
  snapshot: AuthoritativeSnapshot,
  request: RequestPayload,
  signal: AbortSignal,
  dependencies: MissionSupervisorTickDependencies,
): Promise<PreparedDecision> {
  const tickId = planningTickId(payload, snapshotDigest);
  const raw = await dependencies.runPlanningNetwork(
    {
      tickId,
      missionId: payload.missionId,
      goal: snapshot.mission.goal,
      profile: request.profile,
      context: planningAuthorityContext(snapshot, request),
      ...(request.repo === undefined ? {} : { repo: request.repo }),
      desiredWorkstreams: request.desiredWorkstreams,
      maxPrimitives: 6,
    },
    {
      modelFor: (tier) =>
        dependencies.createLanguageModel(
          tier,
          MISSION_SUPERVISOR_MODEL_TIMEOUT_MS,
        ),
      abortSignal: signal,
    },
  );
  const result = parseWithCode(
    planningResultSchema,
    raw,
    "planning_invalid",
    "Mastra planning result is invalid",
  );
  if (result.tickId !== tickId || result.missionId !== payload.missionId) {
    throw new SupervisorRuntimeError(
      "planning_invalid",
      "Mastra planning result is not bound to this tick",
    );
  }
  if (
    (result.kind === "ready_to_commit" && result.proposals.length === 0) ||
    (result.kind === "no_proposals" && result.proposals.length > 0) ||
    result.proposals.length > request.desiredWorkstreams
  ) {
    throw new SupervisorRuntimeError(
      "planning_invalid",
      "Mastra planning result kind does not match its proposals",
    );
  }
  if (
    result.kind === "no_proposals" &&
    request.requestedWorkstreams.length > 0
  ) {
    throw new SupervisorRuntimeError(
      "planning_replaced_requested_work",
      "Mastra planning did not preserve explicit requested workstreams",
    );
  }
  const metadata = modelMetadata(
    `Mastra Jarvis network completed ${result.iterations} bounded primitive(s): ${result.terminalReason}`,
    "mastra-supervisor-network-v1",
  );
  if (
    result.kind === "ready_to_commit" &&
    result.proposals.length < request.desiredWorkstreams
  ) {
    return {
      decision: {
        kind: "request_input",
        question:
          `I could derive only ${result.proposals.length} of ${request.desiredWorkstreams} independent workstreams without inventing scope. Which additional outcome or boundary should I prioritise?`,
        reason:
          "The bounded Mastra planning network returned a partial fleet, which cannot be committed because this runtime does not append missing workstreams after delegation.",
      },
      rationale:
        `The bounded Mastra network returned ${result.proposals.length} of ${request.desiredWorkstreams} required independent workstreams, so no undersized fleet was committed.`,
      metadata,
    };
  }
  if (result.kind === "ready_to_commit" && result.proposals.length > 0) {
    assertPlanningAuthority(result, request);
    return {
      decision: delegateDecision(result),
      rationale: safeBoundedText(
        `The bounded Mastra network selected ${result.proposals.length} independent workstream(s) through ${result.selectedAgents.join(", ")}.`,
        1_000,
        "The bounded Mastra network selected independent workstreams.",
      ),
      metadata,
    };
  }
  return {
    decision: {
      kind: "request_input",
      question:
        "I could not derive a safe independent workstream from the current mission context. What outcome or boundary should I prioritise?",
      reason: "The bounded Mastra planning network returned no proposals.",
    },
    rationale:
      "The genuine bounded Mastra planning network reached its terminal condition without an admissible proposal.",
    metadata,
  };
}

function attentionDecision(jobs: readonly SnapshotJob[]): PreparedDecision | null {
  const attention = jobs.find((job) => ATTENTION_JOB_STATUSES.has(job.status));
  if (!attention) return null;
  const reason = safeBoundedText(
    `${attention.label ?? attention.task} is ${attention.status}${attention.stallReason ? `: ${attention.stallReason}` : ""}.`,
    1_000,
    "A terminal workstream needs Daniel's input.",
  );
  return {
    decision: {
      kind: "request_input",
      question: safeBoundedText(
        `The workstream "${attention.label ?? attention.task.slice(0, 80)}" ended in ${attention.status}. Should I retry with a revised approach, narrow the scope, or stop it?`,
        2_000,
        "A terminal workstream needs a retry, narrower scope, or stop decision.",
      ),
      reason,
    },
    rationale: reason,
    metadata: policyMetadata(
      "Deterministic terminal-status policy; no model was invoked",
    ),
  };
}

function activeDecision(jobs: readonly SnapshotJob[]): PreparedDecision | null {
  const active = jobs.filter((job) => ACTIVE_JOB_STATUSES.has(job.status));
  if (active.length === 0) return null;
  const reason = `${active.length} workstream(s) remain active; job transitions mark the mission due immediately for sweep dispatch, and this is only the 15-minute dead-man fallback.`;
  return {
    decision: {
      kind: "wait",
      delayMs: MISSION_SUPERVISOR_ACTIVE_WAIT_MS,
      reason,
    },
    rationale: reason,
    metadata: policyMetadata(
      "Deterministic active-work dead-man policy; no model was invoked",
    ),
  };
}

function receiptWaitDecision(jobs: readonly SnapshotJob[]): PreparedDecision {
  const unready = jobs.filter((job) => !receiptReady(job));
  const reason = `${unready.length} completed workstream receipt(s) are not yet fully bound to their exact authority and evidence digests.`;
  return {
    decision: {
      kind: "wait",
      delayMs: MISSION_SUPERVISOR_RECEIPT_WAIT_MS,
      reason,
    },
    rationale: reason,
    metadata: policyMetadata(
      "Deterministic receipt-readiness policy; no model was invoked",
    ),
  };
}

async function synthesisDecision(
  snapshot: AuthoritativeSnapshot,
  jobs: ReceiptReadyJob[],
  signal: AbortSignal,
  dependencies: MissionSupervisorTickDependencies,
): Promise<PreparedDecision> {
  const model = dependencies.createLanguageModel(
    "sol",
    MISSION_SUPERVISOR_MODEL_TIMEOUT_MS,
  );
  const output = await dependencies.runSynthesis(
    {
      missionId: snapshot.mission.missionId,
      goal: snapshot.mission.goal,
      acceptanceCriteria: snapshot.mission.acceptanceCriteria,
      jobs,
    },
    { model, abortSignal: signal },
  );
  const parsed = parseWithCode(
    synthesisOutputSchema,
    output,
    "synthesis_invalid",
    "Jarvis synthesis output is invalid",
  );
  const allowedEvidence = allowedSynthesisEvidence(jobs);
  if (
    utf8Bytes(parsed.summary) > 4_000 ||
    parsed.evidence.some(
      (item) => utf8Bytes(item) > 500 || !allowedEvidence.has(item),
    )
  ) {
    throw new SupervisorRuntimeError(
      "synthesis_invalid",
      "Jarvis synthesis is not receipt-bound",
    );
  }
  return {
    decision: { kind: "synthesize", summary: parsed.summary },
    rationale: safeBoundedText(
      `Jarvis synthesized ${jobs.length} exact succeeded/pass work receipt(s); Convex independently validates and derives persisted evidence.`,
      1_000,
      "Jarvis synthesized exact succeeded/pass work receipts.",
    ),
    metadata: modelMetadata(
      "Sol synthesized the complete receipt-bound mission result",
      "jarvis-receipt-synthesis-v1",
    ),
  };
}

async function decide(
  payload: MissionSupervisorTickPayload,
  snapshotDigest: string,
  snapshot: AuthoritativeSnapshot,
  request: RequestPayload,
  signal: AbortSignal,
  dependencies: MissionSupervisorTickDependencies,
): Promise<PreparedDecision> {
  if (snapshot.jobs.length === 0) {
    return await planEmptyMission(
      payload,
      snapshotDigest,
      snapshot,
      request,
      signal,
      dependencies,
    );
  }
  const attention = attentionDecision(snapshot.jobs);
  if (attention) return attention;
  const active = activeDecision(snapshot.jobs);
  if (active) return active;
  if (!snapshot.jobs.every((job) => job.status === "done")) {
    throw new SupervisorRuntimeError(
      "unknown_job_state",
      "Mission contains an unsupported job state",
    );
  }
  if (!snapshot.jobs.every(receiptReady)) {
    return receiptWaitDecision(snapshot.jobs);
  }
  return await synthesisDecision(
    snapshot,
    snapshot.jobs,
    signal,
    dependencies,
  );
}

type LeaseHeartbeat = {
  signal: AbortSignal;
  stop(): Promise<void>;
  assertLive(): void;
};

async function beginLeaseHeartbeat(
  fence: SupervisorLeaseFence,
  externalSignal: AbortSignal,
  dependencies: MissionSupervisorTickDependencies,
): Promise<LeaseHeartbeat> {
  const lost = new AbortController();
  const signal = AbortSignal.any([externalSignal, lost.signal]);
  let heartbeatError: SupervisorRuntimeError | undefined;
  let stopped = false;
  let chain = Promise.resolve();

  const markLost = (error: unknown): void => {
    if (heartbeatError) return;
    heartbeatError = error instanceof SupervisorRuntimeError
      ? error
      : new SupervisorRuntimeError(
          "lease_lost",
          "Mission supervisor lease renewal failed",
        );
    lost.abort(heartbeatError);
  };

  const renew = async (): Promise<void> => {
    if (stopped || heartbeatError) return;
    let raw: unknown;
    try {
      raw = await dependencies.convex(
        "mutation",
        "missionSupervisor:renewV1",
        fence,
      );
    } catch (error) {
      markLost(error);
      return;
    }
    const result = parseWithCode(
      z.union([renewSuccessSchema, renewFailureSchema]),
      raw,
      "lease_lost",
      "Mission supervisor renewal response is invalid",
    );
    if (
      !result.renewed ||
      result.leaseVersion !== fence.leaseVersion ||
      result.inputRevision !== fence.expectedInputRevision
    ) {
      markLost(
        new SupervisorRuntimeError(
          "lease_lost",
          `Mission supervisor lease was lost: ${result.renewed ? "fence_changed" : result.reason}`,
        ),
      );
    }
  };

  await renew();
  if (heartbeatError) throw heartbeatError;
  const handle = dependencies.scheduleHeartbeat(() => {
    chain = chain.then(renew).catch(markLost);
  }, MISSION_SUPERVISOR_HEARTBEAT_MS);

  return {
    signal,
    async stop() {
      if (!stopped) {
        stopped = true;
        dependencies.cancelHeartbeat(handle);
      }
      await chain;
      if (heartbeatError) throw heartbeatError;
      if (externalSignal.aborted) {
        throw new SupervisorRuntimeError(
          "task_cancelled",
          "Trigger cancelled the mission supervisor tick",
        );
      }
    },
    assertLive() {
      if (heartbeatError) throw heartbeatError;
      if (externalSignal.aborted) {
        throw new SupervisorRuntimeError(
          "task_cancelled",
          "Trigger cancelled the mission supervisor tick",
        );
      }
    },
  };
}

function errorCode(error: unknown): string {
  if (error instanceof SupervisorRuntimeError) return error.code;
  if (error instanceof Error && error.name === "AbortError") {
    return "task_cancelled";
  }
  return "bounded_worker_failure";
}

function assertRunContext(
  context: MissionSupervisorRunContext,
): MissionSupervisorRunContext {
  missionSupervisorLeaseOwner(context.runId);
  if (!(context.signal instanceof AbortSignal)) {
    throw new SupervisorRuntimeError(
      "invalid_run_context",
      "Trigger cancellation signal is missing",
    );
  }
  if (
    context.deploymentVersion !== undefined &&
    (typeof context.deploymentVersion !== "string" ||
      context.deploymentVersion.length > 160)
  ) {
    throw new SupervisorRuntimeError(
      "invalid_run_context",
      "Trigger deployment version is invalid",
    );
  }
  return context;
}

function commitArguments(
  fence: SupervisorLeaseFence,
  snapshotDigest: string,
  prepared: PreparedDecision,
  context: MissionSupervisorRunContext,
): JsonRecord {
  return {
    ...fence,
    expectedSnapshotDigest: snapshotDigest,
    decision: prepared.decision,
    rationale: safeBoundedText(
      prepared.rationale,
      1_000,
      "Bounded supervisor decision",
    ),
    ...prepared.metadata,
    triggerRunId: context.runId.slice(0, 160),
    ...(context.deploymentVersion === undefined
      ? {}
      : { deploymentVersion: context.deploymentVersion }),
  };
}

export async function runMissionSupervisorTick(
  rawPayload: unknown,
  rawContext: MissionSupervisorRunContext,
  dependencies: MissionSupervisorTickDependencies,
): Promise<
  | {
      status: "not_claimed";
      missionId: string;
      reason: string;
    }
  | {
      status: "committed";
      missionId: string;
      kind: SupervisorDecisionKind;
      replayed: boolean;
      decisionId: string;
      decisionKey: string;
      resultState: string;
      createdJobIds: string[];
    }
  | {
      status: "released" | "stale";
      missionId: string;
      errorCode: string;
      released: boolean;
      releaseReason?: string;
    }
> {
  const payload = parseMissionSupervisorTickPayload(rawPayload);
  const context = assertRunContext(rawContext);
  const leaseOwner = missionSupervisorLeaseOwner(context.runId);
  const leaseToken = dependencies.createLeaseToken();
  if (!/^[A-Za-z0-9_-]{32,120}$/.test(leaseToken)) {
    throw new SupervisorRuntimeError(
      "invalid_lease_token",
      "Cryptographic lease token is invalid",
    );
  }

  const claim = parseWithCode(
    z.union([claimSuccessSchema, claimFailureSchema]),
    await dependencies.convex(
      "mutation",
      "missionSupervisor:claimV1",
      {
        missionId: payload.missionId,
        leaseOwner,
        leaseToken,
        expectedLeaseVersion: payload.expectedLeaseVersion,
      },
    ),
    "claim_invalid",
    "Mission supervisor claim response is invalid",
  );
  if (!claim.claimed) {
    return {
      status: "not_claimed",
      missionId: payload.missionId,
      reason: claim.reason,
    };
  }

  const fence = exactFence(payload, claim, leaseOwner, leaseToken);
  let heartbeat: LeaseHeartbeat | undefined;
  let heartbeatStopped = false;
  try {
    const { snapshot, request } = parseAuthoritativeSnapshot(claim, payload);
    heartbeat = await beginLeaseHeartbeat(
      fence,
      context.signal,
      dependencies,
    );
    const prepared = await decide(
      payload,
      claim.snapshotDigest,
      snapshot,
      request,
      heartbeat.signal,
      dependencies,
    );
    await heartbeat.stop();
    heartbeatStopped = true;
    heartbeat.assertLive();
    const committed = parseWithCode(
      z.union([commitSuccessSchema, commitFailureSchema]),
      await dependencies.convex(
        "mutation",
        "missionSupervisor:commitV1",
        commitArguments(fence, claim.snapshotDigest, prepared, context),
      ),
      "commit_invalid",
      "Mission supervisor commit response is invalid",
    );
    if (!committed.committed) {
      throw new SupervisorRuntimeError(
        "commit_rejected",
        `Mission supervisor commit was rejected: ${committed.reason}`,
      );
    }
    if (committed.kind !== prepared.decision.kind) {
      throw new SupervisorRuntimeError(
        "commit_invalid",
        "Mission supervisor commit kind does not match",
      );
    }
    return {
      status: "committed",
      missionId: payload.missionId,
      kind: committed.kind,
      replayed: committed.replayed,
      decisionId: committed.decisionId,
      decisionKey: committed.decisionKey,
      resultState: committed.resultState,
      createdJobIds: committed.createdJobIds,
    };
  } catch (error) {
    if (heartbeat && !heartbeatStopped) {
      try {
        await heartbeat.stop();
      } catch (heartbeatFailure) {
        error = heartbeatFailure;
      }
    }
    const boundedCode = errorCode(error);
    let released: z.infer<typeof releaseResultSchema>;
    try {
      released = parseWithCode(
        releaseResultSchema,
        await dependencies.convex(
          "mutation",
          "missionSupervisor:releaseFailureV1",
          { ...fence, errorCode: boundedCode },
        ),
        "release_invalid",
        "Mission supervisor release response is invalid",
      );
    } catch (releaseError) {
      throw new SupervisorRuntimeError(
        "release_failed",
        `Mission supervisor failure release could not be recorded (${errorCode(releaseError)})`,
      );
    }
    return {
      status: released.released ? "released" : "stale",
      missionId: payload.missionId,
      errorCode: boundedCode,
      released: released.released,
      ...("reason" in released && released.reason
        ? { releaseReason: released.reason }
        : {}),
    };
  }
}

export async function runMissionSupervisorSweep(
  dependencies: MissionSupervisorSweepDependencies,
): Promise<{
  due: number;
  dispatched: number;
  failed: number;
  launches: Array<{
    missionId: string;
    dispatched: boolean;
    runId?: string;
  }>;
}> {
  const due = parseWithCode(
    z.array(dueEntrySchema).max(MISSION_SUPERVISOR_MAX_DUE),
    await dependencies.convex(
      "query",
      "missionSupervisor:dueV1",
      { limit: MISSION_SUPERVISOR_MAX_DUE },
    ),
    "due_invalid",
    "Mission supervisor due response is invalid",
  );
  const launches = await Promise.all(
    due.map(async (entry) => {
      const payload: MissionSupervisorTickPayload = {
        protocolVersion: 1,
        missionId: entry.missionId,
        expectedLeaseVersion: entry.expectedLeaseVersion,
        expectedEpoch: entry.epoch,
        expectedDecisionSequence: entry.nextDecisionSequence,
        expectedInputRevision: entry.inputRevision,
      };
      try {
        const handle = await dependencies.dispatchTick(
          payload,
          missionSupervisorDispatchIdentity(payload),
        );
        return {
          missionId: entry.missionId,
          dispatched: true,
          runId: handle.id,
        };
      } catch {
        return { missionId: entry.missionId, dispatched: false };
      }
    }),
  );
  return {
    due: due.length,
    dispatched: launches.filter((launch) => launch.dispatched).length,
    failed: launches.filter((launch) => !launch.dispatched).length,
    launches,
  };
}

type SupervisorConvexClientOptions = {
  url?: string;
  workerToken?: string;
  fetcher?: typeof fetch;
};

export function createSupervisorConvexClient(
  options: SupervisorConvexClientOptions = {},
): MissionSupervisorTickDependencies["convex"] {
  const configuredUrl =
    options.url ??
    process.env.CONVEX_URL ??
    process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!configuredUrl) {
    throw new SupervisorRuntimeError(
      "convex_url_missing",
      "CONVEX_URL is not configured",
    );
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(configuredUrl);
  } catch {
    throw new SupervisorRuntimeError(
      "convex_url_invalid",
      "CONVEX_URL is invalid",
    );
  }
  if (
    parsedUrl.protocol !== "https:" ||
    parsedUrl.username ||
    parsedUrl.password ||
    (parsedUrl.pathname !== "" && parsedUrl.pathname !== "/") ||
    parsedUrl.search ||
    parsedUrl.hash
  ) {
    throw new SupervisorRuntimeError(
      "convex_url_invalid",
      "CONVEX_URL must be a credential-free HTTPS origin",
    );
  }
  const url = parsedUrl.origin;
  const workerToken = options.workerToken ?? process.env.JARVIS_WORKER_TOKEN;
  const fetcher = options.fetcher ?? fetch;
  if (!workerToken) {
    throw new SupervisorRuntimeError(
      "worker_capability_missing",
      "JARVIS_WORKER_TOKEN is not configured",
    );
  }
  return async (kind, path, args) => {
    let response: Response;
    try {
      response = await fetcher(`${url}/api/${kind}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path,
          args: { ...args, workerToken },
          format: "json",
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new SupervisorRuntimeError(
        "convex_http_failure",
        `Convex ${kind} ${path} failed`,
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new SupervisorRuntimeError(
        "convex_http_failure",
        `Convex ${kind} ${path} returned invalid JSON`,
      );
    }
    const envelope = payload as {
      status?: unknown;
      value?: unknown;
    } | null;
    if (
      !response.ok ||
      !envelope ||
      envelope.status !== "success" ||
      !Object.prototype.hasOwnProperty.call(envelope, "value")
    ) {
      throw new SupervisorRuntimeError(
        "convex_http_failure",
        `Convex ${kind} ${path} rejected the request`,
      );
    }
    return envelope.value;
  };
}

function productionTickDependencies(): MissionSupervisorTickDependencies {
  return {
    convex: createSupervisorConvexClient(),
    createLeaseToken: freshLeaseToken,
    createLanguageModel: (tier, turnTimeoutMs) =>
      createCodexSubscriptionLanguageModel({
        modelTier: tier,
        turnTimeoutMs,
      }),
    runPlanningNetwork: (input, options) =>
      runSupervisorPlanningNetwork(input, options),
    runSynthesis: runJarvisReceiptSynthesis,
    scheduleHeartbeat: (callback, delayMs) => {
      const handle = setInterval(callback, delayMs);
      handle.unref?.();
      return handle;
    },
    cancelHeartbeat: (handle) => {
      clearInterval(handle as ReturnType<typeof setInterval>);
    },
  };
}

export const missionSupervisorTick = task({
  id: MISSION_SUPERVISOR_TICK_TASK_ID,
  machine: "small-1x",
  queue: {
    name: "jarvis-mission-supervisor",
    concurrencyLimit: 1,
  },
  retry: { maxAttempts: 1 },
  maxDuration: 1_800,
  run: async (payload: MissionSupervisorTickPayload, { ctx, signal }) =>
    runMissionSupervisorTick(
      payload,
      {
        runId: ctx.run.id,
        deploymentVersion: ctx.deployment?.version,
        signal,
      },
      productionTickDependencies(),
    ),
});

function productionSweepDependencies(): MissionSupervisorSweepDependencies {
  return {
    convex: createSupervisorConvexClient(),
    dispatchTick: async (payload, options) => {
      const {
        idempotencyKey,
        idempotencyKeyScope,
        ...dispatchOptions
      } = options;
      const globalIdempotencyKey = await idempotencyKeys.create(
        idempotencyKey,
        { scope: idempotencyKeyScope },
      );
      return await tasks.trigger<typeof missionSupervisorTick>(
        MISSION_SUPERVISOR_TICK_TASK_ID,
        payload,
        {
          ...dispatchOptions,
          idempotencyKey: globalIdempotencyKey,
        },
      );
    },
  };
}

export const missionSupervisorSweep = schedules.task({
  id: MISSION_SUPERVISOR_SWEEP_TASK_ID,
  cron: "* * * * *",
  machine: "micro",
  queue: {
    name: "jarvis-mission-supervisor-sweep",
    concurrencyLimit: 1,
  },
  retry: { maxAttempts: 1 },
  maxDuration: 60,
  run: async () => runMissionSupervisorSweep(productionSweepDependencies()),
});
