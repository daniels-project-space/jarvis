export const BACKGROUND_QUEUE = "jarvis-background-agents";
export const BACKGROUND_CONCURRENCY_LIMIT = 8;
export const DISPATCH_SCHEDULER_KEY = "background-fair-v1";
export const SCHEDULING_PROTOCOL_VERSION = 2;
export const DISPATCH_CANDIDATE_WINDOW_MAX = 96;

// A single executable project group may use most of the background fleet, but
// never all of it. Two reservations remain available for newly admitted work
// from another immutable mission/project group.
export const MAX_ACTIVE_PER_WORK_GROUP = BACKGROUND_CONCURRENCY_LIMIT - 2;
export const MAX_ACTIVE_PER_WRITE_LINEAGE = 1;

export type WorkGroupAuthority = Readonly<{
  missionGroupId: string;
  projectGroupId: string;
  canonicalProjectId: string;
  projectRepository?: string;
  schedulingGroupKey: string;
}>;

export type SchedulingBinding = WorkGroupAuthority & Readonly<{
  protocolVersion: typeof SCHEDULING_PROTOCOL_VERSION;
  jobId: string;
  readonly: boolean;
  sourceProvider: "github" | "none";
  sourceBranch?: string;
  sourceRef?: string;
  sourceHeadSha?: string;
  sourceObservedAt: number;
  sourceAdmissionDigest: string;
  workerBranch?: string;
  workerLineage: string;
  workspaceLineage: string;
  retryLineage: string;
  integrationBranch?: string;
  integrationLineage: string;
}>;

type WorkLedgerIdentity = {
  _id?: unknown;
  jobId?: unknown;
  missionId?: unknown;
  planParentMissionId?: unknown;
  repo?: unknown;
  canonicalProjectId?: unknown;
};

const identityPart = (value: string) => encodeURIComponent(value);

/**
 * Derive scheduling authority only from immutable ledger ids and the
 * canonical repository persisted on the work item. Human labels, selected UI
 * projects, branches and latest pointers are deliberately absent.
 */
export function workGroupAuthority(job: WorkLedgerIdentity): WorkGroupAuthority {
  const jobId = String(job.jobId ?? job._id ?? "").trim();
  if (!jobId) throw new Error("A durable job id is required for scheduling authority");
  const admittedMission = String(job.planParentMissionId ?? job.missionId ?? `standalone:${jobId}`);
  const repository = typeof job.repo === "string" && job.repo.trim() ? job.repo.trim() : undefined;
  const canonicalProjectId = typeof job.canonicalProjectId === "string" && job.canonicalProjectId.trim()
    ? job.canonicalProjectId.trim()
    : repository ? "unadmitted" : "evidence";
  const executableProject = `${String(job.missionId ?? admittedMission)}:project:${canonicalProjectId}`;
  const repositoryScope = repository ?? "read-only-evidence";
  return {
    missionGroupId: admittedMission,
    projectGroupId: executableProject,
    canonicalProjectId,
    projectRepository: repository,
    schedulingGroupKey: [
      "mission", identityPart(admittedMission),
      "project", identityPart(executableProject),
      "canonical", identityPart(canonicalProjectId),
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
    && job.canonicalProjectId === expected.canonicalProjectId
    && job.projectRepository === expected.projectRepository
    && job.schedulingGroupKey === expected.schedulingGroupKey;
}

/**
 * Canonical bytes hashed into the immutable admission ledger. The branch and
 * workspace values were already allocated from the durable job id; mutable
 * labels, UI state, source refs and "latest" pointers are intentionally absent.
 */
export function canonicalSchedulingBinding(binding: SchedulingBinding): string {
  return JSON.stringify({
    protocolVersion: binding.protocolVersion,
    jobId: binding.jobId,
    missionGroupId: binding.missionGroupId,
    projectGroupId: binding.projectGroupId,
    canonicalProjectId: binding.canonicalProjectId,
    projectRepository: binding.projectRepository ?? null,
    schedulingGroupKey: binding.schedulingGroupKey,
    readonly: binding.readonly,
    sourceProvider: binding.sourceProvider,
    sourceBranch: binding.sourceBranch ?? null,
    sourceRef: binding.sourceRef ?? null,
    sourceHeadSha: binding.sourceHeadSha ?? null,
    sourceObservedAt: binding.sourceObservedAt,
    sourceAdmissionDigest: binding.sourceAdmissionDigest,
    workerBranch: binding.workerBranch ?? null,
    workerLineage: binding.workerLineage,
    workspaceLineage: binding.workspaceLineage,
    retryLineage: binding.retryLineage,
    integrationBranch: binding.integrationBranch ?? null,
    integrationLineage: binding.integrationLineage,
  });
}

export function integrationLineageForAuthority(authority: WorkGroupAuthority): string {
  return [
    "integration",
    identityPart(authority.missionGroupId),
    identityPart(authority.projectGroupId),
    identityPart(authority.projectRepository ?? "evidence"),
    "lineage:1",
  ].join(":");
}

export function schedulingBindingForJob(job: WorkLedgerIdentity & {
  readonly?: unknown;
  sourceProvider?: unknown;
  sourceBranch?: unknown;
  sourceRef?: unknown;
  sourceHeadSha?: unknown;
  sourceObservedAt?: unknown;
  sourceAdmissionDigest?: unknown;
  workerBranch?: unknown;
  workerLineage?: unknown;
  workspaceLineage?: unknown;
  retryLineage?: unknown;
  integrationBranch?: unknown;
  integrationLineage?: unknown;
}): SchedulingBinding | null {
  const jobId = String(job.jobId ?? job._id ?? "").trim();
  if (!jobId || typeof job.workerLineage !== "string" || typeof job.workspaceLineage !== "string"
    || typeof job.retryLineage !== "string" || typeof job.integrationLineage !== "string"
    || !Number.isSafeInteger(job.sourceObservedAt) || typeof job.sourceAdmissionDigest !== "string") return null;
  const authority = workGroupAuthority(job);
  const readonly = Boolean(job.readonly || !authority.projectRepository);
  const workerBranch = typeof job.workerBranch === "string" && job.workerBranch ? job.workerBranch : undefined;
  if (!readonly && !workerBranch) return null;
  const sourceProvider = job.sourceProvider === "github" ? "github" : job.sourceProvider === "none" ? "none" : null;
  if (!sourceProvider) return null;
  const sourceBranch = typeof job.sourceBranch === "string" && job.sourceBranch ? job.sourceBranch : undefined;
  const sourceRef = typeof job.sourceRef === "string" && job.sourceRef ? job.sourceRef : undefined;
  const sourceHeadSha = typeof job.sourceHeadSha === "string" && job.sourceHeadSha ? job.sourceHeadSha : undefined;
  if (authority.projectRepository
    ? sourceProvider !== "github" || !sourceBranch || !sourceRef || !sourceHeadSha
    : sourceProvider !== "none" || sourceBranch || sourceRef || sourceHeadSha) return null;
  return {
    protocolVersion: SCHEDULING_PROTOCOL_VERSION,
    jobId,
    ...authority,
    readonly,
    sourceProvider,
    sourceBranch,
    sourceRef,
    sourceHeadSha,
    sourceObservedAt: Number(job.sourceObservedAt),
    sourceAdmissionDigest: job.sourceAdmissionDigest,
    workerBranch,
    workerLineage: job.workerLineage,
    workspaceLineage: job.workspaceLineage,
    retryLineage: job.retryLineage,
    integrationBranch: typeof job.integrationBranch === "string" && job.integrationBranch ? job.integrationBranch : undefined,
    integrationLineage: job.integrationLineage,
  };
}

export function projectedSchedulingBindingMatches(
  row: WorkLedgerIdentity & Partial<SchedulingBinding> & {
    schedulingProtocolVersion?: unknown;
    schedulingAdmissionId?: unknown;
    schedulingBindingDigest?: unknown;
  },
  binding: SchedulingBinding,
  admissionId: unknown,
  bindingDigest: string,
): boolean {
  return row.schedulingProtocolVersion === SCHEDULING_PROTOCOL_VERSION
    && String(row.schedulingAdmissionId ?? "") === String(admissionId ?? "")
    && row.schedulingBindingDigest === bindingDigest
    && schedulingAuthorityMatches(row, binding)
    && String(row.jobId ?? row._id ?? "") === binding.jobId
    && Boolean(row.readonly || !row.repo) === binding.readonly
    && row.sourceProvider === binding.sourceProvider
    && row.sourceBranch === binding.sourceBranch
    && row.sourceRef === binding.sourceRef
    && row.sourceHeadSha === binding.sourceHeadSha
    && row.sourceObservedAt === binding.sourceObservedAt
    && row.sourceAdmissionDigest === binding.sourceAdmissionDigest
    && row.workerBranch === binding.workerBranch
    && row.workerLineage === binding.workerLineage
    && row.workspaceLineage === binding.workspaceLineage
    && row.retryLineage === binding.retryLineage
    && row.integrationBranch === binding.integrationBranch
    && row.integrationLineage === binding.integrationLineage;
}

export function immutableLineageIsValid(job: {
  _id?: unknown;
  jobId?: unknown;
  workspaceLineage?: unknown;
  retryLineage?: unknown;
  workerLineage?: unknown;
  integrationLineage?: unknown;
  readonly?: unknown;
  repo?: unknown;
  workerBranch?: unknown;
}): boolean {
  const jobId = String(job.jobId ?? job._id ?? "").trim();
  if (!jobId) return false;
  if (job.workerLineage !== `worker:${jobId}:lineage:1`) return false;
  if (job.workspaceLineage !== `sandbox:${jobId}:lineage:1`) return false;
  if (job.retryLineage !== `job:${jobId}:lineage:1`) return false;
  let authority: WorkGroupAuthority;
  try { authority = workGroupAuthority(job); } catch { return false; }
  if (job.integrationLineage !== integrationLineageForAuthority(authority)) return false;
  const writable = !job.readonly && typeof job.repo === "string" && job.repo.length > 0;
  return !writable || (typeof job.workerBranch === "string" && job.workerBranch.length > 0);
}

export function canonicalAttemptAuthority(args: {
  binding: SchedulingBinding;
  bindingDigest: string;
  workOrderRevisionId: string;
  workOrderRevision: number;
  workOrderRevisionDigest: string;
  attempt: number;
}): string {
  return JSON.stringify({
    protocolVersion: args.binding.protocolVersion,
    bindingDigest: args.bindingDigest,
    workOrderRevisionId: args.workOrderRevisionId,
    workOrderRevision: Math.max(1, Math.floor(args.workOrderRevision)),
    workOrderRevisionDigest: args.workOrderRevisionDigest,
    missionGroupId: args.binding.missionGroupId,
    projectGroupId: args.binding.projectGroupId,
    canonicalProjectId: args.binding.canonicalProjectId,
    repository: args.binding.projectRepository ?? null,
    sourceBranch: args.binding.sourceBranch ?? null,
    sourceHeadSha: args.binding.sourceHeadSha ?? null,
    jobId: args.binding.jobId,
    attempt: Math.max(1, Math.floor(args.attempt)),
    workerLineage: args.binding.workerLineage,
    workspaceLineage: args.binding.workspaceLineage,
    retryLineage: args.binding.retryLineage,
    integrationLineage: args.binding.integrationLineage,
  });
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
  activeCount: number;
  lastServedSequence?: number;
}>;

/**
 * Strict bounded round-robin across executable project groups. A single
 * durable cursor names the last group served, so candidate selection never
 * needs an admission/group join for every row. Priority orders work inside a
 * group and chooses the first group only when no cursor exists; after that the
 * immutable group-key ring prevents permanent priority starvation.
 */
export function selectFairWork(
  candidates: readonly FairWorkCandidate[],
  groupStates: ReadonlyMap<string, FairWorkGroupState>,
  activeWriteLineages: ReadonlySet<string>,
  limit: number,
  lastServedGroupKey?: string,
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
    state: groupStates.get(groupKey) ?? { activeCount: 0 },
  })).filter((group) => group.state.activeCount < MAX_ACTIVE_PER_WORK_GROUP)
    .sort((left, right) => {
      const leftSequence = left.state.lastServedSequence;
      const rightSequence = right.state.lastServedSequence;
      if (leftSequence !== undefined || rightSequence !== undefined) {
        return Number(leftSequence ?? 0) - Number(rightSequence ?? 0)
          || right.maxPriority - left.maxPriority
          || left.oldestCreatedAt - right.oldestCreatedAt
          || left.groupKey.localeCompare(right.groupKey);
      }
      return left.groupKey.localeCompare(right.groupKey);
    });

  const hasServiceTickets = groups.some((group) => group.state.lastServedSequence !== undefined);
  if (!lastServedGroupKey && !hasServiceTickets) {
    groups.sort((left, right) =>
      right.maxPriority - left.maxPriority
        || left.oldestCreatedAt - right.oldestCreatedAt
        || left.groupKey.localeCompare(right.groupKey));
  } else if (lastServedGroupKey && !hasServiceTickets) {
    const afterCursor = groups.findIndex((group) => group.groupKey.localeCompare(lastServedGroupKey) > 0);
    const start = afterCursor < 0 ? 0 : afterCursor;
    groups.push(...groups.splice(0, start));
  }

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
