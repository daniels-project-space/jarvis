export type FleetNodeState =
  | "queued"
  | "dependency_held"
  | "dispatching"
  | "running"
  | "reviewing"
  | "integrating"
  | "paused"
  | "done"
  | "blocked"
  | "needs_input";

export type FleetAttentionKind = "approval" | "input" | "system" | "recovery";

export type FleetControl =
  | "pause"
  | "resume"
  | "cancel"
  | "steer"
  | "provide_input"
  | "approve"
  | "decline";

export type FleetSupervisorAuthority = {
  protocolVersion: 1;
  state: "ready" | "leased" | "waiting" | "paused" | "needs_input" | "terminal";
  inputRevision: number;
  steerRevision: number;
  deadlineAt: number;
  question?: string;
};

export type CompactWorkItem = {
  id: string;
  missionId: string | null;
  label: string;
  status: FleetNodeState;
  stage: string;
  percent: number;
  extraCount: number;
  needsDaniel: boolean;
};

export type FleetEdge = {
  id: string;
  source: string;
  target: string;
  readiness: "waiting" | "ready" | "delivered" | "blocked";
};

export type FleetNode = {
  id: string;
  jobId: string;
  label: string;
  agent: string;
  repository: string | null;
  state: FleetNodeState;
  status: string;
  stage: string;
  percent: number;
  progress: string;
  progressAt: number | null;
  model: string | null;
  reasoningEffort: string | null;
  modelReason: string | null;
  workerRuntime: string | null;
  workerRunId: string | null;
  generation: number;
  attempt: number;
  maxAttempts: number;
  dependencyCount: number;
  dependenciesReady: number;
  integrationState: string;
  deliveryStatus: string | null;
  mergeState: string;
  recoverySummary: string | null;
  needsDaniel: boolean;
  attentionKind?: FleetAttentionKind | null;
  attentionLabel?: string | null;
  attentionReason: string | null;
  controls: FleetControl[];
  startedAt: number | null;
  projectionKind?: "supervisor_planning";
};

export type FleetMission = {
  id: string;
  goal: string;
  mode: string;
  status: string;
  phase: string;
  percent: number;
  repository: string | null;
  planDigest: string | null;
  planGeneration: number | null;
  integrationState: string;
  attentionCount: number;
  controls: FleetControl[];
  supervisor?: FleetSupervisorAuthority;
  nodes: FleetNode[];
  edges: FleetEdge[];
};

export type FleetProjectGroup = {
  id: string;
  canonicalProjectId: string;
  repository: string | null;
  jobs: FleetNode[];
};

export type FleetMissionGroup = {
  id: string;
  label: string;
  status: string;
  phase: string;
  projects: FleetProjectGroup[];
};

export type CompactWorkSnapshot = {
  active: CompactWorkItem | null;
  fleet: FleetMission | null;
  hierarchy: FleetMissionGroup[];
};

export type CompactJobDetail = {
  jobId: string;
  status: string;
  attempt: number;
  stage: string;
  percent: number;
  progress: string;
  sourceBranch: string | null;
  sourceHeadSha: string | null;
  integrationBranch: string | null;
  workerBranch: string | null;
  branch: string | null;
  mergeCommitSha: string | null;
  label: string;
  agentId: string | null;
  repo: string | null;
  progressAt: number | null;
  model: string | null;
  reasoningEffort: string | null;
  modelReason: string | null;
  workerRuntime: string | null;
  workerRunId: string | null;
  generation: number;
  maxAttempts: number;
  integrationState: string | null;
  deliveryStatus: string | null;
  startedAt: number | null;
  stallReason: string | null;
};

export type CompactWorkCache = {
  threadId: string;
  snapshot: CompactWorkSnapshot;
} | null;

/**
 * A resolved server result is authoritative, including an explicit empty one.
 * While the same subscription is unresolved during a refresh, retain its last
 * result so the command centre does not flash out and back in.
 */
export function visibleWorkSnapshot(
  cache: CompactWorkCache,
  threadId: string,
  snapshot: CompactWorkSnapshot | undefined,
): CompactWorkSnapshot {
  if (snapshot !== undefined) return snapshot;
  return cache?.threadId === threadId ? cache.snapshot : { active: null, fleet: null, hierarchy: [] };
}

export function visibleCompactWork(
  cache: CompactWorkCache,
  threadId: string,
  snapshot: CompactWorkSnapshot | undefined,
): CompactWorkItem | null {
  return visibleWorkSnapshot(cache, threadId, snapshot).active;
}

export function cacheCompactWorkSnapshot(
  cache: CompactWorkCache,
  threadId: string,
  snapshot: CompactWorkSnapshot | undefined,
): CompactWorkCache {
  return snapshot === undefined ? cache : { threadId, snapshot };
}

/** A selection is explicit browser-session state; snapshots never choose it. */
export function retainedFleetSelection(selectedJobId: string | null, snapshot: CompactWorkSnapshot): string | null {
  if (!selectedJobId) return null;
  const inHierarchy = snapshot.hierarchy?.some((mission) => mission.projects
    .some((project) => project.jobs.some((node) => node.jobId === selectedJobId))) ?? false;
  return inHierarchy || snapshot.fleet?.nodes.some((node) => node.jobId === selectedJobId) ? selectedJobId : null;
}

export function needsDaniel(job: { status?: string; needsDaniel?: boolean }): boolean {
  return job.needsDaniel === true || job.status === "awaiting_approval" || job.status === "needs_input";
}
