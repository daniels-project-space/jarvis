import type { ProjectSourceAdmission } from "./source-admission";
import { sha256Hex } from "./source-admission";
import {
  normalizeToolInvocationContext,
  type ToolInvocationContext,
} from "./tool-invocation-context";
import { canonicalizeRepository } from "./workflow-contract";
import {
  normalizeWorkstream,
  type ManagedWorkstream,
} from "../mastra/supervisor-routing";
import { routeWork } from "../mastra/routing";

export const MISSION_SUPERVISOR_ROLLOUT_ENV =
  "JARVIS_MISSION_SUPERVISOR_ROLLOUT";
export const MISSION_SUPERVISOR_CANARY_ALLOWLIST_ENV =
  "JARVIS_MISSION_SUPERVISOR_CANARY_ALLOWLIST";

export type MissionSupervisorRolloutMode =
  | "dormant"
  | "canary"
  | "active"
  | "rollback";

export type MissionSupervisorInvocationIdentity = Readonly<{
  kind: "requestId" | "userMessageId";
  value: string;
}>;

export type MissionSupervisorRequestedWorkstream = Readonly<{
  task: string;
  label?: string;
  repo?: string;
  model?: string;
  agentId?: string;
  readonly?: boolean;
  approvalRequired?: boolean;
  risk?: string;
  acceptanceCriteria?: string[];
}>;

export type MissionSupervisorStartPayload = Readonly<{
  authTokenHash?: string;
  requestKey: string;
  goal: string;
  profile: "short_fleet";
  context?: string;
  repo?: string;
  desiredWorkstreams: number;
  requestedWorkstreams: Array<{
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
  acceptanceCriteria: string[];
  projectAdmissions: ProjectSourceAdmission[];
  originThreadId: string;
  priority: number;
  risk: "low" | "medium" | "high" | "consequential";
}>;

export type SupervisedOrchestrationInput = Readonly<{
  mission: string;
  primaryRepo?: string;
  context?: string;
  acceptanceCriteria?: string[];
  requestedWorkstreams?: readonly MissionSupervisorRequestedWorkstream[];
  invocationContext?: ToolInvocationContext;
  authTokenHash?: string;
}>;

export interface SupervisedOrchestrationDependencies {
  getOriginThreadId(): Promise<string>;
  resolveProjectAdmissions(
    repositories: readonly (string | undefined)[],
  ): Promise<ProjectSourceAdmission[]>;
  mutate(path: string, payload: MissionSupervisorStartPayload): Promise<unknown>;
  dispatchWakeTicket(wakeTicket: unknown): Promise<unknown>;
}

export type SupervisedOrchestrationResult = Readonly<{
  mode: "active" | "canary";
  missionId: string;
  replayed: boolean;
  requestKey: string;
  requestedWorkstreams: number;
  wakeDispatched: boolean;
  dispatch: unknown;
}>;

const CANARY_ALLOWLIST_MAX_ENTRIES = 100;
const THREAD_ID_MAX_LENGTH = 120;
const RISK_ORDER = {
  low: 0,
  medium: 1,
  high: 2,
  consequential: 3,
} as const;

function boundedText(value: string | undefined, maximum: number): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, maximum) : undefined;
}

function boundedCriteria(value: readonly string[] | undefined): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value ?? []) {
    const normalized = String(item).trim().slice(0, 500);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length === 8) break;
  }
  return result;
}

function canonicalRepository(
  value: string | undefined,
  field: string,
): string | undefined {
  if (value === undefined) return undefined;
  const repository = canonicalizeRepository(value, { allowShortName: true });
  if (!repository) throw new Error(`${field} is not a canonical JARVIS project`);
  return repository;
}

function normalizedOriginThreadId(value: string): string {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > THREAD_ID_MAX_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new Error("Supervised orchestrate requires a valid origin thread");
  }
  return normalized;
}

function invocationIdentities(
  value: ToolInvocationContext | undefined,
): MissionSupervisorInvocationIdentity[] {
  const context = normalizeToolInvocationContext(value, {
    allowUserMessageId: true,
  });
  if (!context) return [];
  return [
    ...(context.userMessageId
      ? [{ kind: "userMessageId" as const, value: context.userMessageId }]
      : []),
    ...(context.requestId
      ? [{ kind: "requestId" as const, value: context.requestId }]
      : []),
  ];
}

function identityToken(identity: MissionSupervisorInvocationIdentity): string {
  return `${identity.kind}:${identity.value}`;
}

function canaryAllowlist(value: string | undefined): ReadonlySet<string> | null {
  if (value === undefined) return new Set();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length > CANARY_ALLOWLIST_MAX_ENTRIES
  ) {
    return null;
  }
  const entries = new Set<string>();
  for (const item of parsed) {
    if (typeof item !== "string") return null;
    const separator = item.indexOf(":");
    const kind = item.slice(0, separator);
    const identityValue = item.slice(separator + 1);
    if (
      separator < 1 ||
      (kind !== "requestId" && kind !== "userMessageId") ||
      !identityValue ||
      identityValue.length > 120 ||
      identityValue !== identityValue.trim() ||
      /[\u0000-\u001f\u007f]/u.test(identityValue)
    ) {
      return null;
    }
    entries.add(item);
  }
  return entries;
}

export function missionSupervisorRolloutMode(
  value: string | undefined = process.env[MISSION_SUPERVISOR_ROLLOUT_ENV],
): MissionSupervisorRolloutMode {
  switch (value) {
    case "dormant":
    case "canary":
    case "active":
    case "rollback":
      return value;
    default:
      return "dormant";
  }
}

export function selectMissionSupervisorRollout(
  invocationContext: ToolInvocationContext | undefined,
  options: Readonly<{
    rollout?: string;
    canaryAllowlist?: string;
  }> = {},
):
  | Readonly<{ supervised: false; mode: "dormant" | "canary" | "rollback" }>
  | Readonly<{
      supervised: true;
      mode: "active" | "canary";
      identity: MissionSupervisorInvocationIdentity;
    }> {
  const mode = missionSupervisorRolloutMode(
    options.rollout ?? process.env[MISSION_SUPERVISOR_ROLLOUT_ENV],
  );
  if (mode === "dormant" || mode === "rollback") {
    return { supervised: false, mode };
  }

  const identities = invocationIdentities(invocationContext);
  if (mode === "active") {
    const identity = identities[0];
    if (!identity) {
      throw new Error(
        "Supervised orchestrate requires a durable requestId or userMessageId",
      );
    }
    return { supervised: true, mode, identity };
  }

  const allowlist = canaryAllowlist(
    options.canaryAllowlist ??
      process.env[MISSION_SUPERVISOR_CANARY_ALLOWLIST_ENV],
  );
  if (!allowlist) return { supervised: false, mode };
  const identity = identities.find((candidate) =>
    allowlist.has(identityToken(candidate)),
  );
  return identity
    ? { supervised: true, mode, identity }
    : { supervised: false, mode };
}

export async function missionSupervisorRequestKey(
  identity: MissionSupervisorInvocationIdentity,
  originThreadId: string,
): Promise<string> {
  const thread = normalizedOriginThreadId(originThreadId);
  const normalizedIdentity = invocationIdentities({
    [identity.kind]: identity.value,
  })[0];
  if (!normalizedIdentity || normalizedIdentity.kind !== identity.kind) {
    throw new Error("Supervised orchestrate requires a valid durable identity");
  }
  const digest = await sha256Hex(JSON.stringify({
    protocolVersion: 1,
    tool: "orchestrate",
    identityKind: normalizedIdentity.kind,
    identityValue: normalizedIdentity.value,
    originThreadId: thread,
  }));
  return `orchestrate-v1:${digest}`;
}

function requestedWorkstreamPayload(
  workstream: ManagedWorkstream,
): MissionSupervisorStartPayload["requestedWorkstreams"][number] {
  return {
    task: workstream.task,
    label: workstream.label,
    ...(workstream.repo ? { repo: workstream.repo } : {}),
    model: workstream.model,
    agentId: workstream.agentId,
    readonly:
      workstream.readonly ||
      workstream.approvalRequired ||
      workstream.repo === null,
    approvalRequired: workstream.approvalRequired,
    risk: workstream.approvalRequired
      ? "consequential"
      : workstream.risk,
    acceptanceCriteria: workstream.acceptanceCriteria,
  };
}

function routedWorkstreams(
  workstreams: readonly MissionSupervisorRequestedWorkstream[],
  primaryRepo: string | undefined,
): MissionSupervisorStartPayload["requestedWorkstreams"] {
  if (workstreams.length > 6) {
    throw new Error("Supervised orchestrate accepts at most 6 workstreams");
  }
  return workstreams.map((candidate, index) => {
    const task = boundedText(candidate.task, 4_000);
    if (!task || task.length < 12) {
      throw new Error(
        `Supervised orchestrate workstream ${index + 1} needs a concrete task`,
      );
    }
    const repo = canonicalRepository(
      boundedText(candidate.repo, 120) ?? primaryRepo,
      `workstream ${index + 1} repository`,
    );
    return requestedWorkstreamPayload(normalizeWorkstream({
      task,
      label: boundedText(candidate.label, 80),
      repo,
      model: candidate.model,
      agentId: candidate.agentId,
      readonly: candidate.readonly,
      approvalRequired: candidate.approvalRequired,
      risk: candidate.risk,
      acceptanceCriteria: boundedCriteria(candidate.acceptanceCriteria),
    }));
  });
}

function highestRisk(
  requestedWorkstreams: MissionSupervisorStartPayload["requestedWorkstreams"],
  fallback: "low" | "medium" | "high" | "consequential",
): "low" | "medium" | "high" | "consequential" {
  return requestedWorkstreams.reduce(
    (highest, workstream) =>
      RISK_ORDER[workstream.risk] > RISK_ORDER[highest]
        ? workstream.risk
        : highest,
    fallback,
  );
}

function parsedStartResult(value: unknown): {
  missionId: string;
  replayed: boolean;
  wakeTicket: unknown;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Mission supervisor start returned an invalid result");
  }
  const result = value as Record<string, unknown>;
  if (
    typeof result.missionId !== "string" ||
    !result.missionId.trim() ||
    !Object.hasOwn(result, "wakeTicket")
  ) {
    throw new Error("Mission supervisor start returned an invalid result");
  }
  return {
    missionId: result.missionId,
    replayed: result.replayed === true,
    wakeTicket: result.wakeTicket,
  };
}

function confirmedDispatch(value: unknown, wakeTicket: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Mission supervisor wake dispatch returned an invalid result");
  }
  const result = value as Record<string, unknown>;
  if (wakeTicket === null) {
    if (
      result.dispatched !== false ||
      result.reason !== "no_wake_ticket"
    ) {
      throw new Error(
        "Mission supervisor no-wake dispatch was not confirmed",
      );
    }
    return false;
  }
  if (
    result.dispatched !== true ||
    typeof result.runId !== "string" ||
    !result.runId.trim()
  ) {
    throw new Error("Mission supervisor wake dispatch was not confirmed");
  }
  return true;
}

/**
 * Returns null only when rollout policy deliberately keeps this invocation on
 * the legacy path. Once selected, every failure is surfaced so a durable
 * supervisor admission can never fall back into duplicate inline jobs.
 */
export async function startSupervisedOrchestrationIfSelected(
  input: SupervisedOrchestrationInput,
  dependencies: SupervisedOrchestrationDependencies,
): Promise<SupervisedOrchestrationResult | null> {
  const selection = selectMissionSupervisorRollout(input.invocationContext);
  if (!selection.supervised) return null;

  const goal = boundedText(input.mission, 500);
  if (!goal || goal.length < 12) {
    throw new Error("Supervised orchestrate requires a concrete mission");
  }
  const primaryRepo = canonicalRepository(
    boundedText(input.primaryRepo, 120),
    "primary repository",
  );
  const requestedWorkstreams = routedWorkstreams(
    input.requestedWorkstreams ?? [],
    primaryRepo,
  );
  const originThreadId = normalizedOriginThreadId(
    await dependencies.getOriginThreadId(),
  );
  const requestKey = await missionSupervisorRequestKey(
    selection.identity,
    originThreadId,
  );
  const admissionScopes = [
    ...(primaryRepo ? [primaryRepo] : []),
    ...requestedWorkstreams.map((workstream) => workstream.repo),
  ];
  const projectAdmissions = await dependencies.resolveProjectAdmissions(
    admissionScopes,
  );
  const missionRoute = routeWork(goal, { repo: primaryRepo });
  const priority = requestedWorkstreams.length
    ? Math.max(...requestedWorkstreams.map((workstream) =>
        routeWork(workstream.task, {
          repo: workstream.repo,
          requestedModel: workstream.model,
          readonly: workstream.readonly,
        }).priority
      ))
    : missionRoute.priority;
  const payload: MissionSupervisorStartPayload = {
    ...(input.authTokenHash ? { authTokenHash: input.authTokenHash } : {}),
    requestKey,
    goal,
    profile: "short_fleet",
    ...(boundedText(input.context, 8_000)
      ? { context: boundedText(input.context, 8_000) }
      : {}),
    ...(primaryRepo ? { repo: primaryRepo } : {}),
    desiredWorkstreams: requestedWorkstreams.length || 2,
    requestedWorkstreams,
    acceptanceCriteria: boundedCriteria(input.acceptanceCriteria),
    projectAdmissions,
    originThreadId,
    priority,
    risk: highestRisk(requestedWorkstreams, missionRoute.risk),
  };
  const started = parsedStartResult(
    await dependencies.mutate("missionSupervisor:startV1", payload),
  );
  // Dispatch the exact returned value. A durable start plus ambiguous dispatch
  // is replay-safe through requestKey; it must never create legacy jobs.
  const dispatch = await dependencies.dispatchWakeTicket(started.wakeTicket);
  const wakeDispatched = confirmedDispatch(dispatch, started.wakeTicket);
  return {
    mode: selection.mode,
    missionId: started.missionId,
    replayed: started.replayed,
    requestKey,
    requestedWorkstreams: requestedWorkstreams.length,
    wakeDispatched,
    dispatch,
  };
}
