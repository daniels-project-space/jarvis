import { internal } from "./_generated/api";
import { internalMutation, mutation } from "./_generated/server";
import { v } from "convex/values";
import { actorAuthArgs, requireActor } from "./controlAuth";
import {
  ACTIVE_CONTEXT_LIMITS,
  ACTIVE_CONTEXT_SOURCES,
  BRAIN_ACTIVE_INDEX_VERSION,
  BRAIN_CONTEXT_KEY,
  BRAIN_CONTEXT_VERSION,
  BRAIN_MEMORY_VERSION,
  CONTEXT_SOURCES,
  type ActiveContextSource,
  type BrainContextPayload,
  type ContextSource,
  compactAgent,
  compactApproval,
  compactAttention,
  compactBusiness,
  compactCreation,
  compactDraft,
  compactFinding,
  compactGoal,
  compactJob,
  compactMission,
  compactProject,
  compactTrip,
  compactUi,
  contextActiveMaterialChanged,
  contextActiveRecord,
  emptyBrainContext,
  estimateJsonBytes,
  fitBrainContextPayload,
  materiallyDifferentAttention,
  memoryDto,
  projectMemoryRow,
  sourceMeta,
} from "./brainContextModel";

export const REFRESH_DELAY_MS = 400;
export const REFRESH_LEASE_MS = 60_000;
export const MEMORY_BACKFILL_PAGE = 32;
export const ACTIVE_BACKFILL_PAGE = 32;

const ACTIVE_DEPENDENT_SOURCES = new Set<ContextSource>(["projects", "work", "attention"]);
const ACTIVE_SOURCE_SEQUENCE: readonly ActiveContextSource[] = ACTIVE_CONTEXT_SOURCES;
const ACTIVE_JOB_STATUSES = [
  "dispatching",
  "running",
  "pending",
  "awaiting_approval",
  "paused",
  "needs_input",
] as const;
const ACTIVE_MISSION_STATUSES = ["running", "paused", "needs_input"] as const;
const contextInternal = (internal as any).contextProjection;

function uniqueSources(values: readonly string[]): ContextSource[] {
  const allowed = new Set<string>(CONTEXT_SOURCES);
  return [...new Set(values.filter((value): value is ContextSource => allowed.has(value)))];
}

function sameSources(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((source) => right.includes(source));
}

export function remainingDirtySources(
  dirty: readonly ContextSource[],
  processed: readonly ContextSource[],
): ContextSource[] {
  return uniqueSources(dirty).filter((source) => !processed.includes(source));
}

function activeIndexReady(state: any): boolean {
  return state?.activeIndexVersion === BRAIN_ACTIVE_INDEX_VERSION && state?.activeIndexComplete === true;
}

function sourceIdFor(source: ActiveContextSource, row: any): string {
  if (source === "job") return String(row?.jobId ?? row?._id ?? "");
  if (source === "mission") return String(row?.missionId ?? row?._id ?? "");
  return String(row?._id ?? "");
}

async function projectionRow(ctx: any) {
  return await ctx.db
    .query("brainContextProjection")
    .withIndex("by_key", (q: any) => q.eq("key", BRAIN_CONTEXT_KEY))
    .first();
}

async function refreshState(ctx: any) {
  return await ctx.db
    .query("brainContextRefresh")
    .withIndex("by_key", (q: any) => q.eq("key", BRAIN_CONTEXT_KEY))
    .first();
}

export async function upsertBrainMemory(ctx: any, source: any) {
  const compact = projectMemoryRow(source);
  if (!compact.sourceId) return false;
  const existing = await ctx.db
    .query("brainMemory")
    .withIndex("by_source", (q: any) => q.eq("sourceId", compact.sourceId))
    .first();
  const same = existing
    && existing.kind === compact.kind
    && existing.title === compact.title
    && existing.body === compact.body
    && JSON.stringify(existing.tags) === JSON.stringify(compact.tags)
    && existing.searchText === compact.searchText
    && existing.sourceCreatedAt === compact.sourceCreatedAt
    && existing.sourceUpdatedAt === compact.sourceUpdatedAt;
  if (same) return false;
  if (existing) await ctx.db.replace(existing._id, compact);
  else await ctx.db.insert("brainMemory", compact);
  return true;
}

// Writers and the resumable legacy migration share this one transaction-local
// helper. It inserts only active rows, deletes rows that leave the active set,
// and ignores timestamp-only churn such as job heartbeats.
export async function syncContextActiveRow(
  ctx: any,
  source: ActiveContextSource,
  row: any,
): Promise<boolean> {
  const sourceId = sourceIdFor(source, row);
  if (!sourceId) return false;
  const existing = await ctx.db
    .query("brainContextActive")
    .withIndex("by_source_id", (q: any) => q.eq("source", source).eq("sourceId", sourceId))
    .first();
  const projected = contextActiveRecord(source, row);
  if (!projected) {
    if (!existing) return false;
    await ctx.db.delete(existing._id);
    return true;
  }
  if (!contextActiveMaterialChanged(existing, projected)) return false;
  if (existing) await ctx.db.replace(existing._id, projected);
  else await ctx.db.insert("brainContextActive", projected);
  return true;
}

// Every attention producer uses this helper. Source rows retain full evidence,
// while the compact active index and context refresh move only on a material
// foreground-visible change.
export async function upsertAttentionWithContext(
  ctx: any,
  existing: any | null,
  value: Record<string, unknown>,
  now = Date.now(),
) {
  const candidate = {
    ...(existing ?? {}),
    ...value,
    createdAt: existing?.createdAt ?? value.createdAt ?? now,
    updatedAt: now,
  };
  if (existing && !materiallyDifferentAttention(existing, candidate)) {
    return { id: existing._id, changed: false, contextChanged: false, created: false, row: existing };
  }

  let id = existing?._id;
  if (existing) {
    const {
      _id: _ignoredId,
      _creationTime: _ignoredCreationTime,
      createdAt: _ignoredCreatedAt,
      ...patch
    } = candidate;
    await ctx.db.patch(existing._id, patch);
  } else {
    const { _id: _ignoredId, _creationTime: _ignoredCreationTime, ...insert } = candidate;
    id = await ctx.db.insert("attentionItems", insert);
  }
  const row = { ...candidate, _id: id };
  const contextChanged = await syncContextActiveRow(ctx, "attention", row);
  if (contextChanged) await requestContextRefresh(ctx, ["attention"]);
  return { id, changed: true, contextChanged, created: !existing, row };
}

function activeBackfillPosition(state: any): { source: ActiveContextSource; cursor: string | null } {
  const source = ACTIVE_SOURCE_SEQUENCE.includes(state?.activeBackfillSource)
    ? state.activeBackfillSource as ActiveContextSource
    : ACTIVE_SOURCE_SEQUENCE[0];
  return { source, cursor: state?.activeBackfillCursor ?? null };
}

export async function requestContextRefresh(ctx: any, requested: readonly ContextSource[]) {
  const now = Date.now();
  const state = await refreshState(ctx);
  const versionChanged = !state || state.version !== BRAIN_CONTEXT_VERSION;
  const indexVersionChanged = !state || state.activeIndexVersion !== BRAIN_ACTIVE_INDEX_VERSION;
  const currentDirty = versionChanged ? [...CONTEXT_SOURCES] : uniqueSources(state.dirtySources ?? []);
  const dirtySources = uniqueSources([...currentDirty, ...requested]);
  const ready = !indexVersionChanged && activeIndexReady(state);
  const refreshable = ready
    ? dirtySources
    : dirtySources.filter((source) => !ACTIVE_DEPENDENT_SOURCES.has(source));
  const refreshLeaseHealthy = Boolean(
    !versionChanged && state?.scheduledAt && now - state.scheduledAt < REFRESH_LEASE_MS,
  );
  const activeLeaseHealthy = Boolean(
    !indexVersionChanged
      && !ready
      && state?.activeBackfillScheduledAt
      && now - state.activeBackfillScheduledAt < REFRESH_LEASE_MS,
  );
  const needsRefreshSchedule = refreshable.length > 0 && !refreshLeaseHealthy;
  const needsActiveSchedule = !ready && !activeLeaseHealthy;
  const dirtyChanged = !state || !sameSources(dirtySources, uniqueSources(state.dirtySources ?? []));

  if (state && !versionChanged && !dirtyChanged && !needsRefreshSchedule && !needsActiveSchedule) return;

  const generation = (state?.generation ?? 0) + (needsRefreshSchedule ? 1 : 0);
  const position = indexVersionChanged
    ? { source: ACTIVE_SOURCE_SEQUENCE[0], cursor: null }
    : activeBackfillPosition(state);
  if (needsRefreshSchedule) {
    await ctx.scheduler.runAfter(REFRESH_DELAY_MS, contextInternal.refresh, { generation });
  }
  if (needsActiveSchedule) {
    await ctx.scheduler.runAfter(0, contextInternal.backfillActive, {
      version: BRAIN_ACTIVE_INDEX_VERSION,
      source: position.source,
      cursor: position.cursor,
    });
  }

  const common = {
    key: BRAIN_CONTEXT_KEY,
    version: BRAIN_CONTEXT_VERSION,
    generation,
    dirtySources,
    requestedAt: now,
    scheduledAt: needsRefreshSchedule ? now : refreshLeaseHealthy ? state?.scheduledAt : undefined,
    lastCompletedAt: state?.lastCompletedAt,
    lastError: needsRefreshSchedule ? undefined : state?.lastError,
    memoryCursor: state?.memoryVersion === BRAIN_MEMORY_VERSION ? state.memoryCursor : undefined,
    memoryComplete: state?.memoryVersion === BRAIN_MEMORY_VERSION ? Boolean(state.memoryComplete) : false,
    memoryVersion: BRAIN_MEMORY_VERSION,
    memoryBackfillScheduledAt:
      state?.memoryVersion === BRAIN_MEMORY_VERSION ? state.memoryBackfillScheduledAt : undefined,
    activeIndexVersion: BRAIN_ACTIVE_INDEX_VERSION,
    activeIndexComplete: ready,
    activeBackfillSource: ready ? undefined : position.source,
    activeBackfillCursor: ready ? undefined : position.cursor ?? undefined,
    activeBackfillScheduledAt: needsActiveSchedule
      ? now
      : activeLeaseHealthy
        ? state?.activeBackfillScheduledAt
        : undefined,
    updatedAt: now,
  };
  if (state) await ctx.db.patch(state._id, common);
  else await ctx.db.insert("brainContextRefresh", common);
}

async function loadMemory(ctx: any, refreshedAt: number) {
  let rows = await ctx.db.query("brainMemory").withIndex("by_updatedAt").order("desc").take(6);
  if (!rows.length) {
    const sourceRows = await ctx.db.query("memory").withIndex("by_createdAt").order("desc").take(6);
    for (const row of sourceRows) await upsertBrainMemory(ctx, row);
    rows = sourceRows.map(projectMemoryRow);
  }
  return {
    memory: rows.map(memoryDto).slice(0, 6),
    meta: sourceMeta(["brainMemory.by_updatedAt", "memory.by_createdAt (rollout bootstrap only)"], rows, refreshedAt),
  };
}

async function loadBusiness(ctx: any, refreshedAt: number) {
  const rows = await ctx.db.query("businessState").withIndex("by_domain").take(8);
  return {
    business: rows.map(compactBusiness),
    meta: sourceMeta(["businessState.by_domain"], rows, refreshedAt),
  };
}

async function activeRows(ctx: any, source: ActiveContextSource) {
  return await ctx.db
    .query("brainContextActive")
    .withIndex("by_version_source_rank", (q: any) =>
      q.eq("version", BRAIN_ACTIVE_INDEX_VERSION).eq("source", source),
    )
    .order("desc")
    .take(ACTIVE_CONTEXT_LIMITS[source]);
}

async function loadProjects(ctx: any, refreshedAt: number) {
  const [projects, goals] = await Promise.all([
    ctx.db.query("projectState").withIndex("by_slug").take(24),
    activeRows(ctx, "goal"),
  ]);
  return {
    projects: projects.map(compactProject),
    goals: goals.map((row: any) => row.payload),
    meta: sourceMeta(
      ["projectState.by_slug", "brainContextActive.v1.goal.by_rank (complete active set)"],
      [...projects, ...goals],
      refreshedAt,
    ),
  };
}

async function loadWork(ctx: any, refreshedAt: number) {
  const [jobRows, missionRows, profiles, findings, approvals] = await Promise.all([
    activeRows(ctx, "job"),
    activeRows(ctx, "mission"),
    ctx.db.query("agentProfiles").withIndex("by_slug").take(12),
    ctx.db
      .query("findings")
      .withIndex("by_status", (q: any) => q.eq("status", "fresh"))
      .order("desc")
      .take(8),
    ctx.db
      .query("approvals")
      .withIndex("by_status", (q: any) => q.eq("status", "pending"))
      .order("desc")
      .take(6),
  ]);
  const jobs = jobRows.map((row: any) => row.payload);
  return {
    jobs,
    goalMissions: missionRows.map((row: any) => row.payload),
    findings: findings.map(compactFinding).slice(0, 6),
    approvals: approvals.map(compactApproval),
    agents: profiles.map((profile: any) => compactAgent(profile, jobs)),
    meta: sourceMeta(
      [
        "brainContextActive.v1.job.by_rank (complete active set)",
        "brainContextActive.v1.mission.by_rank (complete active set)",
        "agentProfiles.by_slug",
        "findings.by_status=fresh",
        "approvals.by_status=pending",
      ],
      [...jobRows, ...missionRows, ...profiles, ...findings, ...approvals],
      refreshedAt,
    ),
  };
}

async function loadAttention(ctx: any, refreshedAt: number) {
  const rows = await activeRows(ctx, "attention");
  return {
    attention: rows.map((row: any) => row.payload),
    meta: sourceMeta(
      ["brainContextActive.v1.attention.by_true_score (complete open + working set)"],
      rows,
      refreshedAt,
    ),
  };
}

// This is the only operational fan-out in the new design. It runs once when a
// projection version is first rolled out, so legacy rows are visible in the
// last-known-good DTO while the bounded rank-index migration catches up.
async function loadLegacyProjects(ctx: any, refreshedAt: number) {
  const [projects, goalGroups] = await Promise.all([
    ctx.db.query("projectState").withIndex("by_slug").take(24),
    Promise.all(
      ["active", "blocked"].map((status) =>
        ctx.db
          .query("projectGoals")
          .withIndex("by_status_priority", (q: any) => q.eq("status", status))
          .order("desc")
          .take(ACTIVE_CONTEXT_LIMITS.goal),
      ),
    ),
  ]);
  const goals = goalGroups
    .flat()
    .sort((left: any, right: any) => right.priority - left.priority || right.createdAt - left.createdAt)
    .slice(0, ACTIVE_CONTEXT_LIMITS.goal);
  return {
    projects: projects.map(compactProject),
    goals: goals.map(compactGoal),
    meta: sourceMeta(
      ["projectState.by_slug", "projectGoals.by_status_priority (rollout bootstrap only)"],
      [...projects, ...goals],
      refreshedAt,
    ),
  };
}

async function loadLegacyWork(ctx: any, refreshedAt: number) {
  const [jobGroups, missionGroups, profiles, findings, approvals] = await Promise.all([
    Promise.all(
      ACTIVE_JOB_STATUSES.map((status) =>
        ctx.db
          .query("jobRuntime")
          .withIndex("by_status_priority", (q: any) => q.eq("status", status))
          .order("desc")
          .take(ACTIVE_CONTEXT_LIMITS.job),
      ),
    ),
    Promise.all(
      ACTIVE_MISSION_STATUSES.map((status) =>
        ctx.db
          .query("missionRuntime")
          .withIndex("by_mode_status_priority", (q: any) => q.eq("mode", "goal").eq("status", status))
          .order("desc")
          .take(ACTIVE_CONTEXT_LIMITS.mission),
      ),
    ),
    ctx.db.query("agentProfiles").withIndex("by_slug").take(12),
    ctx.db
      .query("findings")
      .withIndex("by_status", (q: any) => q.eq("status", "fresh"))
      .order("desc")
      .take(8),
    ctx.db
      .query("approvals")
      .withIndex("by_status", (q: any) => q.eq("status", "pending"))
      .order("desc")
      .take(6),
  ]);
  const sourceJobs = jobGroups
    .flat()
    .sort((left: any, right: any) => right.priority - left.priority || right.createdAt - left.createdAt)
    .slice(0, ACTIVE_CONTEXT_LIMITS.job);
  const sourceMissions = missionGroups
    .flat()
    .sort((left: any, right: any) => right.priority - left.priority || right.createdAt - left.createdAt)
    .slice(0, ACTIVE_CONTEXT_LIMITS.mission);
  const jobs = sourceJobs.map(compactJob);
  return {
    jobs,
    goalMissions: sourceMissions.map(compactMission),
    findings: findings.map(compactFinding).slice(0, 6),
    approvals: approvals.map(compactApproval),
    agents: profiles.map((profile: any) => compactAgent(profile, jobs)),
    meta: sourceMeta(
      [
        "jobRuntime.by_status_priority (rollout bootstrap only)",
        "missionRuntime.by_mode_status_priority (rollout bootstrap only)",
        "agentProfiles.by_slug",
        "findings.by_status=fresh",
        "approvals.by_status=pending",
      ],
      [...sourceJobs, ...sourceMissions, ...profiles, ...findings, ...approvals],
      refreshedAt,
    ),
  };
}

async function loadLegacyAttention(ctx: any, refreshedAt: number) {
  // Attention score is a product of three stored fields and cannot be derived
  // from a legacy lexicographic index. The rollout bootstrap reads the complete
  // current active set once; every later rebuild uses brainContextActive.
  const groups = await Promise.all(
    ["open", "working"].map((status) =>
      ctx.db
        .query("attentionItems")
        .withIndex("by_status", (q: any) => q.eq("status", status))
        .collect(),
    ),
  );
  const sourceRows = groups
    .flat()
    .sort(
      (left: any, right: any) =>
        right.impact * right.urgency * right.confidence
        - left.impact * left.urgency * left.confidence
        || right.createdAt - left.createdAt,
    )
    .slice(0, ACTIVE_CONTEXT_LIMITS.attention);
  return {
    attention: sourceRows.map(compactAttention),
    meta: sourceMeta(
      ["attentionItems.by_status complete active set (one rollout bootstrap only)"],
      sourceRows,
      refreshedAt,
    ),
  };
}

async function loadArtifacts(ctx: any, refreshedAt: number) {
  const [recent, trip, draft] = await Promise.all([
    ctx.db.query("creations").withIndex("by_updatedAt").order("desc").take(10),
    ctx.db.query("creations").withIndex("by_kind", (q: any) => q.eq("kind", "trip")).order("desc").first(),
    ctx.db.query("creations").withIndex("by_kind", (q: any) => q.eq("kind", "doc")).order("desc").first(),
  ]);
  return {
    creations: recent.map(compactCreation),
    trip: compactTrip(trip),
    draft: compactDraft(draft),
    meta: sourceMeta(
      ["creations.by_updatedAt", "creations.by_kind=trip", "creations.by_kind=doc"],
      [...recent, trip, draft].filter(Boolean),
      refreshedAt,
    ),
  };
}

async function loadUi(ctx: any, refreshedAt: number) {
  const [location, panel] = await Promise.all([
    ctx.db.query("ui").withIndex("by_key", (q: any) => q.eq("key", "location")).first(),
    ctx.db.query("ui").withIndex("by_key", (q: any) => q.eq("key", "panel")).first(),
  ]);
  return {
    location: compactUi(location),
    panel: compactUi(panel),
    meta: sourceMeta(["ui.by_key=location", "ui.by_key=panel"], [location, panel].filter(Boolean), refreshedAt),
  };
}

async function rebuildProjection(
  ctx: any,
  requested: readonly ContextSource[],
  now: number,
  mode: "indexed" | "rollout" = "indexed",
): Promise<{ payload: BrainContextPayload; payloadBytes: number }> {
  const existing = await projectionRow(ctx);
  const versionValid = existing?.version === BRAIN_CONTEXT_VERSION;
  if (!versionValid && mode !== "rollout") throw new Error("rollout bootstrap required");
  const previous: BrainContextPayload = versionValid ? existing.payload : emptyBrainContext(now);
  const sources = mode === "rollout" ? [...CONTEXT_SOURCES] : uniqueSources(requested);
  const payload: BrainContextPayload = JSON.parse(JSON.stringify(previous));

  const results = await Promise.all([
    sources.includes("memory") ? loadMemory(ctx, now) : null,
    sources.includes("business") ? loadBusiness(ctx, now) : null,
    sources.includes("projects")
      ? mode === "rollout" ? loadLegacyProjects(ctx, now) : loadProjects(ctx, now)
      : null,
    sources.includes("work")
      ? mode === "rollout" ? loadLegacyWork(ctx, now) : loadWork(ctx, now)
      : null,
    sources.includes("attention")
      ? mode === "rollout" ? loadLegacyAttention(ctx, now) : loadAttention(ctx, now)
      : null,
    sources.includes("artifacts") ? loadArtifacts(ctx, now) : null,
    sources.includes("ui") ? loadUi(ctx, now) : null,
  ]);
  const [memory, business, projects, work, attention, artifacts, ui] = results;
  if (memory) {
    payload.memory = memory.memory;
    payload.sources.memory = memory.meta;
  }
  if (business) {
    payload.business = business.business;
    payload.sources.business = business.meta;
  }
  if (projects) {
    payload.projects = projects.projects;
    payload.goals = projects.goals;
    payload.sources.projects = projects.meta;
  }
  if (work) {
    payload.jobs = work.jobs;
    payload.goalMissions = work.goalMissions;
    payload.findings = work.findings;
    payload.approvals = work.approvals;
    payload.agents = work.agents;
    payload.sources.work = work.meta;
  }
  if (attention) {
    payload.attention = attention.attention;
    payload.sources.attention = attention.meta;
  }
  if (artifacts) {
    payload.creations = artifacts.creations;
    payload.trip = artifacts.trip;
    payload.draft = artifacts.draft;
    payload.sources.artifacts = artifacts.meta;
  }
  if (ui) {
    payload.location = ui.location;
    payload.panel = ui.panel;
    payload.sources.ui = ui.meta;
  }
  payload.generatedAt = now;
  const fitted = fitBrainContextPayload(payload);
  const payloadBytes = estimateJsonBytes(fitted);
  const row = {
    key: BRAIN_CONTEXT_KEY,
    version: BRAIN_CONTEXT_VERSION,
    payload: fitted,
    payloadBytes,
    generatedAt: now,
  };
  if (existing) await ctx.db.replace(existing._id, row);
  else await ctx.db.insert("brainContextProjection", row);
  return { payload: fitted, payloadBytes };
}

async function scheduleMemoryBackfill(ctx: any, state: any, now: number) {
  if (state.memoryComplete && state.memoryVersion === BRAIN_MEMORY_VERSION) return;
  if (state.memoryBackfillScheduledAt && now - state.memoryBackfillScheduledAt < REFRESH_LEASE_MS) return;
  await ctx.scheduler.runAfter(0, contextInternal.backfillMemory, {
    version: BRAIN_MEMORY_VERSION,
    cursor: state.memoryCursor ?? null,
  });
  await ctx.db.patch(state._id, { memoryBackfillScheduledAt: now, updatedAt: now });
}

export const refresh = internalMutation({
  args: { generation: v.number() },
  handler: async (ctx, a) => {
    const state = await refreshState(ctx);
    if (!state || state.generation !== a.generation) return { refreshed: false, reason: "superseded" };
    const now = Date.now();
    const dirty = uniqueSources(state.dirtySources ?? []);
    const ready = activeIndexReady(state);
    const processable = ready ? dirty : dirty.filter((source) => !ACTIVE_DEPENDENT_SOURCES.has(source));
    if (!processable.length) {
      await ctx.db.patch(state._id, { scheduledAt: undefined, updatedAt: now });
      await requestContextRefresh(ctx, []);
      return { refreshed: false, reason: ready ? "clean" : "active-index-migrating" };
    }
    try {
      const result = await rebuildProjection(ctx, processable, now);
      // Convex's optimistic transaction retries if a writer changes this state
      // after our read. Therefore this subtraction can only clear sources this
      // exact transaction observed and rebuilt; a racing dirty source survives.
      const remaining = remainingDirtySources(dirty, processable);
      await ctx.db.patch(state._id, {
        dirtySources: remaining,
        scheduledAt: undefined,
        lastCompletedAt: now,
        lastError: undefined,
        updatedAt: now,
      });
      await scheduleMemoryBackfill(ctx, { ...state, dirtySources: remaining, scheduledAt: undefined }, now);
      return { refreshed: true, payloadBytes: result.payloadBytes, processedSources: processable, remaining };
    } catch (error) {
      await ctx.db.patch(state._id, {
        scheduledAt: undefined,
        lastError: String(error instanceof Error ? error.message : error).slice(0, 500),
        updatedAt: now,
      });
      return { refreshed: false, reason: "failed" };
    }
  },
});

async function activeSourcePage(ctx: any, source: ActiveContextSource, cursor: string | null) {
  const pagination = { cursor, numItems: ACTIVE_BACKFILL_PAGE, maximumRowsRead: ACTIVE_BACKFILL_PAGE };
  if (source === "job") {
    return await ctx.db.query("jobRuntime").withIndex("by_createdAt").order("asc").paginate(pagination);
  }
  if (source === "mission") {
    return await ctx.db.query("missionRuntime").withIndex("by_createdAt").order("asc").paginate(pagination);
  }
  if (source === "goal") {
    return await ctx.db.query("projectGoals").withIndex("by_updatedAt").order("asc").paginate(pagination);
  }
  return await ctx.db.query("attentionItems").withIndex("by_updatedAt").order("asc").paginate(pagination);
}

export const backfillActive = internalMutation({
  args: {
    version: v.number(),
    source: v.string(),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, a) => {
    const state = await refreshState(ctx);
    if (!state || activeIndexReady(state)) return { complete: true };
    const position = activeBackfillPosition(state);
    if (
      a.version !== BRAIN_ACTIVE_INDEX_VERSION
      || a.source !== position.source
      || a.cursor !== position.cursor
    ) return { complete: false, reason: "superseded" };

    const page = await activeSourcePage(ctx, position.source, position.cursor);
    let changed = 0;
    for (const row of page.page) {
      if (await syncContextActiveRow(ctx, position.source, row)) changed += 1;
    }
    const now = Date.now();
    if (!page.isDone) {
      await ctx.scheduler.runAfter(100, contextInternal.backfillActive, {
        version: BRAIN_ACTIVE_INDEX_VERSION,
        source: position.source,
        cursor: page.continueCursor,
      });
      await ctx.db.patch(state._id, {
        activeBackfillCursor: page.continueCursor,
        activeBackfillScheduledAt: now,
        updatedAt: now,
      });
      return { complete: false, source: position.source, processed: page.page.length, changed };
    }

    const sourceIndex = ACTIVE_SOURCE_SEQUENCE.indexOf(position.source);
    const nextSource = ACTIVE_SOURCE_SEQUENCE[sourceIndex + 1];
    if (nextSource) {
      await ctx.scheduler.runAfter(100, contextInternal.backfillActive, {
        version: BRAIN_ACTIVE_INDEX_VERSION,
        source: nextSource,
        cursor: null,
      });
      await ctx.db.patch(state._id, {
        activeBackfillSource: nextSource,
        activeBackfillCursor: undefined,
        activeBackfillScheduledAt: now,
        updatedAt: now,
      });
      return { complete: false, source: position.source, processed: page.page.length, changed };
    }

    await ctx.db.patch(state._id, {
      activeIndexVersion: BRAIN_ACTIVE_INDEX_VERSION,
      activeIndexComplete: true,
      activeBackfillSource: undefined,
      activeBackfillCursor: undefined,
      activeBackfillScheduledAt: undefined,
      updatedAt: now,
    });
    await requestContextRefresh(ctx, ["projects", "work", "attention"]);
    return { complete: true, source: position.source, processed: page.page.length, changed };
  },
});

export const backfillMemory = internalMutation({
  args: { version: v.number(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, a) => {
    const state = await refreshState(ctx);
    if (!state || (state.memoryComplete && state.memoryVersion === BRAIN_MEMORY_VERSION)) return { complete: true };
    if (
      a.version !== BRAIN_MEMORY_VERSION
      || a.cursor !== (state.memoryCursor ?? null)
    ) return { complete: false, reason: "superseded" };
    const page = await ctx.db
      .query("memory")
      .withIndex("by_createdAt")
      .order("desc")
      .paginate({
        cursor: a.cursor,
        numItems: MEMORY_BACKFILL_PAGE,
        maximumRowsRead: MEMORY_BACKFILL_PAGE,
      });
    for (const row of page.page) await upsertBrainMemory(ctx, row);
    const now = Date.now();
    if (page.isDone) {
      await ctx.db.patch(state._id, {
        memoryCursor: undefined,
        memoryComplete: true,
        memoryVersion: BRAIN_MEMORY_VERSION,
        memoryBackfillScheduledAt: undefined,
        updatedAt: now,
      });
      return { complete: true, processed: page.page.length };
    }
    await ctx.scheduler.runAfter(100, contextInternal.backfillMemory, {
      version: BRAIN_MEMORY_VERSION,
      cursor: page.continueCursor,
    });
    await ctx.db.patch(state._id, {
      memoryCursor: page.continueCursor,
      memoryComplete: false,
      memoryVersion: BRAIN_MEMORY_VERSION,
      memoryBackfillScheduledAt: now,
      updatedAt: now,
    });
    return { complete: false, processed: page.page.length };
  },
});

// A deployment/cold-start safety valve. It performs one complete operational
// bootstrap for the new version, then all foreground reads and rebuilds stay on
// singleton/compact rank projections while the resumable migration finishes.
export const bootstrap = mutation({
  args: { ...actorAuthArgs },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const [existing, state] = await Promise.all([projectionRow(ctx), refreshState(ctx)]);
    if (existing?.version === BRAIN_CONTEXT_VERSION) {
      await requestContextRefresh(ctx, []);
      const current = await refreshState(ctx);
      if (current) await scheduleMemoryBackfill(ctx, current, Date.now());
      return {
        ...existing.payload,
        projection: {
          state: activeIndexReady(current) ? "fresh" : "migrating",
          version: existing.version,
          payloadBytes: existing.payloadBytes,
          generatedAt: existing.generatedAt,
          memoryIndexComplete: current?.memoryComplete ?? false,
          activeIndexComplete: activeIndexReady(current),
        },
      };
    }

    const now = Date.now();
    const generation = (state?.generation ?? 0) + 1;
    const result = await rebuildProjection(ctx, CONTEXT_SOURCES, now, "rollout");
    const keepActiveMigration = state?.activeIndexVersion === BRAIN_ACTIVE_INDEX_VERSION;
    const nextState = {
      key: BRAIN_CONTEXT_KEY,
      version: BRAIN_CONTEXT_VERSION,
      generation,
      dirtySources: [],
      requestedAt: now,
      scheduledAt: undefined,
      lastCompletedAt: now,
      lastError: undefined,
      memoryCursor: state?.memoryVersion === BRAIN_MEMORY_VERSION ? state.memoryCursor : undefined,
      memoryComplete: state?.memoryVersion === BRAIN_MEMORY_VERSION ? Boolean(state.memoryComplete) : false,
      memoryVersion: BRAIN_MEMORY_VERSION,
      memoryBackfillScheduledAt: undefined,
      activeIndexVersion: BRAIN_ACTIVE_INDEX_VERSION,
      activeIndexComplete: keepActiveMigration ? Boolean(state.activeIndexComplete) : false,
      activeBackfillSource: keepActiveMigration
        ? state.activeBackfillSource ?? ACTIVE_SOURCE_SEQUENCE[0]
        : ACTIVE_SOURCE_SEQUENCE[0],
      activeBackfillCursor: keepActiveMigration ? state.activeBackfillCursor : undefined,
      activeBackfillScheduledAt: undefined,
      updatedAt: now,
    };
    let persistedState: any;
    if (state) {
      await ctx.db.replace(state._id, nextState);
      persistedState = { ...nextState, _id: state._id };
    } else {
      const id = await ctx.db.insert("brainContextRefresh", nextState);
      persistedState = { ...nextState, _id: id };
    }
    await requestContextRefresh(ctx, []);
    const current = await refreshState(ctx) ?? persistedState;
    await scheduleMemoryBackfill(ctx, current, now);
    return {
      ...result.payload,
      projection: {
        state: activeIndexReady(current) ? "fresh" : "migrating",
        version: BRAIN_CONTEXT_VERSION,
        payloadBytes: result.payloadBytes,
        generatedAt: now,
        memoryIndexComplete: current.memoryComplete ?? false,
        activeIndexComplete: activeIndexReady(current),
      },
    };
  },
});

// Stale readers keep using the last-known-good DTO and only ask this mutation
// to re-arm lost refresh/backfill leases. It never reconstructs context inline.
export const kick = mutation({
  args: { ...actorAuthArgs },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const state = await refreshState(ctx);
    await requestContextRefresh(
      ctx,
      uniqueSources(state?.dirtySources?.length ? state.dirtySources : []),
    );
    const current = await refreshState(ctx);
    if (current) await scheduleMemoryBackfill(ctx, current, Date.now());
    return true;
  },
});
