import type { GoalPlan, GoalWorkstream } from "./goal-mode";
import { canonicalizeRepository } from "./workflow-contract";
import { validateWorkDag } from "./workspace-protocol";

export const GOAL_DAG_MAX_NODES = 8;
export const GOAL_DAG_MAX_DEPENDENCIES = GOAL_DAG_MAX_NODES - 1;
export const GOAL_HANDOFF_SUMMARY_MAX_CHARS = 1_200;
export const GOAL_HANDOFF_ARTIFACT_MAX = 8;

const text = (value: unknown, max: number) => String(value ?? "").trim().slice(0, max);
const list = (value: unknown, count: number, chars: number) =>
  (Array.isArray(value) ? value : []).map((item) => text(item, chars)).filter(Boolean).slice(0, count);

function canonicalWorkstream(value: GoalWorkstream): GoalWorkstream {
  const repository = value.repo
    ? canonicalizeRepository(value.repo, { allowShortName: true }) ?? undefined
    : undefined;
  if (value.repo && !repository) throw new Error(`Goal plan workstream ${value.id} has an invalid repository scope`);
  return {
    id: text(value.id, 80),
    label: text(value.label, 120),
    task: text(value.task, 4_000),
    agentId: value.agentId,
    repo: repository,
    readonly: value.readonly === true,
    dependsOn: list(value.dependsOn, GOAL_DAG_MAX_DEPENDENCIES, 80).sort(),
    acceptanceCriteria: list(value.acceptanceCriteria, 10, 500),
    mcp: [...new Set((Array.isArray(value.mcp) ? value.mcp : [])
      .filter((item): item is "playwright" | "context7" => item === "playwright" || item === "context7"))].sort(),
  };
}

/**
 * Canonical parent authority. Ordering in planner JSON is not executable
 * meaning, so nodes and dependency ids are sorted while all scoped text stays
 * byte-stable after the same bounded normalization used at acceptance.
 */
export function canonicalGoalPlan(value: GoalPlan, maxNodes = GOAL_DAG_MAX_NODES): GoalPlan {
  if (!value || !Array.isArray(value.workstreams)) throw new Error("Goal plan workstreams are required");
  const workstreams = value.workstreams.map(canonicalWorkstream).sort((a, b) => a.id.localeCompare(b.id));
  validateWorkDag(workstreams, Math.min(GOAL_DAG_MAX_NODES, maxNodes));
  for (const stream of workstreams) {
    if (!stream.id || !stream.label || stream.task.length < 1) throw new Error("Goal plan contains an incomplete workstream");
  }
  const primaryRepo = value.primaryRepo
    ? canonicalizeRepository(value.primaryRepo, { allowShortName: true }) ?? undefined
    : undefined;
  if (value.primaryRepo && !primaryRepo) throw new Error("Goal plan primary repository is invalid");
  return {
    summary: text(value.summary, 1_000),
    route: value.route,
    primaryRepo,
    assumptions: list(value.assumptions, 12, 500).sort(),
    workstreams,
    validation: {
      criteria: list(value.validation?.criteria, 12, 500),
      tests: list(value.validation?.tests, 12, 500),
      liveChecks: list(value.validation?.liveChecks, 12, 500),
    },
    ...(value.factory ? { factory: {
      name: text(value.factory.name, 120), slug: text(value.factory.slug, 120), brief: text(value.factory.brief, 4_000),
    } } : {}),
  };
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)]),
  );
  return value;
}

export function canonicalGoalPlanJson(value: GoalPlan, maxNodes = GOAL_DAG_MAX_NODES) {
  return JSON.stringify(canonicalValue(canonicalGoalPlan(value, maxNodes)));
}

export function topologicalGoalWorkstreams(workstreams: readonly GoalWorkstream[]) {
  validateWorkDag(workstreams, GOAL_DAG_MAX_NODES);
  const remaining = new Map(workstreams.map((stream) => [stream.id, stream]));
  const emitted = new Set<string>();
  const ordered: GoalWorkstream[] = [];
  while (remaining.size) {
    const ready = [...remaining.values()]
      .filter((stream) => stream.dependsOn.every((dependency) => emitted.has(dependency)))
      .sort((a, b) => a.id.localeCompare(b.id));
    if (!ready.length) throw new Error("Goal plan workstream dependencies contain a cycle");
    for (const stream of ready) {
      remaining.delete(stream.id);
      emitted.add(stream.id);
      ordered.push(stream);
    }
  }
  return ordered;
}

export function goalDagEdgeId(sourceNodeId: string, targetNodeId: string) {
  return `${sourceNodeId}->${targetNodeId}`;
}

