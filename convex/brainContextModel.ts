export const BRAIN_CONTEXT_KEY = "foreground";
export const BRAIN_CONTEXT_VERSION = 2;
export const BRAIN_MEMORY_VERSION = 1;
export const BRAIN_ACTIVE_INDEX_VERSION = 1;
export const MAX_PROJECTION_PAYLOAD_BYTES = 30_000;
export const MAX_MEMORY_MATCHES = 4;

export const ACTIVE_CONTEXT_SOURCES = ["job", "mission", "goal", "attention"] as const;
export type ActiveContextSource = (typeof ACTIVE_CONTEXT_SOURCES)[number];

export const ACTIVE_CONTEXT_LIMITS: Record<ActiveContextSource, number> = {
  job: 10,
  mission: 6,
  goal: 12,
  attention: 8,
};

export const CONTEXT_SOURCES = [
  "memory",
  "business",
  "projects",
  "work",
  "attention",
  "artifacts",
  "ui",
] as const;

export type ContextSource = (typeof CONTEXT_SOURCES)[number];

export type ContextSourceMeta = {
  provenance: string[];
  sourceUpdatedAt: number;
  refreshedAt: number;
};

export type BrainContextPayload = {
  memory: any[];
  business: any[];
  projects: any[];
  goals: any[];
  goalMissions: any[];
  jobs: any[];
  findings: any[];
  trip: any | null;
  draft: any | null;
  location: any | null;
  panel: any | null;
  creations: any[];
  agents: any[];
  attention: any[];
  approvals: any[];
  sources: Partial<Record<ContextSource, ContextSourceMeta>>;
  generatedAt: number;
};

const ACTIVE_WORK_STATUSES = new Set([
  "dispatching",
  "running",
  "pending",
  "awaiting_approval",
  "paused",
  "needs_input",
]);
const ACTIVE_MISSION_STATUSES = new Set(["running", "paused", "needs_input"]);
const ACTIVE_GOAL_STATUSES = new Set(["active", "blocked"]);
const ACTIVE_ATTENTION_STATUSES = new Set(["open", "working"]);

function text(value: unknown, limit: number): string {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, limit);
}

function optionalText(value: unknown, limit: number): string | undefined {
  const compact = text(value, limit);
  return compact || undefined;
}

function finite(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function defined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function withoutVolatileTimestamps<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  const { updatedAt: _updatedAt, createdAt: _createdAt, ...stable } = value;
  return stable;
}

export function estimateJsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function emptyBrainContext(generatedAt = 0): BrainContextPayload {
  return {
    memory: [],
    business: [],
    projects: [],
    goals: [],
    goalMissions: [],
    jobs: [],
    findings: [],
    trip: null,
    draft: null,
    location: null,
    panel: null,
    creations: [],
    agents: [],
    attention: [],
    approvals: [],
    sources: {},
    generatedAt,
  };
}

export function sourceMeta(
  provenance: string[],
  rows: readonly any[],
  refreshedAt: number,
): ContextSourceMeta {
  const sourceUpdatedAt = rows.reduce(
    (latest, row) => Math.max(
      latest,
      finite(row?.sourceUpdatedAt),
      finite(row?.updatedAt),
      finite(row?.createdAt),
      finite(row?._creationTime),
    ),
    0,
  );
  return { provenance, sourceUpdatedAt, refreshedAt };
}

export function projectMemoryRow(row: any) {
  const title = text(row?.title, 120);
  const body = text(row?.body, 700);
  const tags = Array.isArray(row?.tags) ? row.tags.map((tag: unknown) => text(tag, 40)).filter(Boolean).slice(0, 8) : [];
  return {
    sourceId: row?._id ?? row?.sourceId,
    kind: text(row?.kind, 30) || "knowledge",
    title,
    body,
    tags,
    searchText: text(`${title}\n${tags.join(" ")}\n${body}`, 1_000),
    sourceCreatedAt: finite(row?.createdAt ?? row?.sourceCreatedAt ?? row?._creationTime),
    sourceUpdatedAt: finite(row?.updatedAt ?? row?.sourceUpdatedAt ?? row?.createdAt ?? row?._creationTime),
  };
}

export function memoryDto(row: any) {
  return {
    id: String(row?.sourceId ?? row?._id ?? ""),
    kind: text(row?.kind, 30),
    title: text(row?.title, 120),
    body: text(row?.body, 700),
    tags: Array.isArray(row?.tags) ? row.tags.map((tag: unknown) => text(tag, 40)).filter(Boolean).slice(0, 8) : [],
    updatedAt: finite(row?.sourceUpdatedAt ?? row?.updatedAt ?? row?.createdAt),
  };
}

export function mergeMemoryDtos(matches: readonly any[], recent: readonly any[], limit = 8) {
  const seen = new Set<string>();
  return [...matches, ...recent]
    .map(memoryDto)
    .filter((row) => {
      const key = row.id || `${row.kind}:${row.title}:${row.updatedAt}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return Boolean(row.title || row.body);
    })
    .slice(0, limit);
}

export function compactBusiness(row: any) {
  return defined({
    domain: text(row?.domain, 40),
    headline: text(row?.headline, 220),
    detail: optionalText(row?.detail, 300),
    updatedAt: finite(row?.updatedAt),
  });
}

export function compactProject(row: any) {
  const data = row?.data && typeof row.data === "object" ? row.data : {};
  const objectives = Array.isArray(data.objectives)
    ? data.objectives.map((item: unknown) => text(item, 160)).filter(Boolean).slice(0, 2)
    : [];
  return {
    slug: text(row?.slug, 80),
    status: text(row?.status, 30),
    summary: text(row?.summary, 240),
    data: defined({
      purpose: optionalText(data.purpose, 240),
      vision: optionalText(data.vision, 220),
      objectives: objectives.length ? objectives : undefined,
      recent: optionalText(data.recent, 220),
    }),
    updatedAt: finite(row?.updatedAt),
  };
}

export function compactGoal(row: any) {
  return defined({
    id: String(row?._id ?? ""),
    project: text(row?.project, 80),
    title: text(row?.title, 160),
    outcome: text(row?.outcome, 420),
    status: text(row?.status, 30),
    priority: Math.max(0, Math.min(100, finite(row?.priority, 50))),
    progress: Math.max(0, Math.min(100, finite(row?.progress))),
    nextAction: optionalText(row?.nextAction, 260),
    blockedBy: optionalText(row?.blockedBy, 260),
    updatedAt: finite(row?.updatedAt),
  });
}

export function isActiveWork(row: any): boolean {
  return ACTIVE_WORK_STATUSES.has(String(row?.status ?? ""));
}

export function compactJob(row: any) {
  return defined({
    id: String(row?.jobId ?? row?._id ?? ""),
    agentId: optionalText(row?.agentId, 40),
    label: optionalText(row?.label, 100),
    task: text(row?.task, 180),
    status: text(row?.status, 32),
    stage: text(row?.stage, 60),
    percent: Math.max(0, Math.min(100, finite(row?.percent))),
    priority: Math.max(0, Math.min(100, finite(row?.priority, 50))),
    attempt: Math.max(1, finite(row?.attempt, 1)),
    updatedAt: finite(row?.updatedAt),
  });
}

export function compactMission(row: any) {
  return defined({
    id: String(row?.missionId ?? row?._id ?? ""),
    goal: text(row?.goal, 360),
    status: text(row?.status, 32),
    phase: text(row?.phase, 60),
    percent: Math.max(0, Math.min(100, finite(row?.percent))),
    route: optionalText(row?.route, 50),
    revisionWave: Math.max(0, finite(row?.revisionWave)),
    failureReason: optionalText(row?.failureReason, 300),
    externalStatus: optionalText(row?.externalStatus, 50),
    externalStage: optionalText(row?.externalStage, 60),
    updatedAt: finite(row?.updatedAt),
  });
}

export function isActiveGoalMission(row: any): boolean {
  return row?.mode === "goal" && ACTIVE_MISSION_STATUSES.has(String(row?.status ?? ""));
}

export function isActiveGoal(row: any): boolean {
  return ACTIVE_GOAL_STATUSES.has(String(row?.status ?? ""));
}

export function isActiveAttention(row: any): boolean {
  return ACTIVE_ATTENTION_STATUSES.has(String(row?.status ?? ""));
}

export function compactFinding(row: any) {
  return {
    id: String(row?._id ?? ""),
    spoken: text(row?.spoken, 360),
    createdAt: finite(row?.createdAt),
  };
}

export function compactAttention(row: any) {
  return defined({
    id: String(row?._id ?? ""),
    project: optionalText(row?.project, 80),
    title: text(row?.title, 160),
    detail: text(row?.detail, 420),
    severity: text(row?.severity, 30),
    impact: Math.max(0, Math.min(100, finite(row?.impact))),
    urgency: Math.max(0, Math.min(100, finite(row?.urgency))),
    confidence: Math.max(0, Math.min(1, finite(row?.confidence))),
    actionClass: text(row?.actionClass, 40),
    status: text(row?.status, 30),
    updatedAt: finite(row?.updatedAt),
  });
}

export function compactApproval(row: any) {
  return {
    jobId: text(row?.jobId, 120),
    summary: text(row?.summary, 320),
    risk: text(row?.risk, 30),
    requestedAt: finite(row?.requestedAt),
  };
}

export function compactCreation(row: any) {
  return defined({
    id: String(row?._id ?? ""),
    kind: text(row?.kind, 40),
    title: text(row?.title, 120),
    category: optionalText(row?.category, 80),
    folder: optionalText(row?.folder, 140),
    project: optionalText(row?.project, 80),
    inquiry: optionalText(row?.inquiry, 80),
    updatedAt: finite(row?.updatedAt),
  });
}

export function compactTrip(row: any): any | null {
  if (!row?.data) return null;
  try {
    const value = JSON.parse(String(row.data));
    const activities = Array.isArray(value?.locked?.activities)
      ? value.locked.activities.map((item: unknown) => text(item, 100)).filter(Boolean).slice(0, 12)
      : [];
    return defined({
      id: String(row._id ?? ""),
      title: text(value?.title ?? row.title, 160),
      status: text(value?.status, 40),
      budgetGbp: finite(value?.budgetGbp),
      projectedTotal: finite(value?.totals?.projectedTotal ?? value?.totals?.total),
      lockedTotal: finite(value?.totals?.lockedTotal),
      flight: value?.locked?.flight
        ? defined({ airline: optionalText(value.locked.flight.airline, 80), priceGbp: finite(value.locked.flight.priceGbp) })
        : undefined,
      stay: value?.locked?.stay
        ? defined({ name: optionalText(value.locked.stay.name, 120), totalGbp: finite(value.locked.stay.totalGbp) })
        : undefined,
      activities,
      transfer: value?.transfer
        ? defined({
            durationText: optionalText(value.transfer.durationText, 80),
            distanceText: optionalText(value.transfer.distanceText, 80),
            mode: optionalText(value.transfer.mode, 50),
          })
        : undefined,
      updatedAt: finite(row.updatedAt),
    });
  } catch {
    return null;
  }
}

export function compactDraft(row: any): any | null {
  if (!row?.data) return null;
  return {
    id: String(row._id ?? ""),
    title: text(row.title, 120),
    data: String(row.data).slice(0, 2_500),
    updatedAt: finite(row.updatedAt),
  };
}

export function compactUi(row: any): any | null {
  if (!row) return null;
  const base = defined({
    key: text(row.key, 40),
    type: text(row.type, 40),
    title: optionalText(row.title, 160),
    updatedAt: finite(row.updatedAt),
  });
  if (row.key === "location") return { ...base, value: text(row.value, 120) };
  if (row.key !== "panel" || row.type !== "widget") return base;
  try {
    const widget = JSON.parse(String(row.value));
    const items = Array.isArray(widget?.items)
      ? widget.items.slice(0, 12).map((item: any) => defined({
          rank: finite(item?.rank),
          name: text(item?.name, 100),
          bio: optionalText(item?.bio, 220),
        }))
      : undefined;
    return {
      ...base,
      value: JSON.stringify(defined({
        kind: optionalText(widget?.kind, 50),
        title: optionalText(widget?.title, 160),
        items,
      })).slice(0, 3_000),
    };
  } catch {
    return base;
  }
}

export function compactAgent(profile: any, jobs: readonly any[]) {
  const owned = jobs.filter((job) => job.agentId === profile?.slug);
  const executing = owned.find((job) => job.status === "running" || job.status === "pending");
  const blocked = owned.find((job) => ["needs_input", "paused", "awaiting_approval"].includes(job.status));
  return {
    slug: text(profile?.slug, 40),
    name: text(profile?.name, 80),
    role: text(profile?.role, 140),
    status: executing ? "working" : blocked ? "blocked" : "available",
    activeJobCount: owned.length,
    currentJobId: executing?.id ?? blocked?.id,
    updatedAt: Math.max(finite(profile?.updatedAt), ...owned.map((job) => finite(job.updatedAt)), 0),
  };
}

export type ContextActiveRecord = {
  version: number;
  source: ActiveContextSource;
  sourceId: string;
  rank: number;
  tieBreakAt: number;
  payload: Record<string, unknown>;
  materialKey: string;
  sourceUpdatedAt: number;
};

// Active operational rows are projected into a dedicated rank index. The
// foreground DTO rebuild can therefore read the true global top-N directly;
// it never takes a recent prefix and filters active rows afterwards.
export function contextActiveRecord(
  source: ActiveContextSource,
  row: any,
): ContextActiveRecord | null {
  let active = false;
  let sourceId = "";
  let rank = 0;
  let payload: Record<string, unknown> = {};

  if (source === "job") {
    active = isActiveWork(row);
    sourceId = String(row?.jobId ?? row?._id ?? "");
    rank = Math.max(0, Math.min(100, finite(row?.priority, 50)));
    payload = compactJob(row);
  } else if (source === "mission") {
    active = isActiveGoalMission(row);
    sourceId = String(row?.missionId ?? row?._id ?? "");
    rank = Math.max(0, Math.min(100, finite(row?.priority, 50)));
    payload = compactMission(row);
  } else if (source === "goal") {
    active = isActiveGoal(row);
    sourceId = String(row?._id ?? "");
    rank = Math.max(0, Math.min(100, finite(row?.priority, 50)));
    payload = compactGoal(row);
  } else {
    active = isActiveAttention(row);
    sourceId = String(row?._id ?? "");
    rank = Math.max(0, finite(row?.impact))
      * Math.max(0, finite(row?.urgency))
      * Math.max(0, Math.min(1, finite(row?.confidence)));
    payload = compactAttention(row);
  }

  if (!active || !sourceId) return null;
  const sourceUpdatedAt = finite(row?.updatedAt ?? row?.createdAt ?? row?._creationTime);
  const tieBreakAt = finite(row?.createdAt ?? row?._creationTime ?? sourceUpdatedAt);
  return {
    version: BRAIN_ACTIVE_INDEX_VERSION,
    source,
    sourceId,
    rank,
    tieBreakAt,
    payload,
    materialKey: stableJson({ rank, payload: withoutVolatileTimestamps(payload) }),
    sourceUpdatedAt,
  };
}

export function contextActiveMaterialChanged(previous: any | null, next: ContextActiveRecord | null): boolean {
  if (!previous && !next) return false;
  if (!previous || !next) return true;
  return previous.version !== next.version || previous.materialKey !== next.materialKey;
}

export function attentionSourceMaterialKey(row: any): string {
  return stableJson({
    fingerprint: row?.fingerprint,
    project: row?.project,
    title: row?.title,
    detail: row?.detail,
    evidence: Array.isArray(row?.evidence) ? row.evidence : undefined,
    severity: row?.severity,
    impact: finite(row?.impact),
    urgency: finite(row?.urgency),
    confidence: finite(row?.confidence),
    actionClass: row?.actionClass,
    status: row?.status,
    jobId: row?.jobId,
  });
}

export function materiallyDifferentAttention(previous: any | null, next: any): boolean {
  return !previous || attentionSourceMaterialKey(previous) !== attentionSourceMaterialKey(next);
}

export function materiallyDifferentGoal(previous: any | null, next: any): boolean {
  if (!previous) return isActiveGoal(next);
  const previousRecord = contextActiveRecord("goal", previous);
  const nextRecord = contextActiveRecord("goal", next);
  return contextActiveMaterialChanged(previousRecord, nextRecord);
}

export function materiallyDifferentArtifact(previous: any | null, next: any | null): boolean {
  if (!previous || !next) return previous !== next;
  const compact = (row: any) => ({
    creation: withoutVolatileTimestamps(compactCreation(row)),
    trip: row?.kind === "trip" ? withoutVolatileTimestamps(compactTrip(row) ?? {}) : null,
    draft: row?.kind === "doc" ? withoutVolatileTimestamps(compactDraft(row) ?? {}) : null,
  });
  return stableJson(compact(previous)) !== stableJson(compact(next));
}

export function materiallyDifferentUi(previous: any | null, next: any | null): boolean {
  if (!previous || !next) return previous !== next;
  return stableJson(withoutVolatileTimestamps(compactUi(previous) ?? {}))
    !== stableJson(withoutVolatileTimestamps(compactUi(next) ?? {}));
}

function capStrings(value: unknown, maxLength: number): unknown {
  if (typeof value === "string") return value.slice(0, maxLength);
  if (Array.isArray(value)) return value.map((item) => capStrings(item, maxLength));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, capStrings(item, maxLength)]));
  }
  return value;
}

// The source compactors already impose field caps. This final budget protects
// the invariant even if a future segment adds an accidentally rich field.
export function fitBrainContextPayload(input: BrainContextPayload): BrainContextPayload {
  let payload = JSON.parse(JSON.stringify(input)) as BrainContextPayload;
  const reductions: Array<[keyof BrainContextPayload, number]> = [
    ["projects", 8],
    ["goals", 6],
    ["jobs", 6],
    ["attention", 4],
    ["creations", 6],
    ["memory", 4],
    ["findings", 4],
    ["goalMissions", 3],
    ["business", 4],
  ];
  while (estimateJsonBytes(payload) > MAX_PROJECTION_PAYLOAD_BYTES) {
    const reducible = reductions.find(([key, minimum]) => {
      const value = payload[key];
      return Array.isArray(value) && value.length > minimum;
    });
    if (!reducible) break;
    (payload[reducible[0]] as any[]).pop();
  }
  if (estimateJsonBytes(payload) > MAX_PROJECTION_PAYLOAD_BYTES && payload.draft?.data?.length > 800) {
    payload.draft.data = payload.draft.data.slice(0, 800);
  }
  for (const limit of [420, 300, 220, 160, 120]) {
    if (estimateJsonBytes(payload) <= MAX_PROJECTION_PAYLOAD_BYTES) break;
    payload = capStrings(payload, limit) as BrainContextPayload;
  }
  if (estimateJsonBytes(payload) > MAX_PROJECTION_PAYLOAD_BYTES) {
    // This branch should be unreachable with the minimums above, but it keeps
    // the database invariant safe if an object-valued source grows later.
    payload = capStrings({
      ...payload,
      projects: payload.projects.slice(0, 6),
      goals: payload.goals.slice(0, 4),
      jobs: payload.jobs.slice(0, 4),
      attention: payload.attention.slice(0, 3),
      creations: payload.creations.slice(0, 4),
      memory: payload.memory.slice(0, 4),
    }, 80) as BrainContextPayload;
  }
  return payload;
}

function percentBucket(value: unknown): number {
  return Math.floor(Math.max(0, Math.min(100, finite(value))) / 10);
}

export function materiallyDifferentWork(previous: any | null, next: any): boolean {
  if (!previous) return isActiveWork(next);
  if (!isActiveWork(previous) && !isActiveWork(next)) return false;
  for (const field of ["status", "stage", "task", "label", "agentId", "attempt", "priority"]) {
    if (previous?.[field] !== next?.[field]) return true;
  }
  return percentBucket(previous?.percent) !== percentBucket(next?.percent);
}

export function materiallyDifferentMission(previous: any | null, next: any): boolean {
  if (!previous) return isActiveGoalMission(next);
  if (!isActiveGoalMission(previous) && !isActiveGoalMission(next)) return false;
  for (const field of ["status", "phase", "goal", "failureReason", "externalStatus", "externalStage", "revisionWave"]) {
    if (previous?.[field] !== next?.[field]) return true;
  }
  return percentBucket(previous?.percent) !== percentBucket(next?.percent);
}
