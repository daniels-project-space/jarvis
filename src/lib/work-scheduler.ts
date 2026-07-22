export const BACKGROUND_QUEUE = "jarvis-background-agents";
export const BACKGROUND_CONCURRENCY_LIMIT = 8;
export const DISPATCH_SCHEDULER_KEY = "background-fair-v1";

// A single executable project group may use most of the background fleet, but
// never all of it. Two reservations remain available for newly admitted work
// from another immutable mission/project group.
export const MAX_ACTIVE_PER_WORK_GROUP = BACKGROUND_CONCURRENCY_LIMIT - 2;
export const MAX_ACTIVE_PER_WRITE_LINEAGE = 1;

export type WorkGroupAuthority = Readonly<{
  missionGroupId: string;
  projectGroupId: string;
  projectRepository?: string;
  schedulingGroupKey: string;
}>;

type WorkLedgerIdentity = {
  _id?: unknown;
  jobId?: unknown;
  missionId?: unknown;
  planParentMissionId?: unknown;
  repo?: unknown;
};

const identityPart = (value: string) => encodeURIComponent(value).slice(0, 360);

/**
 * Derive scheduling authority only from immutable ledger ids and the
 * canonical repository persisted on the work item. Human labels, selected UI
 * projects, branches and latest pointers are deliberately absent.
 */
export function workGroupAuthority(job: WorkLedgerIdentity): WorkGroupAuthority {
  const jobId = String(job.jobId ?? job._id ?? "").trim();
  if (!jobId) throw new Error("A durable job id is required for scheduling authority");
  const admittedMission = String(job.planParentMissionId ?? job.missionId ?? `standalone:${jobId}`);
  const executableProject = String(job.missionId ?? admittedMission);
  const repository = typeof job.repo === "string" && job.repo.trim() ? job.repo.trim() : undefined;
  const repositoryScope = repository ?? "read-only-evidence";
  return {
    missionGroupId: admittedMission,
    projectGroupId: executableProject,
    projectRepository: repository,
    schedulingGroupKey: [
      "mission", identityPart(admittedMission),
      "project", identityPart(executableProject),
      "repository", identityPart(repositoryScope),
    ].join(":"),
  };
}

export function schedulingAuthorityMatches(
  job: WorkLedgerIdentity & Partial<WorkGroupAuthority>,
  expected = workGroupAuthority(job),
): boolean {
  return job.missionGroupId === expected.missionGroupId
    && job.projectGroupId === expected.projectGroupId
    && job.projectRepository === expected.projectRepository
    && job.schedulingGroupKey === expected.schedulingGroupKey;
}

export function immutableLineageIsValid(job: {
  _id?: unknown;
  jobId?: unknown;
  workspaceLineage?: unknown;
  retryLineage?: unknown;
  readonly?: unknown;
  repo?: unknown;
  workerBranch?: unknown;
}): boolean {
  const jobId = String(job.jobId ?? job._id ?? "").trim();
  if (!jobId) return false;
  if (job.workspaceLineage !== `sandbox:${jobId}:lineage:1`) return false;
  if (job.retryLineage !== `job:${jobId}:lineage:1`) return false;
  const writable = !job.readonly && typeof job.repo === "string" && job.repo.length > 0;
  return !writable || (typeof job.workerBranch === "string" && job.workerBranch.length > 0);
}

export function writeLineageKey(job: {
  readonly?: unknown;
  repo?: unknown;
  integrationAttemptId?: unknown;
  schedulingGroupKey?: unknown;
  workspaceLineage?: unknown;
}): string | null {
  if (job.readonly || typeof job.repo !== "string" || !job.repo) return null;
  // Integration controllers are the only writers of a mission's shared
  // integration head. Specialists write their unique immutable workspaces.
  if (job.integrationAttemptId) {
    return typeof job.schedulingGroupKey === "string"
      ? `integration:${job.schedulingGroupKey}`
      : null;
  }
  return typeof job.workspaceLineage === "string"
    ? `workspace:${job.workspaceLineage}`
    : null;
}

export type FairWorkCandidate = Readonly<{
  id: string;
  groupKey: string;
  priority: number;
  createdAt: number;
  writeLineage: string | null;
}>;

export type FairWorkGroupState = Readonly<{
  lastServedSequence: number;
  activeCount: number;
}>;

/**
 * Strict bounded round-robin across executable project groups. The oldest
 * service sequence wins; priority, creation time and the immutable key are
 * deterministic tie-breakers. Priority orders work inside a group and among
 * equally served groups, so urgent work is prompt but can never permanently
 * starve a lower-priority group.
 */
export function selectFairWork(
  candidates: readonly FairWorkCandidate[],
  groupStates: ReadonlyMap<string, FairWorkGroupState>,
  activeWriteLineages: ReadonlySet<string>,
  limit: number,
): FairWorkCandidate[] {
  const boundedLimit = Math.max(0, Math.min(BACKGROUND_CONCURRENCY_LIMIT, Math.floor(limit)));
  if (!boundedLimit) return [];
  const byGroup = new Map<string, FairWorkCandidate[]>();
  for (const candidate of candidates) {
    const rows = byGroup.get(candidate.groupKey) ?? [];
    rows.push(candidate);
    byGroup.set(candidate.groupKey, rows);
  }
  for (const rows of byGroup.values()) rows.sort((left, right) =>
    right.priority - left.priority
      || left.createdAt - right.createdAt
      || left.id.localeCompare(right.id));

  const groups = [...byGroup.entries()].map(([groupKey, rows]) => ({
    groupKey,
    rows,
    maxPriority: rows[0]?.priority ?? 0,
    oldestCreatedAt: Math.min(...rows.map((row) => row.createdAt)),
    state: groupStates.get(groupKey) ?? { lastServedSequence: 0, activeCount: 0 },
  })).filter((group) => group.state.activeCount < MAX_ACTIVE_PER_WORK_GROUP)
    .sort((left, right) =>
      left.state.lastServedSequence - right.state.lastServedSequence
        || right.maxPriority - left.maxPriority
        || left.oldestCreatedAt - right.oldestCreatedAt
        || left.groupKey.localeCompare(right.groupKey));

  const selected: FairWorkCandidate[] = [];
  const selectedByGroup = new Map<string, number>();
  const claimedLineages = new Map([...activeWriteLineages].map((lineage) => [lineage, 1]));
  while (selected.length < boundedLimit) {
    let advanced = false;
    for (const group of groups) {
      if (selected.length >= boundedLimit) break;
      const selectedCount = selectedByGroup.get(group.groupKey) ?? 0;
      if (group.state.activeCount + selectedCount >= MAX_ACTIVE_PER_WORK_GROUP) continue;
      const candidateIndex = group.rows.findIndex((candidate) =>
        !candidate.writeLineage
          || (claimedLineages.get(candidate.writeLineage) ?? 0) < MAX_ACTIVE_PER_WRITE_LINEAGE);
      if (candidateIndex < 0) continue;
      const [candidate] = group.rows.splice(candidateIndex, 1);
      selected.push(candidate);
      selectedByGroup.set(group.groupKey, selectedCount + 1);
      if (candidate.writeLineage) {
        claimedLineages.set(candidate.writeLineage, (claimedLineages.get(candidate.writeLineage) ?? 0) + 1);
      }
      advanced = true;
    }
    if (!advanced) break;
  }
  return selected;
}
