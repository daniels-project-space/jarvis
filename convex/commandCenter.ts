import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireViewer, viewerAuthArgs } from "./controlAuth";

export const FLEET_MAX_NODES = 8;
export const FLEET_MAX_EDGES = 28;
export const ACTIVE_CANDIDATE_LIMIT = 33;

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
const ROUTINE_WORK = /\b(?:health[ -]?(?:check|audit)|cloud health|heartbeat|uptime|stack poll|sentry sweep|provider health|lease reaper|execution reaper|reaper|control-plane migration|runtime migration|cron(?:job)?|routine (?:monitor|poll)|background (?:monitor|poll)|system monitor|stack monitor)\b/i;

type RuntimeRow = Record<string, any>;
type PlanNodeRow = Record<string, any>;
type PlanEdgeRow = Record<string, any>;
type HandoffRow = Record<string, any>;

export function isUserRelevantWork(row: RuntimeRow, threadId: string): boolean {
  if (!RELEVANT.has(String(row.status ?? ""))) return false;
  if (row.visibility !== "conversation" || row.originThreadId !== threadId) return false;
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

export function selectRelevantWork(rows: readonly RuntimeRow[], threadId: string): RuntimeRow[] {
  return rows.filter((row) => isUserRelevantWork(row, threadId)).sort(stableRuntimeOrder);
}

function needsAttention(row: RuntimeRow): boolean {
  return ["needs_input", "awaiting_approval", "stalled", "error"].includes(String(row.status))
    || row.integrationState === "needs_attention"
    || /\b(?:blocked|failed|conflict)\b/i.test(`${row.stage ?? ""} ${row.stallReason ?? ""}`);
}

function nodeState(row: RuntimeRow, dependencyCount: number, dependenciesReady: number) {
  const status = String(row.status ?? "missing");
  const integration = String(row.integrationState ?? "");
  const stage = String(row.stage ?? status);
  if (status === "needs_input" || status === "awaiting_approval") return "needs_input";
  if (status === "stalled" || status === "error" || /\b(?:blocked|failed|conflict)\b/i.test(`${stage} ${integration}`)) return "blocked";
  if (status === "done") return "done";
  if (status === "paused") return "paused";
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
  const consequentialApproval = row.approvalRequired === true
    && row.approvalStatus === "pending"
    && (row.risk === "consequential" || row.deliveryMode === "manual");
  if (consequentialApproval) controls.push("approve", "decline");
  if (["running", "dispatching", "steering"].includes(status)) controls.push("pause", "cancel", "steer");
  else if (["paused", "stalled", "needs_input"].includes(status)) controls.push("resume", "cancel", "steer");
  else if (status === "pending") controls.push("cancel", "steer");
  return controls;
}

function missionControls(mission: RuntimeRow | null) {
  if (!mission) return [];
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

export function buildFleetSnapshot(input: {
  threadId: string;
  activeRows: RuntimeRow[];
  mission?: RuntimeRow | null;
  nodes?: PlanNodeRow[];
  edges?: PlanEdgeRow[];
  handoffs?: HandoffRow[];
  activities?: RuntimeRow[];
}) {
  const relevant = selectRelevantWork(input.activeRows, input.threadId);
  const primary = relevant[0];
  if (!primary) return { active: null, fleet: null };

  const rawNodes = input.nodes?.length
    ? [...input.nodes]
    : (input.activities?.length ? input.activities : relevant).slice(0, FLEET_MAX_NODES).map((row) => ({
        nodeId: String(row.planNodeId ?? row.jobId), jobId: row.jobId,
        label: row.label ?? row.task, agentId: row.agentId, repository: row.repo,
        dependencyCount: Array.isArray(row.dependsOn) ? row.dependsOn.length : 0,
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
    const attention = needsAttention(row);
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
      modelReason: String(row.modelReason ?? "").slice(0, 300) || null,
      workerRuntime: row.workerRuntime ?? null, workerRunId: row.workerRunId ?? null,
      generation: Number(row.deliveryGeneration ?? row.goalWave ?? 0),
      attempt: Math.max(1, Number(row.attempt ?? 1)), maxAttempts: Math.max(1, Number(row.maxAttempts ?? 1)),
      dependencyCount: Number(node.dependencyCount ?? incoming.length), dependenciesReady,
      integrationState: String(row.integrationState ?? "not_applicable"),
      deliveryStatus: row.deliveryStatus ?? null, mergeState: mergeState(row),
      recoverySummary: recoverySummary(row), needsDaniel: attention,
      attentionReason: attention ? String(row.stallReason ?? row.progress ?? row.stage ?? row.status).slice(0, 180) : null,
      controls: controlsFor(row), startedAt: typeof row.startedAt === "number" ? row.startedAt : null,
    };
  });

  const missionId = input.mission ? String(input.mission.missionId ?? input.mission._id) : null;
  const liveNodes = projectedNodes.filter((node) => !["done"].includes(node.state));
  const primaryNode = projectedNodes.find((node) => node.jobId === String(primary.jobId)) ?? liveNodes[0] ?? projectedNodes[0];
  const attentionCount = projectedNodes.filter((node) => node.needsDaniel).length;
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
    attentionCount, controls: missionControls(input.mission ?? null), nodes: projectedNodes, edges: projectedEdges,
  };
  return {
    active: primaryNode ? {
      id: primaryNode.jobId, missionId, label: primaryNode.label, status: primaryNode.state,
      stage: primaryNode.stage, percent: primaryNode.percent,
      model: primaryNode.model, reasoningEffort: primaryNode.reasoningEffort,
      modelReason: primaryNode.modelReason,
      extraCount: Math.max(0, liveNodes.length - 1), needsDaniel: attentionCount > 0,
    } : null,
    fleet,
  };
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
    if (!threadId) return { active: null, fleet: null };

    const candidates = await ctx.db.query("jobRuntime")
      .withIndex("by_thread_visibility_active_priority", (q) => q
        .eq("originThreadId", threadId)
        .eq("visibility", "conversation")
        .eq("active", true))
      .order("desc")
      .take(ACTIVE_CANDIDATE_LIMIT);
    const relevant = selectRelevantWork(candidates, threadId);
    const primary = relevant[0];
    if (!primary) return { active: null, fleet: null };

    const rawMissionId = primary.planParentMissionId ?? primary.missionId;
    const missionId = rawMissionId ? ctx.db.normalizeId("missions", String(rawMissionId)) : null;
    if (!missionId) return buildFleetSnapshot({ threadId, activeRows: relevant });
    const mission = await ctx.db.query("missionRuntime").withIndex("by_mission", (q) => q.eq("missionId", missionId)).first();
    if (!mission) return buildFleetSnapshot({ threadId, activeRows: relevant });

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
      return buildFleetSnapshot({ threadId, activeRows: relevant, mission, nodes, edges, handoffs, activities });
    }

    const activities = await ctx.db.query("jobRuntime")
      .withIndex("by_mission", (q) => q.eq("missionId", String(missionId)))
      .take(FLEET_MAX_NODES + 1);
    if (activities.length > FLEET_MAX_NODES) throw new Error("Fleet projection exceeds its 8-node hot bound");
    return buildFleetSnapshot({ threadId, activeRows: relevant, mission, activities });
  },
});
