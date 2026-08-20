import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { actorAuthArgs, requireActor, requireWorker } from "./controlAuth";

const MAX_TEXT = 500;
const REFRESH_STATES = [
  "scheduled",
  "pending_refresh",
  "pending_google",
  "needs_flight_confirmation",
  "needs_city_confirmation",
  "too_late",
  "trip_missing",
] as const;
type RefreshState = typeof REFRESH_STATES[number];

// Only rows with an actual future maintenance path belong in the worker queue.
// `needs_*` rows may be parked without a timestamp while their exact booking
// identity is confirmed, so the range below also excludes missing timestamps.
// Terminal rows are deliberately absent even if a historical indexed value is
// still present.
const REFRESHABLE_STATES = [
  "scheduled",
  "pending_refresh",
  "pending_google",
  "needs_flight_confirmation",
  "needs_city_confirmation",
] as const satisfies readonly RefreshState[];

const identityValidator = v.object({
  selectionId: v.string(),
  messageId: v.string(),
  marker: v.string(),
  threadId: v.optional(v.string()),
  kind: v.string(),
  provider: v.string(),
  confirmationCode: v.optional(v.string()),
});

const cityProofValidator = v.object({
  city: v.string(),
  title: v.string(),
  bookingName: v.optional(v.string()),
  location: v.string(),
  start: v.number(),
  end: v.number(),
  timeZone: v.optional(v.string()),
  lat: v.number(),
  lng: v.number(),
  distanceKm: v.number(),
  verifiedAt: v.number(),
});

const preflightValidator = v.object({
  city: v.string(),
  flightMarker: v.string(),
  flightTitle: v.string(),
  flightStart: v.number(),
  at: v.number(),
  timeZone: v.string(),
  mapUrl: v.string(),
  todoText: v.string(),
  reminderText: v.string(),
});

function bounded(value: unknown, max = MAX_TEXT, min = 1): boolean {
  return typeof value === "string" && value.length >= min && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

function validSourceKey(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function validIdentity(value: any): boolean {
  return bounded(value?.selectionId, 80) && bounded(value?.messageId, 240) && bounded(value?.marker, 240) && bounded(value?.kind, 40)
    && bounded(value?.provider, 180) && (value.threadId === undefined || bounded(value.threadId, 240))
    && (value.confirmationCode === undefined || bounded(value.confirmationCode, 80));
}

function validProof(value: any): boolean {
  return bounded(value?.city, 120) && bounded(value?.title, 180) && bounded(value?.location, 300)
    && (value.bookingName === undefined || bounded(value.bookingName, 180))
    && (value.timeZone === undefined || bounded(value.timeZone, 80))
    && [value.start, value.end, value.lat, value.lng, value.distanceKm, value.verifiedAt].every(Number.isFinite)
    && value.end >= value.start && Math.abs(value.lat) <= 90 && Math.abs(value.lng) <= 180;
}

function validPreflight(value: any): boolean {
  return bounded(value?.city, 120) && bounded(value?.flightMarker, 240) && bounded(value?.flightTitle, 120)
    && bounded(value?.timeZone, 80) && bounded(value?.mapUrl, 1_000) && bounded(value?.todoText, 500) && bounded(value?.reminderText, 500)
    && [value.flightStart, value.at].every(Number.isFinite)
    && /^https:\/\/maps\.apple\.com\//.test(value.mapUrl);
}

function validRefreshState(value: unknown): value is RefreshState {
  return typeof value === "string" && (REFRESH_STATES as readonly string[]).includes(value);
}

function patchTripPreflight(creation: any, changes: Record<string, unknown>): string | null {
  if (creation?.kind !== "trip" || typeof creation.data !== "string") return null;
  try {
    const doc = JSON.parse(creation.data);
    if (!doc || typeof doc !== "object" || Array.isArray(doc) || doc.kind !== "trip") return null;
    doc.offlineMapPreflight = {
      ...(doc.offlineMapPreflight && typeof doc.offlineMapPreflight === "object" && !Array.isArray(doc.offlineMapPreflight)
        ? doc.offlineMapPreflight
        : {}),
      ...changes,
    };
    const data = JSON.stringify(doc);
    return data.length <= 120_000 ? data : null;
  } catch {
    return null;
  }
}

/** Owner action: create or replace the one registry row for one saved TripDoc. */
export const upsert = mutation({
  args: {
    creationId: v.id("creations"),
    sourceKey: v.string(),
    preflight: preflightValidator,
    flightIdentity: identityValidator,
    cityProofIdentity: identityValidator,
    cityProof: cityProofValidator,
    nextRefreshAt: v.number(),
    ...actorAuthArgs,
  },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    if (!validSourceKey(a.sourceKey) || !validPreflight(a.preflight) || !validIdentity(a.flightIdentity)
      || !validIdentity(a.cityProofIdentity) || !validProof(a.cityProof) || !Number.isFinite(a.nextRefreshAt)) {
      return { ok: false as const, reason: "invalid" as const };
    }
    const creation = await ctx.db.get(a.creationId);
    if (!creation || creation.kind !== "trip" || typeof creation.data !== "string") {
      return { ok: false as const, reason: "not_saved_trip" as const };
    }
    const now = Date.now();
    const existing = await ctx.db
      .query("appleMapsOfflinePreflights")
      .withIndex("by_creationId", (q) => q.eq("creationId", a.creationId))
      .unique();
    const record = {
      creationId: a.creationId,
      sourceKey: a.sourceKey,
      preflight: a.preflight,
      flightIdentity: a.flightIdentity,
      cityProofIdentity: a.cityProofIdentity,
      cityProof: a.cityProof,
      refreshState: "scheduled" as const,
      lastError: undefined,
      lastCheckedAt: now,
      nextRefreshAt: a.nextRefreshAt,
      updatedAt: now,
    };
    if (existing) {
      await ctx.db.patch(existing._id, record);
      return { ok: true as const, id: existing._id, created: false as const };
    }
    const id = await ctx.db.insert("appleMapsOfflinePreflights", { ...record, createdAt: now });
    return { ok: true as const, id, created: true as const };
  },
});

/** Worker-only and registry-only: no travel-library or Gmail-wide enumeration. */
export const due = query({
  args: { now: v.number(), limit: v.number(), ...actorAuthArgs },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const limit = Math.max(1, Math.min(8, Math.floor(a.limit)));
    if (!Number.isFinite(a.now)) return [];
    // Do not rely on clearing an optional indexed field to park a record:
    // historical `too_late` rows can retain an index entry for `undefined`.
    // The state-first index makes terminal rows permanently invisible to the
    // worker queue, while the finite lower bound also parks every `needs_*`
    // record that intentionally has no retry time.
    const rows = (await Promise.all(REFRESHABLE_STATES.map((state) => ctx.db
      .query("appleMapsOfflinePreflights")
      .withIndex("by_refreshState_nextRefreshAt", (q) => q
        .eq("refreshState", state)
        .gt("nextRefreshAt", Number.MIN_SAFE_INTEGER)
        .lte("nextRefreshAt", a.now))
      .take(limit))))
      .flat()
      .sort((left, right) => Number(left.nextRefreshAt) - Number(right.nextRefreshAt))
      .slice(0, limit);
    return await Promise.all(rows.map(async (row) => ({
      ...row,
      creation: await ctx.db.get(row.creationId),
    })));
  },
});

/** Atomically records a successful Gmail refresh and mirrors it into the exact saved TripDoc. */
export const completeRefresh = mutation({
  args: {
    id: v.id("appleMapsOfflinePreflights"),
    expectedUpdatedAt: v.number(),
    preflight: preflightValidator,
    flightIdentity: identityValidator,
    cityProofIdentity: identityValidator,
    cityProof: cityProofValidator,
    checkedAt: v.number(),
    nextRefreshAt: v.optional(v.number()),
    refreshState: v.union(v.literal("scheduled"), v.literal("too_late")),
    refreshError: v.optional(v.string()),
    todoStatus: v.union(v.literal("created"), v.literal("existing"), v.literal("needs_retry")),
    calendarRefreshRequired: v.boolean(),
    ...actorAuthArgs,
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    if (!Number.isFinite(a.expectedUpdatedAt) || !Number.isFinite(a.checkedAt)
      || (a.nextRefreshAt !== undefined && !Number.isFinite(a.nextRefreshAt))
      || (a.refreshState === "scheduled" && !Number.isFinite(a.nextRefreshAt))
      || (a.refreshState === "too_late" && (a.nextRefreshAt !== undefined || !bounded(a.refreshError, 180)))
      || (a.refreshState === "scheduled" && a.refreshError !== undefined)
      || !validPreflight(a.preflight) || !validIdentity(a.flightIdentity) || !validIdentity(a.cityProofIdentity) || !validProof(a.cityProof)) {
      return { ok: false as const, reason: "invalid" as const };
    }
    const row = await ctx.db.get(a.id);
    if (!row) return { ok: false as const, reason: "not_found" as const };
    if (row.updatedAt !== a.expectedUpdatedAt) return { ok: false as const, reason: "stale" as const };
    const creation = await ctx.db.get(row.creationId);
    const data = patchTripPreflight(creation, {
      ...a.preflight,
      sourceKey: row.sourceKey,
      flightSelectionId: a.flightIdentity.selectionId,
      refreshState: a.refreshState,
      lastCheckedAt: a.checkedAt,
      nextRefreshAt: a.nextRefreshAt,
      refreshError: a.refreshError,
      todoStatus: a.todoStatus,
      calendarRefreshRequired: a.calendarRefreshRequired,
      updatedAt: a.checkedAt,
    });
    if (!data || !creation) return { ok: false as const, reason: "trip_missing" as const };
    await ctx.db.patch(creation._id, { data, updatedAt: a.checkedAt });
    await ctx.db.patch(row._id, {
      preflight: a.preflight,
      flightIdentity: a.flightIdentity,
      cityProofIdentity: a.cityProofIdentity,
      cityProof: a.cityProof,
      refreshState: a.refreshState,
      lastError: a.refreshError,
      lastCheckedAt: a.checkedAt,
      nextRefreshAt: a.nextRefreshAt,
      updatedAt: a.checkedAt,
    });
    return { ok: true as const };
  },
});

/** Fail closed while retaining the existing reminder and the owner-visible saved-trip status. */
export const markPending = mutation({
  args: {
    id: v.id("appleMapsOfflinePreflights"),
    expectedUpdatedAt: v.number(),
    state: v.string(),
    error: v.string(),
    checkedAt: v.number(),
    nextRefreshAt: v.optional(v.number()),
    ...actorAuthArgs,
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    if (!Number.isFinite(a.expectedUpdatedAt) || !Number.isFinite(a.checkedAt) || !validRefreshState(a.state)
      || a.state === "scheduled" || !bounded(a.error, 180) || (a.nextRefreshAt !== undefined && !Number.isFinite(a.nextRefreshAt))) {
      return { ok: false as const, reason: "invalid" as const };
    }
    const row = await ctx.db.get(a.id);
    if (!row) return { ok: false as const, reason: "not_found" as const };
    if (row.updatedAt !== a.expectedUpdatedAt) return { ok: false as const, reason: "stale" as const };
    const creation = await ctx.db.get(row.creationId);
    const data = patchTripPreflight(creation, {
      refreshState: a.state,
      refreshError: a.error,
      lastCheckedAt: a.checkedAt,
      nextRefreshAt: a.nextRefreshAt,
      updatedAt: a.checkedAt,
    });
    if (creation && data) await ctx.db.patch(creation._id, { data, updatedAt: a.checkedAt });
    await ctx.db.patch(row._id, {
      refreshState: a.state,
      lastError: a.error,
      lastCheckedAt: a.checkedAt,
      nextRefreshAt: a.nextRefreshAt,
      updatedAt: a.checkedAt,
    });
    return { ok: true as const };
  },
});
