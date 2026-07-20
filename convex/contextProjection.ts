import { internal } from "./_generated/api";
import { internalMutation, mutation } from "./_generated/server";
import { v } from "convex/values";
import { actorAuthArgs, requireActor } from "./controlAuth";
import {
  BRAIN_CONTEXT_KEY,
  BRAIN_CONTEXT_VERSION,
  BRAIN_MEMORY_VERSION,
  CONTEXT_SOURCES,
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
  emptyBrainContext,
  estimateJsonBytes,
  fitBrainContextPayload,
  isActiveGoalMission,
  isActiveWork,
  memoryDto,
  projectMemoryRow,
  sourceMeta,
} from "./brainContextModel";

const REFRESH_DELAY_MS = 400;
const REFRESH_LEASE_MS = 60_000;
const MEMORY_BACKFILL_PAGE = 32;

const contextInternal = (internal as any).contextProjection;

function uniqueSources(values: readonly string[]): ContextSource[] {
  const allowed = new Set<string>(CONTEXT_SOURCES);
  return [...new Set(values.filter((value): value is ContextSource => allowed.has(value)))];
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
  if (!compact.sourceId) return;
  const existing = await ctx.db
    .query("brainMemory")
    .withIndex("by_source", (q: any) => q.eq("sourceId", compact.sourceId))
    .first();
  if (existing) await ctx.db.replace(existing._id, compact);
  else await ctx.db.insert("brainMemory", compact);
}

export async function requestContextRefresh(ctx: any, requested: readonly ContextSource[]) {
  const now = Date.now();
  const state = await refreshState(ctx);
  const versionChanged = !state || state.version !== BRAIN_CONTEXT_VERSION;
  const sources = uniqueSources([
    ...(versionChanged ? CONTEXT_SOURCES : state.dirtySources),
    ...requested,
  ]);
  const scheduleHealthy = Boolean(state?.scheduledAt && now - state.scheduledAt < REFRESH_LEASE_MS);

  // A source already covered by the pending coalesced rebuild needs no second
  // metadata write or scheduler entry. This is what keeps heartbeats and batch
  // writers from amplifying foreground-context maintenance.
  if (
    state
    && scheduleHealthy
    && sources.length === state.dirtySources.length
    && sources.every((source) => state.dirtySources.includes(source))
  ) return;

  if (scheduleHealthy) {
    await ctx.db.patch(state._id, { dirtySources: sources, requestedAt: now, updatedAt: now });
    return;
  }

  const generation = (state?.generation ?? 0) + 1;
  await ctx.scheduler.runAfter(REFRESH_DELAY_MS, contextInternal.refresh, { generation });
  const next = {
    key: BRAIN_CONTEXT_KEY,
    version: BRAIN_CONTEXT_VERSION,
    generation,
    dirtySources: sources.length ? sources : [...CONTEXT_SOURCES],
    requestedAt: now,
    scheduledAt: now,
    lastCompletedAt: state?.lastCompletedAt,
    lastError: undefined,
    memoryCursor: state?.memoryVersion === BRAIN_MEMORY_VERSION ? state.memoryCursor : undefined,
    memoryComplete: state?.memoryVersion === BRAIN_MEMORY_VERSION ? state.memoryComplete : false,
    memoryVersion: BRAIN_MEMORY_VERSION,
    memoryBackfillScheduledAt:
      state?.memoryVersion === BRAIN_MEMORY_VERSION ? state.memoryBackfillScheduledAt : undefined,
    updatedAt: now,
  };
  if (state) await ctx.db.replace(state._id, next);
  else await ctx.db.insert("brainContextRefresh", next);
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
    meta: sourceMeta(["brainMemory.by_updatedAt", "memory.by_createdAt (bootstrap only)"], rows, refreshedAt),
  };
}

async function loadBusiness(ctx: any, refreshedAt: number) {
  const rows = await ctx.db.query("businessState").withIndex("by_domain").take(8);
  return {
    business: rows.map(compactBusiness),
    meta: sourceMeta(["businessState.by_domain"], rows, refreshedAt),
  };
}

async function loadProjects(ctx: any, refreshedAt: number) {
  const [projects, recentGoals] = await Promise.all([
    ctx.db.query("projectState").withIndex("by_slug").take(24),
    ctx.db.query("projectGoals").withIndex("by_updatedAt").order("desc").take(32),
  ]);
  const goals = recentGoals
    .filter((goal: any) => goal.status === "active" || goal.status === "blocked")
    .sort((left: any, right: any) => right.priority - left.priority || right.updatedAt - left.updatedAt)
    .slice(0, 12);
  return {
    projects: projects.map(compactProject),
    goals: goals.map(compactGoal),
    meta: sourceMeta(
      ["projectState.by_slug", "projectGoals.by_updatedAt (single bounded background scan)"],
      [...projects, ...goals],
      refreshedAt,
    ),
  };
}

async function loadWork(ctx: any, refreshedAt: number) {
  // One recency index replaces the former five per-status scans. Running work
  // keeps itself recent through its existing runtime heartbeat; lifecycle and
  // stage changes are what request a context refresh.
  const [recentRuntime, recentMissions, profiles, findings, approvals] = await Promise.all([
    ctx.db.query("jobRuntime").withIndex("by_updatedAt").order("desc").take(32),
    ctx.db.query("missionRuntime").withIndex("by_createdAt").order("desc").take(16),
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
  const jobs = recentRuntime
    .filter(isActiveWork)
    .sort((left: any, right: any) => right.priority - left.priority || right.updatedAt - left.updatedAt)
    .slice(0, 10)
    .map(compactJob);
  const goalMissions = recentMissions.filter(isActiveGoalMission).slice(0, 6).map(compactMission);
  return {
    jobs,
    goalMissions,
    findings: findings.map(compactFinding).slice(0, 6),
    approvals: approvals.map(compactApproval),
    agents: profiles.map((profile: any) => compactAgent(profile, jobs)),
    meta: sourceMeta(
      [
        "jobRuntime.by_updatedAt (single bounded scan)",
        "missionRuntime.by_createdAt",
        "agentProfiles.by_slug",
        "findings.by_status=fresh",
        "approvals.by_status=pending",
      ],
      [...recentRuntime, ...recentMissions, ...profiles, ...findings, ...approvals],
      refreshedAt,
    ),
  };
}

async function loadAttention(ctx: any, refreshedAt: number) {
  const recent = await ctx.db.query("attentionItems").withIndex("by_updatedAt").order("desc").take(24);
  const attention = recent
    .filter((row: any) => row.status === "open" || row.status === "working")
    .sort(
      (left: any, right: any) =>
        right.impact * right.urgency * right.confidence - left.impact * left.urgency * left.confidence,
    )
    .slice(0, 8)
    .map(compactAttention);
  return {
    attention,
    meta: sourceMeta(["attentionItems.by_updatedAt (active rows, ranked in background)"], recent, refreshedAt),
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
  const previous: BrainContextPayload =
    existing?.version === BRAIN_CONTEXT_VERSION ? existing.payload : emptyBrainContext(now);
  const sources = existing?.version === BRAIN_CONTEXT_VERSION ? uniqueSources(requested) : [...CONTEXT_SOURCES];
  const payload: BrainContextPayload = JSON.parse(JSON.stringify(previous));

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
  await ctx.scheduler.runAfter(0, contextInternal.backfillMemory, { cursor: state.memoryCursor ?? null });
  await ctx.db.patch(state._id, { memoryBackfillScheduledAt: now, updatedAt: now });
}

export const refresh = internalMutation({
  args: { generation: v.number() },
  handler: async (ctx, a) => {
    const state = await refreshState(ctx);
    if (!state || state.generation !== a.generation) return { refreshed: false, reason: "superseded" };
    const now = Date.now();
    try {
      const result = await rebuildProjection(ctx, uniqueSources(state.dirtySources), now);
      await ctx.db.patch(state._id, {
        dirtySources: [],
        scheduledAt: undefined,
        lastCompletedAt: now,
        lastError: undefined,
        updatedAt: now,
      });
      await scheduleMemoryBackfill(ctx, { ...state, scheduledAt: undefined }, now);
      return { refreshed: true, payloadBytes: result.payloadBytes };
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

export const backfillMemory = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, a) => {
    const state = await refreshState(ctx);
    if (!state || (state.memoryComplete && state.memoryVersion === BRAIN_MEMORY_VERSION)) return { complete: true };
    const page = await ctx.db
      .query("memory")
      .withIndex("by_createdAt")
      .order("desc")
      .paginate({ cursor: a.cursor, numItems: MEMORY_BACKFILL_PAGE });
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
    await ctx.scheduler.runAfter(100, contextInternal.backfillMemory, { cursor: page.continueCursor });
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

// A deployment/cold-start safety valve. Normal turns never call this once the
// versioned row exists; it creates the initial bounded DTO synchronously so a
// rollout cannot trade latency savings for an ungrounded first answer.
export const bootstrap = mutation({
  args: { ...actorAuthArgs },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const [existing, state] = await Promise.all([projectionRow(ctx), refreshState(ctx)]);
    if (existing?.version === BRAIN_CONTEXT_VERSION) {
      if (state) await scheduleMemoryBackfill(ctx, state, Date.now());
      return {
        ...existing.payload,
        projection: {
          state: "fresh",
          version: existing.version,
          payloadBytes: existing.payloadBytes,
          generatedAt: existing.generatedAt,
          memoryIndexComplete: state?.memoryComplete ?? false,
        },
      };
    }
    const now = Date.now();
    const generation = (state?.generation ?? 0) + 1;
    const result = await rebuildProjection(ctx, CONTEXT_SOURCES, now);
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
      memoryComplete: state?.memoryVersion === BRAIN_MEMORY_VERSION ? state.memoryComplete : false,
      memoryVersion: BRAIN_MEMORY_VERSION,
      memoryBackfillScheduledAt: undefined,
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
    await scheduleMemoryBackfill(ctx, persistedState, now);
    return {
      ...result.payload,
      projection: {
        state: "fresh",
        version: BRAIN_CONTEXT_VERSION,
        payloadBytes: result.payloadBytes,
        generatedAt: now,
        memoryIndexComplete: false,
      },
    };
  },
});

// Stale readers keep using the last-known-good DTO and only ask this mutation
// to re-arm a lost scheduler lease. It never reconstructs context inline.
export const kick = mutation({
  args: { ...actorAuthArgs },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const state = await refreshState(ctx);
    await requestContextRefresh(
      ctx,
      uniqueSources(state?.dirtySources?.length ? state.dirtySources : CONTEXT_SOURCES),
    );
    const current = await refreshState(ctx);
    if (current) await scheduleMemoryBackfill(ctx, current, Date.now());
    return true;
  },
});
