import { mutation, query, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import {
  dispatcherAuthArgs,
  ownerDispatcherAuthArgs,
  requireDispatcher,
  requireOwnerOrDispatcher,
  requireWorker,
} from "./controlAuth";
import {
  insertJobWithRuntime,
  insertMissionWithRuntime,
  patchMissionWithRuntime,
  readAttemptExecutionAuthority,
  readJobSchedulingAuthority,
  readJobWorkOrderAuthority,
} from "./controlPlane";
import {
  admissionForRepository,
  projectSourceAdmissionValidator,
  validProjectAdmissions,
} from "./sourceAdmission";
import { workApprovalPolicy } from "./workPolicy";
import {
  sha256Hex,
  type ProjectSourceAdmission,
} from "../src/lib/source-admission";
import { redactSensitiveText } from "../src/lib/secret-redaction";
import { canonicalizeRepository } from "../src/lib/workflow-contract";
import {
  exactTerminalWorkReceipt,
  terminalWorkReceiptDigest,
} from "./workReceiptAuthority";
import { syncMissionSupervisorCommand } from "./missionSupervisorCommand";
import {
  applySupervisorPauseBatch,
  applySupervisorResumeBatch,
  preflightSupervisorPauseResumeBatch,
  refreshSupervisorJobControlGroups,
} from "./supervisorJobControl";
import {
  MISSION_SUPERVISOR_MAX_AUTONOMOUS_RECOVERIES,
  MISSION_SUPERVISOR_MAX_RECOVERY_GENERATION,
} from "./missionSupervisorProtocol";
export {
  MISSION_SUPERVISOR_MAX_AUTONOMOUS_RECOVERIES,
  MISSION_SUPERVISOR_MAX_RECOVERY_GENERATION,
} from "./missionSupervisorProtocol";

export const MISSION_SUPERVISOR_LEASE_MS = 10 * 60_000;
export const MISSION_SUPERVISOR_MAX_JOBS = 24;
export const MISSION_SUPERVISOR_MAX_DECISIONS = 64;
export const MISSION_SUPERVISOR_MAX_DUE = 8;

const REQUEST_PAYLOAD_MAX_BYTES = 16 * 1024;
const DECISION_PAYLOAD_MAX_BYTES = 48 * 1024;
const SNAPSHOT_MAX_BYTES = 96 * 1024;
const SYNTHESIS_SUMMARY_MAX_BYTES = 4_000;
const NOTIFICATION_MAX_BYTES = 1_200;
const DEFAULT_DEADLINE_MS = 7 * 24 * 60 * 60_000;
const MIN_DEADLINE_MS = 10 * 60_000;
const MAX_DEADLINE_MS = 30 * 24 * 60 * 60_000;
const SUPERVISOR_DELEGATE_RECHECK_MS = 30_000;
const SUPERVISOR_WAIT_MIN_MS = 5_000;
const SUPERVISOR_WAIT_MAX_MS = 15 * 60_000;
const FAILURE_ESCALATION_COUNT = 5;
const FAILURE_BACKOFF_BASE_MS = 30_000;
const FAILURE_BACKOFF_MAX_MS = 15 * 60_000;
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
const SAFE_LEASE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._~:/+=-]{15,239}$/;
const SAFE_ERROR_CODE = /^[a-z][a-z0-9_:-]{0,79}$/;
const TERMINAL_JOB_STATUSES = new Set([
  "done",
  "error",
  "cancelled",
  "needs_input",
]);

const profileValidator = v.union(
  v.literal("short_fleet"),
  v.literal("durable_goal"),
);
const modelTierValidator = v.union(
  v.literal("luna"),
  v.literal("terra"),
  v.literal("sol"),
);
const agentValidator = v.union(
  v.literal("paul"),
  v.literal("atlas"),
  v.literal("iris"),
  v.literal("maya"),
  v.literal("sentry"),
);
const riskValidator = v.union(
  v.literal("low"),
  v.literal("medium"),
  v.literal("high"),
  v.literal("consequential"),
);
const reasoningEffortValidator = v.union(
  v.literal("none"),
  v.literal("low"),
  v.literal("medium"),
  v.literal("high"),
  v.literal("max"),
);
const decisionOriginValidator = v.union(
  v.literal("model"),
  v.literal("policy"),
);
const modelProviderValidator = v.union(
  v.literal("codex-subscription"),
  v.literal("deterministic-policy"),
);
const controlActionValidator = v.union(
  v.literal("pause"),
  v.literal("resume"),
  v.literal("cancel"),
  v.literal("steer"),
  v.literal("provide_input"),
);
const requestedWorkstreamValidator = v.object({
  task: v.string(),
  label: v.optional(v.string()),
  repo: v.optional(v.string()),
  model: v.optional(modelTierValidator),
  agentId: v.optional(agentValidator),
  readonly: v.optional(v.boolean()),
  approvalRequired: v.optional(v.boolean()),
  risk: v.optional(riskValidator),
  acceptanceCriteria: v.optional(v.array(v.string())),
});
const delegatedWorkstreamValidator = v.object({
  task: v.string(),
  label: v.string(),
  repo: v.optional(v.string()),
  model: modelTierValidator,
  agentId: agentValidator,
  readonly: v.boolean(),
  approvalRequired: v.boolean(),
  risk: riskValidator,
  acceptanceCriteria: v.array(v.string()),
});
const retryRecoveryValidator = v.object({
  mode: v.literal("retry"),
  predecessorJobId: v.id("jobs"),
  predecessorReceiptDigest: v.string(),
});
const revisedRecoveryFields = {
  predecessorJobId: v.id("jobs"),
  predecessorReceiptDigest: v.string(),
  task: v.string(),
  label: v.string(),
  model: modelTierValidator,
  agentId: agentValidator,
  risk: riskValidator,
  acceptanceCriteria: v.array(v.string()),
};
const remediateRecoveryValidator = v.object({
  mode: v.literal("remediate"),
  ...revisedRecoveryFields,
});
const inputRevisionRecoveryValidator = v.object({
  mode: v.literal("input_revision"),
  ...revisedRecoveryFields,
});
const recoveryValidator = v.union(
  retryRecoveryValidator,
  remediateRecoveryValidator,
  inputRevisionRecoveryValidator,
);
const supervisorDecisionValidator = v.union(
  v.object({
    kind: v.literal("delegate"),
    workstreams: v.array(delegatedWorkstreamValidator),
  }),
  v.object({
    kind: v.literal("recover"),
    recoveries: v.array(recoveryValidator),
  }),
  v.object({
    kind: v.literal("wait"),
    delayMs: v.number(),
    reason: v.string(),
  }),
  v.object({
    kind: v.literal("request_input"),
    question: v.string(),
    reason: v.string(),
    target: v.optional(v.object({
      predecessorJobId: v.id("jobs"),
      predecessorReceiptDigest: v.string(),
    })),
  }),
  v.object({
    kind: v.literal("replan"),
    reason: v.string(),
  }),
  v.object({
    kind: v.literal("synthesize"),
    summary: v.string(),
  }),
  v.object({
    kind: v.literal("fail"),
    reason: v.string(),
  }),
);

type MissionSupervisorState = Doc<"missionSupervisorState">;
type MissionSupervisorControl = Doc<"missionSupervisorControls">;
type Mission = Doc<"missions">;
type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

type RequestedWorkstreamInput = {
  task: string;
  label?: string;
  repo?: string;
  model?: "luna" | "terra" | "sol";
  agentId?: "paul" | "atlas" | "iris" | "maya" | "sentry";
  readonly?: boolean;
  approvalRequired?: boolean;
  risk?: "low" | "medium" | "high" | "consequential";
  acceptanceCriteria?: string[];
};

type ModelTier = "luna" | "terra" | "sol";
type PermanentAgent = "paul" | "atlas" | "iris" | "maya" | "sentry";
type WorkRisk = "low" | "medium" | "high" | "consequential";
type ReasoningEffort = "none" | "low" | "medium" | "high" | "max";
type DecisionOrigin = "model" | "policy";
type ModelProvider = "codex-subscription" | "deterministic-policy";
type SupervisorControlAction =
  | "pause"
  | "resume"
  | "cancel"
  | "steer"
  | "provide_input";
type SupervisorWakeTicket = {
  protocolVersion: 1;
  missionId: Id<"missions">;
  expectedLeaseVersion: number;
  expectedEpoch: number;
  expectedDecisionSequence: number;
  expectedInputRevision: number;
};
type DelegatedWorkstreamInput = {
  task: string;
  label: string;
  repo?: string;
  model: ModelTier;
  agentId: PermanentAgent;
  readonly: boolean;
  approvalRequired: boolean;
  risk: WorkRisk;
  acceptanceCriteria: string[];
};
type RetryRecoveryInput = {
  mode: "retry";
  predecessorJobId: Id<"jobs">;
  predecessorReceiptDigest: string;
};
type RevisedRecoveryInput = {
  mode: "remediate" | "input_revision";
  predecessorJobId: Id<"jobs">;
  predecessorReceiptDigest: string;
  task: string;
  label: string;
  model: ModelTier;
  agentId: PermanentAgent;
  risk: WorkRisk;
  acceptanceCriteria: string[];
};
type RecoveryInput = RetryRecoveryInput | RevisedRecoveryInput;
type SupervisorDecisionInput =
  | { kind: "delegate"; workstreams: DelegatedWorkstreamInput[] }
  | { kind: "recover"; recoveries: RecoveryInput[] }
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
type CommitMetadataInput = {
  decisionOrigin: DecisionOrigin;
  modelProvider: ModelProvider;
  modelTier: ModelTier;
  modelId: string;
  reasoningEffort: ReasoningEffort;
  tierReason: string;
  supervisorPromptVersion: string;
  triggerRunId: string;
  deploymentVersion?: string;
};

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (utf8Bytes(value) <= maximumBytes) return value;
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const size = utf8Bytes(character);
    if (bytes + size > maximumBytes) break;
    result += character;
    bytes += size;
  }
  return result;
}

function boundedText(
  value: string,
  field: string,
  minimumBytes: number,
  maximumBytes: number,
): string {
  const normalized = value.trim();
  const bytes = utf8Bytes(normalized);
  if (bytes < minimumBytes || bytes > maximumBytes) {
    throw new Error(`${field} must be between ${minimumBytes} and ${maximumBytes} UTF-8 bytes`);
  }
  return normalized;
}

function redactedBoundedText(
  value: string,
  field: string,
  minimumBytes: number,
  maximumBytes: number,
): string {
  const bounded = boundedText(value, field, minimumBytes, maximumBytes);
  return boundedText(
    redactSensitiveText(bounded),
    field,
    minimumBytes,
    maximumBytes,
  );
}

function optionalBoundedText(
  value: string | undefined,
  field: string,
  maximumBytes: number,
  minimumBytes = 1,
): string | undefined {
  if (value === undefined) return undefined;
  return boundedText(value, field, minimumBytes, maximumBytes);
}

function boundedInteger(
  value: number | undefined,
  field: string,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return normalized;
}

function boundedCriteria(
  value: readonly string[] | undefined,
  field: string,
  maximumItems: number,
): string[] {
  if (value === undefined) return [];
  if (value.length > maximumItems) {
    throw new Error(`${field} may contain at most ${maximumItems} items`);
  }
  const normalized = value.map((item, index) =>
    boundedText(item, `${field}[${index}]`, 1, 500)
  );
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${field} contains duplicate items`);
  }
  return normalized;
}

function canonicalRepository(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  const bounded = boundedText(value, field, 1, 120);
  const repository = canonicalizeRepository(bounded, { allowShortName: true }) ?? undefined;
  if (!repository) throw new Error(`${field} must be a canonical admitted repository`);
  return repository;
}

function normalizeWorkstreams(
  workstreams: readonly RequestedWorkstreamInput[] | undefined,
): Array<{
  task: string;
  label?: string;
  repo?: string;
  model?: "luna" | "terra" | "sol";
  agentId?: "paul" | "atlas" | "iris" | "maya" | "sentry";
  readonly?: boolean;
  approvalRequired?: boolean;
  risk?: "low" | "medium" | "high" | "consequential";
  acceptanceCriteria: string[];
}> {
  if (workstreams === undefined) return [];
  if (workstreams.length > 6) {
    throw new Error("requestedWorkstreams may contain at most 6 items");
  }
  return workstreams.map((workstream, index) => {
    const acceptanceCriteria = boundedCriteria(
      workstream.acceptanceCriteria,
      `requestedWorkstreams[${index}].acceptanceCriteria`,
      8,
    );
    if (acceptanceCriteria.length === 0) {
      throw new Error(
        `requestedWorkstreams[${index}].acceptanceCriteria must contain at least 1 item`,
      );
    }
    return {
      task: boundedText(
        workstream.task,
        `requestedWorkstreams[${index}].task`,
        12,
        4_000,
      ),
      label: optionalBoundedText(
        workstream.label,
        `requestedWorkstreams[${index}].label`,
        80,
        3,
      ),
      repo: canonicalRepository(
        workstream.repo,
        `requestedWorkstreams[${index}].repo`,
      ),
      model: workstream.model,
      agentId: workstream.agentId,
      readonly: workstream.readonly,
      approvalRequired: workstream.approvalRequired,
      risk: workstream.risk,
      acceptanceCriteria,
    };
  });
}

function normalizeDelegatedWorkstreams(
  workstreams: readonly DelegatedWorkstreamInput[],
) {
  if (workstreams.length < 1 || workstreams.length > 6) {
    throw new Error("delegate.workstreams must contain between 1 and 6 items");
  }
  const normalized = workstreams.map((workstream, index) => {
    const acceptanceCriteria = boundedCriteria(
      workstream.acceptanceCriteria,
      `decision.workstreams[${index}].acceptanceCriteria`,
      8,
    );
    if (acceptanceCriteria.length === 0) {
      throw new Error(
        `decision.workstreams[${index}].acceptanceCriteria must contain at least 1 item`,
      );
    }
    return {
      task: boundedText(
        workstream.task,
        `decision.workstreams[${index}].task`,
        12,
        4_000,
      ),
      label: boundedText(
        workstream.label,
        `decision.workstreams[${index}].label`,
        3,
        80,
      ),
      repo: canonicalRepository(
        workstream.repo,
        `decision.workstreams[${index}].repo`,
      ),
      model: workstream.model,
      agentId: workstream.agentId,
      readonly: workstream.readonly,
      approvalRequired: workstream.approvalRequired,
      risk: workstream.risk,
      acceptanceCriteria,
    };
  });
  const fingerprints = normalized.map((workstream) =>
    delegatedWorkIdentity(workstream)
  );
  if (new Set(fingerprints).size !== fingerprints.length) {
    throw new Error("delegate.workstreams contains duplicate work");
  }
  return normalized;
}

function normalizeRecoveries(
  recoveries: readonly RecoveryInput[],
): RecoveryInput[] {
  if (recoveries.length < 1 || recoveries.length > 4) {
    throw new Error("recover.recoveries must contain between 1 and 4 items");
  }
  const normalized = recoveries.map((recovery, index): RecoveryInput => {
    const predecessorReceiptDigest = requireSha256Digest(
      recovery.predecessorReceiptDigest,
      `decision.recoveries[${index}].predecessorReceiptDigest`,
    );
    if (recovery.mode === "retry") {
      return {
        mode: "retry",
        predecessorJobId: recovery.predecessorJobId,
        predecessorReceiptDigest,
      };
    }
    const acceptanceCriteria = boundedCriteria(
      recovery.acceptanceCriteria,
      `decision.recoveries[${index}].acceptanceCriteria`,
      8,
    );
    if (acceptanceCriteria.length === 0) {
      throw new Error(
        `decision.recoveries[${index}].acceptanceCriteria must contain at least 1 item`,
      );
    }
    return {
      mode: recovery.mode,
      predecessorJobId: recovery.predecessorJobId,
      predecessorReceiptDigest,
      task: boundedText(
        recovery.task,
        `decision.recoveries[${index}].task`,
        12,
        4_000,
      ),
      label: boundedText(
        recovery.label,
        `decision.recoveries[${index}].label`,
        3,
        80,
      ),
      model: recovery.model,
      agentId: recovery.agentId,
      risk: recovery.risk,
      acceptanceCriteria,
    };
  });
  const predecessorIds = normalized.map((recovery) =>
    String(recovery.predecessorJobId)
  );
  if (new Set(predecessorIds).size !== predecessorIds.length) {
    throw new Error("recover.recoveries contains duplicate predecessors");
  }
  const hasRetry = normalized.some((recovery) => recovery.mode === "retry");
  if (hasRetry && normalized.some((recovery) => recovery.mode !== "retry")) {
    throw new Error(
      "recover.recoveries cannot mix policy retries with model revisions",
    );
  }
  return normalized;
}

function normalizeSupervisorDecision(
  decision: SupervisorDecisionInput,
): SupervisorDecisionInput {
  switch (decision.kind) {
    case "delegate":
      return {
        kind: "delegate",
        workstreams: normalizeDelegatedWorkstreams(decision.workstreams),
      };
    case "recover":
      return {
        kind: "recover",
        recoveries: normalizeRecoveries(decision.recoveries),
      };
    case "wait":
      return {
        kind: "wait",
        delayMs: boundedInteger(
          decision.delayMs,
          "decision.delayMs",
          SUPERVISOR_WAIT_MIN_MS,
          SUPERVISOR_WAIT_MAX_MS,
          decision.delayMs,
        ),
        reason: redactedBoundedText(
          decision.reason,
          "decision.reason",
          1,
          500,
        ),
      };
    case "request_input":
      return {
        kind: "request_input",
        question: redactedBoundedText(
          decision.question,
          "decision.question",
          12,
          1_000,
        ),
        reason: redactedBoundedText(
          decision.reason,
          "decision.reason",
          1,
          500,
        ),
        target: decision.target
          ? {
            predecessorJobId: decision.target.predecessorJobId,
            predecessorReceiptDigest: requireSha256Digest(
              decision.target.predecessorReceiptDigest,
              "decision.target.predecessorReceiptDigest",
            ),
          }
          : undefined,
      };
    case "replan":
      return {
        kind: "replan",
        reason: redactedBoundedText(
          decision.reason,
          "decision.reason",
          12,
          1_000,
        ),
      };
    case "synthesize":
      return {
        kind: "synthesize",
        summary: redactedBoundedText(
          decision.summary,
          "decision.summary",
          12,
          SYNTHESIS_SUMMARY_MAX_BYTES,
        ),
      };
    case "fail":
      return {
        kind: "fail",
        reason: redactedBoundedText(
          decision.reason,
          "decision.reason",
          12,
          1_000,
        ),
      };
  }
}

function normalizeCommitMetadata(
  decision: SupervisorDecisionInput,
  input: CommitMetadataInput,
) {
  const metadata = {
    decisionOrigin: input.decisionOrigin,
    modelProvider: input.modelProvider,
    modelTier: input.modelTier,
    modelId: boundedText(input.modelId, "modelId", 1, 120),
    reasoningEffort: input.reasoningEffort,
    tierReason: redactedBoundedText(input.tierReason, "tierReason", 1, 500),
    supervisorPromptVersion: boundedText(
      input.supervisorPromptVersion,
      "supervisorPromptVersion",
      1,
      80,
    ),
    triggerRunId: boundedText(input.triggerRunId, "triggerRunId", 1, 160),
    deploymentVersion: optionalBoundedText(
      input.deploymentVersion,
      "deploymentVersion",
      160,
    ),
  };
  const policyKind = ["wait", "replan"].includes(decision.kind)
    || (decision.kind === "recover"
      && decision.recoveries.every((recovery) => recovery.mode === "retry"));
  const modelKind = ["delegate", "synthesize"].includes(decision.kind)
    || (decision.kind === "recover"
      && decision.recoveries.every((recovery) => recovery.mode !== "retry"));
  if (
    metadata.decisionOrigin === "model"
      ? metadata.modelProvider !== "codex-subscription"
      : metadata.modelProvider !== "deterministic-policy"
  ) {
    throw new Error("decisionOrigin and modelProvider do not match");
  }
  if (policyKind && metadata.decisionOrigin !== "policy") {
    throw new Error(`${decision.kind} must use deterministic policy authorship`);
  }
  if (modelKind && metadata.decisionOrigin !== "model") {
    throw new Error(`${decision.kind} must use Codex subscription authorship`);
  }
  if (metadata.decisionOrigin === "policy" && (
    metadata.modelTier !== "luna"
    || metadata.modelId !== "jarvis-supervisor-policy-v1"
    || metadata.reasoningEffort !== "none"
  )) {
    throw new Error("Deterministic policy metadata is not canonical");
  }
  if (metadata.decisionOrigin === "model" && metadata.reasoningEffort === "none") {
    throw new Error("Model-authored decisions require a model reasoning effort");
  }
  return metadata;
}

function sortedAdmissions(
  admissions: readonly ProjectSourceAdmission[],
): ProjectSourceAdmission[] {
  return admissions
    .map((admission) => ({ ...admission }))
    .sort((left, right) =>
      (left.repository ?? "evidence").localeCompare(right.repository ?? "evidence")
    );
}

function canonicalJson(value: unknown): string {
  const counter = { nodes: 0 };
  const encode = (item: unknown, depth: number): string => {
    counter.nodes += 1;
    if (counter.nodes > 4_096 || depth > 16) {
      throw new Error("Canonical payload exceeds structural bounds");
    }
    if (item === null) return "null";
    if (typeof item === "string" || typeof item === "boolean") {
      return JSON.stringify(item);
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new Error("Canonical payload contains a non-finite number");
      return JSON.stringify(item);
    }
    if (Array.isArray(item)) {
      return `[${item.map((entry) => {
        if (entry === undefined) throw new Error("Canonical arrays may not contain undefined");
        return encode(entry, depth + 1);
      }).join(",")}]`;
    }
    if (typeof item === "object") {
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error("Canonical payload must contain plain objects only");
      }
      const record = item as Record<string, unknown>;
      const members = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${encode(record[key], depth + 1)}`);
      return `{${members.join(",")}}`;
    }
    throw new Error("Canonical payload contains an unsupported value");
  };
  return encode(value, 0);
}

function delegatedWorkIdentity(work: {
  agentId: string | null | undefined;
  repo: string | null | undefined;
  task: string;
}): string {
  return canonicalJson({
    agentId: work.agentId ?? null,
    repo: work.repo ?? null,
    task: work.task.trim().replace(/\s+/gu, " ").toLowerCase(),
  });
}

function normalizedStartRequest(args: {
  requestKey: string;
  goal: string;
  profile?: "short_fleet" | "durable_goal";
  context?: string;
  repo?: string;
  desiredWorkstreams?: number;
  requestedWorkstreams?: RequestedWorkstreamInput[];
  acceptanceCriteria?: string[];
  projectAdmissions: ProjectSourceAdmission[];
  originThreadId?: string;
  priority?: number;
  risk?: "low" | "medium" | "high" | "consequential";
  deadlineMs?: number;
}) {
  const requestKey = boundedText(args.requestKey, "requestKey", 1, 160);
  if (!SAFE_KEY.test(requestKey)) throw new Error("requestKey has an invalid format");
  const goal = boundedText(args.goal, "goal", 12, 500);
  const profile = args.profile ?? "short_fleet";
  const context = optionalBoundedText(args.context, "context", 8_000);
  const repo = canonicalRepository(args.repo, "repo");
  const requestedWorkstreams = normalizeWorkstreams(args.requestedWorkstreams);
  const minimumDesiredWorkstreams = profile === "durable_goal" ? 2 : 1;
  const desiredWorkstreams = boundedInteger(
    args.desiredWorkstreams,
    "desiredWorkstreams",
    minimumDesiredWorkstreams,
    6,
    Math.max(minimumDesiredWorkstreams, requestedWorkstreams.length),
  );
  const acceptanceCriteria = boundedCriteria(
    args.acceptanceCriteria,
    "acceptanceCriteria",
    8,
  );
  const projectAdmissions = sortedAdmissions(args.projectAdmissions);
  const originThreadId =
    optionalBoundedText(args.originThreadId, "originThreadId", 120) ?? "main";
  const priority = boundedInteger(args.priority, "priority", 0, 100, 50);
  const risk = args.risk ?? "low";
  const deadlineMs = boundedInteger(
    args.deadlineMs,
    "deadlineMs",
    MIN_DEADLINE_MS,
    MAX_DEADLINE_MS,
    DEFAULT_DEADLINE_MS,
  );
  const payload = {
    protocolVersion: 1,
    goal,
    profile,
    context,
    repo,
    desiredWorkstreams,
    requestedWorkstreams,
    acceptanceCriteria,
    projectAdmissions,
    originThreadId,
    priority,
    risk,
    deadlineMs,
  };
  const requestPayloadJson = canonicalJson(payload);
  const idempotencyPayloadJson = canonicalJson({
    ...payload,
    projectAdmissions: projectAdmissions.map((admission) => ({
      protocolVersion: admission.protocolVersion,
      canonicalProjectId: admission.canonicalProjectId,
      repository: admission.repository ?? null,
      sourceProvider: admission.sourceProvider,
      sourceBranch: admission.sourceBranch ?? null,
      sourceRef: admission.sourceRef ?? null,
    })),
  });
  if (utf8Bytes(requestPayloadJson) > REQUEST_PAYLOAD_MAX_BYTES) {
    throw new Error(`Canonical request payload exceeds ${REQUEST_PAYLOAD_MAX_BYTES} UTF-8 bytes`);
  }
  return {
    requestKey,
    payload,
    requestPayloadJson,
    idempotencyPayloadJson,
  };
}

async function stateForMission(
  ctx: Pick<MutationCtx, "db">,
  missionId: Id<"missions">,
): Promise<MissionSupervisorState | null> {
  const rows = await ctx.db
    .query("missionSupervisorState")
    .withIndex("by_mission", (q) => q.eq("missionId", missionId))
    .take(2);
  if (rows.length > 1) throw new Error("Mission supervisor state is not unique");
  return rows[0] ?? null;
}

function validFenceInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
}

function validateLeaseIdentity(owner: string, token: string): void {
  if (!SAFE_KEY.test(owner)) throw new Error("leaseOwner has an invalid format");
  if (!SAFE_LEASE_TOKEN.test(token)) throw new Error("leaseToken has an invalid format");
}

function clearLease() {
  return {
    leaseOwner: undefined,
    leaseToken: undefined,
    leaseHeartbeatAt: undefined,
    leaseUntil: undefined,
  };
}

function supervisorWakeTicket(
  state: Pick<
    MissionSupervisorState,
    | "missionId"
    | "leaseVersion"
    | "epoch"
    | "nextDecisionSequence"
    | "inputRevision"
  >,
): SupervisorWakeTicket {
  return {
    protocolVersion: 1,
    missionId: state.missionId,
    expectedLeaseVersion: state.leaseVersion,
    expectedEpoch: state.epoch,
    expectedDecisionSequence: state.nextDecisionSequence,
    expectedInputRevision: state.inputRevision,
  };
}

function isDue(state: MissionSupervisorState, now: number): boolean {
  if (state.state === "ready" || state.state === "waiting") {
    return typeof state.nextTickAt === "number" && state.nextTickAt <= now;
  }
  return state.state === "leased"
    && typeof state.leaseUntil === "number"
    && state.leaseUntil <= now;
}

function excerpt(value: unknown, maximum: number): string | null {
  return typeof value === "string" ? value.slice(0, maximum) : null;
}

function boundedSnapshotList(value: readonly string[], maximumItems = 8): string[] {
  return value
    .slice(0, maximumItems)
    .map((item) => truncateUtf8(redactSensitiveText(String(item)), 500));
}

async function terminalAuthorityAndReceipt(
  ctx: Pick<MutationCtx, "db">,
  job: Doc<"jobs">,
): Promise<{ authorityDigest: string | null; receipt: JsonValue }> {
  if (!TERMINAL_JOB_STATUSES.has(job.status)) {
    return { authorityDigest: null, receipt: null };
  }
  const attempt = Number(job.attempt ?? 1);
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    return { authorityDigest: null, receipt: null };
  }
  const [authority, receipts] = await Promise.all([
    readAttemptExecutionAuthority(ctx, job, attempt),
    ctx.db
      .query("workReceipts")
      .withIndex("by_job_attempt", (q) =>
        q.eq("jobId", job._id).eq("attempt", attempt)
      )
      .take(2),
  ]);
  if (receipts.length !== 1) {
    return {
      authorityDigest: authority?.authorityDigest ?? null,
      receipt: null,
    };
  }
  const receipt = receipts[0];
  return {
    authorityDigest: authority?.authorityDigest ?? null,
    receipt: {
      jobId: String(receipt.jobId),
      attempt: receipt.attempt,
      protocolVersion: receipt.protocolVersion ?? null,
      receiptDigest: receipt.receiptDigest ?? null,
      terminalCode: receipt.terminalCode ?? null,
      recoveryDisposition: receipt.recoveryDisposition ?? null,
      observedInputRevision: receipt.observedInputRevision ?? null,
      status: receipt.status,
      verification: receipt.verification,
      authorityDigest: receipt.authorityDigest ?? null,
      schedulingBindingDigest: receipt.schedulingBindingDigest ?? null,
      workOrderRevisionId: receipt.workOrderRevisionId
        ? String(receipt.workOrderRevisionId)
        : null,
      workOrderRevision: receipt.workOrderRevision ?? null,
      workOrderRevisionDigest: receipt.workOrderRevisionDigest ?? null,
      canonicalProjectId: receipt.canonicalProjectId ?? null,
      repository: receipt.repository ?? null,
      resultDigest: receipt.resultDigest ?? null,
      evidenceDigest: receipt.evidenceDigest ?? null,
      acceptanceEvidence: boundedSnapshotList(receipt.acceptanceEvidence),
      artifacts: boundedSnapshotList(receipt.artifacts),
      reviewReceiptDigest: receipt.reviewReceiptDigest ?? null,
    },
  };
}

async function snapshotJob(
  job: Doc<"jobs">,
  terminal: { authorityDigest: string | null; receipt: JsonValue },
): Promise<JsonValue> {
  const task = String(job.task ?? "");
  const result = typeof job.result === "string" ? job.result : undefined;
  const verificationNote =
    typeof job.verificationNote === "string" ? job.verificationNote : undefined;
  const criteria = Array.isArray(job.acceptanceCriteria)
    ? job.acceptanceCriteria.map(String)
    : [];
  const dependsOn = Array.isArray(job.dependsOn)
    ? job.dependsOn.map(String).sort()
    : [];
  const steer = typeof job.steer === "string" ? job.steer : undefined;
  const evidenceSummary =
    typeof job.evidenceSummary === "string" ? job.evidenceSummary : undefined;
  return {
    jobId: String(job._id),
    supervisorEpoch: job.supervisorEpoch ?? null,
    supervisorDecisionKey: job.supervisorDecisionKey ?? null,
    supervisorJobOrdinal: job.supervisorJobOrdinal ?? null,
    label: excerpt(job.label, 80),
    task: task.slice(0, 600),
    taskDigest: await sha256Hex(task),
    repo: excerpt(job.repo, 120),
    status: String(job.status),
    readonly: job.readonly ?? null,
    agentId: excerpt(job.agentId, 40),
    model: excerpt(job.model, 24),
    reasoningEffort: excerpt(job.reasoningEffort, 24),
    risk: excerpt(job.risk, 24),
    priority: typeof job.priority === "number" ? job.priority : null,
    approvalRequired: job.approvalRequired ?? null,
    approvalStatus: excerpt(job.approvalStatus, 32),
    approvalReason: excerpt(job.approvalReason, 300),
    attempt: job.attempt ?? 1,
    maxAttempts: job.maxAttempts ?? 1,
    steer: steer?.slice(0, 500) ?? null,
    steerDigest: steer ? await sha256Hex(steer) : null,
    steerRevision: job.steerRevision ?? 0,
    dependsOn: dependsOn.slice(0, 16),
    dependsOnDigest: await sha256Hex(canonicalJson(dependsOn)),
    acceptanceCriteria: criteria.slice(0, 8).map((item) => item.slice(0, 500)),
    acceptanceCriteriaDigest: await sha256Hex(canonicalJson(criteria)),
    authorityDigest: terminal.authorityDigest,
    workOrderRevision: job.workOrderRevision ?? null,
    workOrderRevisionDigest: excerpt(job.workOrderRevisionDigest, 64),
    schedulingBindingDigest: excerpt(job.schedulingBindingDigest, 64),
    sourceAdmissionDigest: excerpt(job.sourceAdmissionDigest, 64),
    sourceHeadSha: excerpt(job.sourceHeadSha, 80),
    integrationState: excerpt(job.integrationState, 40),
    deliveryStatus: excerpt(job.deliveryStatus, 32),
    reviewReceiptDigest: excerpt(job.reviewReceiptDigest, 64),
    result: result?.slice(0, 2_000) ?? null,
    resultDigest: result ? await sha256Hex(result) : null,
    verificationVerdict: excerpt(job.verificationVerdict, 32),
    verificationNote: verificationNote?.slice(0, 500) ?? null,
    evidenceDigest: verificationNote ? await sha256Hex(verificationNote) : null,
    evidenceSummary: evidenceSummary?.slice(0, 500) ?? null,
    evidenceSummaryDigest: evidenceSummary
      ? await sha256Hex(evidenceSummary)
      : null,
    stallReason: job.status === "stalled" ? excerpt(job.stallReason, 400) : null,
    completedAt: job.completedAt ?? null,
    receipt: terminal.receipt,
  };
}

async function pendingInputAuthority(
  ctx: Pick<MutationCtx, "db">,
  mission: Mission,
  state: MissionSupervisorState,
  jobs: Doc<"jobs">[],
  supersessions: Doc<"missionSupervisorSupersessions">[],
): Promise<JsonValue> {
  if (typeof state.lastDecisionKey !== "string") return null;
  const decisions = await ctx.db
    .query("missionSupervisorDecisions")
    .withIndex("by_key", (q) => q.eq("decisionKey", state.lastDecisionKey!))
    .take(2);
  const decision = decisions.length === 1 ? decisions[0] : null;
  if (
    !decision
    || decision.kind !== "request_input"
    || !decision.inputTargetJobId
    || !decision.inputTargetReceiptDigest
  ) return null;
  const target = jobs.find((job) =>
    String(job._id) === String(decision.inputTargetJobId)
  );
  if (
    !target
    || supersessions.some((edge) =>
      String(edge.predecessorJobId) === String(target._id)
    )
  ) return null;
  const terminal = await exactTerminalWorkReceipt(ctx, target);
  if (
    !terminal
    || terminal.receipt.receiptDigest !== decision.inputTargetReceiptDigest
  ) return null;
  const controls = await ctx.db
    .query("missionSupervisorControls")
    .withIndex("by_mission_created", (q) => q.eq("missionId", mission._id))
    .order("desc")
    .take(8);
  const steerDigest = typeof mission.steer === "string"
    ? await sha256Hex(mission.steer)
    : null;
  const control = controls.find((receipt) =>
    receipt.action === "provide_input"
    && receipt.applied
    && !receipt.noop
    && receipt.scope === `terminal_leaf_recovery_input:${String(target._id)}`
    && receipt.expectedInputRevision === decision.observedInputRevision
    && receipt.resultInputRevision === state.inputRevision
    && state.inputRevision === decision.observedInputRevision + 1
    && typeof receipt.inputDigest === "string"
    && receipt.inputDigest === steerDigest
  );
  return {
    requestDecisionKey: decision.decisionKey,
    requestObservedInputRevision: decision.observedInputRevision,
    predecessorJobId: String(target._id),
    predecessorAttempt: terminal.receipt.attempt,
    predecessorReceiptId: String(terminal.receipt._id),
    predecessorReceiptDigest: terminal.receipt.receiptDigest,
    terminalCode: terminal.receipt.terminalCode ?? null,
    recoveryDisposition: terminal.receipt.recoveryDisposition ?? null,
    controlReceiptId: control ? String(control._id) : null,
    controlRequestDigest: control?.requestDigest ?? null,
    controlExpectedInputRevision: control?.expectedInputRevision ?? null,
    controlInputDigest: control?.inputDigest ?? null,
    controlResultInputRevision: control?.resultInputRevision ?? null,
    steerDigest,
    steerDigestMatchesControl: Boolean(
      control?.inputDigest
      && steerDigest
      && control.inputDigest === steerDigest,
    ),
  };
}

async function authoritativeSnapshot(
  ctx: Pick<MutationCtx, "db">,
  mission: Mission,
  state: MissionSupervisorState,
  jobs: Doc<"jobs">[],
): Promise<{ snapshot: JsonValue; snapshotJson: string; snapshotDigest: string }> {
  const missionCriteria = Array.isArray(mission.acceptanceCriteria)
    ? mission.acceptanceCriteria.map(String)
    : [];
  const missionSteer = typeof mission.steer === "string" ? mission.steer : undefined;
  const failureReason =
    typeof mission.failureReason === "string" ? mission.failureReason : undefined;
  const orderedJobs = [...jobs]
    .sort((left, right) => String(left._id).localeCompare(String(right._id)));
  const [terminalBindings, supersessionRows] = await Promise.all([
    Promise.all(
      orderedJobs.map((job) => terminalAuthorityAndReceipt(ctx, job)),
    ),
    ctx.db
      .query("missionSupervisorSupersessions")
      .withIndex("by_mission_created", (q) =>
        q.eq("missionId", mission._id)
      )
      .take(MISSION_SUPERVISOR_MAX_JOBS + 1),
  ]);
  if (supersessionRows.length > MISSION_SUPERVISOR_MAX_JOBS - 1) {
    throw new Error("supervisor_supersession_ledger_too_large");
  }
  const jobSnapshots = await Promise.all(
    orderedJobs.map((job, index) => snapshotJob(job, terminalBindings[index])),
  );
  const pendingInput =
    state.inputRevision > state.handledInputRevision
      && typeof mission.steer === "string"
    ? await pendingInputAuthority(
      ctx,
      mission,
      state,
      orderedJobs,
      supersessionRows,
    )
    : null;
  const snapshot: JsonValue = {
    protocolVersion: 1,
    mission: {
      missionId: String(mission._id),
      goal: mission.goal,
      mode: mission.mode ?? null,
      status: mission.status,
      originThreadId: mission.originThreadId ?? "main",
      priority: mission.priority ?? 50,
      risk: mission.risk ?? "low",
      acceptanceCriteria: missionCriteria.slice(0, 8).map((item) =>
        item.slice(0, 500)
      ),
      acceptanceCriteriaDigest: await sha256Hex(canonicalJson(missionCriteria)),
      projectAdmissions: sortedAdmissions(mission.projectAdmissions ?? []),
      controlRequested: mission.controlRequested ?? null,
      steer: missionSteer?.slice(0, 2_000) ?? null,
      steerDigest: missionSteer ? await sha256Hex(missionSteer) : null,
      steerRevision: mission.steerRevision ?? 0,
      failureReason: failureReason?.slice(0, 600) ?? null,
      failureReasonDigest: failureReason ? await sha256Hex(failureReason) : null,
    },
    supervisor: {
      requestDigest: state.requestDigest,
      requestPayloadJson: state.requestPayloadJson,
      epoch: state.epoch,
      nextDecisionSequence: state.nextDecisionSequence,
      inputRevision: state.inputRevision,
      handledInputRevision: state.handledInputRevision,
      dirtyJobIds: [...state.dirtyJobIds].map(String).sort(),
      totalJobs: state.totalJobs,
      maxJobs: state.maxJobs,
      decisionCount: state.decisionCount,
      maxDecisions: state.maxDecisions,
      deadlineAt: state.deadlineAt,
      lastDecisionKey: state.lastDecisionKey ?? null,
      lastDecisionDigest: state.lastDecisionDigest ?? null,
    },
    jobs: jobSnapshots,
    pendingInputAuthority: pendingInput,
    supersessions: supersessionRows
      .sort((left, right) =>
        left.createdAt - right.createdAt
        || String(left._id).localeCompare(String(right._id))
      )
      .map((row) => ({
        supersessionId: String(row._id),
        supersessionKey: row.supersessionKey,
        supersessionDigest: row.supersessionDigest,
        decisionKey: row.decisionKey,
        decisionOrdinal: row.decisionOrdinal,
        mode: row.mode,
        rootJobId: String(row.rootJobId),
        generation: row.generation,
        autonomousRecoveryCount: row.autonomousRecoveryCount,
        predecessorJobId: String(row.predecessorJobId),
        predecessorAttempt: row.predecessorAttempt,
        predecessorReceiptDigest: row.predecessorReceiptDigest,
        successorJobId: String(row.successorJobId),
        successorSchedulingBindingDigest:
          row.successorSchedulingBindingDigest,
        successorWorkOrderRevisionId:
          String(row.successorWorkOrderRevisionId),
        successorWorkOrderRevisionDigest:
          row.successorWorkOrderRevisionDigest,
        successorCanonicalProjectId: row.successorCanonicalProjectId,
        successorRepository: row.successorRepository ?? null,
        successorSourceAdmissionDigest: row.successorSourceAdmissionDigest,
        observedInputRevision: row.observedInputRevision,
        inputControlReceiptId: row.inputControlReceiptId
          ? String(row.inputControlReceiptId)
          : null,
        inputControlRequestDigest: row.inputControlRequestDigest ?? null,
        inputControlDigest: row.inputControlDigest ?? null,
      })),
  };
  const snapshotJson = canonicalJson(snapshot);
  if (utf8Bytes(snapshotJson) > SNAPSHOT_MAX_BYTES) {
    throw new Error("supervisor_snapshot_too_large");
  }
  return {
    snapshot,
    snapshotJson,
    snapshotDigest: await sha256Hex(snapshotJson),
  };
}

async function upsertSupervisorAttention(
  ctx: Pick<MutationCtx, "db">,
  mission: Mission,
  code: string,
  failures: number,
  detail: string,
  now: number,
  options: {
    fingerprintSuffix?: string;
    titlePrefix?: string;
    severity?: "medium" | "high";
  } = {},
) {
  const fingerprint =
    `mission-supervisor:${String(mission._id)}:${options.fingerprintSuffix ?? "needs-input"}`;
  const existing = await ctx.db
    .query("attentionItems")
    .withIndex("by_fingerprint", (q) => q.eq("fingerprint", fingerprint))
    .first();
  const value = {
    fingerprint,
    project: mission.primaryRepo,
    title: `${options.titlePrefix ?? "Supervisor needs input"} · ${mission.goal.slice(0, 96)}`,
    detail: detail.slice(0, 2_000),
    evidence: [code, `failures:${failures}`],
    severity: options.severity
      ?? (failures >= FAILURE_ESCALATION_COUNT ? "high" : "medium"),
    impact: Math.min(100, 55 + failures * 8),
    urgency: Math.min(100, 50 + failures * 10),
    confidence: 1,
    actionClass: "ask",
    authority: "mission-supervisor",
    status: "open",
    updatedAt: now,
  };
  if (existing) {
    await ctx.db.patch(existing._id, value);
    return existing._id;
  }
  return await ctx.db.insert("attentionItems", { ...value, createdAt: now });
}

async function resolveSupervisorAttention(
  ctx: Pick<MutationCtx, "db">,
  missionId: Id<"missions">,
  now: number,
  includeTerminalFailure: boolean,
) {
  const suffixes = includeTerminalFailure
    ? ["needs-input", "failed"]
    : ["needs-input"];
  for (const suffix of suffixes) {
    const rows = await ctx.db
      .query("attentionItems")
      .withIndex("by_fingerprint", (q) =>
        q.eq(
          "fingerprint",
          `mission-supervisor:${String(missionId)}:${suffix}`,
        )
      )
      .take(2);
    if (rows.length > 1) {
      throw new Error("Supervisor attention authority is not unique");
    }
    const attention = rows[0];
    if (
      attention
      && attention.authority === "mission-supervisor"
      && attention.status !== "resolved"
      && attention.status !== "dismissed"
    ) {
      await ctx.db.patch(attention._id, { status: "resolved", updatedAt: now });
    }
  }
}

async function holdMissionForInput(
  ctx: MutationCtx,
  state: MissionSupervisorState,
  mission: Mission,
  code: string,
  detail: string,
  failures: number,
  now: number,
) {
  const attentionItemId = await upsertSupervisorAttention(
    ctx,
    mission,
    code,
    failures,
    detail,
    now,
  );
  const statePatch = {
    state: "needs_input",
    nextTickAt: undefined,
    ...clearLease(),
    consecutiveFailures: failures,
    lastErrorCode: code,
    lastErrorAt: now,
    updatedAt: now,
  } as const;
  const missionPatch = {
    status: "needs_input",
    phase: "needs_input",
    failureReason: detail.slice(0, 600),
    updatedAt: now,
  };
  await ctx.db.patch(state._id, statePatch);
  await patchMissionWithRuntime(ctx, mission, missionPatch);
  await syncMissionSupervisorCommand(
    ctx,
    { ...mission, ...missionPatch },
    { ...state, ...statePatch },
    { mode: "set", question: detail },
    false,
  );
  return attentionItemId;
}

type NormalizedControlRequest = {
  requestKey: string;
  requestDigest: string;
  action: SupervisorControlAction;
  expectedInputRevision: number;
  input?: string;
  inputDigest?: string;
};

type SupervisorControlOutcome = {
  applied: boolean;
  noop: boolean;
  reason: string;
  scope: string;
  resultState?: MissionSupervisorState["state"];
  resultInputRevision?: number;
  wakeTicket?: SupervisorWakeTicket | null;
  batchProtocolVersion?: 1;
  affectedJobIds?: Id<"jobs">[];
  affectedJobCount?: number;
  batchDigest?: string;
  sourcePauseControlReceiptId?: Id<"missionSupervisorControls">;
};

async function normalizedControlRequest(args: {
  missionId: Id<"missions">;
  requestKey: string;
  action: SupervisorControlAction;
  expectedInputRevision: number;
  input?: string;
}): Promise<NormalizedControlRequest> {
  const requestKey = args.requestKey.trim();
  if (!SAFE_KEY.test(requestKey)) {
    throw new Error("requestKey has an invalid format");
  }
  validFenceInteger(args.expectedInputRevision, "expectedInputRevision");
  const expectsInput =
    args.action === "steer" || args.action === "provide_input";
  const input = expectsInput
    ? boundedText(args.input ?? "", "input", 1, 2_000)
    : undefined;
  if (!expectsInput && typeof args.input === "string" && args.input.trim()) {
    throw new Error(`${args.action} does not accept input`);
  }
  const requestDigest = await sha256Hex(canonicalJson({
    protocolVersion: 1,
    missionId: String(args.missionId),
    action: args.action,
    expectedInputRevision: args.expectedInputRevision,
    input: input ?? null,
  }));
  return {
    requestKey,
    requestDigest,
    action: args.action,
    expectedInputRevision: args.expectedInputRevision,
    input,
    inputDigest: input === undefined ? undefined : await sha256Hex(input),
  };
}

function canonicalControlJobIds(
  jobIds: readonly Id<"jobs">[],
): Id<"jobs">[] {
  const sorted = [...jobIds].sort((left, right) =>
    String(left).localeCompare(String(right))
  );
  if (
    sorted.length > MISSION_SUPERVISOR_MAX_JOBS
    || new Set(sorted.map(String)).size !== sorted.length
  ) {
    throw new Error("Supervisor control batch membership is invalid");
  }
  return sorted;
}

async function supervisorControlBatchDigest(args: {
  missionId: Id<"missions">;
  action: "pause" | "resume";
  requestKey: string;
  requestDigest: string;
  expectedInputRevision: number;
  resultInputRevision: number;
  affectedJobIds: readonly Id<"jobs">[];
  sourcePauseControlReceiptId?: Id<"missionSupervisorControls">;
}): Promise<string> {
  return await sha256Hex(canonicalJson({
    protocolVersion: 1,
    missionId: String(args.missionId),
    action: args.action,
    requestKey: args.requestKey,
    requestDigest: args.requestDigest,
    expectedInputRevision: args.expectedInputRevision,
    resultInputRevision: args.resultInputRevision,
    affectedJobIds: canonicalControlJobIds(args.affectedJobIds).map(String),
    sourcePauseControlReceiptId:
      args.sourcePauseControlReceiptId === undefined
        ? null
        : String(args.sourcePauseControlReceiptId),
  }));
}

type PauseCohortAuthority =
  | {
      ok: true;
      receipt: MissionSupervisorControl;
      affectedJobIds: Id<"jobs">[];
    }
  | { ok: false; reason: "missing_or_invalid_pause_cohort" };

async function pauseCohortAuthority(
  ctx: Pick<MutationCtx, "db">,
  state: MissionSupervisorState,
): Promise<PauseCohortAuthority | null> {
  const fields = [
    state.pauseCohortProtocolVersion,
    state.pauseCohortControlReceiptId,
    state.pauseCohortInputRevision,
    state.pauseCohortJobCount,
    state.pauseCohortDigest,
  ];
  if (fields.every((field) => field === undefined)) return null;
  if (
    state.pauseCohortProtocolVersion !== 1
    || !state.pauseCohortControlReceiptId
    || !Number.isSafeInteger(state.pauseCohortInputRevision)
    || Number(state.pauseCohortInputRevision) < 0
    || !Number.isSafeInteger(state.pauseCohortJobCount)
    || Number(state.pauseCohortJobCount) < 1
    || Number(state.pauseCohortJobCount) > MISSION_SUPERVISOR_MAX_JOBS
    || typeof state.pauseCohortDigest !== "string"
    || !/^[0-9a-f]{64}$/.test(state.pauseCohortDigest)
  ) {
    return { ok: false, reason: "missing_or_invalid_pause_cohort" };
  }
  const receipt = await ctx.db.get(state.pauseCohortControlReceiptId);
  if (
    !receipt
    || receipt.protocolVersion !== 1
    || String(receipt.missionId) !== String(state.missionId)
    || receipt.action !== "pause"
    || !receipt.applied
    || receipt.noop
    || receipt.scope !== "supervisor_active_job_batch"
    || receipt.resultState !== "paused"
    || receipt.batchProtocolVersion !== 1
    || receipt.resultInputRevision !== state.pauseCohortInputRevision
    || receipt.expectedInputRevision + 1 !== receipt.resultInputRevision
    || receipt.resultInputRevision! > state.inputRevision
    || receipt.affectedJobCount !== state.pauseCohortJobCount
    || receipt.batchDigest !== state.pauseCohortDigest
    || !receipt.affectedJobIds
    || receipt.affectedJobIds.length !== receipt.affectedJobCount
    || canonicalControlJobIds(receipt.affectedJobIds).some((jobId, index) =>
      String(jobId) !== String(receipt.affectedJobIds![index])
    )
  ) {
    return { ok: false, reason: "missing_or_invalid_pause_cohort" };
  }
  const digest = await supervisorControlBatchDigest({
    missionId: receipt.missionId,
    action: "pause",
    requestKey: receipt.requestKey,
    requestDigest: receipt.requestDigest,
    expectedInputRevision: receipt.expectedInputRevision,
    resultInputRevision: receipt.resultInputRevision,
    affectedJobIds: receipt.affectedJobIds,
  });
  if (digest !== receipt.batchDigest) {
    return { ok: false, reason: "missing_or_invalid_pause_cohort" };
  }
  return {
    ok: true,
    receipt,
    affectedJobIds: receipt.affectedJobIds,
  };
}

function wakeTicketFromControlReceipt(
  receipt: MissionSupervisorControl,
): SupervisorWakeTicket | null {
  if (!receipt.wakeRequested) return null;
  if (
    receipt.ticketLeaseVersion === undefined
    || receipt.ticketEpoch === undefined
    || receipt.ticketDecisionSequence === undefined
    || receipt.ticketInputRevision === undefined
  ) {
    throw new Error("Supervisor control receipt has an incomplete wake ticket");
  }
  return {
    protocolVersion: 1,
    missionId: receipt.missionId,
    expectedLeaseVersion: receipt.ticketLeaseVersion,
    expectedEpoch: receipt.ticketEpoch,
    expectedDecisionSequence: receipt.ticketDecisionSequence,
    expectedInputRevision: receipt.ticketInputRevision,
  };
}

function supervisorControlResult(
  receipt: MissionSupervisorControl,
  replayed: boolean,
) {
  return {
    applied: receipt.applied,
    replayed,
    noop: receipt.noop,
    reason: receipt.reason,
    scope: receipt.scope,
    missionId: receipt.missionId,
    action: receipt.action,
    requestDigest: receipt.requestDigest,
    controlReceiptId: receipt._id,
    inputDigest: receipt.inputDigest,
    state: receipt.resultState,
    inputRevision: receipt.resultInputRevision,
    batchProtocolVersion: receipt.batchProtocolVersion,
    affectedJobIds: receipt.affectedJobIds,
    affectedJobCount: receipt.affectedJobCount,
    batchDigest: receipt.batchDigest,
    sourcePauseControlReceiptId: receipt.sourcePauseControlReceiptId,
    wakeTicket: wakeTicketFromControlReceipt(receipt),
  };
}

async function persistSupervisorControl(
  ctx: Pick<MutationCtx, "db">,
  missionId: Id<"missions">,
  request: NormalizedControlRequest,
  outcome: SupervisorControlOutcome,
  now: number,
) {
  const ticket = outcome.wakeTicket ?? null;
  const receiptId = await ctx.db.insert("missionSupervisorControls", {
    protocolVersion: 1,
    missionId,
    requestKey: request.requestKey,
    requestDigest: request.requestDigest,
    action: request.action,
    expectedInputRevision: request.expectedInputRevision,
    inputDigest: request.inputDigest,
    applied: outcome.applied,
    noop: outcome.noop,
    reason: outcome.reason,
    scope: outcome.scope,
    resultState: outcome.resultState,
    resultInputRevision: outcome.resultInputRevision,
    batchProtocolVersion: outcome.batchProtocolVersion,
    affectedJobIds: outcome.affectedJobIds,
    affectedJobCount: outcome.affectedJobCount,
    batchDigest: outcome.batchDigest,
    sourcePauseControlReceiptId: outcome.sourcePauseControlReceiptId,
    wakeRequested: Boolean(ticket),
    ticketLeaseVersion: ticket?.expectedLeaseVersion,
    ticketEpoch: ticket?.expectedEpoch,
    ticketDecisionSequence: ticket?.expectedDecisionSequence,
    ticketInputRevision: ticket?.expectedInputRevision,
    createdAt: now,
  });
  const receipt = await ctx.db.get(receiptId);
  if (!receipt) throw new Error("Supervisor control receipt was not persisted");
  return receipt;
}

async function recordSupervisorControl(
  ctx: Pick<MutationCtx, "db">,
  missionId: Id<"missions">,
  request: NormalizedControlRequest,
  outcome: SupervisorControlOutcome,
  now: number,
) {
  const receipt = await persistSupervisorControl(
    ctx,
    missionId,
    request,
    outcome,
    now,
  );
  return supervisorControlResult(receipt, false);
}

export const startV1 = mutation({
  args: {
    requestKey: v.string(),
    goal: v.string(),
    profile: v.optional(profileValidator),
    context: v.optional(v.string()),
    repo: v.optional(v.string()),
    desiredWorkstreams: v.optional(v.number()),
    requestedWorkstreams: v.optional(v.array(requestedWorkstreamValidator)),
    acceptanceCriteria: v.optional(v.array(v.string())),
    projectAdmissions: v.array(projectSourceAdmissionValidator),
    originThreadId: v.optional(v.string()),
    priority: v.optional(v.number()),
    risk: v.optional(riskValidator),
    deadlineMs: v.optional(v.number()),
    ...dispatcherAuthArgs,
  },
  handler: async (ctx, args) => {
    await requireDispatcher(ctx, args);
    const normalized = normalizedStartRequest(args);
    const requestDigest = await sha256Hex(normalized.requestPayloadJson);
    const idempotencyDigest = await sha256Hex(
      normalized.idempotencyPayloadJson,
    );
    const prior = await ctx.db
      .query("missionSupervisorState")
      .withIndex("by_request", (q) =>
        q.eq("requestKey", normalized.requestKey)
      )
      .take(2);
    if (prior.length > 1) throw new Error("Supervisor request key is not unique");
    if (prior[0]) {
      if (!await validProjectAdmissions(
        normalized.payload.projectAdmissions,
        { requireFresh: false },
      )) {
        throw new Error(
          "Supervisor request replay requires valid canonical project admissions",
        );
      }
      if (
        prior[0].requestDigest
          !== await sha256Hex(prior[0].requestPayloadJson)
      ) {
        throw new Error(
          "Supervisor request replay references invalid persisted authority",
        );
      }
      if (
        prior[0].idempotencyDigest === undefined
          ? prior[0].requestDigest !== requestDigest
          : prior[0].idempotencyDigest !== idempotencyDigest
      ) {
        throw new Error("Supervisor request key conflicts with a different payload");
      }
      if (prior[0].idempotencyDigest === undefined) {
        await ctx.db.patch(prior[0]._id, { idempotencyDigest });
      }
      const mission = await ctx.db.get(prior[0].missionId);
      if (!mission || mission.mode !== "supervised") {
        throw new Error("Supervisor request replay references invalid authority");
      }
      await syncMissionSupervisorCommand(
        ctx,
        mission,
        prior[0],
        prior[0].state === "needs_input"
          && typeof mission.failureReason === "string"
          ? { mode: "set", question: mission.failureReason }
          : { mode: "preserve" },
      );
      return {
        replayed: true,
        missionId: prior[0].missionId,
        stateId: prior[0]._id,
        requestDigest: prior[0].requestDigest,
        deadlineAt: prior[0].deadlineAt,
        wakeTicket: isDue(prior[0], Date.now())
          ? supervisorWakeTicket(prior[0])
          : null,
      };
    }

    if (!await validProjectAdmissions(normalized.payload.projectAdmissions, {
      requireFresh: true,
    })) {
      throw new Error("Supervisor mission requires fresh canonical project admissions");
    }
    const admittedRepositories = new Set(
      normalized.payload.projectAdmissions
        .map((admission) => admission.repository)
        .filter((repository): repository is string => typeof repository === "string"),
    );
    const requestedRepositories = [
      normalized.payload.repo,
      ...normalized.payload.requestedWorkstreams.map((workstream) => workstream.repo),
    ].filter((repository): repository is string => typeof repository === "string");
    if (requestedRepositories.some((repository) => !admittedRepositories.has(repository))) {
      throw new Error("Supervisor request references a repository outside its project admissions");
    }

    const now = Date.now();
    const primaryAdmission = normalized.payload.repo
      ? normalized.payload.projectAdmissions.find((admission) =>
          admission.repository === normalized.payload.repo
        )
      : normalized.payload.projectAdmissions.length === 1
        ? normalized.payload.projectAdmissions[0]
        : undefined;
    const missionId: Id<"missions"> = await insertMissionWithRuntime(ctx, {
      goal: normalized.payload.goal,
      admissionProtocolVersion: 2,
      mode: "supervised",
      status: "running",
      agentCount: 0,
      originThreadId: normalized.payload.originThreadId,
      managerAgentId: "jarvis",
      priority: normalized.payload.priority,
      risk: normalized.payload.risk,
      phase: "supervising",
      percent: 0,
      acceptanceCriteria: normalized.payload.acceptanceCriteria,
      projectAdmissions: normalized.payload.projectAdmissions,
      canonicalProjectId: primaryAdmission?.canonicalProjectId,
      primaryRepo: primaryAdmission?.repository,
      sourceProvider: primaryAdmission?.sourceProvider,
      sourceBranch: primaryAdmission?.sourceBranch,
      sourceRef: primaryAdmission?.sourceRef,
      sourceHeadSha: primaryAdmission?.sourceHeadSha,
      sourceObservedAt: primaryAdmission?.sourceObservedAt,
      sourceAdmissionDigest: primaryAdmission?.sourceAdmissionDigest,
      createdAt: now,
      updatedAt: now,
    });
    const deadlineAt = now + normalized.payload.deadlineMs;
    const initialState = {
      protocolVersion: 1 as const,
      missionId,
      requestKey: normalized.requestKey,
      requestDigest,
      requestPayloadJson: normalized.requestPayloadJson,
      idempotencyDigest,
      state: "ready" as const,
      epoch: 1,
      nextDecisionSequence: 1,
      inputRevision: 1,
      handledInputRevision: 0,
      dirtyJobIds: [],
      nextTickAt: now,
      leaseVersion: 0,
      totalJobs: 0,
      nonterminalJobCount: 0,
      activeJobControlProtocolVersion: 1 as const,
      activeJobControlActions: [
        "pause" as const,
        "resume" as const,
      ],
      maxJobs: MISSION_SUPERVISOR_MAX_JOBS,
      decisionCount: 0,
      maxDecisions: MISSION_SUPERVISOR_MAX_DECISIONS,
      deadlineAt,
      consecutiveFailures: 0,
      createdAt: now,
      updatedAt: now,
    };
    const stateId = await ctx.db.insert("missionSupervisorState", initialState);
    const [mission, state] = await Promise.all([
      ctx.db.get(missionId),
      ctx.db.get(stateId),
    ]);
    if (!mission || !state) {
      throw new Error("Supervisor command projection source was not persisted");
    }
    await syncMissionSupervisorCommand(
      ctx,
      mission,
      state,
      { mode: "clear" },
    );
    return {
      replayed: false,
      missionId,
      stateId,
      requestDigest,
      deadlineAt,
      wakeTicket: supervisorWakeTicket(initialState),
    };
  },
});

export const controlV1 = mutation({
  args: {
    missionId: v.id("missions"),
    requestKey: v.string(),
    action: controlActionValidator,
    expectedInputRevision: v.number(),
    input: v.optional(v.string()),
    ...ownerDispatcherAuthArgs,
  },
  handler: async (ctx, args) => {
    await requireOwnerOrDispatcher(ctx, args);
    const request = await normalizedControlRequest(args);
    const prior = await ctx.db
      .query("missionSupervisorControls")
      .withIndex("by_key", (q) => q.eq("requestKey", request.requestKey))
      .take(2);
    if (prior.length > 1) {
      throw new Error("Supervisor control request key is not unique");
    }
    if (prior[0]) {
      if (
        prior[0].requestDigest !== request.requestDigest
        || String(prior[0].missionId) !== String(args.missionId)
        || prior[0].action !== request.action
      ) {
        throw new Error(
          "Supervisor control request key conflicts with a different payload",
        );
      }
      return supervisorControlResult(prior[0], true);
    }

    const now = Date.now();
    const [state, mission] = await Promise.all([
      stateForMission(ctx, args.missionId),
      ctx.db.get(args.missionId),
    ]);
    const record = async (
      outcome: SupervisorControlOutcome,
    ) => await recordSupervisorControl(
      ctx,
      args.missionId,
      request,
      outcome,
      now,
    );
    const reject = async (
      reason: string,
      options: {
        noop?: boolean;
        state?: MissionSupervisorState;
      } = {},
    ) => await record({
      applied: false,
      noop: options.noop ?? false,
      reason,
      scope: "none",
      resultState: options.state?.state,
      resultInputRevision: options.state?.inputRevision,
      wakeTicket: null,
    });

    if (!state) return await reject("missing_state");
    if (
      !mission
      || mission.mode !== "supervised"
      || mission.admissionProtocolVersion !== 2
    ) {
      return await reject("invalid_mission", { state });
    }
    if (state.inputRevision !== request.expectedInputRevision) {
      return await reject("stale_input_revision", { state });
    }
    const validBounds = [
      state.leaseVersion,
      state.epoch,
      state.nextDecisionSequence,
      state.inputRevision,
    ].every((value) =>
      Number.isSafeInteger(value)
      && value >= 0
      && value < Number.MAX_SAFE_INTEGER
    );
    if (!validBounds) {
      return await reject("invalid_state_bounds", { state });
    }

    const missionMatchesState =
      state.state === "terminal"
        ? ["done", "failed", "cancelled"].includes(mission.status)
        : state.state === "paused"
          ? mission.status === "paused"
          : state.state === "needs_input"
            ? mission.status === "needs_input"
            : mission.status === "running";
    if (!missionMatchesState) {
      return await reject("invalid_mission_state", { state });
    }

    const jobs = await ctx.db
      .query("jobs")
      .withIndex("by_mission", (q) =>
        q.eq("missionId", String(args.missionId))
      )
      .take(MISSION_SUPERVISOR_MAX_JOBS + 1);
    if (jobs.length > MISSION_SUPERVISOR_MAX_JOBS) {
      return await reject("supervisor_job_limit", { state });
    }
    if (state.state === "terminal") {
      if (request.action === "cancel" && mission.status === "cancelled") {
        return await reject("terminal_noop", { noop: true, state });
      }
      return await reject("terminal_state", { state });
    }
    if (jobs.length !== state.totalJobs) {
      return await reject("job_ledger_mismatch", { state });
    }
    const nonterminalJobCount = jobs.filter((job) =>
      !TERMINAL_JOB_STATUSES.has(job.status)
    ).length;
    if (
      state.nonterminalJobCount !== undefined
      && state.nonterminalJobCount !== nonterminalJobCount
    ) {
      return await reject("nonterminal_job_count_mismatch", { state });
    }
    if (
      !["pause", "resume"].includes(request.action)
      && nonterminalJobCount > 0
    ) {
      return await reject("active_jobs_require_batch_control", { state });
    }
    let terminalInputTarget: Doc<"jobs"> | undefined;
    if (request.action === "provide_input" && jobs.length > 0) {
      const [supersessions, inputDecisions] = await Promise.all([
        ctx.db
          .query("missionSupervisorSupersessions")
          .withIndex("by_mission_created", (q) =>
            q.eq("missionId", args.missionId)
          )
          .take(MISSION_SUPERVISOR_MAX_JOBS + 1),
        typeof state.lastDecisionKey === "string"
          ? ctx.db
            .query("missionSupervisorDecisions")
            .withIndex("by_key", (q) =>
              q.eq("decisionKey", state.lastDecisionKey!)
            )
            .take(2)
          : Promise.resolve([]),
      ]);
      if (supersessions.length > MISSION_SUPERVISOR_MAX_JOBS - 1) {
        return await reject("recovery_lineage_too_large", { state });
      }
      const superseded = new Set(
        supersessions.map((edge) => String(edge.predecessorJobId)),
      );
      const inputDecision = inputDecisions.length === 1
        ? inputDecisions[0]
        : undefined;
      const candidate = inputDecision?.kind === "request_input"
        && inputDecision.inputTargetJobId
        && inputDecision.inputTargetReceiptDigest
        ? jobs.find((job) =>
          String(job._id) === String(inputDecision.inputTargetJobId)
        )
        : undefined;
      const terminal = candidate
        && !superseded.has(String(candidate._id))
        ? await exactTerminalWorkReceipt(ctx, candidate)
        : null;
      if (
        candidate
        && terminal
        && terminal.receipt.receiptDigest
          === inputDecision?.inputTargetReceiptDigest
        && ["retryable", "remediable", "needs_input", "operator_stop"].includes(
          terminal.receipt.recoveryDisposition ?? "",
        )
      ) {
        terminalInputTarget = candidate;
      }
    }
    if (
      (request.action === "steer" || request.action === "provide_input")
      && jobs.length > 0
      && !terminalInputTarget
    ) {
      // Planning input is intentionally limited to the zero-job question
      // phase. Existing terminal/error work needs a real revision primitive;
      // waking the current loop would only ask again or fail synthesis.
      return await reject("active_jobs_require_batch_control", { state });
    }

    if (request.action === "pause") {
      if (state.state === "paused") {
        return await reject("already_paused", { noop: true, state });
      }
      if (
        !["ready", "waiting", "leased"].includes(state.state)
        || mission.status !== "running"
      ) {
        return await reject("invalid_transition", { state });
      }
      const preflight = await preflightSupervisorPauseResumeBatch(ctx, {
        missionId: args.missionId,
        action: "pause",
        jobs,
        expectedTotalJobs: state.totalJobs,
      });
      if (!preflight.ok) {
        return await reject(preflight.reason, { state });
      }
      const affectedJobIds = canonicalControlJobIds(
        preflight.plan.control.affectedJobIds,
      );
      if (affectedJobIds.length > 0) {
        const applied = await applySupervisorPauseBatch(
          ctx,
          preflight.plan,
          now,
        );
        if (
          applied.patchedJobIds.length !== affectedJobIds.length
          || new Set(applied.patchedJobIds.map(String)).size
            !== affectedJobIds.length
        ) {
          throw new Error("Supervisor pause batch apply was incomplete");
        }
        await refreshSupervisorJobControlGroups(
          ctx,
          applied.touchedSchedulingGroupKeys,
          now,
        );
      }
      const inputRevision = state.inputRevision + 1;
      const batchDigest = affectedJobIds.length > 0
        ? await supervisorControlBatchDigest({
          missionId: args.missionId,
          action: "pause",
          requestKey: request.requestKey,
          requestDigest: request.requestDigest,
          expectedInputRevision: request.expectedInputRevision,
          resultInputRevision: inputRevision,
          affectedJobIds,
        })
        : undefined;
      const outcome: SupervisorControlOutcome = {
        applied: true,
        noop: false,
        reason: "applied",
        scope: affectedJobIds.length > 0
          ? "supervisor_active_job_batch"
          : "supervisor_only_no_active_jobs",
        resultState: "paused",
        resultInputRevision: inputRevision,
        ...(batchDigest === undefined
          ? {}
          : {
            batchProtocolVersion: 1,
            affectedJobIds,
            affectedJobCount: affectedJobIds.length,
            batchDigest,
          }),
        wakeTicket: null,
      };
      const receipt = await persistSupervisorControl(
        ctx,
        args.missionId,
        request,
        outcome,
        now,
      );
      const statePatch = {
        state: "paused",
        inputRevision,
        ...(affectedJobIds.length > 0
          ? { dirtyJobIds: affectedJobIds }
          : {}),
        nextTickAt: undefined,
        ...clearLease(),
        nonterminalJobCount,
        ...(batchDigest === undefined
          ? {
            pauseCohortProtocolVersion: undefined,
            pauseCohortControlReceiptId: undefined,
            pauseCohortInputRevision: undefined,
            pauseCohortJobCount: undefined,
            pauseCohortDigest: undefined,
          }
          : {
            pauseCohortProtocolVersion: 1 as const,
            pauseCohortControlReceiptId: receipt._id,
            pauseCohortInputRevision: inputRevision,
            pauseCohortJobCount: affectedJobIds.length,
            pauseCohortDigest: batchDigest,
          }),
        updatedAt: now,
      } as const;
      const missionPatch = {
        status: "paused",
        pausedPhase: mission.phase ?? "supervising",
        phase: "paused",
        controlRequested: undefined,
        controlRequestedAt: undefined,
        updatedAt: now,
      };
      await ctx.db.patch(state._id, statePatch);
      await patchMissionWithRuntime(ctx, mission, missionPatch);
      await syncMissionSupervisorCommand(
        ctx,
        { ...mission, ...missionPatch },
        { ...state, ...statePatch },
        { mode: "clear" },
      );
      return supervisorControlResult(receipt, false);
    }

    if (request.action === "resume") {
      if (
        (state.state === "ready"
          || state.state === "waiting"
          || state.state === "leased")
        && mission.status === "running"
      ) {
        return await reject("already_running", { noop: true, state });
      }
      if (state.state !== "paused" || mission.status !== "paused") {
        return await reject("invalid_transition", { state });
      }
      const pauseCohort = await pauseCohortAuthority(ctx, state);
      if (pauseCohort && !pauseCohort.ok) {
        return await reject(pauseCohort.reason, { state });
      }
      const targetJobIds = pauseCohort?.affectedJobIds ?? [];
      const preflight = await preflightSupervisorPauseResumeBatch(ctx, {
        missionId: args.missionId,
        action: "resume",
        jobs,
        expectedTotalJobs: state.totalJobs,
        targetJobIds,
      });
      if (!preflight.ok) {
        return await reject(preflight.reason, { state });
      }
      const affectedJobIds = canonicalControlJobIds(
        preflight.plan.control.affectedJobIds,
      );
      if (affectedJobIds.length > 0) {
        const applied = await applySupervisorResumeBatch(
          ctx,
          preflight.plan,
          now,
        );
        if (
          applied.patchedJobIds.length !== affectedJobIds.length
          || new Set(applied.patchedJobIds.map(String)).size
            !== affectedJobIds.length
        ) {
          throw new Error("Supervisor resume batch apply was incomplete");
        }
        await refreshSupervisorJobControlGroups(
          ctx,
          applied.touchedSchedulingGroupKeys,
          now,
        );
      }
      const inputRevision = state.inputRevision + 1;
      const sourcePauseControlReceiptId = pauseCohort?.receipt._id;
      const batchDigest = sourcePauseControlReceiptId
        ? await supervisorControlBatchDigest({
          missionId: args.missionId,
          action: "resume",
          requestKey: request.requestKey,
          requestDigest: request.requestDigest,
          expectedInputRevision: request.expectedInputRevision,
          resultInputRevision: inputRevision,
          affectedJobIds,
          sourcePauseControlReceiptId,
        })
        : undefined;
      const statePatch = {
        state: "ready",
        inputRevision,
        ...(affectedJobIds.length > 0
          ? { dirtyJobIds: affectedJobIds }
          : {}),
        nextTickAt: now,
        ...clearLease(),
        nonterminalJobCount,
        pauseCohortProtocolVersion: undefined,
        pauseCohortControlReceiptId: undefined,
        pauseCohortInputRevision: undefined,
        pauseCohortJobCount: undefined,
        pauseCohortDigest: undefined,
        updatedAt: now,
      } as const;
      const nextState = { ...state, ...statePatch };
      const missionPatch = {
        status: "running",
        phase: mission.pausedPhase ?? "supervising",
        pausedPhase: undefined,
        controlRequested: undefined,
        controlRequestedAt: undefined,
        updatedAt: now,
      };
      await ctx.db.patch(state._id, statePatch);
      await patchMissionWithRuntime(ctx, mission, missionPatch);
      await syncMissionSupervisorCommand(
        ctx,
        { ...mission, ...missionPatch },
        { ...state, ...statePatch },
        { mode: "clear" },
      );
      return await record({
        applied: true,
        noop: false,
        reason: "applied",
        scope: sourcePauseControlReceiptId
          ? "supervisor_active_job_batch"
          : "supervisor_only_no_active_jobs",
        resultState: "ready",
        resultInputRevision: inputRevision,
        ...(batchDigest === undefined
          ? {}
          : {
            batchProtocolVersion: 1,
            affectedJobIds,
            affectedJobCount: affectedJobIds.length,
            batchDigest,
            sourcePauseControlReceiptId,
          }),
        wakeTicket: supervisorWakeTicket(nextState),
      });
    }

    if (request.action === "cancel") {
      const inputRevision = state.inputRevision + 1;
      const statePatch = {
        state: "terminal",
        inputRevision,
        nextTickAt: undefined,
        ...clearLease(),
        updatedAt: now,
      } as const;
      const missionPatch = {
        status: "cancelled",
        phase: "cancelled",
        pausedPhase: undefined,
        controlRequested: undefined,
        controlRequestedAt: undefined,
        completedAt: now,
        updatedAt: now,
      };
      await ctx.db.patch(state._id, statePatch);
      await patchMissionWithRuntime(ctx, mission, missionPatch);
      await syncMissionSupervisorCommand(
        ctx,
        { ...mission, ...missionPatch },
        { ...state, ...statePatch },
        { mode: "clear" },
      );
      await resolveSupervisorAttention(ctx, args.missionId, now, true);
      return await record({
        applied: true,
        noop: false,
        reason: "applied",
        scope: "supervisor_only_no_active_jobs",
        resultState: "terminal",
        resultInputRevision: inputRevision,
        wakeTicket: null,
      });
    }

    if (request.action === "steer") {
      if (
        !["ready", "waiting", "leased"].includes(state.state)
        || mission.status !== "running"
      ) {
        return await reject("invalid_transition", { state });
      }
      const steerRevision = Number(mission.steerRevision ?? 0) + 1;
      if (!Number.isSafeInteger(steerRevision)) {
        return await reject("invalid_state_bounds", { state });
      }
      const inputRevision = state.inputRevision + 1;
      const nextState = {
        ...state,
        state: "ready" as const,
        inputRevision,
      };
      const statePatch = {
        state: "ready" as const,
        inputRevision,
        dirtyJobIds: [],
        nextTickAt: now,
        ...clearLease(),
        updatedAt: now,
      };
      const missionPatch = {
        steer: request.input,
        steerRevision,
        phase: "planning",
        failureReason: undefined,
        updatedAt: now,
      };
      await ctx.db.patch(state._id, statePatch);
      await patchMissionWithRuntime(ctx, mission, missionPatch);
      await syncMissionSupervisorCommand(
        ctx,
        { ...mission, ...missionPatch },
        { ...state, ...statePatch },
        { mode: "clear" },
      );
      return await record({
        applied: true,
        noop: false,
        reason: "applied",
        scope: "planning_only_zero_jobs",
        resultState: "ready",
        resultInputRevision: inputRevision,
        wakeTicket: supervisorWakeTicket(nextState),
      });
    }

    if (
      state.state !== "needs_input"
      || mission.status !== "needs_input"
    ) {
      return await reject("invalid_transition", { state });
    }
    const steerRevision = Number(mission.steerRevision ?? 0) + 1;
    if (!Number.isSafeInteger(steerRevision)) {
      return await reject("invalid_state_bounds", { state });
    }
    const inputRevision = state.inputRevision + 1;
    const nextState = {
      ...state,
      state: "ready" as const,
      inputRevision,
    };
    const statePatch = {
      state: "ready" as const,
      inputRevision,
      dirtyJobIds: [],
      nextTickAt: now,
      ...clearLease(),
      consecutiveFailures: 0,
      lastErrorCode: undefined,
      lastErrorAt: undefined,
      updatedAt: now,
    };
    const missionPatch = {
      status: "running",
      phase: "planning",
      steer: request.input,
      steerRevision,
      failureReason: undefined,
      updatedAt: now,
    };
    await ctx.db.patch(state._id, statePatch);
    await patchMissionWithRuntime(ctx, mission, missionPatch);
    await syncMissionSupervisorCommand(
      ctx,
      { ...mission, ...missionPatch },
      { ...state, ...statePatch },
      { mode: "clear" },
    );
    await resolveSupervisorAttention(ctx, args.missionId, now, false);
    return await record({
      applied: true,
      noop: false,
      reason: "applied",
      scope: terminalInputTarget
        ? `terminal_leaf_recovery_input:${String(terminalInputTarget._id)}`
        : "planning_only_zero_jobs",
      resultState: "ready",
      resultInputRevision: inputRevision,
      wakeTicket: supervisorWakeTicket(nextState),
    });
  },
});

export const dueV1 = query({
  args: {
    limit: v.optional(v.number()),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    const limit = boundedInteger(
      args.limit,
      "limit",
      1,
      MISSION_SUPERVISOR_MAX_DUE,
      MISSION_SUPERVISOR_MAX_DUE,
    );
    const now = Date.now();
    const [ready, waiting, expired] = await Promise.all([
      ctx.db
        .query("missionSupervisorState")
        .withIndex("by_state_due", (q) =>
          q.eq("state", "ready").gt("nextTickAt", 0).lte("nextTickAt", now)
        )
        .order("asc")
        .take(limit),
      ctx.db
        .query("missionSupervisorState")
        .withIndex("by_state_due", (q) =>
          q.eq("state", "waiting").gt("nextTickAt", 0).lte("nextTickAt", now)
        )
        .order("asc")
        .take(limit),
      ctx.db
        .query("missionSupervisorState")
        .withIndex("by_state_lease", (q) =>
          q.eq("state", "leased").gt("leaseUntil", 0).lte("leaseUntil", now)
        )
        .order("asc")
        .take(limit),
    ]);
    return [...ready, ...waiting, ...expired]
      .sort((left, right) => {
        const leftDue =
          left.state === "leased" ? left.leaseUntil ?? 0 : left.nextTickAt ?? 0;
        const rightDue =
          right.state === "leased" ? right.leaseUntil ?? 0 : right.nextTickAt ?? 0;
        return leftDue - rightDue
          || String(left.missionId).localeCompare(String(right.missionId));
      })
      .slice(0, limit)
      .map((state) => ({
        missionId: state.missionId,
        state: state.state,
        epoch: state.epoch,
        nextDecisionSequence: state.nextDecisionSequence,
        inputRevision: state.inputRevision,
        expectedLeaseVersion: state.leaseVersion,
        nextTickAt: state.nextTickAt,
        leaseUntil: state.leaseUntil,
      }));
  },
});

export const claimV1 = mutation({
  args: {
    missionId: v.id("missions"),
    leaseOwner: v.string(),
    leaseToken: v.string(),
    expectedLeaseVersion: v.number(),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    validateLeaseIdentity(args.leaseOwner, args.leaseToken);
    validFenceInteger(args.expectedLeaseVersion, "expectedLeaseVersion");
    const state = await stateForMission(ctx, args.missionId);
    if (!state) return { claimed: false as const, reason: "missing_state" };
    if (state.leaseVersion !== args.expectedLeaseVersion) {
      return { claimed: false as const, reason: "lease_version_mismatch" };
    }
    const now = Date.now();
    if (!isDue(state, now)) {
      return { claimed: false as const, reason: "not_due" };
    }
    const mission = await ctx.db.get(args.missionId);
    if (!mission || mission.mode !== "supervised") {
      return { claimed: false as const, reason: "invalid_mission" };
    }
    if (mission.status !== "running") {
      return { claimed: false as const, reason: "mission_not_running" };
    }
    if (state.deadlineAt <= now || state.decisionCount >= state.maxDecisions) {
      const code = state.deadlineAt <= now
        ? "supervisor_deadline_reached"
        : "supervisor_decision_limit";
      const detail = state.deadlineAt <= now
        ? "The supervised mission reached its bounded deadline and needs Daniel to continue or stop it."
        : "The supervised mission exhausted its bounded decision budget and needs Daniel to choose the next step.";
      const attentionItemId = await holdMissionForInput(
        ctx,
        state,
        mission,
        code,
        detail,
        state.consecutiveFailures,
        now,
      );
      return {
        claimed: false as const,
        reason: code,
        escalated: true,
        attentionItemId,
      };
    }

    const jobs = await ctx.db
      .query("jobs")
      .withIndex("by_mission", (q) => q.eq("missionId", String(args.missionId)))
      .take(MISSION_SUPERVISOR_MAX_JOBS + 1);
    if (jobs.length > MISSION_SUPERVISOR_MAX_JOBS || jobs.length > state.maxJobs) {
      const attentionItemId = await holdMissionForInput(
        ctx,
        state,
        mission,
        "supervisor_job_limit",
        "The supervised mission contains more jobs than its bounded authority permits.",
        state.consecutiveFailures,
        now,
      );
      return {
        claimed: false as const,
        reason: "supervisor_job_limit",
        escalated: true,
        attentionItemId,
      };
    }

    let snapshotResult;
    try {
      snapshotResult = await authoritativeSnapshot(ctx, mission, state, jobs);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "supervisor_snapshot_too_large") {
        throw error;
      }
      const attentionItemId = await holdMissionForInput(
        ctx,
        state,
        mission,
        "supervisor_snapshot_too_large",
        "The mission snapshot exceeded its bounded supervisor envelope and needs a narrower scope.",
        state.consecutiveFailures,
        now,
      );
      return {
        claimed: false as const,
        reason: "supervisor_snapshot_too_large",
        escalated: true,
        attentionItemId,
      };
    }

    const leaseVersion = state.leaseVersion + 1;
    const leaseUntil = now + MISSION_SUPERVISOR_LEASE_MS;
    const statePatch = {
      state: "leased",
      nextTickAt: undefined,
      leaseOwner: args.leaseOwner,
      leaseToken: args.leaseToken,
      leaseVersion,
      leaseHeartbeatAt: now,
      leaseUntil,
      lastSnapshotDigest: snapshotResult.snapshotDigest,
      updatedAt: now,
    } as const;
    await ctx.db.patch(state._id, statePatch);
    await syncMissionSupervisorCommand(
      ctx,
      mission,
      { ...state, ...statePatch },
      { mode: "clear" },
    );
    return {
      claimed: true as const,
      missionId: args.missionId,
      epoch: state.epoch,
      nextDecisionSequence: state.nextDecisionSequence,
      inputRevision: state.inputRevision,
      leaseVersion,
      leaseUntil,
      snapshot: snapshotResult.snapshot,
      snapshotDigest: snapshotResult.snapshotDigest,
    };
  },
});

const leaseFenceArgs = {
  missionId: v.id("missions"),
  leaseOwner: v.string(),
  leaseToken: v.string(),
  leaseVersion: v.number(),
  expectedEpoch: v.number(),
  expectedDecisionSequence: v.number(),
  expectedInputRevision: v.number(),
  workerToken: v.optional(v.string()),
};

function validateLeaseFenceInput(args: {
  leaseOwner: string;
  leaseToken: string;
  leaseVersion: number;
  expectedEpoch: number;
  expectedDecisionSequence: number;
  expectedInputRevision: number;
}) {
  validateLeaseIdentity(args.leaseOwner, args.leaseToken);
  validFenceInteger(args.leaseVersion, "leaseVersion");
  validFenceInteger(args.expectedEpoch, "expectedEpoch");
  validFenceInteger(args.expectedDecisionSequence, "expectedDecisionSequence");
  validFenceInteger(args.expectedInputRevision, "expectedInputRevision");
}

function leaseFenceMatches(
  state: MissionSupervisorState,
  args: {
    leaseOwner: string;
    leaseToken: string;
    leaseVersion: number;
    expectedEpoch: number;
    expectedDecisionSequence: number;
  },
): boolean {
  return state.state === "leased"
    && state.leaseOwner === args.leaseOwner
    && state.leaseToken === args.leaseToken
    && state.leaseVersion === args.leaseVersion
    && state.epoch === args.expectedEpoch
    && state.nextDecisionSequence === args.expectedDecisionSequence;
}

export const renewV1 = mutation({
  args: leaseFenceArgs,
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    validateLeaseFenceInput(args);
    const state = await stateForMission(ctx, args.missionId);
    if (!state) return { renewed: false as const, reason: "missing_state" };
    if (!leaseFenceMatches(state, args)) {
      return { renewed: false as const, reason: "fence_mismatch" };
    }
    const now = Date.now();
    if (state.inputRevision !== args.expectedInputRevision) {
      const statePatch = {
        state: "ready",
        nextTickAt: now,
        ...clearLease(),
        updatedAt: now,
      } as const;
      await ctx.db.patch(state._id, statePatch);
      const mission = await ctx.db.get(args.missionId);
      if (mission?.mode === "supervised") {
        await syncMissionSupervisorCommand(
          ctx,
          mission,
          { ...state, ...statePatch },
          { mode: "clear" },
        );
      }
      return {
        renewed: false as const,
        reason: "input_revision_changed",
        stale: true,
        released: true,
        inputRevision: state.inputRevision,
      };
    }
    if ((state.leaseUntil ?? 0) <= now) {
      return { renewed: false as const, reason: "lease_expired" };
    }
    if (state.deadlineAt <= now) {
      const statePatch = {
        state: "ready",
        nextTickAt: now,
        ...clearLease(),
        updatedAt: now,
      } as const;
      await ctx.db.patch(state._id, statePatch);
      const mission = await ctx.db.get(args.missionId);
      if (mission?.mode === "supervised") {
        await syncMissionSupervisorCommand(
          ctx,
          mission,
          { ...state, ...statePatch },
          { mode: "clear" },
        );
      }
      return {
        renewed: false as const,
        reason: "deadline_reached",
        stale: true,
        released: true,
        inputRevision: state.inputRevision,
      };
    }
    const leaseUntil = now + MISSION_SUPERVISOR_LEASE_MS;
    await ctx.db.patch(state._id, {
      leaseHeartbeatAt: now,
      leaseUntil,
      updatedAt: now,
    });
    return {
      renewed: true as const,
      leaseVersion: state.leaseVersion,
      leaseUntil,
      inputRevision: state.inputRevision,
    };
  },
});

export const releaseFailureV1 = mutation({
  args: {
    ...leaseFenceArgs,
    errorCode: v.string(),
  },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    validateLeaseFenceInput(args);
    if (!SAFE_ERROR_CODE.test(args.errorCode)) {
      throw new Error("errorCode must be a redacted lower-case code of at most 80 characters");
    }
    const state = await stateForMission(ctx, args.missionId);
    if (!state) return { released: false as const, reason: "missing_state" };
    if (!leaseFenceMatches(state, args)) {
      return { released: false as const, reason: "fence_mismatch" };
    }
    const now = Date.now();
    if (state.inputRevision !== args.expectedInputRevision) {
      const statePatch = {
        state: "ready",
        nextTickAt: now,
        ...clearLease(),
        updatedAt: now,
      } as const;
      await ctx.db.patch(state._id, statePatch);
      const mission = await ctx.db.get(args.missionId);
      if (mission?.mode === "supervised") {
        await syncMissionSupervisorCommand(
          ctx,
          mission,
          { ...state, ...statePatch },
          { mode: "clear" },
        );
      }
      return {
        released: true as const,
        stale: true,
        escalated: false,
        reason: "input_revision_changed",
        inputRevision: state.inputRevision,
      };
    }
    const mission = await ctx.db.get(args.missionId);
    if (!mission || mission.mode !== "supervised") {
      return { released: false as const, reason: "invalid_mission" };
    }
    const failures = state.consecutiveFailures + 1;
    const escalated =
      failures >= FAILURE_ESCALATION_COUNT || state.deadlineAt <= now;
    if (escalated) {
      const detail = state.deadlineAt <= now
        ? `Supervisor stopped at its bounded deadline after ${failures} failure(s) (${args.errorCode}).`
        : `Supervisor paused after ${failures} consecutive bounded failures (${args.errorCode}).`;
      const attentionItemId = await holdMissionForInput(
        ctx,
        state,
        mission,
        args.errorCode,
        detail,
        failures,
        now,
      );
      return {
        released: true as const,
        stale: false,
        escalated: true,
        failures,
        errorCode: args.errorCode,
        attentionItemId,
      };
    }
    const exponent = Math.min(10, Math.max(0, failures - 1));
    const backoffMs = Math.min(
      FAILURE_BACKOFF_MAX_MS,
      FAILURE_BACKOFF_BASE_MS * (2 ** exponent),
    );
    const nextTickAt = now + backoffMs;
    const statePatch = {
      state: "waiting",
      nextTickAt,
      ...clearLease(),
      consecutiveFailures: failures,
      lastErrorCode: args.errorCode,
      lastErrorAt: now,
      updatedAt: now,
    } as const;
    await ctx.db.patch(state._id, statePatch);
    await syncMissionSupervisorCommand(
      ctx,
      mission,
      { ...state, ...statePatch },
      { mode: "clear" },
    );
    return {
      released: true as const,
      stale: false,
      escalated: false,
      failures,
      errorCode: args.errorCode,
      backoffMs,
      nextTickAt,
    };
  },
});

function requireSha256Digest(value: string, field: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${field} must be a lower-case SHA-256 digest`);
  }
  return value;
}

async function postSupervisorNotification(
  ctx: Pick<MutationCtx, "db">,
  mission: Mission,
  decisionKey: string,
  category: string,
  text: string,
  model: string,
  now: number,
) {
  const requestId = `supervisor:${decisionKey}:${category}`;
  return await ctx.db.insert("chatMessages", {
    threadId: mission.originThreadId ?? "main",
    role: "assistant",
    text: truncateUtf8(redactSensitiveText(text), NOTIFICATION_MAX_BYTES),
    status: "done",
    model: truncateUtf8(model, 24),
    requestId: truncateUtf8(requestId, 120),
    delivery: "notification",
    createdAt: now,
  });
}

type NormalizedCommitEnvelope = {
  decision: SupervisorDecisionInput;
  payloadJson: string;
  payloadDigest: string;
  decisionKey: string;
  rationale: string;
  metadata: ReturnType<typeof normalizeCommitMetadata>;
};

async function normalizedCommitEnvelope(args: {
  missionId: Id<"missions">;
  leaseVersion: number;
  expectedEpoch: number;
  expectedDecisionSequence: number;
  expectedInputRevision: number;
  expectedSnapshotDigest: string;
  decision: SupervisorDecisionInput;
  rationale: string;
} & CommitMetadataInput): Promise<NormalizedCommitEnvelope> {
  const decision = normalizeSupervisorDecision(args.decision);
  const metadata = normalizeCommitMetadata(decision, args);
  const rationale = redactedBoundedText(
    args.rationale,
    "rationale",
    1,
    2_000,
  );
  const payloadJson = canonicalJson(decision);
  if (utf8Bytes(payloadJson) > DECISION_PAYLOAD_MAX_BYTES) {
    throw new Error(
      `Canonical decision payload exceeds ${DECISION_PAYLOAD_MAX_BYTES} UTF-8 bytes`,
    );
  }
  const payloadDigest = await sha256Hex(payloadJson);
  const decisionKey = await sha256Hex(canonicalJson({
    protocolVersion: 1,
    missionId: String(args.missionId),
    epoch: args.expectedEpoch,
    sequence: args.expectedDecisionSequence,
    observedInputRevision: args.expectedInputRevision,
    snapshotDigest: args.expectedSnapshotDigest,
    payloadDigest,
  }));
  return {
    decision,
    payloadJson,
    payloadDigest,
    decisionKey,
    rationale,
    metadata,
  };
}

function decisionReceiptMatches(
  receipt: Doc<"missionSupervisorDecisions">,
  args: {
    missionId: Id<"missions">;
    leaseVersion: number;
    expectedEpoch: number;
    expectedDecisionSequence: number;
    expectedInputRevision: number;
    expectedSnapshotDigest: string;
  },
  envelope: NormalizedCommitEnvelope,
) {
  return receipt.missionId === args.missionId
    && receipt.epoch === args.expectedEpoch
    && receipt.sequence === args.expectedDecisionSequence
    && receipt.observedInputRevision === args.expectedInputRevision
    && receipt.snapshotDigest === args.expectedSnapshotDigest
    && receipt.decisionKey === envelope.decisionKey
    && receipt.kind === envelope.decision.kind
    && receipt.payloadJson === envelope.payloadJson
    && receipt.payloadDigest === envelope.payloadDigest;
}

function committedDecisionResult(
  receipt: Doc<"missionSupervisorDecisions">,
  replayed: boolean,
) {
  return {
    committed: true as const,
    replayed,
    decisionId: receipt._id,
    decisionKey: receipt.decisionKey,
    kind: receipt.kind,
    resultState: receipt.resultState,
    nextTickAt: receipt.nextTickAt,
    createdJobIds: receipt.createdJobIds,
    supersessionIds: receipt.supersessionIds ?? [],
    attentionItemId: receipt.attentionItemId,
    chatMessageIds: receipt.chatMessageIds,
  };
}

type RecoveryLineageNode = {
  rootJobId: Id<"jobs">;
  generation: number;
  autonomousRecoveryCount: number;
};

type RecoveryLedger = {
  nodes: Map<string, RecoveryLineageNode>;
  incoming: Map<string, Doc<"missionSupervisorSupersessions">>;
  outgoing: Map<string, Doc<"missionSupervisorSupersessions">>;
  terminalReceipts: Map<
    string,
    Awaited<ReturnType<typeof exactTerminalWorkReceipt>>
  >;
  leaves: Doc<"jobs">[];
};

type RecoveryLedgerResult =
  | { ok: true; ledger: RecoveryLedger }
  | { ok: false; reason: string; jobId?: Id<"jobs"> };

function sameStrings(left: unknown, right: readonly string[]): boolean {
  return Array.isArray(left)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function modelRank(model: unknown): number {
  return ["luna", "terra", "sol"].indexOf(String(model));
}

function riskRank(risk: unknown): number {
  return ["low", "medium", "high", "consequential"].indexOf(String(risk));
}

function supersessionDigestPayload(
  row: Omit<
    Doc<"missionSupervisorSupersessions">,
    "_id" | "_creationTime" | "createdAt" | "supersessionDigest"
  >,
) {
  return {
    protocolVersion: row.protocolVersion,
    supersessionKey: row.supersessionKey,
    missionId: String(row.missionId),
    decisionKey: row.decisionKey,
    decisionOrdinal: row.decisionOrdinal,
    mode: row.mode,
    rootJobId: String(row.rootJobId),
    generation: row.generation,
    autonomousRecoveryCount: row.autonomousRecoveryCount,
    predecessorJobId: String(row.predecessorJobId),
    predecessorAttempt: row.predecessorAttempt,
    predecessorReceiptId: String(row.predecessorReceiptId),
    predecessorReceiptDigest: row.predecessorReceiptDigest,
    successorJobId: String(row.successorJobId),
    successorSchedulingBindingDigest: row.successorSchedulingBindingDigest,
    successorWorkOrderRevisionId: String(row.successorWorkOrderRevisionId),
    successorWorkOrderRevisionDigest: row.successorWorkOrderRevisionDigest,
    successorCanonicalProjectId: row.successorCanonicalProjectId,
    successorRepository: row.successorRepository ?? null,
    successorSourceAdmissionDigest: row.successorSourceAdmissionDigest,
    observedInputRevision: row.observedInputRevision,
    inputControlReceiptId: row.inputControlReceiptId
      ? String(row.inputControlReceiptId)
      : null,
    inputControlRequestDigest: row.inputControlRequestDigest ?? null,
    inputControlDigest: row.inputControlDigest ?? null,
  };
}

export async function supersessionDigest(
  row: Parameters<typeof supersessionDigestPayload>[0],
): Promise<string> {
  return await sha256Hex(canonicalJson(supersessionDigestPayload(row)));
}

function sourceAdmissionMatchesAuthority(
  admission: ProjectSourceAdmission,
  authority: NonNullable<Awaited<ReturnType<typeof readJobSchedulingAuthority>>>,
): boolean {
  const binding = authority.binding;
  return admission.canonicalProjectId === binding.canonicalProjectId
    && admission.repository === binding.projectRepository
    && admission.sourceProvider === binding.sourceProvider
    && admission.sourceBranch === binding.sourceBranch
    && admission.sourceRef === binding.sourceRef
    && admission.sourceHeadSha === binding.sourceHeadSha
    && admission.sourceObservedAt === binding.sourceObservedAt
    && admission.sourceAdmissionDigest === binding.sourceAdmissionDigest;
}

async function exactAppliedInputControl(
  ctx: Pick<MutationCtx, "db">,
  missionId: Id<"missions">,
  predecessorJobId: Id<"jobs">,
  observedInputRevision: number,
  missionInput: unknown,
): Promise<Doc<"missionSupervisorControls"> | null> {
  if (typeof missionInput !== "string" || !missionInput.trim()) return null;
  const inputDigest = await sha256Hex(missionInput);
  const controls = await ctx.db
    .query("missionSupervisorControls")
    .withIndex("by_mission_created", (q) => q.eq("missionId", missionId))
    .order("desc")
    .take(8);
  const exact = controls.filter((control) =>
    control.protocolVersion === 1
    && control.action === "provide_input"
    && control.applied
    && !control.noop
    && control.scope
      === `terminal_leaf_recovery_input:${String(predecessorJobId)}`
    && control.expectedInputRevision + 1 === observedInputRevision
    && control.resultState === "ready"
    && control.resultInputRevision === observedInputRevision
    && control.inputDigest === inputDigest
  );
  return exact.length === 1 ? exact[0] : null;
}

async function validateRecoveryLedger(
  ctx: Pick<MutationCtx, "db">,
  missionId: Id<"missions">,
  jobs: Doc<"jobs">[],
  supersessions: Doc<"missionSupervisorSupersessions">[],
): Promise<RecoveryLedgerResult> {
  // Let the structural pass name a one-edge fork/cycle precisely. Anything
  // denser than one outgoing edge per physical job is impossible even before
  // lineage validation.
  if (supersessions.length > jobs.length) {
    return { ok: false, reason: "recovery_lineage_too_large" };
  }
  const jobsById = new Map(jobs.map((job) => [String(job._id), job]));
  if (jobsById.size !== jobs.length) {
    return { ok: false, reason: "recovery_job_ledger_ambiguous" };
  }
  const incoming = new Map<
    string,
    Doc<"missionSupervisorSupersessions">
  >();
  const outgoing = new Map<
    string,
    Doc<"missionSupervisorSupersessions">
  >();
  const keys = new Set<string>();
  const rootGenerations = new Set<string>();

  for (const job of jobs) {
    if (
      job.missionId !== String(missionId)
      || !Number.isSafeInteger(job.supervisorEpoch)
      || typeof job.supervisorDecisionKey !== "string"
      || !Number.isSafeInteger(job.supervisorJobOrdinal)
    ) {
      return {
        ok: false,
        reason: "recovery_job_provenance_invalid",
        jobId: job._id,
      };
    }
  }

  for (const edge of supersessions) {
    const predecessorKey = String(edge.predecessorJobId);
    const successorKey = String(edge.successorJobId);
    const predecessor = jobsById.get(predecessorKey);
    const successor = jobsById.get(successorKey);
    const rootGeneration = `${String(edge.rootJobId)}:${edge.generation}`;
    if (
      edge.protocolVersion !== 1
      || String(edge.missionId) !== String(missionId)
      || !predecessor
      || !successor
      || predecessorKey === successorKey
      || !Number.isSafeInteger(edge.decisionOrdinal)
      || edge.decisionOrdinal < 0
      || !Number.isSafeInteger(edge.generation)
      || edge.generation < 1
      || edge.generation > MISSION_SUPERVISOR_MAX_RECOVERY_GENERATION
      || !Number.isSafeInteger(edge.autonomousRecoveryCount)
      || edge.autonomousRecoveryCount < 0
      || edge.autonomousRecoveryCount
        > MISSION_SUPERVISOR_MAX_AUTONOMOUS_RECOVERIES
      || keys.has(edge.supersessionKey)
      || rootGenerations.has(rootGeneration)
    ) {
      return {
        ok: false,
        reason: "recovery_lineage_binding_invalid",
        jobId: predecessor?._id ?? successor?._id,
      };
    }
    if (outgoing.has(predecessorKey)) {
      return {
        ok: false,
        reason: "recovery_lineage_fork",
        jobId: predecessor._id,
      };
    }
    if (incoming.has(successorKey)) {
      return {
        ok: false,
        reason: "recovery_lineage_merge",
        jobId: successor._id,
      };
    }
    if (
      successor.supervisorDecisionKey !== edge.decisionKey
      || successor.supervisorJobOrdinal !== edge.decisionOrdinal
      || successor.schedulingBindingDigest
        !== edge.successorSchedulingBindingDigest
      || successor.workOrderRevisionId !== edge.successorWorkOrderRevisionId
      || successor.workOrderRevisionDigest
        !== edge.successorWorkOrderRevisionDigest
      || successor.canonicalProjectId !== edge.successorCanonicalProjectId
      || successor.repo !== edge.successorRepository
      || successor.sourceAdmissionDigest
        !== edge.successorSourceAdmissionDigest
      || edge.supersessionDigest !== await supersessionDigest(edge)
    ) {
      return {
        ok: false,
        reason: "recovery_successor_binding_mismatch",
        jobId: successor._id,
      };
    }
    keys.add(edge.supersessionKey);
    rootGenerations.add(rootGeneration);
    outgoing.set(predecessorKey, edge);
    incoming.set(successorKey, edge);
  }

  const nodes = new Map<string, RecoveryLineageNode>();
  const visiting = new Set<string>();
  const resolve = (jobKey: string): RecoveryLineageNode | null => {
    const resolved = nodes.get(jobKey);
    if (resolved) return resolved;
    if (visiting.has(jobKey)) return null;
    visiting.add(jobKey);
    const edge = incoming.get(jobKey);
    let node: RecoveryLineageNode;
    if (!edge) {
      const job = jobsById.get(jobKey);
      if (!job) return null;
      node = {
        rootJobId: job._id,
        generation: 0,
        autonomousRecoveryCount: 0,
      };
    } else {
      const parent = resolve(String(edge.predecessorJobId));
      if (!parent) return null;
      node = {
        rootJobId: parent.rootJobId,
        generation: parent.generation + 1,
        autonomousRecoveryCount:
          parent.autonomousRecoveryCount
          + (edge.mode === "input_revision" ? 0 : 1),
      };
      if (
        String(edge.rootJobId) !== String(node.rootJobId)
        || edge.generation !== node.generation
        || edge.autonomousRecoveryCount !== node.autonomousRecoveryCount
      ) {
        return null;
      }
    }
    visiting.delete(jobKey);
    nodes.set(jobKey, node);
    return node;
  };
  for (const job of jobs) {
    if (!resolve(String(job._id))) {
      return {
        ok: false,
        reason: "recovery_lineage_cycle_or_cap_reset",
        jobId: job._id,
      };
    }
  }

  const decisions = await ctx.db
    .query("missionSupervisorDecisions")
    .withIndex("by_mission_epoch_sequence", (q) =>
      q.eq("missionId", missionId)
    )
    .take(MISSION_SUPERVISOR_MAX_DECISIONS + 1);
  if (decisions.length > MISSION_SUPERVISOR_MAX_DECISIONS) {
    return { ok: false, reason: "recovery_decision_ledger_too_large" };
  }
  const decisionsByKey = new Map<string, Doc<"missionSupervisorDecisions">>();
  for (const decision of decisions) {
    if (decisionsByKey.has(decision.decisionKey)) {
      return { ok: false, reason: "recovery_decision_ledger_ambiguous" };
    }
    decisionsByKey.set(decision.decisionKey, decision);
  }
  for (const job of jobs) {
    const decision = decisionsByKey.get(job.supervisorDecisionKey!);
    const ordinal = Number(job.supervisorJobOrdinal);
    const edge = incoming.get(String(job._id));
    if (
      !decision
      || decision.epoch !== job.supervisorEpoch
      || ordinal < 0
      || ordinal >= decision.createdJobIds.length
      || String(decision.createdJobIds[ordinal]) !== String(job._id)
      || (edge ? decision.kind !== "recover" : decision.kind !== "delegate")
      || (edge && (
        !decision.supersessionIds
        || ordinal >= decision.supersessionIds.length
        || String(decision.supersessionIds[ordinal]) !== String(edge._id)
      ))
    ) {
      return {
        ok: false,
        reason: "recovery_creation_provenance_mismatch",
        jobId: job._id,
      };
    }
  }

  const terminalReceipts = new Map<
    string,
    Awaited<ReturnType<typeof exactTerminalWorkReceipt>>
  >();
  for (const edge of supersessions) {
    const predecessor = jobsById.get(String(edge.predecessorJobId))!;
    const successor = jobsById.get(String(edge.successorJobId))!;
    const [terminal, predecessorScheduling, successorScheduling, successorOrder] =
      await Promise.all([
        exactTerminalWorkReceipt(ctx, predecessor),
        readJobSchedulingAuthority(ctx, predecessor),
        readJobSchedulingAuthority(ctx, successor),
        readJobWorkOrderAuthority(ctx, successor),
      ]);
    if (
      !terminal
      || !predecessorScheduling
      || !successorScheduling
      || !successorOrder
      || terminal.receipt._id !== edge.predecessorReceiptId
      || terminal.receipt.receiptDigest !== edge.predecessorReceiptDigest
      || terminal.receipt.attempt !== edge.predecessorAttempt
      || predecessorScheduling.binding.canonicalProjectId
        !== successorScheduling.binding.canonicalProjectId
      || predecessorScheduling.binding.projectRepository
        !== successorScheduling.binding.projectRepository
      || predecessorScheduling.binding.sourceAdmissionDigest
        !== successorScheduling.binding.sourceAdmissionDigest
      || successorOrder.digest !== edge.successorWorkOrderRevisionDigest
      || successorScheduling.digest !== edge.successorSchedulingBindingDigest
    ) {
      return {
        ok: false,
        reason: "recovery_receipt_or_authority_mismatch",
        jobId: predecessor._id,
      };
    }
    const disposition = terminal.receipt.recoveryDisposition;
    const decision = decisionsByKey.get(edge.decisionKey);
    if (
      !decision
      || edge.observedInputRevision !== decision.observedInputRevision
    ) {
      return {
        ok: false,
        reason: "recovery_input_fence_mismatch",
        jobId: predecessor._id,
      };
    }
    const inputControl = edge.inputControlReceiptId
      ? await ctx.db.get(edge.inputControlReceiptId)
      : null;
    const inputControlValid = edge.mode === "input_revision"
      ? Boolean(
        inputControl
        && inputControl.missionId === missionId
        && inputControl.action === "provide_input"
        && inputControl.applied
        && !inputControl.noop
        && inputControl.scope
          === `terminal_leaf_recovery_input:${String(predecessor._id)}`
        && inputControl.requestDigest === edge.inputControlRequestDigest
        && inputControl.inputDigest === edge.inputControlDigest
        && inputControl.resultInputRevision === edge.observedInputRevision
        && inputControl.expectedInputRevision + 1
          === edge.observedInputRevision,
      )
      : !edge.inputControlReceiptId
        && !edge.inputControlRequestDigest
        && !edge.inputControlDigest;
    const permitted =
      (edge.mode === "retry" && disposition === "retryable")
      || (edge.mode === "remediate"
        && (disposition === "retryable" || disposition === "remediable"))
      || (edge.mode === "input_revision"
        && ["retryable", "remediable", "needs_input", "operator_stop"].includes(
          disposition ?? "",
        )
        && inputControlValid
        && Number.isSafeInteger(terminal.receipt.observedInputRevision)
        && edge.observedInputRevision
          > Number(terminal.receipt.observedInputRevision));
    if (!permitted) {
      return {
        ok: false,
        reason: "recovery_disposition_mismatch",
        jobId: predecessor._id,
      };
    }
    terminalReceipts.set(String(predecessor._id), terminal);
  }

  return {
    ok: true,
    ledger: {
      nodes,
      incoming,
      outgoing,
      terminalReceipts,
      leaves: jobs.filter((job) => !outgoing.has(String(job._id))),
    },
  };
}

type SynthesisGate =
  | { ok: true; evidence: string[] }
  | { ok: false; reason: string; jobId?: Id<"jobs"> };

async function synthesisEvidence(
  ctx: Pick<MutationCtx, "db">,
  missionId: Id<"missions">,
  jobs: Doc<"jobs">[],
): Promise<SynthesisGate> {
  if (jobs.length === 0) {
    return { ok: false, reason: "synthesis_requires_jobs" };
  }
  const supersessions = await ctx.db
    .query("missionSupervisorSupersessions")
    .withIndex("by_mission_created", (q) => q.eq("missionId", missionId))
    .take(MISSION_SUPERVISOR_MAX_JOBS + 1);
  if (supersessions.length > MISSION_SUPERVISOR_MAX_JOBS - 1) {
    return { ok: false, reason: "recovery_lineage_too_large" };
  }
  const recovery = await validateRecoveryLedger(
    ctx,
    missionId,
    jobs,
    supersessions,
  );
  if (!recovery.ok) return recovery;
  const evidence: string[] = [];
  const leaves = [...recovery.ledger.leaves].sort((left, right) =>
    String(left._id).localeCompare(String(right._id))
  );
  for (const job of leaves) {
    const attempt = Number(job.attempt ?? 1);
    if (
      job.status !== "done"
      || job.verificationVerdict !== "pass"
      || !Number.isSafeInteger(attempt)
      || attempt < 1
      || !Number.isSafeInteger(job.supervisorEpoch)
      || typeof job.supervisorDecisionKey !== "string"
      || !Number.isSafeInteger(job.supervisorJobOrdinal)
    ) {
      return {
        ok: false,
        reason: "synthesis_job_not_verified",
        jobId: job._id,
      };
    }
    const [authority, receipts] = await Promise.all([
      readAttemptExecutionAuthority(ctx, job, attempt),
      ctx.db
        .query("workReceipts")
        .withIndex("by_job_attempt", (q) =>
          q.eq("jobId", job._id).eq("attempt", attempt)
        )
        .take(2),
    ]);
    if (!authority || receipts.length !== 1) {
      return {
        ok: false,
        reason: "synthesis_receipt_missing_or_ambiguous",
        jobId: job._id,
      };
    }
    const receipt = receipts[0];
    const resultDigest = await sha256Hex(String(job.result ?? ""));
    const evidenceDigest = await sha256Hex(String(job.verificationNote ?? ""));
    if (
      receipt.status !== "succeeded"
      || receipt.verification !== "pass"
      || receipt.authorityDigest !== authority.authorityDigest
      || receipt.schedulingBindingDigest !== authority.schedulingBindingDigest
      || receipt.workOrderRevisionId !== authority.workOrderRevisionId
      || receipt.workOrderRevision !== authority.workOrderRevision
      || receipt.workOrderRevisionDigest !== authority.workOrderRevisionDigest
      || receipt.canonicalProjectId !== authority.canonicalProjectId
      || receipt.repository !== authority.repository
      || receipt.resultDigest !== resultDigest
      || receipt.evidenceDigest !== evidenceDigest
      || receipt.acceptanceEvidence.length < 1
      || receipt.protocolVersion !== 2
      || typeof receipt.receiptDigest !== "string"
      || receipt.receiptDigest !== await terminalWorkReceiptDigest(receipt)
    ) {
      return {
        ok: false,
        reason: "synthesis_receipt_binding_mismatch",
        jobId: job._id,
      };
    }
    const label = truncateUtf8(job.label ?? job.task, 80);
    const accepted = truncateUtf8(
      redactSensitiveText(receipt.acceptanceEvidence[0]),
      300,
    );
    evidence.push(
      truncateUtf8(
        `${label} · receipt ${resultDigest.slice(0, 16)} · ${accepted}`,
        500,
      ),
    );
  }
  const recoveries = [...supersessions].sort((left, right) =>
    String(left.rootJobId).localeCompare(String(right.rootJobId))
    || left.generation - right.generation
  );
  for (const edge of recoveries) {
    const predecessor = jobs.find((job) =>
      String(job._id) === String(edge.predecessorJobId)
    );
    const successor = jobs.find((job) =>
      String(job._id) === String(edge.successorJobId)
    );
    if (!predecessor || !successor) {
      return { ok: false, reason: "recovery_lineage_binding_invalid" };
    }
    evidence.push(truncateUtf8(
      `${truncateUtf8(predecessor.label ?? predecessor.task, 70)} · `
        + `${edge.mode} recovery g${edge.generation} · terminal `
        + `${edge.predecessorReceiptDigest.slice(0, 16)} · successor `
        + `${String(successor._id).slice(-12)}`,
      500,
    ));
  }
  return { ok: true, evidence };
}

function boundedSynthesisSummary(summary: string, evidence: readonly string[]) {
  if (evidence.length === 0) {
    return truncateUtf8(summary, SYNTHESIS_SUMMARY_MAX_BYTES);
  }
  const header = "\n\nVerified evidence:\n";
  const evidenceBudget = 3_000;
  const itemBudget = Math.max(
    40,
    Math.floor(
      (evidenceBudget - utf8Bytes(header) - evidence.length * 3)
        / evidence.length,
    ),
  );
  const evidenceBlock = `${header}${evidence
    .map((item) => `- ${truncateUtf8(item, itemBudget)}`)
    .join("\n")}`;
  const summaryBudget = Math.max(
    0,
    SYNTHESIS_SUMMARY_MAX_BYTES - utf8Bytes(evidenceBlock),
  );
  return `${truncateUtf8(summary, summaryBudget)}${evidenceBlock}`;
}

export const commitV1 = mutation({
  args: {
    missionId: v.id("missions"),
    leaseOwner: v.string(),
    leaseToken: v.string(),
    leaseVersion: v.number(),
    expectedEpoch: v.number(),
    expectedDecisionSequence: v.number(),
    expectedInputRevision: v.number(),
    expectedSnapshotDigest: v.string(),
    decision: supervisorDecisionValidator,
    rationale: v.string(),
    decisionOrigin: decisionOriginValidator,
    modelProvider: modelProviderValidator,
    modelTier: modelTierValidator,
    modelId: v.string(),
    reasoningEffort: reasoningEffortValidator,
    tierReason: v.string(),
    supervisorPromptVersion: v.string(),
    triggerRunId: v.string(),
    deploymentVersion: v.optional(v.string()),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    validateLeaseFenceInput(args);
    requireSha256Digest(args.expectedSnapshotDigest, "expectedSnapshotDigest");
    const envelope = await normalizedCommitEnvelope(args);

    // Lost-response replay is resolved from append-only authority before any
    // mutable lease/state read. The original result remains replayable after
    // the mission has advanced, terminalized, or accepted new input.
    const [slotRows, keyRows] = await Promise.all([
      ctx.db
        .query("missionSupervisorDecisions")
        .withIndex("by_mission_epoch_sequence", (q) =>
          q
            .eq("missionId", args.missionId)
            .eq("epoch", args.expectedEpoch)
            .eq("sequence", args.expectedDecisionSequence)
        )
        .take(2),
      ctx.db
        .query("missionSupervisorDecisions")
        .withIndex("by_key", (q) =>
          q.eq("decisionKey", envelope.decisionKey)
        )
        .take(2),
    ]);
    if (slotRows.length > 1 || keyRows.length > 1) {
      throw new Error("Supervisor decision authority is not unique");
    }
    const prior = slotRows[0] ?? keyRows[0];
    if (prior) {
      if (
        slotRows[0]?._id !== prior._id
        || keyRows[0]?._id !== prior._id
        || !decisionReceiptMatches(prior, args, envelope)
      ) {
        throw new Error(
          "Supervisor decision slot conflicts with a different immutable decision",
        );
      }
      return committedDecisionResult(prior, true);
    }

    const state = await stateForMission(ctx, args.missionId);
    if (!state) {
      return {
        committed: false as const,
        replayed: false,
        reason: "missing_state",
      };
    }
    if (!leaseFenceMatches(state, args)) {
      return {
        committed: false as const,
        replayed: false,
        reason: "fence_mismatch",
      };
    }
    if (state.inputRevision !== args.expectedInputRevision) {
      return {
        committed: false as const,
        replayed: false,
        reason: "input_revision_mismatch",
      };
    }
    if (state.lastSnapshotDigest !== args.expectedSnapshotDigest) {
      return {
        committed: false as const,
        replayed: false,
        reason: "snapshot_digest_mismatch",
      };
    }
    const now = Date.now();
    if ((state.leaseUntil ?? 0) <= now) {
      return {
        committed: false as const,
        replayed: false,
        reason: "lease_expired",
      };
    }
    if (state.deadlineAt <= now) {
      return {
        committed: false as const,
        replayed: false,
        reason: "deadline_reached",
      };
    }
    if (
      state.decisionCount >= state.maxDecisions
      || state.decisionCount >= MISSION_SUPERVISOR_MAX_DECISIONS
    ) {
      return {
        committed: false as const,
        replayed: false,
        reason: "decision_limit_reached",
      };
    }
    const mission = await ctx.db.get(args.missionId);
    if (
      !mission
      || mission.mode !== "supervised"
      || mission.status !== "running"
      || mission.admissionProtocolVersion !== 2
    ) {
      return {
        committed: false as const,
        replayed: false,
        reason: "invalid_mission",
      };
    }

    const createdJobIds: Id<"jobs">[] = [];
    const supersessionIds: Id<"missionSupervisorSupersessions">[] = [];
    const chatMessageIds: Id<"chatMessages">[] = [];
    let attentionItemId: Id<"attentionItems"> | undefined;
    let inputTargetJobId: Id<"jobs"> | undefined;
    let inputTargetReceiptDigest: string | undefined;
    let nextTickAt: number | undefined;
    let resultState:
      | "ready"
      | "waiting"
      | "needs_input"
      | "terminal";
    let totalJobs = state.totalJobs;
    let nonterminalJobCount = state.nonterminalJobCount;
    let missionPatch: Record<string, unknown> = { updatedAt: now };

    if (envelope.decision.kind === "delegate") {
      const existingJobs = await ctx.db
        .query("jobs")
        .withIndex("by_mission", (q) =>
          q.eq("missionId", String(args.missionId))
        )
        .take(MISSION_SUPERVISOR_MAX_JOBS + 1);
      if (
        existingJobs.length > MISSION_SUPERVISOR_MAX_JOBS
        || existingJobs.length !== state.totalJobs
      ) {
        return {
          committed: false as const,
          replayed: false,
          reason: "job_ledger_mismatch",
        };
      }
      if (
        existingJobs.length + envelope.decision.workstreams.length
          > Math.min(MISSION_SUPERVISOR_MAX_JOBS, state.maxJobs)
      ) {
        return {
          committed: false as const,
          replayed: false,
          reason: "job_limit_reached",
        };
      }
      const admissions = mission.projectAdmissions ?? [];
      if (!await validProjectAdmissions(admissions)) {
        throw new Error("Supervisor mission project admission ledger is invalid");
      }
      const planned = envelope.decision.workstreams.map((workstream, index) => {
        const repo = workstream.repo ?? mission.primaryRepo;
        const projectAdmission = admissionForRepository(admissions, repo);
        if (!projectAdmission) {
          throw new Error(
            `decision.workstreams[${index}] is outside the mission project admissions`,
          );
        }
        const readonly = Boolean(workstream.readonly || !repo);
        const approval = workApprovalPolicy({
          task: workstream.task,
          repo,
          readonly,
          risk: workstream.risk,
          approvalRequired: workstream.approvalRequired,
        });
        return {
          workstream,
          repo,
          readonly,
          approval,
          projectAdmission,
          ordinal: index,
        };
      });
      const existingWork = new Set(existingJobs.map((job) =>
        delegatedWorkIdentity({
          agentId: job.agentId,
          repo: job.repo,
          task: job.task,
        })
      ));
      const plannedWork = planned.map((item) =>
        delegatedWorkIdentity({
          agentId: item.workstream.agentId,
          repo: item.repo,
          task: item.workstream.task,
        })
      );
      if (
        new Set(plannedWork).size !== plannedWork.length
        || plannedWork.some((fingerprint) => existingWork.has(fingerprint))
      ) {
        throw new Error(
          "delegate.workstreams duplicates existing mission work",
        );
      }
      for (const item of planned) {
        const approvalRequired = item.approval.required;
        const jobId = await insertJobWithRuntime(ctx, {
          admissionProtocolVersion: 2,
          projectAdmission: item.projectAdmission,
          requireFreshSourceAdmission: false,
          missionId: String(args.missionId),
          supervisorEpoch: args.expectedEpoch,
          supervisorDecisionKey: envelope.decisionKey,
          supervisorJobOrdinal: item.ordinal,
          task: item.workstream.task,
          label: item.workstream.label,
          repo: item.repo,
          model: item.workstream.model,
          agentId: item.workstream.agentId,
          readonly: item.readonly,
          approvalRequired,
          approvalReason: item.approval.reason,
          approvalStatus: approvalRequired ? "pending" : undefined,
          deliveryMode: item.approval.deliveryMode,
          risk: approvalRequired ? "consequential" : item.workstream.risk,
          priority: mission.priority ?? 50,
          acceptanceCriteria: item.workstream.acceptanceCriteria,
          dependsOn: [],
          dispatchReady: true,
          originThreadId: mission.originThreadId ?? "main",
          visibility: "conversation",
          status: approvalRequired ? "awaiting_approval" : "pending",
          stage: approvalRequired ? "approval" : "queued",
          percent: 0,
          progressAt: now,
          stallCount: 0,
          steerRevision: 0,
          attempt: 1,
          maxAttempts: 12,
          nextRunAt: now,
          createdAt: now,
        });
        createdJobIds.push(jobId);
        if (approvalRequired) {
          await ctx.db.insert("approvals", {
            jobId: String(jobId),
            kind: "consequential-work",
            summary: item.workstream.label.slice(0, 240),
            risk: "consequential",
            payload: {
              repo: item.repo,
              agentId: item.workstream.agentId,
              reason: item.approval.reason,
            },
            status: "pending",
            requestedAt: now,
          });
        }
      }
      totalJobs = existingJobs.length + createdJobIds.length;
      nonterminalJobCount = existingJobs.filter((job) =>
        !TERMINAL_JOB_STATUSES.has(job.status)
      ).length + createdJobIds.length;
      nextTickAt = now + SUPERVISOR_DELEGATE_RECHECK_MS;
      resultState = "waiting";
      missionPatch = {
        agentCount: totalJobs,
        phase: "executing",
        updatedAt: now,
      };
    } else if (envelope.decision.kind === "recover") {
      const [existingJobs, existingSupersessions] = await Promise.all([
        ctx.db
          .query("jobs")
          .withIndex("by_mission", (q) =>
            q.eq("missionId", String(args.missionId))
          )
          .take(MISSION_SUPERVISOR_MAX_JOBS + 1),
        ctx.db
          .query("missionSupervisorSupersessions")
          .withIndex("by_mission_created", (q) =>
            q.eq("missionId", args.missionId)
          )
          .take(MISSION_SUPERVISOR_MAX_JOBS + 1),
      ]);
      if (
        existingJobs.length > MISSION_SUPERVISOR_MAX_JOBS
        || existingJobs.length !== state.totalJobs
      ) {
        return {
          committed: false as const,
          replayed: false,
          reason: "job_ledger_mismatch",
        };
      }
      if (
        existingJobs.length + envelope.decision.recoveries.length
          > Math.min(MISSION_SUPERVISOR_MAX_JOBS, state.maxJobs)
      ) {
        return {
          committed: false as const,
          replayed: false,
          reason: "job_limit_reached",
        };
      }
      if (existingSupersessions.length > MISSION_SUPERVISOR_MAX_JOBS - 1) {
        return {
          committed: false as const,
          replayed: false,
          reason: "recovery_lineage_too_large",
        };
      }
      const lineage = await validateRecoveryLedger(
        ctx,
        args.missionId,
        existingJobs,
        existingSupersessions,
      );
      if (!lineage.ok) {
        return {
          committed: false as const,
          replayed: false,
          reason: lineage.reason,
          jobId: lineage.jobId,
        };
      }
      const admissions = mission.projectAdmissions ?? [];
      if (!await validProjectAdmissions(admissions)) {
        throw new Error("Supervisor mission project admission ledger is invalid");
      }

      for (
        let ordinal = 0;
        ordinal < envelope.decision.recoveries.length;
        ordinal += 1
      ) {
        const recovery = envelope.decision.recoveries[ordinal];
        const predecessor = existingJobs.find((job) =>
          String(job._id) === String(recovery.predecessorJobId)
        );
        if (!predecessor) {
          throw new Error(
            `decision.recoveries[${ordinal}] is outside the mission job ledger`,
          );
        }
        if (lineage.ledger.outgoing.has(String(predecessor._id))) {
          return {
            committed: false as const,
            replayed: false,
            reason: "recovery_predecessor_not_leaf",
            jobId: predecessor._id,
          };
        }
        const node = lineage.ledger.nodes.get(String(predecessor._id));
        const terminal = await exactTerminalWorkReceipt(ctx, predecessor);
        const [scheduling, workOrder] = await Promise.all([
          readJobSchedulingAuthority(ctx, predecessor),
          readJobWorkOrderAuthority(ctx, predecessor),
        ]);
        if (
          !node
          || !terminal
          || !scheduling
          || !workOrder
          || terminal.receipt.receiptDigest
            !== recovery.predecessorReceiptDigest
        ) {
          return {
            committed: false as const,
            replayed: false,
            reason: "recovery_receipt_or_authority_mismatch",
            jobId: predecessor._id,
          };
        }
        const disposition = terminal.receipt.recoveryDisposition;
        if (
          (recovery.mode === "retry" && disposition !== "retryable")
          || (recovery.mode === "remediate"
            && disposition !== "retryable"
            && disposition !== "remediable")
          || (recovery.mode === "input_revision"
            && !["retryable", "remediable", "needs_input", "operator_stop"]
              .includes(disposition ?? ""))
        ) {
          return {
            committed: false as const,
            replayed: false,
            reason: "recovery_disposition_mismatch",
            jobId: predecessor._id,
          };
        }
        const generation = node.generation + 1;
        const autonomousRecoveryCount =
          node.autonomousRecoveryCount
          + (recovery.mode === "input_revision" ? 0 : 1);
        if (generation > MISSION_SUPERVISOR_MAX_RECOVERY_GENERATION) {
          return {
            committed: false as const,
            replayed: false,
            reason: "recovery_generation_limit_reached",
            jobId: predecessor._id,
          };
        }
        if (
          autonomousRecoveryCount
            > MISSION_SUPERVISOR_MAX_AUTONOMOUS_RECOVERIES
        ) {
          return {
            committed: false as const,
            replayed: false,
            reason: "autonomous_recovery_limit_reached",
            jobId: predecessor._id,
          };
        }
        const projectAdmission = admissionForRepository(
          admissions,
          predecessor.repo,
        );
        if (
          !projectAdmission
          || !sourceAdmissionMatchesAuthority(projectAdmission, scheduling)
        ) {
          return {
            committed: false as const,
            replayed: false,
            reason: "recovery_project_authority_mismatch",
            jobId: predecessor._id,
          };
        }
        const predecessorOrder = workOrder.binding;
        const revised = recovery.mode === "retry" ? null : recovery;
        if (
          revised
          && (
            modelRank(revised.model) < modelRank(predecessorOrder.minimumModel)
            || riskRank(revised.risk) < riskRank(predecessorOrder.risk)
            || predecessorOrder.acceptanceCriteria.some((criterion) =>
              !revised.acceptanceCriteria.includes(criterion)
            )
          )
        ) {
          return {
            committed: false as const,
            replayed: false,
            reason: "recovery_authority_downgrade",
            jobId: predecessor._id,
          };
        }
        const inputControl = recovery.mode === "input_revision"
          ? await exactAppliedInputControl(
            ctx,
            args.missionId,
            predecessor._id,
            args.expectedInputRevision,
            mission.steer,
          )
          : null;
        if (recovery.mode === "input_revision" && !inputControl) {
          return {
            committed: false as const,
            replayed: false,
            reason: "recovery_input_control_missing_or_ambiguous",
            jobId: predecessor._id,
          };
        }
        const task = revised?.task ?? predecessorOrder.executableTask;
        const label = revised?.label
          ?? predecessor.label
          ?? truncateUtf8(predecessorOrder.executableTask, 80);
        const model = revised?.model ?? predecessorOrder.minimumModel;
        const agentId = revised?.agentId ?? predecessorOrder.agentId;
        const risk = revised?.risk as WorkRisk | undefined
          ?? predecessorOrder.risk as WorkRisk;
        const acceptanceCriteria = revised?.acceptanceCriteria
          ?? [...predecessorOrder.acceptanceCriteria];
        const approval = workApprovalPolicy({
          task,
          repo: predecessorOrder.repository,
          readonly: predecessorOrder.readonly,
          risk,
          // Every consequential successor receives a fresh approval; an
          // approval on the predecessor never transfers across job identity.
          approvalRequired: predecessorOrder.approvalRequired,
        });
        const approvalRequired = approval.required;
        const successorId = await insertJobWithRuntime(ctx, {
          admissionProtocolVersion: 2,
          projectAdmission,
          requireFreshSourceAdmission: false,
          missionId: String(args.missionId),
          supervisorEpoch: args.expectedEpoch,
          supervisorDecisionKey: envelope.decisionKey,
          supervisorJobOrdinal: ordinal,
          task,
          policyTask: recovery.mode === "retry"
            ? predecessorOrder.policyTask
            : task,
          label,
          repo: predecessorOrder.repository,
          model,
          reasoningEffort: predecessorOrder.minimumReasoningEffort,
          mcp: [...predecessorOrder.mcpScope],
          agentId,
          readonly: predecessorOrder.readonly,
          approvalRequired,
          approvalReason: approval.reason,
          approvalStatus: approvalRequired ? "pending" : undefined,
          deliveryMode: approval.deliveryMode,
          risk: approvalRequired ? "consequential" : risk,
          priority: predecessor.priority ?? mission.priority ?? 50,
          acceptanceCriteria,
          dependsOn: [],
          dispatchReady: true,
          originThreadId: mission.originThreadId ?? "main",
          visibility: "conversation",
          status: approvalRequired ? "awaiting_approval" : "pending",
          stage: approvalRequired ? "approval" : "queued",
          percent: 0,
          progressAt: now,
          stallCount: 0,
          steerRevision: 0,
          attempt: 1,
          maxAttempts: 4,
          nextRunAt: approvalRequired ? undefined : now,
          createdAt: now,
        });
        const successor = await ctx.db.get(successorId);
        if (!successor) {
          throw new Error("Recovery successor was not persisted");
        }
        const [successorScheduling, successorOrder] = await Promise.all([
          readJobSchedulingAuthority(ctx, successor),
          readJobWorkOrderAuthority(ctx, successor),
        ]);
        if (
          !successorScheduling
          || !successorOrder
          || !sourceAdmissionMatchesAuthority(
            projectAdmission,
            successorScheduling,
          )
        ) {
          throw new Error("Recovery successor authority was not admitted");
        }
        if (recovery.mode === "retry") {
          const clone = successorOrder.binding;
          if (
            clone.executableTask !== predecessorOrder.executableTask
            || clone.policyTask !== predecessorOrder.policyTask
            || !sameStrings(
              clone.acceptanceCriteria,
              predecessorOrder.acceptanceCriteria,
            )
            || clone.readonly !== predecessorOrder.readonly
            || !sameStrings(clone.toolScope, predecessorOrder.toolScope)
            || !sameStrings(clone.mcpScope, predecessorOrder.mcpScope)
            || clone.deliveryPolicy !== predecessorOrder.deliveryPolicy
            || clone.risk !== predecessorOrder.risk
            || clone.approvalRequired !== predecessorOrder.approvalRequired
            || clone.approvalReason !== predecessorOrder.approvalReason
            || clone.agentId !== predecessorOrder.agentId
            || clone.minimumModel !== predecessorOrder.minimumModel
            || clone.minimumReasoningEffort
              !== predecessorOrder.minimumReasoningEffort
          ) {
            throw new Error("Policy retry did not clone immutable work authority");
          }
        }
        const supersessionKey = await sha256Hex(canonicalJson({
          protocolVersion: 1,
          missionId: String(args.missionId),
          decisionKey: envelope.decisionKey,
          decisionOrdinal: ordinal,
          predecessorJobId: String(predecessor._id),
          predecessorReceiptDigest: recovery.predecessorReceiptDigest,
        }));
        const [priorKey, priorPredecessor, priorGeneration] =
          await Promise.all([
            ctx.db
              .query("missionSupervisorSupersessions")
              .withIndex("by_key", (q) =>
                q.eq("supersessionKey", supersessionKey)
              )
              .take(2),
            ctx.db
              .query("missionSupervisorSupersessions")
              .withIndex("by_predecessor", (q) =>
                q.eq("predecessorJobId", predecessor._id)
              )
              .take(2),
            ctx.db
              .query("missionSupervisorSupersessions")
              .withIndex("by_root_generation", (q) =>
                q
                  .eq("rootJobId", node.rootJobId)
                  .eq("generation", generation)
              )
              .take(2),
          ]);
        if (
          priorKey.length
          || priorPredecessor.length
          || priorGeneration.length
        ) {
          throw new Error("Recovery supersession authority conflicts");
        }
        const supersession = {
          protocolVersion: 1 as const,
          supersessionKey,
          missionId: args.missionId,
          decisionKey: envelope.decisionKey,
          decisionOrdinal: ordinal,
          mode: recovery.mode,
          rootJobId: node.rootJobId,
          generation,
          autonomousRecoveryCount,
          predecessorJobId: predecessor._id,
          predecessorAttempt: terminal.receipt.attempt,
          predecessorReceiptId: terminal.receipt._id,
          predecessorReceiptDigest: recovery.predecessorReceiptDigest,
          successorJobId: successorId,
          successorSchedulingBindingDigest: successorScheduling.digest,
          successorWorkOrderRevisionId: successorOrder.row._id,
          successorWorkOrderRevisionDigest: successorOrder.digest,
          successorCanonicalProjectId:
            successorScheduling.binding.canonicalProjectId,
          successorRepository:
            successorScheduling.binding.projectRepository,
          successorSourceAdmissionDigest:
            successorScheduling.binding.sourceAdmissionDigest,
          observedInputRevision: args.expectedInputRevision,
          inputControlReceiptId: inputControl?._id,
          inputControlRequestDigest: inputControl?.requestDigest,
          inputControlDigest: inputControl?.inputDigest,
        };
        const supersessionId = await ctx.db.insert(
          "missionSupervisorSupersessions",
          {
            ...supersession,
            supersessionDigest: await supersessionDigest(supersession),
            createdAt: now,
          },
        );
        createdJobIds.push(successorId);
        supersessionIds.push(supersessionId);
        if (approvalRequired) {
          await ctx.db.insert("approvals", {
            jobId: String(successorId),
            kind: "consequential-work-recovery",
            summary: label.slice(0, 240),
            risk: "consequential",
            payload: {
              repo: predecessorOrder.repository,
              agentId,
              reason: approval.reason,
              predecessorJobId: String(predecessor._id),
            },
            status: "pending",
            requestedAt: now,
          });
        }
      }
      totalJobs = existingJobs.length + createdJobIds.length;
      nonterminalJobCount = existingJobs.filter((job) =>
        !TERMINAL_JOB_STATUSES.has(job.status)
      ).length + createdJobIds.length;
      nextTickAt = now + SUPERVISOR_DELEGATE_RECHECK_MS;
      resultState = "waiting";
      missionPatch = {
        agentCount: totalJobs,
        phase: "executing",
        failureReason: undefined,
        updatedAt: now,
      };
    } else if (envelope.decision.kind === "wait") {
      nextTickAt = now + envelope.decision.delayMs;
      resultState = "waiting";
      missionPatch = { phase: "supervising", updatedAt: now };
    } else if (envelope.decision.kind === "request_input") {
      const [jobs, supersessions] = await Promise.all([
        ctx.db
          .query("jobs")
          .withIndex("by_mission", (q) =>
            q.eq("missionId", String(args.missionId))
          )
          .take(MISSION_SUPERVISOR_MAX_JOBS + 1),
        ctx.db
          .query("missionSupervisorSupersessions")
          .withIndex("by_mission_created", (q) =>
            q.eq("missionId", args.missionId)
          )
          .take(MISSION_SUPERVISOR_MAX_JOBS + 1),
      ]);
      if (
        jobs.length > MISSION_SUPERVISOR_MAX_JOBS
        || jobs.length !== state.totalJobs
      ) {
        return {
          committed: false as const,
          replayed: false,
          reason: "job_ledger_mismatch",
        };
      }
      nonterminalJobCount = jobs.filter((job) =>
        !TERMINAL_JOB_STATUSES.has(job.status)
      ).length;
      if (jobs.length > 0 && !envelope.decision.target) {
        return {
          committed: false as const,
          replayed: false,
          reason: "request_input_target_required",
        };
      }
      if (jobs.length === 0 && envelope.decision.target) {
        return {
          committed: false as const,
          replayed: false,
          reason: "request_input_target_not_allowed",
        };
      }
      if (envelope.decision.target) {
        const decisionTarget = envelope.decision.target;
        const lineage = await validateRecoveryLedger(
          ctx,
          args.missionId,
          jobs,
          supersessions,
        );
        if (!lineage.ok) {
          return {
            committed: false as const,
            replayed: false,
            reason: lineage.reason,
            jobId: lineage.jobId,
          };
        }
        const target = jobs.find((job) =>
          String(job._id)
            === String(decisionTarget.predecessorJobId)
        );
        const terminal = target
          ? await exactTerminalWorkReceipt(ctx, target)
          : null;
        if (
          !target
          || lineage.ledger.outgoing.has(String(target._id))
          || !terminal
          || terminal.receipt.receiptDigest
            !== decisionTarget.predecessorReceiptDigest
          || !["retryable", "remediable", "needs_input", "operator_stop"].includes(
            terminal.receipt.recoveryDisposition ?? "",
          )
        ) {
          return {
            committed: false as const,
            replayed: false,
            reason: "request_input_target_invalid",
            jobId: target?._id,
          };
        }
        inputTargetJobId = target._id;
        inputTargetReceiptDigest = terminal.receipt.receiptDigest;
      }
      attentionItemId = await upsertSupervisorAttention(
        ctx,
        mission,
        "supervisor_request_input",
        state.consecutiveFailures,
        envelope.decision.question,
        now,
      );
      chatMessageIds.push(await postSupervisorNotification(
        ctx,
        mission,
        envelope.decisionKey,
        "request-input",
        `JARVIS needs your input · ${envelope.decision.question}`,
        envelope.metadata.modelId,
        now,
      ));
      resultState = "needs_input";
      missionPatch = {
        status: "needs_input",
        phase: "needs_input",
        failureReason: envelope.decision.question,
        updatedAt: now,
      };
    } else if (envelope.decision.kind === "replan") {
      nextTickAt = now;
      resultState = "ready";
      missionPatch = {
        phase: "planning",
        failureReason: undefined,
        updatedAt: now,
      };
    } else if (envelope.decision.kind === "synthesize") {
      const jobs = await ctx.db
        .query("jobs")
        .withIndex("by_mission", (q) =>
          q.eq("missionId", String(args.missionId))
        )
        .take(MISSION_SUPERVISOR_MAX_JOBS + 1);
      if (
        jobs.length > MISSION_SUPERVISOR_MAX_JOBS
        || jobs.length !== state.totalJobs
      ) {
        return {
          committed: false as const,
          replayed: false,
          reason: "job_ledger_mismatch",
        };
      }
      const gate = await synthesisEvidence(ctx, args.missionId, jobs);
      if (!gate.ok) {
        return {
          committed: false as const,
          replayed: false,
          reason: gate.reason,
          jobId: gate.jobId,
        };
      }
      nonterminalJobCount = jobs.filter((job) =>
        !TERMINAL_JOB_STATUSES.has(job.status)
      ).length;
      const summary = boundedSynthesisSummary(
        envelope.decision.summary,
        gate.evidence,
      );
      chatMessageIds.push(await postSupervisorNotification(
        ctx,
        mission,
        envelope.decisionKey,
        "synthesized",
        `Mission complete · ${mission.goal}\n${summary}`,
        envelope.metadata.modelId,
        now,
      ));
      resultState = "terminal";
      missionPatch = {
        status: "done",
        phase: "done",
        percent: 100,
        summary,
        failureReason: undefined,
        completedAt: now,
        updatedAt: now,
      };
    } else {
      const reason = envelope.decision.reason;
      attentionItemId = await upsertSupervisorAttention(
        ctx,
        mission,
        "supervisor_terminal_failure",
        state.consecutiveFailures,
        reason,
        now,
        {
          fingerprintSuffix: "failed",
          titlePrefix: "Supervisor mission failed",
          severity: "high",
        },
      );
      chatMessageIds.push(await postSupervisorNotification(
        ctx,
        mission,
        envelope.decisionKey,
        "failed",
        `Mission stopped safely · ${mission.goal}\n${reason}`,
        envelope.metadata.modelId,
        now,
      ));
      resultState = "terminal";
      missionPatch = {
        status: "failed",
        phase: "failed",
        failureReason: reason,
        completedAt: now,
        updatedAt: now,
      };
    }

    const decisionId = await ctx.db.insert("missionSupervisorDecisions", {
      protocolVersion: 1,
      missionId: args.missionId,
      epoch: args.expectedEpoch,
      sequence: args.expectedDecisionSequence,
      decisionKey: envelope.decisionKey,
      observedInputRevision: args.expectedInputRevision,
      snapshotDigest: args.expectedSnapshotDigest,
      kind: envelope.decision.kind,
      payloadJson: envelope.payloadJson,
      payloadDigest: envelope.payloadDigest,
      rationale: envelope.rationale,
      decisionOrigin: envelope.metadata.decisionOrigin,
      modelProvider: envelope.metadata.modelProvider,
      modelTier: envelope.metadata.modelTier,
      modelId: envelope.metadata.modelId,
      reasoningEffort: envelope.metadata.reasoningEffort,
      tierReason: envelope.metadata.tierReason,
      supervisorPromptVersion: envelope.metadata.supervisorPromptVersion,
      leaseVersion: args.leaseVersion,
      triggerRunId: envelope.metadata.triggerRunId,
      deploymentVersion: envelope.metadata.deploymentVersion,
      createdJobIds,
      supersessionIds,
      inputTargetJobId,
      inputTargetReceiptDigest,
      attentionItemId,
      chatMessageIds,
      resultState,
      nextTickAt,
      createdAt: now,
    });
    const statePatch = {
      state: resultState,
      epoch: envelope.decision.kind === "replan"
        ? state.epoch + 1
        : state.epoch,
      nextDecisionSequence: state.nextDecisionSequence + 1,
      handledInputRevision: state.inputRevision,
      dirtyJobIds: [],
      nextTickAt,
      ...clearLease(),
      totalJobs,
      ...(nonterminalJobCount === undefined
        ? {}
        : { nonterminalJobCount }),
      decisionCount: state.decisionCount + 1,
      lastDecisionKey: envelope.decisionKey,
      lastDecisionDigest: envelope.payloadDigest,
      lastDecisionAt: now,
      consecutiveFailures: 0,
      lastErrorCode: undefined,
      lastErrorAt: undefined,
      updatedAt: now,
    };
    await ctx.db.patch(state._id, statePatch);
    await patchMissionWithRuntime(ctx, mission, missionPatch);
    await syncMissionSupervisorCommand(
      ctx,
      { ...mission, ...missionPatch } as Mission,
      { ...state, ...statePatch },
      envelope.decision.kind === "request_input"
        ? { mode: "set", question: envelope.decision.question }
        : { mode: "clear" },
      envelope.decision.kind === "request_input"
        ? Boolean(envelope.decision.target)
        : false,
    );
    const receipt = await ctx.db.get(decisionId);
    if (!receipt) throw new Error("Supervisor decision receipt was not persisted");
    return committedDecisionResult(receipt, false);
  },
});
