const safe = (value: unknown, fallback: string, max = 32) =>
  String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max) || fallback;

// Ledger ids are already short ASCII tokens in production. Keep that exact
// token in the ref instead of normalizing/truncating it: two distinct ids must
// never collapse onto one writable branch. The hexadecimal fallback is a
// lossless encoding for defensive callers with punctuation or Unicode ids.
const immutableId = (value: string) => /^[A-Za-z0-9_-]{1,96}$/.test(value)
  ? value
  : Array.from(new TextEncoder().encode(value), (byte) => byte.toString(16).padStart(2, "0")).join("");

export type WorkItemIdentity = Readonly<{
  workerBranch?: string;
  workerLineage: string;
  workspaceLineage: string;
  retryLineage: string;
}>;

/**
 * Repository work identities are derived only from immutable ledger ids.
 * Labels are included for operators, never for uniqueness. Attempts are not:
 * a safe retry resumes this exact branch lineage instead of inventing a new
 * branch that could replace or reparent already-reviewed history.
 */
export function workItemIdentity(args: {
  missionId: string;
  jobId: string;
  workstreamId?: string;
  readonly: boolean;
}): WorkItemIdentity {
  const mission = safe(args.missionId, "mission", 16);
  const job = immutableId(args.jobId);
  const retryLineage = `job:${args.jobId}:lineage:1`;
  return {
    workerBranch: args.readonly ? undefined : `jarvis/work/${mission}/${job}`,
    workerLineage: `worker:${args.jobId}:lineage:1`,
    workspaceLineage: `sandbox:${args.jobId}:lineage:1`,
    retryLineage,
  };
}

export function attemptWorkspaceKey(workspaceLineage: string, attempt: number) {
  return `${workspaceLineage}:attempt:${Math.max(1, Math.floor(attempt))}`;
}

export type DagNode = Readonly<{ id: string; dependsOn: readonly string[] }>;

/** Validate the persisted planner contract before any work item is inserted. */
export function validateWorkDag(nodes: readonly DagNode[], maxNodes: number) {
  if (nodes.length < 1 || nodes.length > maxNodes) throw new Error(`Goal DAG fanout must be bounded to 1-${maxNodes} workstreams`);
  const ids = new Set<string>();
  for (const node of nodes) {
    if (ids.has(node.id)) throw new Error(`Goal plan contains duplicate workstream id ${node.id}`);
    ids.add(node.id);
    if (node.dependsOn.length > maxNodes - 1) throw new Error(`Goal plan workstream ${node.id} has unbounded dependency fanout`);
  }
  for (const node of nodes) {
    const seen = new Set<string>();
    for (const dependency of node.dependsOn) {
      if (!ids.has(dependency)) throw new Error(`Goal plan workstream ${node.id} depends on unknown workstream ${dependency}`);
      if (dependency === node.id) throw new Error(`Goal plan workstream ${node.id} depends on itself`);
      if (seen.has(dependency)) throw new Error(`Goal plan workstream ${node.id} contains duplicate dependency ${dependency}`);
      seen.add(dependency);
    }
  }
  const remaining = new Set(ids);
  while (remaining.size) {
    const ready = nodes.filter((node) => remaining.has(node.id) && node.dependsOn.every((dependency) => !remaining.has(dependency)));
    if (!ready.length) throw new Error("Goal plan workstream dependencies contain a cycle");
    for (const node of ready) remaining.delete(node.id);
  }
}
