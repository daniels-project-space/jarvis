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
  compactBusiness,
  compactCreation,
  compactDraft,
  compactFinding,
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
const ACTIVE_BACKFILL_SOURCE_PHASE = "source";
const ACTIVE_BACKFILL_CLEANUP_PHASE = "cleanup";
const contextInternal = (internal as any).contextProjection;

type ActiveBackfillPosition = {
  generation: number;
  phase: typeof ACTIVE_BACKFILL_SOURCE_PHASE | typeof ACTIVE_BACKFILL_CLEANUP_PHASE;
  source?: ActiveContextSource;
  cursor: string | null;
};

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

function activeBackfillPosition(state: any): ActiveBackfillPosition | null {
  const generation = Number(state?.activeBackfillGeneration);
  if (!Number.isSafeInteger(generation) || generation < 1) return null;
  const cursor = state?.activeBackfillCursor ?? null;
  if (state?.activeBackfillPhase === ACTIVE_BACKFILL_CLEANUP_PHASE) {
    return { generation, phase: ACTIVE_BACKFILL_CLEANUP_PHASE, cursor };
  }
  if (
    state?.activeBackfillPhase === ACTIVE_BACKFILL_SOURCE_PHASE
    && ACTIVE_SOURCE_SEQUENCE.includes(state?.activeBackfillSource)
  ) {
    return {
      generation,
      phase: ACTIVE_BACKFILL_SOURCE_PHASE,
      source: state.activeBackfillSource as ActiveContextSource,
      cursor,
    };
  }
  return null;
}

function initialActiveBackfillPosition(generation: number): ActiveBackfillPosition {
  return {
    generation,
    phase: ACTIVE_BACKFILL_SOURCE_PHASE,
    source: ACTIVE_SOURCE_SEQUENCE[0],
    cursor: null,
  };
}

function activeBackfillArgs(position: ActiveBackfillPosition) {
  return {
    version: BRAIN_ACTIVE_INDEX_VERSION,
    generation: position.generation,
    phase: position.phase,
    source: position.source,
    cursor: position.cursor,
  };
}

export async function requestContextRefresh(ctx: any, requested: readonly ContextSource[]) {
  const now = Date.now();
  const state = await refreshState(ctx);
  const versionChanged = !state || state.version !== BRAIN_CONTEXT_VERSION;
  const indexVersionChanged = !state || state.activeIndexVersion !== BRAIN_ACTIVE_INDEX_VERSION;
  const currentDirty = versionChanged ? [...CONTEXT_SOURCES] : uniqueSources(state.dirtySources ?? []);
  const dirtySources = uniqueSources([...currentDirty, ...requested]);
  const ready = !indexVersionChanged && activeIndexReady(state);
  const storedPosition = !indexVersionChanged && !ready ? activeBackfillPosition(state) : null;
  const refreshable = ready
    ? dirtySources
    : dirtySources.filter((source) => !ACTIVE_DEPENDENT_SOURCES.has(source));
  const refreshLeaseHealthy = Boolean(
    !versionChanged && state?.scheduledAt && now - state.scheduledAt < REFRESH_LEASE_MS,
  );
  const activeLeaseHealthy = Boolean(
    !indexVersionChanged
      && !ready
      && storedPosition
      && state?.activeBackfillScheduledAt
      && now - state.activeBackfillScheduledAt < REFRESH_LEASE_MS,
  );
  const needsRefreshSchedule = refreshable.length > 0 && !refreshLeaseHealthy;
  const needsActiveSchedule = !ready && !activeLeaseHealthy;
  const dirtyChanged = !state || !sameSources(dirtySources, uniqueSources(state.dirtySources ?? []));

  if (state && !versionChanged && !dirtyChanged && !needsRefreshSchedule && !needsActiveSchedule) return;

  const generation = (state?.generation ?? 0) + (needsRefreshSchedule ? 1 : 0);
  // Every initial/recovered lease advances a durable generation. An abandoned
  // scheduled mutation can therefore never resume at a reused cursor.
  const activeGeneration = needsActiveSchedule
    ? Number(state?.activeBackfillGeneration ?? 0) + 1
    : storedPosition?.generation ?? Number(state?.activeBackfillGeneration ?? 0);
  const position = storedPosition
    ? { ...storedPosition, generation: activeGeneration }
    : initialActiveBackfillPosition(activeGeneration || 1);

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
    activeBackfillGeneration: activeGeneration || undefined,
    activeBackfillPhase: ready ? undefined : position.phase,
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
  // The migration is persisted and queued before the optional non-dependent
  // projection refresh. Both effects commit atomically with this transaction.
  if (needsActiveSchedule) {
    await ctx.scheduler.runAfter(0, contextInternal.backfillActive, activeBackfillArgs(position));
  }
  if (needsRefreshSchedule) {
    await ctx.scheduler.runAfter(REFRESH_DELAY_MS, contextInternal.refresh, { generation });
  }
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
    meta: sourceMeta(["brainMemory.by_updatedAt", "memory.by_createdAt (bounded cold index seed)"], rows, refreshedAt),
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
      ["projectState.by_slug", `brainContextActive.v${BRAIN_ACTIVE_INDEX_VERSION}.goal.by_rank (complete active set)`],
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
        `brainContextActive.v${BRAIN_ACTIVE_INDEX_VERSION}.job.by_rank (complete active set)`,
        `brainContextActive.v${BRAIN_ACTIVE_INDEX_VERSION}.mission.by_rank (complete active set)`,
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
      [`brainContextActive.v${BRAIN_ACTIVE_INDEX_VERSION}.attention.by_true_score (complete open + working set)`],
      rows,
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
): Promise<{ payload: BrainContextPayload; payloadBytes: number }> {
  const existing = await projectionRow(ctx);
  const versionValid = existing?.version === BRAIN_CONTEXT_VERSION;
  const previous: BrainContextPayload = existing?.payload ?? emptyBrainContext(now);
  const sources = uniqueSources(requested);
  const payload: BrainContextPayload = JSON.parse(JSON.stringify(previous));
  payload.sources ??= {};
  if (!versionValid) {
    // Carry a preceding projection forward only as explicitly labelled
    // last-known-good data. No active slice is claimed complete until the
    // versioned source pass and cleanup pass both finish.
    for (const source of ACTIVE_DEPENDENT_SOURCES) {
      const prior = payload.sources[source];
      payload.sources[source] = {
        provenance: [existing
          ? `brainContextProjection.v${existing.version} last-known-good; active index v${BRAIN_ACTIVE_INDEX_VERSION} migrating (coverage incomplete)`
          : `brainContextActive.v${BRAIN_ACTIVE_INDEX_VERSION} migration pending (no complete active slice)`],
        sourceUpdatedAt: prior?.sourceUpdatedAt ?? 0,
        refreshedAt: prior?.refreshedAt ?? 0,
      };
    }
  }

  const results = await Promise.all([
    sources.includes("memory") ? loadMemory(ctx, now) : null,
    sources.includes("business") ? loadBusiness(ctx, now) : null,
    sources.includes("projects") ? loadProjects(ctx, now) : null,
    sources.includes("work") ? loadWork(ctx, now) : null,
    sources.includes("attention") ? loadAttention(ctx, now) : null,
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
    return await ctx.db.query("projectGoals").withIndex("by_createdAt").order("asc").paginate(pagination);
  }
  return await ctx.db.query("attentionItems").withIndex("by_createdAt").order("asc").paginate(pagination);
}

async function authoritativeActiveSource(ctx: any, row: any) {
  const source = row?.source as ActiveContextSource;
  const sourceId = String(row?.sourceId ?? "");
  if (!ACTIVE_SOURCE_SEQUENCE.includes(source) || !sourceId) return null;
  if (source === "job") {
    const id = ctx.db.normalizeId("jobs", sourceId);
    return id
      ? await ctx.db.query("jobRuntime").withIndex("by_job", (q: any) => q.eq("jobId", id)).first()
      : null;
  }
  if (source === "mission") {
    const id = ctx.db.normalizeId("missions", sourceId);
    return id
      ? await ctx.db.query("missionRuntime").withIndex("by_mission", (q: any) => q.eq("missionId", id)).first()
      : null;
  }
  const id = ctx.db.normalizeId(source === "goal" ? "projectGoals" : "attentionItems", sourceId);
  return id ? await ctx.db.get(id) : null;
}

// The cleanup pass is deliberately source-authoritative. It removes orphaned,
// inactive and duplicate rows, and reprojects a stale rank from the newest
// source document. Every lookup is singleton or take(2), so a corrupt index
// still cannot turn one migration page into an unbounded transaction.
async function reconcileActiveIndexEntry(ctx: any, candidate: any): Promise<boolean> {
  const live = await ctx.db.get(candidate._id);
  if (!live) return false;
  if (!ACTIVE_SOURCE_SEQUENCE.includes(live.source as ActiveContextSource)) {
    await ctx.db.delete(live._id);
    return true;
  }
  const source = live.source as ActiveContextSource;
  const sourceRow = await authoritativeActiveSource(ctx, live);
  const projected = sourceRow ? contextActiveRecord(source, sourceRow) : null;
  if (!projected) {
    await ctx.db.delete(live._id);
    return true;
  }
  const siblings = await ctx.db
    .query("brainContextActive")
    .withIndex("by_source_id", (q: any) => q.eq("source", source).eq("sourceId", live.sourceId))
    .take(2);
  const canonical = [...siblings].sort((left: any, right: any) =>
    Number(right.version === BRAIN_ACTIVE_INDEX_VERSION) - Number(left.version === BRAIN_ACTIVE_INDEX_VERSION)
    || Number(right.sourceUpdatedAt ?? 0) - Number(left.sourceUpdatedAt ?? 0)
    || Number(left._creationTime ?? 0) - Number(right._creationTime ?? 0),
  )[0] ?? live;
  if (String(canonical._id) !== String(live._id)) {
    await ctx.db.delete(live._id);
    return true;
  }
  let changed = false;
  if (contextActiveMaterialChanged(live, projected)) {
    await ctx.db.replace(live._id, projected);
    changed = true;
  }
  for (const sibling of siblings) {
    if (String(sibling._id) === String(live._id)) continue;
    await ctx.db.delete(sibling._id);
    changed = true;
  }
  return changed;
}

async function activeCleanupPage(ctx: any, cursor: string | null) {
  return await ctx.db
    .query("brainContextActive")
    .withIndex("by_source_id")
    .order("asc")
    .paginate({
      cursor,
      numItems: ACTIVE_BACKFILL_PAGE,
      maximumRowsRead: ACTIVE_BACKFILL_PAGE,
    });
}

function sameActiveBackfillCall(a: any, position: ActiveBackfillPosition): boolean {
  return a.version === BRAIN_ACTIVE_INDEX_VERSION
    && a.generation === position.generation
    && a.phase === position.phase
    && (a.source ?? undefined) === position.source
    && a.cursor === position.cursor;
}

async function scheduleActiveBackfill(ctx: any, position: ActiveBackfillPosition, delay = 100) {
  await ctx.scheduler.runAfter(delay, contextInternal.backfillActive, activeBackfillArgs(position));
}

export const backfillActive = internalMutation({
  args: {
    version: v.number(),
    generation: v.optional(v.number()),
    phase: v.optional(v.string()),
    source: v.optional(v.string()),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, a) => {
    const state = await refreshState(ctx);
    if (!state || activeIndexReady(state)) return { complete: true };
    const position = activeBackfillPosition(state);
    if (!position || !sameActiveBackfillCall(a, position)) {
      return { complete: false, reason: "superseded" };
    }

    let changed = 0;
    const page = position.phase === ACTIVE_BACKFILL_SOURCE_PHASE
      ? await activeSourcePage(ctx, position.source!, position.cursor)
      : await activeCleanupPage(ctx, position.cursor);
    for (const row of page.page) {
      const didChange = position.phase === ACTIVE_BACKFILL_SOURCE_PHASE
        ? await syncContextActiveRow(ctx, position.source!, row)
        : await reconcileActiveIndexEntry(ctx, row);
      if (didChange) changed += 1;
    }
    const now = Date.now();
    if (!page.isDone) {
      const next = {
        ...position,
        cursor: page.continueCursor,
      };
      await scheduleActiveBackfill(ctx, next);
      await ctx.db.patch(state._id, {
        activeBackfillCursor: page.continueCursor,
        activeBackfillScheduledAt: now,
        updatedAt: now,
      });
      return {
        complete: false,
        phase: position.phase,
        source: position.source,
        processed: page.page.length,
        changed,
      };
    }

    if (position.phase === ACTIVE_BACKFILL_SOURCE_PHASE) {
      const sourceIndex = ACTIVE_SOURCE_SEQUENCE.indexOf(position.source!);
      const nextSource = ACTIVE_SOURCE_SEQUENCE[sourceIndex + 1];
      const next: ActiveBackfillPosition = nextSource
        ? { ...position, source: nextSource, cursor: null }
        : {
            generation: position.generation,
            phase: ACTIVE_BACKFILL_CLEANUP_PHASE,
            cursor: null,
          };
      await scheduleActiveBackfill(ctx, next);
      await ctx.db.patch(state._id, {
        activeBackfillPhase: next.phase,
        activeBackfillSource: next.source,
        activeBackfillCursor: undefined,
        activeBackfillScheduledAt: now,
        updatedAt: now,
      });
      return {
        complete: false,
        phase: position.phase,
        source: position.source,
        processed: page.page.length,
        changed,
      };
    }

    await ctx.db.patch(state._id, {
      activeIndexVersion: BRAIN_ACTIVE_INDEX_VERSION,
      activeIndexComplete: true,
      activeBackfillPhase: undefined,
      activeBackfillSource: undefined,
      activeBackfillCursor: undefined,
      activeBackfillScheduledAt: undefined,
      updatedAt: now,
    });
    await requestContextRefresh(ctx, ["projects", "work", "attention"]);
    return { complete: true, phase: position.phase, processed: page.page.length, changed };
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

// Deployment/cold-start safety valve. It only persists and schedules bounded
// background work. A prior projection is returned as explicitly migrating
// last-known-good context; a true cold start returns an honest empty DTO. No
// operational source table is read by this foreground-triggered transaction.
export const bootstrap = mutation({
  args: { ...actorAuthArgs },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const existing = await projectionRow(ctx);
    const now = Date.now();
    await requestContextRefresh(ctx, []);
    const current = await refreshState(ctx);
    if (current) await scheduleMemoryBackfill(ctx, current, now);
    const payload: BrainContextPayload = existing?.payload ?? emptyBrainContext(0);
    const ready = activeIndexReady(current);
    const currentVersion = existing?.version === BRAIN_CONTEXT_VERSION;
    return {
      ...payload,
      projection: {
        state: ready && currentVersion
          ? current?.dirtySources?.length ? "refreshing" : "fresh"
          : "migrating",
        version: existing?.version ?? 0,
        payloadBytes: existing?.payloadBytes ?? estimateJsonBytes(payload),
        generatedAt: existing?.generatedAt ?? 0,
        memoryIndexComplete: current?.memoryComplete ?? false,
        activeIndexComplete: ready,
        refreshRecommended: false,
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
