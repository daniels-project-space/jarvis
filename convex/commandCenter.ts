import { v } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";
import { requireViewer, viewerAuthArgs } from "./controlAuth";

export const FLEET_MAX_NODES = 8;
export const FLEET_MAX_EDGES = 28;
export const ACTIVE_CANDIDATE_LIMIT = 33;
export const SUPERVISOR_CANDIDATE_LIMIT = ACTIVE_CANDIDATE_LIMIT;
export const SUPERVISOR_PLANNING_PROJECTION = "supervisor_planning";

export const USER_RELEVANT_STATUSES = [
  "pending",
  "dispatching",
  "running",
  "paused",
  "stalled",
  "needs_input",
  "awaiting_approval",
  "steering",
] as const;

const RELEVANT = new Set<string>(USER_RELEVANT_STATUSES);
const HIERARCHY_ACTIVE = new Set(["dispatching", "running", "paused", "stalled", "needs_input", "awaiting_approval", "steering"]);
const ROUTINE_WORK = /\b(?:health[ -]?(?:check|audit)|cloud health|heartbeat|uptime|stack poll|sentry sweep|provider health|lease reaper|execution reaper|reaper|control-plane migration|runtime migration|cron(?:job)?|routine (?:monitor|poll)|background (?:monitor|poll)|system monitor|stack monitor)\b/i;

type RuntimeRow = Record<string, unknown>;
type PlanNodeRow = Record<string, unknown>;
type PlanEdgeRow = Record<string, unknown>;
type HandoffRow = Record<string, unknown>;

function missionIdForRow(row: RuntimeRow): string {
  return String(row.missionGroupId ?? row.planParentMissionId ?? row.missionId ?? "");
}

function supervisorPlanningStage(
  command: RuntimeRow,
  now: number,
): { status: string; stage: string; modelReason: string } {
  if (command.state === "leased") {
    const expired = Number(command.leaseUntil ?? 0) <= now;
    return {
      status: "running",
      stage: expired ? "lease expired · recovery due" : "planning",
      modelReason: expired
        ? "Durable supervisor lease expired; bounded recovery is due"
        : "Durable supervisor lease is active",
    };
  }
  if (command.state === "waiting") {
    const due = Number(command.nextTickAt ?? 0) <= now;
    return {
      status: "pending",
      stage: due ? "retry ready" : "waiting to retry",
      modelReason: due
        ? "Durable supervisor backoff elapsed"
        : "Durable supervisor is waiting for its bounded retry",
    };
  }
  if (command.state === "paused") {
    return {
      status: "paused",
      stage: "paused",
      modelReason: "Durable supervisor is paused by Daniel",
    };
  }
  if (command.state === "needs_input") {
    return {
      status: "needs_input",
      stage: "waiting for Daniel",
      modelReason: "Durable supervisor requires Daniel's exact input",
    };
  }
  const future = Number(command.nextTickAt ?? 0) > now;
  return {
    status: "pending",
    stage: future ? "planning scheduled" : "ready to plan",
    modelReason: future
      ? "Durable supervisor is scheduled for a future tick"
      : "Durable supervisor state is ready",
  };
}

function supervisedPlanningRuntime(
  command: RuntimeRow,
  threadId: string,
  now: number,
): RuntimeRow | null {
  const missionId = String(command.missionId ?? "");
  if (!missionId
    || command.mode !== "supervised"
    || command.active !== true
    || command.state === "terminal"
    || String(command.originThreadId ?? "main") !== threadId) {
    return null;
  }
  const projected = supervisorPlanningStage(command, now);
  const goal = String(command.goal ?? "Supervised mission").slice(0, 500);
  return {
    jobId: `supervisor:${missionId}`,
    missionId,
    missionGroupId: missionId,
    projectGroupId: `${missionId}:planning`,
    canonicalProjectId: String(command.canonicalProjectId ?? command.primaryRepo ?? "planning").slice(0, 120),
    projectRepository: typeof command.primaryRepo === "string" ? command.primaryRepo.slice(0, 120) : undefined,
    repo: typeof command.primaryRepo === "string" ? command.primaryRepo.slice(0, 120) : undefined,
    task: goal,
    label: `Planning · ${goal}`.slice(0, 120),
    status: projected.status,
    visibility: "conversation",
    originThreadId: threadId,
    agentId: "jarvis",
    priority: Math.max(0, Math.min(100, Number(command.priority ?? 50))),
    stage: projected.stage,
    percent: Math.max(0, Math.min(100, Number(command.percent ?? 0))),
    progress: "",
    modelReason: projected.modelReason,
    workerRuntime: command.state === "leased"
      ? "mission-supervisor"
      : undefined,
    integrationState: "not_applicable",
    attempt: 1,
    maxAttempts: 1,
    active: true,
    dependsOn: [],
    projectionKind: SUPERVISOR_PLANNING_PROJECTION,
    createdAt: Number(command.createdAt ?? 0),
    updatedAt: Number(command.updatedAt ?? 0),
  };
}

function missionRuntimeFromSupervisorCommand(command: RuntimeRow): RuntimeRow {
  return {
    missionId: command.missionId,
    goal: command.goal,
    mode: command.mode,
    status: command.status,
    originThreadId: command.originThreadId,
    priority: command.priority,
    phase: command.phase,
    percent: command.percent,
    primaryRepo: command.primaryRepo,
    canonicalProjectId: command.canonicalProjectId,
    agentCount: command.totalJobs,
    createdAt: command.createdAt,
    updatedAt: command.updatedAt,
  };
}

async function supervisorCommandPlanningRows(
  ctx: QueryCtx,
  threadId: string,
  realRows: readonly RuntimeRow[],
): Promise<{
  rows: RuntimeRow[];
  commandsByMission: Map<string, RuntimeRow>;
}> {
  const now = Date.now();
  const commands = await ctx.db
    .query("missionSupervisorCommand")
    .withIndex("by_thread_active_priority", (q) =>
      q
        .eq("originThreadId", threadId)
        .eq("active", true)
    )
    .order("desc")
    .take(SUPERVISOR_CANDIDATE_LIMIT);
  const representedMissionIds = new Set(realRows.map(missionIdForRow).filter(Boolean));
  const commandsByMission = new Map<string, RuntimeRow>();
  const rows = commands.flatMap((command) => {
    const missionId = String(command.missionId ?? "");
    if (!missionId || commandsByMission.has(missionId)) return [];
    commandsByMission.set(missionId, command);
    if (representedMissionIds.has(missionId)) return [];
    const planning = supervisedPlanningRuntime(command, threadId, now);
    return planning ? [planning] : [];
  });
  return { rows, commandsByMission };
}

// threadId === null means "any thread" — used only by the main page's
// fleet-wide projection (see fleetSnapshot below), which surfaces every
// active conversation-origin job Daniel owns regardless of which thread
// dispatched it. Every other caller still passes an exact thread and keeps
// its existing single-thread scoping unchanged.
export function isUserRelevantWork(row: RuntimeRow, threadId: string | null): boolean {
  if (!RELEVANT.has(String(row.status ?? ""))) return false;
  if (row.visibility !== "conversation") return false;
  if (threadId !== null && row.originThreadId !== threadId) return false;
  // A provider configuration hold has no queued retry or running workspace.
  // Keep it in durable history until the verified maintenance path resumes or
  // expires it; do not present it as foreground work.
  if (row.status === "paused" && row.providerRunState === "blocked" && row.nextRunAt === undefined) return false;
  // A pending child with prerequisites is represented inside its parent's DAG
  // as dependency-held. It has no lease and must not make the foreground read
  // "busy" merely because historical plan leaves still exist.
  if (row.status === "pending" && Array.isArray(row.dependsOn) && row.dependsOn.length > 0) return false;
  const identity = [row.label, row.task, row.stage, row.agentId].filter(Boolean).join(" ");
  return !ROUTINE_WORK.test(identity);
}

function attentionScore(row: RuntimeRow): number {
  const status = String(row.status ?? "");
  const blocked = /block|fail|error/i.test(`${row.stage ?? ""} ${row.integrationState ?? ""}`);
  if (status === "needs_input") return 1_000;
  if (status === "awaiting_approval") return 950;
  if (status === "stalled" || status === "error" || blocked) return 900;
  if (status === "paused") return 700;
  if (status === "running" || status === "steering") return 600;
  if (status === "dispatching") return 500;
  return 400;
}

function stableRuntimeOrder(left: RuntimeRow, right: RuntimeRow) {
  return attentionScore(right) - attentionScore(left)
    || Number(right.priority ?? 50) - Number(left.priority ?? 50)
    || Number(right.progressAt ?? right.createdAt ?? 0) - Number(left.progressAt ?? left.createdAt ?? 0)
    || String(left.jobId ?? "").localeCompare(String(right.jobId ?? ""));
}

export function selectRelevantWork(rows: readonly RuntimeRow[], threadId: string | null): RuntimeRow[] {
  return rows.filter((row) => isUserRelevantWork(row, threadId)).sort(stableRuntimeOrder);
}

function needsAttention(row: RuntimeRow): boolean {
  return ["needs_input", "awaiting_approval", "stalled", "error"].includes(String(row.status))
    || row.integrationState === "needs_attention"
    || /\b(?:blocked|failed|conflict)\b/i.test(`${row.stage ?? ""} ${row.stallReason ?? ""}`);
}

function attentionKind(row: RuntimeRow): "approval" | "input" | "system" | "recovery" | null {
  const status = String(row.status ?? "");
  const consequentialApproval = row.approvalRequired === true
    && row.approvalStatus === "pending"
    && (row.risk === "consequential" || row.deliveryMode === "manual");
  if (consequentialApproval || status === "awaiting_approval") return "approval";
  if (row.providerRunState === "blocked") return "system";
  if (status === "needs_input") return "input";
  return needsAttention(row) ? "recovery" : null;
}

function attentionLabel(kind: ReturnType<typeof attentionKind>): string | null {
  if (kind === "approval") return "Approval needed";
  if (kind === "input") return "Your input is needed";
  if (kind === "system") return "Secure worker setup";
  if (kind === "recovery") return "Jarvis is recovering";
  return null;
}

function nodeState(row: RuntimeRow, dependencyCount: number, dependenciesReady: number) {
  const status = String(row.status ?? "missing");
  const integration = String(row.integrationState ?? "");
  const stage = String(row.stage ?? status);
  if (status === "paused") return "paused";
  if (row.providerRunState === "blocked") return "blocked";
  if (status === "needs_input" || status === "awaiting_approval") return "needs_input";
  if (status === "stalled" || status === "error" || /\b(?:blocked|failed|conflict)\b/i.test(`${stage} ${integration}`)) return "blocked";
  if (status === "done") return "done";
  if (/integrat|merge|deliver/i.test(`${integration} ${stage}`)) return "integrating";
  if (/review|validat|verify/i.test(stage)) return "reviewing";
  if (status === "running" || status === "steering") return "running";
  if (status === "dispatching") return "dispatching";
  if (dependencyCount > dependenciesReady) return "dependency_held";
  return "queued";
}

function controlsFor(row: RuntimeRow) {
  const status = String(row.status ?? "");
  const controls: string[] = [];
  // A provider admission failure is a system hold. Offering resume/steer makes
  // the operator look responsible and only creates another doomed dispatch.
  if (row.providerRunState === "blocked") return ["cancel"];
  const consequentialApproval = row.approvalRequired === true
    && row.approvalStatus === "pending"
    && (row.risk === "consequential" || row.deliveryMode === "manual");
  if (consequentialApproval) controls.push("approve", "decline");
  if (["running", "dispatching", "steering"].includes(status)) controls.push("pause", "cancel", "steer");
  else if (["paused", "stalled", "needs_input"].includes(status)) controls.push("resume", "cancel", "steer");
  else if (status === "pending") controls.push("cancel", "steer");
  return controls;
}

function supervisorAuthority(command: RuntimeRow | null) {
  if (!command) return undefined;
  return {
    protocolVersion: 1 as const,
    state: String(command.state),
    inputRevision: Number(command.inputRevision),
    steerRevision: Number(command.steerRevision),
    deadlineAt: Number(command.deadlineAt),
    ...(typeof command.question === "string"
      ? { question: command.question }
      : {}),
  };
}

const SUPERVISOR_CONTROL_ORDER = [
  "pause",
  "resume",
  "cancel",
  "steer",
  "provide_input",
] as const;

type SupervisorControl = typeof SUPERVISOR_CONTROL_ORDER[number];

const SUPERVISOR_CONTROL_RANK = new Map<string, number>(
  SUPERVISOR_CONTROL_ORDER.map((action, index) => [action, index]),
);

function supervisorControls(command: RuntimeRow | null): SupervisorControl[] {
  if (
    !command
    || command.active !== true
    || command.state === "terminal"
    || command.controlAffordanceProtocolVersion !== 1
    || !Array.isArray(command.supportedControlActions)
    || command.supportedControlActions.length > SUPERVISOR_CONTROL_ORDER.length
  ) {
    return [];
  }
  const controls: SupervisorControl[] = [];
  let previousRank = -1;
  for (const action of command.supportedControlActions) {
    const rank = typeof action === "string"
      ? SUPERVISOR_CONTROL_RANK.get(action)
      : undefined;
    if (rank === undefined || rank <= previousRank) return [];
    controls.push(action as SupervisorControl);
    previousRank = rank;
  }
  return controls;
}

function missionControls(
  mission: RuntimeRow | null,
  command: RuntimeRow | null,
) {
  if (!mission) return [];
  if (mission.mode === "supervised") return supervisorControls(command);
  if (mission.mode !== "goal") return [];
  const status = String(mission.status ?? "");
  if (["done", "failed", "cancelled"].includes(status)) return [];
  if (["paused", "needs_input"].includes(status)) return ["resume", "cancel", "steer"];
  return ["pause", "cancel", "steer"];
}

function topologicalNodes(nodes: PlanNodeRow[], edges: PlanEdgeRow[]) {
  const byId = new Map(nodes.map((node) => [String(node.nodeId ?? node.id), node]));
  const incoming = new Map([...byId.keys()].map((id) => [id, 0]));
  const outgoing = new Map([...byId.keys()].map((id) => [id, [] as string[]]));
  for (const edge of edges) {
    const source = String(edge.sourceNodeId ?? edge.source);
    const target = String(edge.targetNodeId ?? edge.target);
    if (!byId.has(source) || !byId.has(target)) continue;
    incoming.set(target, (incoming.get(target) ?? 0) + 1);
    outgoing.get(source)!.push(target);
  }
  const ready = [...byId.keys()].filter((id) => incoming.get(id) === 0).sort();
  const ordered: PlanNodeRow[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    ordered.push(byId.get(id)!);
    for (const target of (outgoing.get(id) ?? []).sort()) {
      incoming.set(target, (incoming.get(target) ?? 1) - 1);
      if (incoming.get(target) === 0) ready.push(target);
    }
    ready.sort();
  }
  if (ordered.length !== nodes.length) return [...nodes].sort((a, b) => String(a.nodeId ?? a.id).localeCompare(String(b.nodeId ?? b.id)));
  return ordered;
}

function recoverySummary(row: RuntimeRow): string | null {
  const value = row.stallReason || row.evidenceSummary || row.retryLineage;
  if (value) return String(value).slice(0, 180);
  if (Number(row.attempt ?? 1) > 1) return `Recovered execution · attempt ${Number(row.attempt)}`;
  return null;
}

function mergeState(row: RuntimeRow): string {
  if (row.deliveryStatus === "merged" || row.mergeCommitSha) return "merged";
  if (row.integrationState && row.integrationState !== "not_applicable") return String(row.integrationState);
  if (row.deliveryStatus) return String(row.deliveryStatus);
  return row.readonly ? "evidence only" : "not started";
}

function runtimeRepository(row: RuntimeRow): string | null {
  if (typeof row.projectRepository === "string") return row.projectRepository.slice(0, 120);
  if (typeof row.repo === "string") return row.repo.slice(0, 120);
  return null;
}

function hierarchyRuntimeNode(row: RuntimeRow) {
  const attention = attentionKind(row);
  const needsDaniel = attention === "approval" || attention === "input";
  const planningProjection = row.projectionKind === SUPERVISOR_PLANNING_PROJECTION;
  return {
    id: String(row.planNodeId ?? row.jobId),
    jobId: String(row.jobId),
    label: String(row.label ?? row.task ?? "Agent work").slice(0, 120),
    agent: String(row.agentId ?? "jarvis").slice(0, 40),
    repository: runtimeRepository(row),
    state: nodeState(row, 0, 0),
    status: String(row.status),
    stage: String(row.stage ?? row.status).slice(0, 80),
    percent: Math.max(0, Math.min(100, Number(row.percent ?? 0))),
    progress: String(row.progress ?? "").slice(0, 180),
    progressAt: typeof row.progressAt === "number" ? row.progressAt : null,
    model: row.model ?? null,
    reasoningEffort: row.reasoningEffort ?? null,
    modelReason: typeof row.modelReason === "string" ? row.modelReason.slice(0, 300) : null,
    workerRuntime: row.workerRuntime ?? null,
    workerRunId: row.workerRunId ?? null,
    generation: Number(row.deliveryGeneration ?? row.goalWave ?? 0),
    attempt: Math.max(1, Number(row.attempt ?? 1)),
    maxAttempts: Math.max(1, Number(row.maxAttempts ?? 1)),
    dependencyCount: Array.isArray(row.dependsOn) ? row.dependsOn.length : 0,
    dependenciesReady: 0,
    integrationState: String(row.integrationState ?? "not_applicable"),
    deliveryStatus: row.deliveryStatus ?? null,
    mergeState: mergeState(row),
    recoverySummary: recoverySummary(row),
    needsDaniel,
    attentionKind: attention,
    attentionLabel: attentionLabel(attention),
    attentionReason: attention ? String(row.stallReason ?? row.progress ?? row.stage ?? row.status).slice(0, 180) : null,
    controls: planningProjection ? [] : controlsFor(row),
    startedAt: typeof row.startedAt === "number" ? row.startedAt : null,
    ...(planningProjection ? { projectionKind: SUPERVISOR_PLANNING_PROJECTION } : {}),
  };
}

type HierarchyJob = ReturnType<typeof hierarchyRuntimeNode>;
type HierarchyProject = {
  id: string;
  canonicalProjectId: string;
  repository: string | null;
  jobs: HierarchyJob[];
};
type HierarchyMission = {
  id: string;
  label: string;
  status: string;
  phase: string;
  projects: HierarchyProject[];
};
type HierarchyMissionAccumulator = Omit<HierarchyMission, "projects"> & {
  projects: Map<string, HierarchyProject>;
};

/**
 * One compact ownership tree for every genuinely live worker in the thread.
 * Persisted mission/project ids are the grouping keys; labels and repository
 * names are display-only and can never merge two authority groups.
 */
export function buildActiveWorkHierarchy(rows: readonly RuntimeRow[], threadId: string | null, mission?: RuntimeRow | null) {
  const missions = new Map<string, HierarchyMissionAccumulator>();
  const seenJobs = new Set<string>();
  for (const row of selectRelevantWork(rows, threadId)) {
    if (!HIERARCHY_ACTIVE.has(String(row.status))
      && row.projectionKind !== SUPERVISOR_PLANNING_PROJECTION) continue;
    const jobId = String(row.jobId ?? "");
    if (!jobId || seenJobs.has(jobId)) continue;
    seenJobs.add(jobId);
    const missionId = String(row.missionGroupId ?? row.planParentMissionId ?? row.missionId ?? `work:${jobId}`);
    const projectId = String(row.projectGroupId ?? row.missionId ?? `project:${jobId}`);
    const missionMatches = mission
      && String(mission.missionId ?? mission._id ?? "") === missionId;
    let missionGroup = missions.get(missionId);
    if (!missionGroup) {
      missionGroup = {
        id: missionId,
        label: String(missionMatches ? mission.goal : row.label ?? row.task ?? "Live mission").slice(0, 500),
        status: String(missionMatches ? mission.status : row.status),
        phase: String(missionMatches ? mission.phase : row.stage ?? row.status),
        projects: new Map<string, HierarchyProject>(),
      };
      missions.set(missionId, missionGroup);
    }
    let project = missionGroup.projects.get(projectId);
    if (!project) {
      const created: HierarchyProject = {
        id: projectId,
        canonicalProjectId: String(row.canonicalProjectId ?? (row.projectRepository ?? row.repo) ?? "evidence").slice(0, 120),
        repository: runtimeRepository(row),
        jobs: [],
      };
      missionGroup.projects.set(projectId, created);
      project = created;
    }
    project.jobs.push(hierarchyRuntimeNode(row));
  }
  return [...missions.values()].map((group) => ({
    ...group,
    projects: [...group.projects.values()],
  }));
}

export function buildFleetSnapshot(input: {
  threadId: string | null;
  activeRows: RuntimeRow[];
  mission?: RuntimeRow | null;
  supervisorCommand?: RuntimeRow | null;
  nodes?: PlanNodeRow[];
  edges?: PlanEdgeRow[];
  handoffs?: HandoffRow[];
  activities?: RuntimeRow[];
}) {
  const relevant = selectRelevantWork(input.activeRows, input.threadId);
  const primary = relevant[0];
  const hierarchy = buildActiveWorkHierarchy(input.activeRows, input.threadId, input.mission);
  if (!primary) return { active: null, fleet: null, hierarchy };

  const rawNodes = input.nodes?.length
    ? [...input.nodes]
    : (input.activities?.length ? input.activities : relevant).slice(0, FLEET_MAX_NODES).map((row) => ({
        nodeId: String(row.planNodeId ?? row.jobId), jobId: row.jobId,
        label: row.label ?? row.task, agentId: row.agentId, repository: row.repo,
        dependencyCount: Array.isArray(row.dependsOn) ? row.dependsOn.length : 0,
        projectionKind: row.projectionKind,
      }));
  const rawEdges = input.edges?.length
    ? [...input.edges]
    : rawNodes.flatMap((node) => {
        const activity = (input.activities ?? relevant).find((row) => String(row.jobId) === String(node.jobId));
        return (Array.isArray(activity?.dependsOn) ? activity.dependsOn : []).map((sourceJobId: string) => ({
          edgeId: `${sourceJobId}->${String(node.jobId)}`,
          sourceNodeId: rawNodes.find((candidate) => String(candidate.jobId) === String(sourceJobId))?.nodeId ?? sourceJobId,
          targetNodeId: node.nodeId,
          sourceJobId,
          targetJobId: node.jobId,
        }));
      }).filter((edge) => rawNodes.some((node) => String(node.nodeId) === String(edge.sourceNodeId)));

  if (rawNodes.length > FLEET_MAX_NODES) throw new Error(`Fleet projection exceeds ${FLEET_MAX_NODES} nodes`);
  if (rawEdges.length > FLEET_MAX_EDGES) throw new Error(`Fleet projection exceeds ${FLEET_MAX_EDGES} edges`);

  const activities = input.activities?.length ? input.activities : relevant;
  const activityByJob = new Map(activities.map((row) => [String(row.jobId), row]));
  const validHandoffs = new Set((input.handoffs ?? []).filter((handoff) => {
    const activity = activityByJob.get(String(handoff.sourceJobId));
    return activity
      && handoff.handoffProtocolVersion === 2
      && typeof handoff.handoffPayloadDigest === "string"
      && typeof handoff.workReceiptDigest === "string"
      && (!input.mission?.planDigest || handoff.planDigest === input.mission.planDigest)
      && Number(handoff.sourceAttempt) === Number(activity.attempt ?? 1)
      && Number(handoff.sourceSteerRevision) === Number(activity.steerRevision ?? 0);
  }).map((handoff) => String(handoff.sourceJobId)));

  const orderedRawNodes = topologicalNodes(rawNodes, rawEdges);
  const projectedEdges = rawEdges
    .map((edge) => {
      const sourceJobId = String(edge.sourceJobId ?? rawNodes.find((node) => String(node.nodeId) === String(edge.sourceNodeId))?.jobId ?? "");
      const source = activityByJob.get(sourceJobId);
      const readiness = validHandoffs.has(sourceJobId)
        ? "delivered"
        : source && needsAttention(source)
          ? "blocked"
          : source?.status === "done"
            ? "ready"
            : "waiting";
      return {
        id: String(edge.edgeId ?? `${edge.sourceNodeId}->${edge.targetNodeId}`),
        source: String(edge.sourceNodeId), target: String(edge.targetNodeId), readiness,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  const projectedNodes = orderedRawNodes.map((node) => {
    const jobId = String(node.jobId);
    const row = activityByJob.get(jobId) ?? {};
    const incoming = rawEdges.filter((edge) => String(edge.targetNodeId) === String(node.nodeId));
    const dependenciesReady = incoming.filter((edge) => validHandoffs.has(String(edge.sourceJobId))).length;
    const attention = attentionKind(row);
    const needsDaniel = attention === "approval" || attention === "input";
    return {
      id: String(node.nodeId), jobId,
      label: String(node.label ?? row.label ?? row.task ?? "Agent work").slice(0, 120),
      agent: String(node.agentId ?? row.agentId ?? "jarvis").slice(0, 40),
      repository: node.repository ?? row.repo ?? null,
      state: nodeState(row, Number(node.dependencyCount ?? incoming.length), dependenciesReady),
      status: String(row.status ?? "missing"), stage: String(row.stage ?? row.status ?? "queued").slice(0, 80),
      percent: Math.max(0, Math.min(100, Number(row.percent ?? 0))),
      progress: String(row.progress ?? "").slice(0, 180),
      progressAt: typeof row.progressAt === "number" ? row.progressAt : null,
      model: row.model ?? null, reasoningEffort: row.reasoningEffort ?? null,
      modelReason: typeof row.modelReason === "string" ? row.modelReason.slice(0, 300) : null,
      workerRuntime: row.workerRuntime ?? null, workerRunId: row.workerRunId ?? null,
      generation: Number(row.deliveryGeneration ?? row.goalWave ?? 0),
      attempt: Math.max(1, Number(row.attempt ?? 1)), maxAttempts: Math.max(1, Number(row.maxAttempts ?? 1)),
      dependencyCount: Number(node.dependencyCount ?? incoming.length), dependenciesReady,
      integrationState: String(row.integrationState ?? "not_applicable"),
      deliveryStatus: row.deliveryStatus ?? null, mergeState: mergeState(row),
      recoverySummary: recoverySummary(row), needsDaniel,
      attentionKind: attention, attentionLabel: attentionLabel(attention),
      attentionReason: attention ? String(row.stallReason ?? row.progress ?? row.stage ?? row.status).slice(0, 180) : null,
      controls: controlsFor(row), startedAt: typeof row.startedAt === "number" ? row.startedAt : null,
      ...((node.projectionKind ?? row.projectionKind) === SUPERVISOR_PLANNING_PROJECTION
        ? { projectionKind: SUPERVISOR_PLANNING_PROJECTION, controls: [] }
        : {}),
    };
  });

  const missionId = input.mission ? String(input.mission.missionId ?? input.mission._id) : null;
  const liveNodes = projectedNodes.filter((node) => !["done"].includes(node.state));
  const primaryNode = projectedNodes.find((node) => node.jobId === String(primary.jobId)) ?? liveNodes[0] ?? projectedNodes[0];
  const hierarchyJobs = hierarchy.flatMap((group) => group.projects.flatMap((project) => project.jobs));
  const attentionCount = hierarchyJobs.filter((node) => node.needsDaniel).length;
  const supervisor = supervisorAuthority(input.supervisorCommand ?? null);
  const fleet = {
    id: missionId ?? `work:${String(primary.jobId)}`,
    goal: String(input.mission?.goal ?? primary.label ?? primary.task ?? "Live work").slice(0, 500),
    mode: String(input.mission?.mode ?? "work"), status: String(input.mission?.status ?? primary.status),
    phase: String(input.mission?.phase ?? primary.stage ?? primary.status),
    percent: Math.max(0, Math.min(100, Number(input.mission?.percent ?? primary.percent ?? 0))),
    repository: input.mission?.primaryRepo ?? primary.repo ?? null,
    planDigest: input.mission?.planDigest ?? null,
    planGeneration: typeof input.mission?.planGeneration === "number" ? input.mission.planGeneration : null,
    integrationState: input.mission?.activeIntegrationAttemptId ? "integrating" : String(input.mission?.phase ?? "not started"),
    attentionCount,
    controls: missionControls(
      input.mission ?? null,
      input.supervisorCommand ?? null,
    ),
    ...(supervisor ? { supervisor } : {}),
    nodes: projectedNodes,
    edges: projectedEdges,
  };
  return {
    active: primaryNode ? {
      id: primaryNode.jobId, missionId, label: primaryNode.label, status: primaryNode.state,
      stage: primaryNode.stage, percent: primaryNode.percent,
      extraCount: Math.max(0, hierarchyJobs.length - 1), needsDaniel: attentionCount > 0,
    } : null,
    fleet,
    hierarchy,
  };
}

// Shared by both `snapshot` (one thread) and `fleetSnapshot` (every thread).
// threadId === null skips origin-thread scoping entirely and also skips the
// supervisor "planning stage" projection, which is inherently thread-bound
// (missionSupervisorCommand has no unscoped index); a mission only appears
// fleet-wide once it has an actual dispatched job in jobRuntime.
async function computeCommandCenterSnapshot(ctx: QueryCtx, threadId: string | null) {
  const candidates = threadId !== null
    ? await ctx.db.query("jobRuntime")
      .withIndex("by_thread_visibility_active_priority", (q) => q
        .eq("originThreadId", threadId)
        .eq("visibility", "conversation")
        .eq("active", true))
      .order("desc")
      .take(ACTIVE_CANDIDATE_LIMIT)
    : await ctx.db.query("jobRuntime")
      .withIndex("by_visibility_active_priority", (q) => q
        .eq("visibility", "conversation")
        .eq("active", true))
      .order("desc")
      .take(ACTIVE_CANDIDATE_LIMIT);
  const relevantJobs = selectRelevantWork(candidates, threadId);
  const supervisorProjection = threadId !== null
    ? await supervisorCommandPlanningRows(ctx, threadId, relevantJobs)
    : { rows: [] as RuntimeRow[], commandsByMission: new Map<string, RuntimeRow>() };
  const relevant = selectRelevantWork([...relevantJobs, ...supervisorProjection.rows], threadId);
  const primary = relevant[0];
  if (!primary) return { active: null, fleet: null, hierarchy: [] };

  const rawMissionId = primary.planParentMissionId ?? primary.missionId;
  const missionId = rawMissionId ? ctx.db.normalizeId("missions", String(rawMissionId)) : null;
  if (!missionId) return buildFleetSnapshot({ threadId, activeRows: relevant });
  const supervisorCommand =
    supervisorProjection.commandsByMission.get(String(missionId)) ?? null;
  const mission = supervisorCommand
    ? missionRuntimeFromSupervisorCommand(supervisorCommand)
    : await ctx.db
      .query("missionRuntime")
      .withIndex("by_mission", (q) => q.eq("missionId", missionId))
      .first();
  if (!mission) return buildFleetSnapshot({ threadId, activeRows: relevant });
  if (primary.projectionKind === SUPERVISOR_PLANNING_PROJECTION) {
    return buildFleetSnapshot({
      threadId,
      activeRows: relevant,
      mission,
      supervisorCommand,
    });
  }

  const generation = Number(mission.planGeneration ?? 0);
  if (mission.planDigest && generation > 0) {
    const [nodes, edges, handoffs, activities] = await Promise.all([
      ctx.db.query("goalPlanNodes").withIndex("by_parent_generation", (q) => q
        .eq("parentMissionId", missionId).eq("planGeneration", generation)).take(FLEET_MAX_NODES + 1),
      ctx.db.query("goalPlanEdges").withIndex("by_parent_generation", (q) => q
        .eq("parentMissionId", missionId).eq("planGeneration", generation)).take(FLEET_MAX_EDGES + 1),
      ctx.db.query("goalHandoffs").withIndex("by_parent_generation", (q) => q
        .eq("parentMissionId", missionId).eq("planGeneration", generation)).take(FLEET_MAX_NODES + 1),
      ctx.db.query("jobRuntime").withIndex("by_plan_parent_generation_node", (q) => q
        .eq("planParentMissionId", missionId).eq("planGeneration", generation)).take(FLEET_MAX_NODES + 1),
    ]);
    if (nodes.length > FLEET_MAX_NODES || activities.length > FLEET_MAX_NODES || handoffs.length > FLEET_MAX_NODES) {
      throw new Error("Fleet projection exceeds its 8-node hot bound");
    }
    if (edges.length > FLEET_MAX_EDGES) throw new Error("Fleet projection exceeds its 28-edge hot bound");
    return buildFleetSnapshot({
      threadId,
      activeRows: relevant,
      mission,
      supervisorCommand,
      nodes,
      edges,
      handoffs,
      activities,
    });
  }

  const activities = await ctx.db.query("jobRuntime")
    .withIndex("by_mission_active_priority", (q) => q
      .eq("missionId", String(missionId))
      .eq("active", true))
    .order("desc")
    .take(FLEET_MAX_NODES);
  return buildFleetSnapshot({
    threadId,
    activeRows: relevant,
    mission,
    supervisorCommand,
    activities,
  });
}

// One subscription owns both collapsed and expanded UI. It reads only compact
// projections through bounded indexes; transcripts, tasks, checkpoints,
// artifacts, approvals and archive rows never enter this result.
export const snapshot = query({
  args: { threadId: v.optional(v.string()), ...viewerAuthArgs },
  returns: v.any(),
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    let threadId = a.threadId?.trim();
    if (a.threadId === undefined) {
      const activeThread = await ctx.db.query("ui").withIndex("by_key", (q) => q.eq("key", "activeThread")).first();
      threadId = activeThread?.value.trim() || "main";
    }
    if (!threadId) return { active: null, fleet: null, hierarchy: [] };
    return computeCommandCenterSnapshot(ctx, threadId);
  },
});

// The main (non-embedded) page's command center. Unlike `snapshot`, this is
// never scoped to one thread: Paul (and every other specialist)'s dispatched
// work should stay visible here even after the shared active-thread pointer
// (ui.getActiveThread) has moved on to a different conversation — including
// one dispatched from an embedded overlay in another app entirely. Embedded
// surfaces keep using `snapshot` unchanged.
export const fleetSnapshot = query({
  args: { ...viewerAuthArgs },
  returns: v.any(),
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    return computeCommandCenterSnapshot(ctx, null);
  },
});
