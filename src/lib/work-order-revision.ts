import { normalizeWorkModelTier, type WorkModelTier } from "./work-models";
import { SCOPED_TEAM_MANIFEST } from "./workflow-contract";

export const WORK_ORDER_REVISION_PROTOCOL_VERSION = 1;
export const WORK_ORDER_MACHINE_RUNTIME = "node-22:codex-0.144.5";
export const WORK_ORDER_MACHINE_TEMPLATE = "node22-codex-0.144.5";
export const WORK_ORDER_MACHINE_CLASS = `${WORK_ORDER_MACHINE_RUNTIME}/${WORK_ORDER_MACHINE_TEMPLATE}/2cpu-4096mb`;

export const WORK_ORDER_MCP_ALLOWLIST = Object.freeze(["browserbase", "context7", "playwright"] as const);
export const WORK_ORDER_READ_TOOLS = Object.freeze([
  "repository_exec",
  "repository_read_file",
  "repository_list_files",
] as const);
export const WORK_ORDER_WRITE_TOOLS = Object.freeze([
  ...WORK_ORDER_READ_TOOLS,
  "repository_write_file",
] as const);

export type WorkOrderRevisionBinding = Readonly<{
  protocolVersion: typeof WORK_ORDER_REVISION_PROTOCOL_VERSION;
  jobId: string;
  revision: number;
  parentRevisionId?: string;
  parentRevisionDigest?: string;
  executableTask: string;
  policyTask: string;
  steeringInstruction?: string;
  acceptanceCriteria: readonly string[];
  schedulingBindingDigest: string;
  canonicalProjectId: string;
  repository?: string;
  sourceProvider: "github" | "none";
  sourceBranch?: string;
  sourceRef?: string;
  sourceHeadSha?: string;
  sourceObservedAt: number;
  sourceAdmissionDigest: string;
  readonly: boolean;
  toolScope: readonly string[];
  mcpScope: readonly string[];
  deliveryPolicy: string;
  risk: string;
  approvalRequired: boolean;
  approvalReason?: string;
  approvalResult: "human_gate_required" | "autonomous";
  agentId: string;
  agentRole: string;
  minimumModel: WorkModelTier;
  minimumReasoningEffort: "low" | "medium" | "high" | "max";
  machineClass: typeof WORK_ORDER_MACHINE_CLASS;
}>;

const effortOrder = ["low", "medium", "high", "max"] as const;
const defaultEffort: Record<WorkModelTier, (typeof effortOrder)[number]> = {
  luna: "low",
  terra: "medium",
  sol: "max",
};

function stringArray(value: unknown, limit: number, itemLimit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, limit).map((item) => String(item).trim().slice(0, itemLimit)).filter(Boolean);
}

function exactArray(left: unknown, right: readonly string[]): boolean {
  return Array.isArray(left)
    && left.length === right.length
    && left.every((item, index) => item === right[index]);
}

export function normalizeWorkOrderAcceptanceCriteria(value: unknown): string[] {
  const criteria = stringArray(value, 10, 500);
  return criteria.length ? criteria : ["Deliver the requested outcome with concrete evidence"];
}

export function normalizeWorkOrderMcpScope(value: unknown): string[] {
  const names = [...new Set(stringArray(value, WORK_ORDER_MCP_ALLOWLIST.length, 32))].sort();
  if (names.some((name) => !(WORK_ORDER_MCP_ALLOWLIST as readonly string[]).includes(name))) {
    throw new Error("Work-order MCP scope contains an unsupported capability");
  }
  return names;
}

export function workOrderToolScope(readonly: boolean): string[] {
  return [...(readonly ? WORK_ORDER_READ_TOOLS : WORK_ORDER_WRITE_TOOLS)];
}

export function normalizeWorkOrderToolScope(value: unknown, readonly: boolean): string[] {
  const allowed = workOrderToolScope(readonly);
  if (value === undefined) return allowed;
  const names = [...new Set(stringArray(value, allowed.length, 64))];
  if (!names.length || names.some((name) => !allowed.includes(name))) {
    throw new Error("Work-order tool scope exceeds the admitted cloud capability set");
  }
  return names;
}

export function normalizeMinimumReasoningEffort(
  value: unknown,
  model: WorkModelTier,
): WorkOrderRevisionBinding["minimumReasoningEffort"] {
  const supplied = effortOrder.includes(value as (typeof effortOrder)[number])
    ? value as (typeof effortOrder)[number]
    : defaultEffort[model];
  return effortOrder[Math.max(effortOrder.indexOf(defaultEffort[model]), effortOrder.indexOf(supplied))];
}

export function workOrderAgent(agentId: unknown): { agentId: string; agentRole: string; defaultModel: WorkModelTier } | null {
  const id = String(agentId ?? "").trim();
  const agent = SCOPED_TEAM_MANIFEST.agents.find((candidate) => candidate.slug === id && candidate.slug !== "jarvis");
  return agent ? { agentId: agent.slug, agentRole: agent.role, defaultModel: agent.defaultModel } : null;
}

export function workOrderRevisionForJob(
  job: Record<string, unknown>,
  lineage: {
    revision: number;
    parentRevisionId?: unknown;
    parentRevisionDigest?: unknown;
  },
): WorkOrderRevisionBinding | null {
  const jobId = String(job.jobId ?? job._id ?? "").trim();
  const revision = Math.floor(lineage.revision);
  const agent = workOrderAgent(job.agentId);
  const minimumModel = normalizeWorkModelTier(job.model, agent?.defaultModel ?? "terra");
  const readonly = Boolean(job.readonly || !job.repo);
  const sourceProvider = job.sourceProvider === "github" ? "github" : job.sourceProvider === "none" ? "none" : null;
  const executableTask = typeof job.task === "string" ? job.task : "";
  const policyTask = typeof job.policyTask === "string" ? job.policyTask : executableTask;
  const schedulingBindingDigest = typeof job.schedulingBindingDigest === "string" ? job.schedulingBindingDigest : "";
  const canonicalProjectId = typeof job.canonicalProjectId === "string" ? job.canonicalProjectId : "";
  const sourceObservedAt = Number(job.sourceObservedAt);
  const sourceAdmissionDigest = typeof job.sourceAdmissionDigest === "string" ? job.sourceAdmissionDigest : "";
  if (!jobId || revision < 1 || !agent || !sourceProvider || !executableTask || !policyTask
    || !/^[0-9a-f]{64}$/.test(schedulingBindingDigest) || !canonicalProjectId
    || !Number.isSafeInteger(sourceObservedAt) || sourceObservedAt <= 0
    || !/^[0-9a-f]{64}$/.test(sourceAdmissionDigest)) return null;
  const parentRevisionId = lineage.parentRevisionId === undefined ? undefined : String(lineage.parentRevisionId);
  const parentRevisionDigest = lineage.parentRevisionDigest === undefined ? undefined : String(lineage.parentRevisionDigest);
  if (revision === 1 ? parentRevisionId !== undefined || parentRevisionDigest !== undefined
    : !parentRevisionId || !/^[0-9a-f]{64}$/.test(parentRevisionDigest ?? "")) return null;
  let mcpScope: string[];
  let toolScope: string[];
  try {
    mcpScope = normalizeWorkOrderMcpScope(job.mcp);
    toolScope = normalizeWorkOrderToolScope(job.toolScope, readonly);
  } catch { return null; }
  const repository = typeof job.repo === "string" && job.repo ? job.repo : undefined;
  const sourceBranch = typeof job.sourceBranch === "string" && job.sourceBranch ? job.sourceBranch : undefined;
  const sourceRef = typeof job.sourceRef === "string" && job.sourceRef ? job.sourceRef : undefined;
  const sourceHeadSha = typeof job.sourceHeadSha === "string" && job.sourceHeadSha ? job.sourceHeadSha : undefined;
  if (repository
    ? sourceProvider !== "github" || !sourceBranch || !sourceRef || !sourceHeadSha
    : sourceProvider !== "none" || sourceBranch || sourceRef || sourceHeadSha) return null;
  return {
    protocolVersion: WORK_ORDER_REVISION_PROTOCOL_VERSION,
    jobId,
    revision,
    parentRevisionId,
    parentRevisionDigest,
    executableTask,
    policyTask,
    steeringInstruction: typeof job.steer === "string" && job.steer.trim() ? job.steer : undefined,
    acceptanceCriteria: normalizeWorkOrderAcceptanceCriteria(job.acceptanceCriteria),
    schedulingBindingDigest,
    canonicalProjectId,
    repository,
    sourceProvider,
    sourceBranch,
    sourceRef,
    sourceHeadSha,
    sourceObservedAt,
    sourceAdmissionDigest,
    readonly,
    toolScope,
    mcpScope,
    deliveryPolicy: String(job.deliveryMode ?? (readonly ? "read_only" : "manual")),
    risk: String(job.risk ?? "low"),
    approvalRequired: job.approvalRequired === true,
    approvalReason: typeof job.approvalReason === "string" && job.approvalReason ? job.approvalReason : undefined,
    approvalResult: job.approvalRequired === true ? "human_gate_required" : "autonomous",
    agentId: agent.agentId,
    agentRole: typeof job.agentRole === "string" && job.agentRole ? job.agentRole : agent.agentRole,
    minimumModel,
    minimumReasoningEffort: normalizeMinimumReasoningEffort(job.reasoningEffort, minimumModel),
    machineClass: WORK_ORDER_MACHINE_CLASS,
  };
}

export function canonicalWorkOrderRevision(binding: WorkOrderRevisionBinding): string {
  return JSON.stringify({
    protocolVersion: binding.protocolVersion,
    jobId: binding.jobId,
    revision: binding.revision,
    parentRevisionId: binding.parentRevisionId ?? null,
    parentRevisionDigest: binding.parentRevisionDigest ?? null,
    executableTask: binding.executableTask,
    policyTask: binding.policyTask,
    steeringInstruction: binding.steeringInstruction ?? null,
    acceptanceCriteria: binding.acceptanceCriteria,
    schedulingBindingDigest: binding.schedulingBindingDigest,
    canonicalProjectId: binding.canonicalProjectId,
    repository: binding.repository ?? null,
    sourceProvider: binding.sourceProvider,
    sourceBranch: binding.sourceBranch ?? null,
    sourceRef: binding.sourceRef ?? null,
    sourceHeadSha: binding.sourceHeadSha ?? null,
    sourceObservedAt: binding.sourceObservedAt,
    sourceAdmissionDigest: binding.sourceAdmissionDigest,
    readonly: binding.readonly,
    toolScope: binding.toolScope,
    mcpScope: binding.mcpScope,
    deliveryPolicy: binding.deliveryPolicy,
    risk: binding.risk,
    approvalRequired: binding.approvalRequired,
    approvalReason: binding.approvalReason ?? null,
    approvalResult: binding.approvalResult,
    agentId: binding.agentId,
    agentRole: binding.agentRole,
    minimumModel: binding.minimumModel,
    minimumReasoningEffort: binding.minimumReasoningEffort,
    machineClass: binding.machineClass,
  });
}

export function workOrderRevisionRowBinding(row: Record<string, unknown>): WorkOrderRevisionBinding | null {
  if (Number(row.protocolVersion) !== WORK_ORDER_REVISION_PROTOCOL_VERSION) return null;
  const binding = {
    protocolVersion: WORK_ORDER_REVISION_PROTOCOL_VERSION,
    jobId: String(row.jobId ?? ""),
    revision: Number(row.revision),
    parentRevisionId: row.parentRevisionId === undefined ? undefined : String(row.parentRevisionId),
    parentRevisionDigest: row.parentRevisionDigest === undefined ? undefined : String(row.parentRevisionDigest),
    executableTask: row.executableTask,
    policyTask: row.policyTask,
    steeringInstruction: row.steeringInstruction,
    acceptanceCriteria: row.acceptanceCriteria,
    schedulingBindingDigest: row.schedulingBindingDigest,
    canonicalProjectId: row.canonicalProjectId,
    repository: row.repository,
    sourceProvider: row.sourceProvider,
    sourceBranch: row.sourceBranch,
    sourceRef: row.sourceRef,
    sourceHeadSha: row.sourceHeadSha,
    sourceObservedAt: row.sourceObservedAt,
    sourceAdmissionDigest: row.sourceAdmissionDigest,
    readonly: row.readonly,
    toolScope: row.toolScope,
    mcpScope: row.mcpScope,
    deliveryPolicy: row.deliveryPolicy,
    risk: row.risk,
    approvalRequired: row.approvalRequired,
    approvalReason: row.approvalReason,
    approvalResult: row.approvalResult,
    agentId: row.agentId,
    agentRole: row.agentRole,
    minimumModel: row.minimumModel,
    minimumReasoningEffort: row.minimumReasoningEffort,
    machineClass: row.machineClass,
  } as WorkOrderRevisionBinding;
  if (!Number.isSafeInteger(binding.revision) || binding.revision < 1
    || typeof binding.executableTask !== "string" || typeof binding.policyTask !== "string"
    || !Array.isArray(binding.acceptanceCriteria) || !Array.isArray(binding.toolScope) || !Array.isArray(binding.mcpScope)
    || !workOrderAgent(binding.agentId)
    || !["human_gate_required", "autonomous"].includes(binding.approvalResult)
    || binding.machineClass !== WORK_ORDER_MACHINE_CLASS) return null;
  return binding;
}

export function workOrderProjectionMatches(job: Record<string, unknown>, binding: WorkOrderRevisionBinding): boolean {
  return String(job.jobId ?? job._id ?? "") === binding.jobId
    && job.task === binding.executableTask
    && (job.policyTask ?? job.task) === binding.policyTask
    && (typeof job.steer === "string" && job.steer.trim() ? job.steer : undefined) === binding.steeringInstruction
    && exactArray(job.acceptanceCriteria, binding.acceptanceCriteria)
    && job.schedulingBindingDigest === binding.schedulingBindingDigest
    && job.canonicalProjectId === binding.canonicalProjectId
    && job.repo === binding.repository
    && job.projectRepository === binding.repository
    && job.sourceProvider === binding.sourceProvider
    && job.sourceBranch === binding.sourceBranch
    && job.sourceRef === binding.sourceRef
    && job.sourceHeadSha === binding.sourceHeadSha
    && job.sourceObservedAt === binding.sourceObservedAt
    && job.sourceAdmissionDigest === binding.sourceAdmissionDigest
    && Boolean(job.readonly || !job.repo) === binding.readonly
    && exactArray(job.toolScope, binding.toolScope)
    && exactArray(job.mcp, binding.mcpScope)
    && job.deliveryMode === binding.deliveryPolicy
    && String(job.risk ?? "low") === binding.risk
    && (job.approvalRequired === true) === binding.approvalRequired
    && job.approvalReason === binding.approvalReason
    && job.agentId === binding.agentId
    && job.agentRole === binding.agentRole
    && job.model === binding.minimumModel
    && job.reasoningEffort === binding.minimumReasoningEffort
    && job.machineClass === binding.machineClass;
}
