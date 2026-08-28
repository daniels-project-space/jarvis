import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { actorAuthArgs, requireActor, requireAdmin, requireWorker } from "./controlAuth";

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

const iCloudCalendarEventValidator = v.object({
  calendarUrl: v.string(),
  eventUrl: v.string(),
  etag: v.string(),
  revision: v.number(),
  nonce: v.string(),
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

function validICloudCalendarEtag(value: unknown): value is string {
  // A strong, concrete entity tag is required for the exact If-Match fence.
  return typeof value === "string" && bounded(value, 512) && /^"[^"\u0000-\u001f\u007f]*"$/.test(value);
}

function validPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

type ICloudCalendarAttempt = {
  sourceKey: string;
  calendarUrl: string;
  eventUrl: string;
  revision: number;
  nonce: string;
  action: "create" | "update";
  expectedEtag?: string;
  observedEtag?: string;
  observedAt?: number;
  missingAt?: number;
  recovery?: { revision: number; nonce: string; etag: string };
  startedAt: number;
};

function normalizedICloudCalendarUrl(value: unknown, trailingSlash = false): string | null {
  if (!bounded(value, 2_000)) return null;
  try {
    const url = new URL(value as string);
    const hostname = url.hostname.toLowerCase();
    if (
      url.protocol !== "https:"
      || url.port
      || url.username
      || url.password
      || url.search
      || url.hash
      || (hostname !== "caldav.icloud.com" && !/^p\d+-caldav\.icloud\.com$/.test(hostname))
    ) return null;
    if (trailingSlash && !url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
    return url.toString();
  } catch {
    return null;
  }
}

function deterministicICloudCalendarEventUrl(calendarUrl: string, sourceKey: string): string | null {
  const calendar = normalizedICloudCalendarUrl(calendarUrl, true);
  if (!calendar || !validSourceKey(sourceKey)) return null;
  return new URL(`jarvis-apple-maps-${sourceKey}@jarvis.ics`, calendar).toString();
}

function validICloudCalendarEvent(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  if (!bounded(event.calendarUrl, 2_000) || !bounded(event.eventUrl, 2_000)
    || !validICloudCalendarEtag(event.etag) || !validSourceKey(event.sourceKey ?? "")
    || typeof event.revision !== "number" || !Number.isSafeInteger(event.revision) || event.revision <= 0
    || !/^[A-Za-z0-9_-]{16,64}$/.test(String(event.nonce ?? ""))) return false;
  const calendarUrl = normalizedICloudCalendarUrl(event.calendarUrl, true);
  const eventUrl = normalizedICloudCalendarUrl(event.eventUrl);
  if (!calendarUrl || !eventUrl || calendarUrl !== event.calendarUrl || eventUrl !== event.eventUrl) return false;
  const calendar = new URL(calendarUrl);
  const eventResource = new URL(eventUrl);
  return eventResource.origin === calendar.origin
    && eventResource.pathname.startsWith(calendar.pathname)
    && eventResource.pathname.endsWith(".ics");
}

function validICloudCalendarAttempt(value: unknown): value is ICloudCalendarAttempt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const attempt = value as Record<string, unknown>;
  const calendarUrl = normalizedICloudCalendarUrl(attempt.calendarUrl, true);
  const eventUrl = normalizedICloudCalendarUrl(attempt.eventUrl);
  if (!calendarUrl || !eventUrl || calendarUrl !== attempt.calendarUrl || eventUrl !== attempt.eventUrl
    || !validSourceKey(attempt.sourceKey)
    || !validPositiveSafeInteger(attempt.revision)
    || !/^[A-Za-z0-9_-]{16,64}$/.test(String(attempt.nonce ?? ""))
    || (attempt.action !== "create" && attempt.action !== "update")
    || (attempt.action === "create" && attempt.expectedEtag !== undefined)
    || (attempt.action === "update" && !validICloudCalendarEtag(attempt.expectedEtag))
    || (attempt.observedEtag !== undefined && !validICloudCalendarEtag(attempt.observedEtag))
    || (attempt.observedAt !== undefined && !validPositiveSafeInteger(attempt.observedAt))
    || (attempt.missingAt !== undefined && !validPositiveSafeInteger(attempt.missingAt))
    || (attempt.missingAt !== undefined && attempt.observedEtag !== undefined)
    || !validPositiveSafeInteger(attempt.startedAt)
  ) return false;
  const calendar = new URL(calendarUrl);
  const eventResource = new URL(eventUrl);
  if (eventResource.origin !== calendar.origin || !eventResource.pathname.startsWith(calendar.pathname) || !eventResource.pathname.endsWith(".ics")) return false;
  const recovery = attempt.recovery;
  if (recovery === undefined) return true;
  if (!recovery || typeof recovery !== "object" || Array.isArray(recovery)) return false;
  const prior = recovery as Record<string, unknown>;
  return validPositiveSafeInteger(prior.revision)
    && /^[A-Za-z0-9_-]{16,64}$/.test(String(prior.nonce ?? ""))
    && validICloudCalendarEtag(prior.etag);
}

function sameICloudCalendarAttempt(
  attempt: any,
  input: { sourceKey: string; calendarUrl: string; eventUrl: string; revision: number; nonce: string; action: "create" | "update"; expectedEtag?: string },
): boolean {
  return attempt
    && attempt.sourceKey === input.sourceKey
    && attempt.calendarUrl === input.calendarUrl
    && attempt.eventUrl === input.eventUrl
    && attempt.revision === input.revision
    && attempt.nonce === input.nonce
    && attempt.action === input.action
    && attempt.expectedEtag === input.expectedEtag;
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

/**
 * Calendar approval receipts seal the preflight's `updatedAt` value. Worker
 * bookkeeping (a successful no-op Gmail check or a transient provider error)
 * must not rotate that receipt: it has not changed the Calendar event the
 * owner reviewed. Keep a separate registry timestamp for worker concurrency.
 */
function calendarApprovalState(creation: any): { sourceKey?: string; revision?: number; refreshRequired: boolean } {
  if (creation?.kind !== "trip" || typeof creation.data !== "string") return { refreshRequired: false };
  try {
    const doc = JSON.parse(creation.data);
    const preflight = doc?.offlineMapPreflight;
    const updatedAt = Number(preflight?.updatedAt);
    const sourceKey = validSourceKey(preflight?.sourceKey) ? preflight.sourceKey : undefined;
    return {
      ...(sourceKey ? { sourceKey } : {}),
      ...(Number.isSafeInteger(updatedAt) && updatedAt > 0 ? { revision: updatedAt } : {}),
      refreshRequired: preflight?.calendarRefreshRequired === true,
    };
  } catch {
    return { refreshRequired: false };
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
      return {
        ok: true as const,
        id: existing._id,
        created: false as const,
        ...(existing.iCloudCalendarEvent ? { iCloudCalendarEvent: existing.iCloudCalendarEvent } : {}),
        ...(existing.iCloudCalendarAttempt ? { iCloudCalendarAttempt: existing.iCloudCalendarAttempt } : {}),
      };
    }
    const id = await ctx.db.insert("appleMapsOfflinePreflights", { ...record, createdAt: now });
    return { ok: true as const, id, created: true as const };
  },
});

/**
 * Route-only pre-write gate for a sealed iCloud travel receipt. This reads one
 * saved trip and its one opt-in registry row; it never enumerates a library or
 * treats a generic Calendar receipt as permission to write a travel event.
 */
export const validateICloudCalendarApproval = query({
  args: {
    creationId: v.id("creations"),
    sourceKey: v.string(),
    expectedPreflightUpdatedAt: v.number(),
    calendarUrl: v.string(),
    action: v.union(v.literal("create"), v.literal("update")),
    nonce: v.string(),
    expectedEtag: v.optional(v.string()),
    eventUrl: v.optional(v.string()),
    ...actorAuthArgs,
  },
  handler: async (ctx, a) => {
    await requireAdmin(ctx, a.authTokenHash);
    const input = normalizedICloudCalendarApprovalInput(a);
    if (!input) {
      return { ok: false as const, reason: "invalid" as const };
    }
    const row = await ctx.db
      .query("appleMapsOfflinePreflights")
      .withIndex("by_creationId", (q) => q.eq("creationId", a.creationId))
      .unique();
    if (!row || row.sourceKey !== input.sourceKey) return { ok: false as const, reason: "not_registered" as const };
    const creation = await ctx.db.get(a.creationId);
    if (!currentCalendarApproval(creation, input)) {
      return { ok: false as const, reason: "stale" as const };
    }
    const existing = row.iCloudCalendarEvent;
    if (existing && !validICloudCalendarEvent({ ...existing, sourceKey: input.sourceKey })) {
      return { ok: false as const, reason: "conflict" as const };
    }
    if (input.action === "create") {
      // The same sealed receipt may retry a lost response. A different nonce
      // on an already-managed event must obtain a fresh update receipt.
      if (existing && (existing.calendarUrl !== input.calendarUrl || existing.revision !== input.revision || existing.nonce !== input.nonce)) {
        return { ok: false as const, reason: "conflict" as const };
      }
    } else {
      const retryOfCommittedReceipt = existing
        && existing.calendarUrl === input.calendarUrl
        && existing.eventUrl === input.eventUrl
        && existing.revision === input.revision
        && existing.nonce === input.nonce;
      if (!retryOfCommittedReceipt && (
        !existing
        || existing.calendarUrl !== input.calendarUrl
        || existing.eventUrl !== input.eventUrl
        || existing.etag !== input.expectedEtag
      )) {
        return { ok: false as const, reason: "conflict" as const };
      }
    }
    return { ok: true as const };
  },
});

type ICloudCalendarApprovalInput = {
  sourceKey: string;
  calendarUrl: string;
  eventUrl: string;
  revision: number;
  nonce: string;
  action: "create" | "update";
  expectedEtag?: string;
};

function normalizedICloudCalendarApprovalInput(value: {
  sourceKey: string;
  calendarUrl: string;
  expectedPreflightUpdatedAt: number;
  nonce: string;
  action: "create" | "update";
  expectedEtag?: string;
  eventUrl?: string;
}): ICloudCalendarApprovalInput | null {
  const calendarUrl = normalizedICloudCalendarUrl(value.calendarUrl, true);
  if (!validSourceKey(value.sourceKey)
    || !calendarUrl
    || calendarUrl !== value.calendarUrl
    || !Number.isSafeInteger(value.expectedPreflightUpdatedAt)
    || value.expectedPreflightUpdatedAt <= 0
    || !/^[A-Za-z0-9_-]{16,64}$/.test(value.nonce)) return null;
  if (value.action === "create") {
    if (value.expectedEtag !== undefined || value.eventUrl !== undefined) return null;
    const eventUrl = deterministicICloudCalendarEventUrl(calendarUrl, value.sourceKey);
    return eventUrl ? {
      sourceKey: value.sourceKey,
      calendarUrl,
      eventUrl,
      revision: value.expectedPreflightUpdatedAt,
      nonce: value.nonce,
      action: "create",
    } : null;
  }
  const eventUrl = normalizedICloudCalendarUrl(value.eventUrl);
  const calendar = new URL(calendarUrl);
  const event = eventUrl ? new URL(eventUrl) : null;
  if (!eventUrl || !event || event.origin !== calendar.origin || !event.pathname.startsWith(calendar.pathname)
    || !event.pathname.endsWith(".ics") || !validICloudCalendarEtag(value.expectedEtag)) return null;
  return {
    sourceKey: value.sourceKey,
    calendarUrl,
    eventUrl,
    revision: value.expectedPreflightUpdatedAt,
    nonce: value.nonce,
    action: "update",
    expectedEtag: value.expectedEtag,
  };
}

function currentCalendarApproval(creation: any, input: ICloudCalendarApprovalInput): boolean {
  const state = calendarApprovalState(creation);
  return state.sourceKey === input.sourceKey && state.revision === input.revision && !state.refreshRequired;
}

function recoveryForAttempt(attempt: any): { revision: number; nonce: string; etag: string } | null {
  if (!attempt || !validICloudCalendarAttempt(attempt)) return null;
  if (validICloudCalendarEtag(attempt.observedEtag)) {
    return { revision: attempt.revision, nonce: attempt.nonce, etag: attempt.observedEtag };
  }
  if (attempt.recovery && validICloudCalendarEtag(attempt.recovery.etag)) {
    return attempt.recovery;
  }
  return null;
}

function pendingICloudCalendarAttempt(input: ICloudCalendarApprovalInput, recovery?: { revision: number; nonce: string; etag: string }) {
  return {
    sourceKey: input.sourceKey,
    calendarUrl: input.calendarUrl,
    eventUrl: input.eventUrl,
    revision: input.revision,
    nonce: input.nonce,
    action: input.action,
    ...(input.expectedEtag ? { expectedEtag: input.expectedEtag } : {}),
    ...(recovery ? { recovery } : {}),
    startedAt: Date.now(),
  };
}

/**
 * Claim the exact sealed CalDAV resource before writing it. The claim is
 * durable so the post-PUT / pre-Convex crash window can be reconciled without
 * treating an arbitrary deterministic-resource 412 as success.
 */
export const beginICloudCalendarApproval = mutation({
  args: {
    creationId: v.id("creations"),
    sourceKey: v.string(),
    expectedPreflightUpdatedAt: v.number(),
    calendarUrl: v.string(),
    action: v.union(v.literal("create"), v.literal("update")),
    nonce: v.string(),
    expectedEtag: v.optional(v.string()),
    eventUrl: v.optional(v.string()),
    ...actorAuthArgs,
  },
  handler: async (ctx, a) => {
    await requireAdmin(ctx, a.authTokenHash);
    const input = normalizedICloudCalendarApprovalInput(a);
    if (!input) return { ok: false as const, reason: "invalid" as const };
    const row = await ctx.db
      .query("appleMapsOfflinePreflights")
      .withIndex("by_creationId", (q) => q.eq("creationId", a.creationId))
      .unique();
    if (!row || row.sourceKey !== input.sourceKey) return { ok: false as const, reason: "not_registered" as const };
    const creation = await ctx.db.get(a.creationId);
    if (!currentCalendarApproval(creation, input)) return { ok: false as const, reason: "stale" as const };
    const existing = row.iCloudCalendarEvent;
    if (existing && !validICloudCalendarEvent({ ...existing, sourceKey: input.sourceKey })) {
      return { ok: false as const, reason: "conflict" as const };
    }
    const attempt = row.iCloudCalendarAttempt;
    if (attempt && !validICloudCalendarAttempt(attempt)) return { ok: false as const, reason: "conflict" as const };

    // A successful durable promotion may have lost only its HTTP response.
    // Never send a second CalDAV write for the same sealed receipt.
    if (existing
      && existing.calendarUrl === input.calendarUrl
      && existing.eventUrl === input.eventUrl
      && existing.revision === input.revision
      && existing.nonce === input.nonce) {
      return { ok: true as const, committed: true as const };
    }
    if (attempt && sameICloudCalendarAttempt(attempt, input)) return { ok: true as const, committed: false as const };

    if (input.action === "create") {
      // A recovered exact-resource 404 can safely discard an unobserved
      // pending create. If a resource reappears, If-None-Match still protects
      // it and turns the click into a conflict rather than an overwrite.
      if (existing || (attempt && !attempt.missingAt)) return { ok: false as const, reason: "conflict" as const };
      await ctx.db.patch(row._id, { iCloudCalendarAttempt: pendingICloudCalendarAttempt(input), updatedAt: Date.now() });
      return { ok: true as const, committed: false as const };
    }

    const recovery = recoveryForAttempt(attempt);
    const updatesExisting = existing
      && existing.calendarUrl === input.calendarUrl
      && existing.eventUrl === input.eventUrl
      && existing.etag === input.expectedEtag;
    const adoptsPending = recovery
      && attempt?.calendarUrl === input.calendarUrl
      && attempt?.eventUrl === input.eventUrl
      && recovery.etag === input.expectedEtag;
    if ((!updatesExisting && !adoptsPending) || (attempt && !adoptsPending)) {
      return { ok: false as const, reason: "conflict" as const };
    }
    await ctx.db.patch(row._id, {
      iCloudCalendarAttempt: pendingICloudCalendarAttempt(input, adoptsPending ? recovery ?? undefined : undefined),
      updatedAt: Date.now(),
    });
    return { ok: true as const, committed: false as const };
  },
});

/**
 * Save the exact provider ETag before promotion. This survives a stale
 * TripDoc revision and makes a same-receipt retry reject an external edit that
 * retained Jarvis's X-properties but changed the entity tag.
 */
export const observeICloudCalendarApproval = mutation({
  args: {
    creationId: v.id("creations"),
    sourceKey: v.string(),
    expectedPreflightUpdatedAt: v.number(),
    calendarUrl: v.string(),
    action: v.union(v.literal("create"), v.literal("update")),
    nonce: v.string(),
    expectedEtag: v.optional(v.string()),
    eventUrl: v.optional(v.string()),
    calendarEvent: iCloudCalendarEventValidator,
    ...actorAuthArgs,
  },
  handler: async (ctx, a) => {
    await requireAdmin(ctx, a.authTokenHash);
    const input = normalizedICloudCalendarApprovalInput(a);
    const candidate = {
      ...a.calendarEvent,
      sourceKey: a.sourceKey,
      revision: a.expectedPreflightUpdatedAt,
    };
    if (!input || !validICloudCalendarEvent(candidate)
      || candidate.calendarUrl !== input.calendarUrl || candidate.eventUrl !== input.eventUrl
      || candidate.revision !== input.revision || candidate.nonce !== input.nonce) {
      return { ok: false as const, reason: "invalid" as const };
    }
    const row = await ctx.db
      .query("appleMapsOfflinePreflights")
      .withIndex("by_creationId", (q) => q.eq("creationId", a.creationId))
      .unique();
    if (!row || row.sourceKey !== input.sourceKey) return { ok: false as const, reason: "not_registered" as const };
    const attempt = row.iCloudCalendarAttempt;
    if (!validICloudCalendarAttempt(attempt) || !sameICloudCalendarAttempt(attempt, input)) {
      return { ok: false as const, reason: "conflict" as const };
    }
    if (attempt.observedEtag && attempt.observedEtag !== candidate.etag) return { ok: false as const, reason: "conflict" as const };
    if (!attempt.observedEtag) {
      await ctx.db.patch(row._id, {
        iCloudCalendarAttempt: { ...attempt, observedEtag: candidate.etag, observedAt: Date.now(), missingAt: undefined },
        updatedAt: Date.now(),
      });
    }
    const creation = await ctx.db.get(a.creationId);
    return currentCalendarApproval(creation, input)
      ? { ok: true as const, current: true as const }
      : { ok: false as const, reason: "stale" as const };
  },
});

/**
 * Reconcile a pending resource before issuing a fresh owner approval. The
 * caller has read this one sealed CalDAV URL; a missing resource is harmless
 * only when there is no official binding, while a matching marker is retained
 * with its exact ETag for a conditional owner-approved update.
 */
export const reconcileICloudCalendarAttempt = mutation({
  args: {
    creationId: v.id("creations"),
    sourceKey: v.string(),
    calendarUrl: v.string(),
    eventUrl: v.string(),
    revision: v.number(),
    nonce: v.string(),
    state: v.union(v.literal("present"), v.literal("missing")),
    etag: v.optional(v.string()),
    ...actorAuthArgs,
  },
  handler: async (ctx, a) => {
    await requireAdmin(ctx, a.authTokenHash);
    const calendarUrl = normalizedICloudCalendarUrl(a.calendarUrl, true);
    const eventUrl = normalizedICloudCalendarUrl(a.eventUrl);
    if (!validSourceKey(a.sourceKey) || !calendarUrl || calendarUrl !== a.calendarUrl || !eventUrl || eventUrl !== a.eventUrl
      || !Number.isSafeInteger(a.revision) || a.revision <= 0 || !/^[A-Za-z0-9_-]{16,64}$/.test(a.nonce)
      || (a.state === "present" && !validICloudCalendarEtag(a.etag))
      || (a.state === "missing" && a.etag !== undefined)) {
      return { ok: false as const, reason: "invalid" as const };
    }
    const row = await ctx.db
      .query("appleMapsOfflinePreflights")
      .withIndex("by_creationId", (q) => q.eq("creationId", a.creationId))
      .unique();
    if (!row || row.sourceKey !== a.sourceKey) {
      return { ok: false as const, reason: "conflict" as const };
    }
    const attempt = row.iCloudCalendarAttempt;
    if (!validICloudCalendarAttempt(attempt)) return { ok: false as const, reason: "conflict" as const };
    if (attempt.calendarUrl !== calendarUrl || attempt.eventUrl !== eventUrl) return { ok: false as const, reason: "conflict" as const };
    const isAttemptMarker = attempt.revision === a.revision && attempt.nonce === a.nonce;
    const isRecoveryMarker = attempt.recovery?.revision === a.revision && attempt.recovery?.nonce === a.nonce;
    if (!isAttemptMarker && !isRecoveryMarker) return { ok: false as const, reason: "conflict" as const };
    const existing = row.iCloudCalendarEvent;
    if (a.state === "missing") {
      if (!isAttemptMarker || existing) return { ok: false as const, reason: "conflict" as const };
      await ctx.db.patch(row._id, {
        iCloudCalendarAttempt: { ...attempt, observedEtag: undefined, observedAt: undefined, missingAt: Date.now() },
        updatedAt: Date.now(),
      });
      return { ok: true as const, state: "missing" as const };
    }
    if (isRecoveryMarker && attempt.recovery?.etag !== a.etag) return { ok: false as const, reason: "conflict" as const };
    if (isAttemptMarker && attempt.observedEtag && attempt.observedEtag !== a.etag) return { ok: false as const, reason: "conflict" as const };
    if (isAttemptMarker && attempt.observedEtag !== a.etag) {
      await ctx.db.patch(row._id, {
        iCloudCalendarAttempt: { ...attempt, observedEtag: a.etag, observedAt: Date.now(), missingAt: undefined },
        updatedAt: Date.now(),
      });
    }
    return { ok: true as const, state: "present" as const };
  },
});

/**
 * Persist a confirmed CalDAV result only while the exact owner-reviewed
 * preflight revision is still current. Both the durable row and owner-visible
 * TripDoc update in this one Convex transaction.
 */
export const commitICloudCalendarApproval = mutation({
  args: {
    creationId: v.id("creations"),
    sourceKey: v.string(),
    expectedPreflightUpdatedAt: v.number(),
    calendarUrl: v.string(),
    action: v.union(v.literal("create"), v.literal("update")),
    calendarEvent: iCloudCalendarEventValidator,
    expectedEtag: v.optional(v.string()),
    ...actorAuthArgs,
  },
  handler: async (ctx, a) => {
    await requireAdmin(ctx, a.authTokenHash);
    const input = normalizedICloudCalendarApprovalInput({
      ...a,
      nonce: a.calendarEvent.nonce,
      ...(a.action === "update" ? { eventUrl: a.calendarEvent.eventUrl } : {}),
    });
    const candidate = {
      ...a.calendarEvent,
      sourceKey: a.sourceKey,
      revision: a.expectedPreflightUpdatedAt,
    };
    if (!input || !validICloudCalendarEvent(candidate)
      || candidate.calendarUrl !== input.calendarUrl || candidate.eventUrl !== input.eventUrl
      || candidate.revision !== input.revision || candidate.nonce !== input.nonce) {
      return { ok: false as const, reason: "invalid" as const };
    }
    const row = await ctx.db
      .query("appleMapsOfflinePreflights")
      .withIndex("by_creationId", (q) => q.eq("creationId", a.creationId))
      .unique();
    if (!row || row.sourceKey !== input.sourceKey) return { ok: false as const, reason: "not_registered" as const };
    const creation = await ctx.db.get(a.creationId);
    if (!currentCalendarApproval(creation, input)) {
      return { ok: false as const, reason: "stale" as const };
    }
    const existing = row.iCloudCalendarEvent;
    if (existing && !validICloudCalendarEvent({ ...existing, sourceKey: input.sourceKey })) {
      return { ok: false as const, reason: "conflict" as const };
    }
    const committedReceipt = existing
      && existing.calendarUrl === input.calendarUrl
      && existing.eventUrl === input.eventUrl
      && existing.revision === input.revision
      && existing.nonce === input.nonce;
    // A lost response may replay the commit itself, but only with the exact
    // persisted ETag. A marker-only match is not enough: external edits can
    // retain X-properties while changing the entity tag.
    if (committedReceipt) {
      return existing.etag === candidate.etag
        ? { ok: true as const }
        : { ok: false as const, reason: "conflict" as const };
    }
    const attempt = row.iCloudCalendarAttempt;
    if (!validICloudCalendarAttempt(attempt) || !sameICloudCalendarAttempt(attempt, input) || attempt.observedEtag !== candidate.etag) {
      return { ok: false as const, reason: "conflict" as const };
    }
    if (input.action === "create") {
      if (existing) return { ok: false as const, reason: "conflict" as const };
    } else if (!attempt.recovery && (
      !existing
      || existing.calendarUrl !== input.calendarUrl
      || existing.eventUrl !== input.eventUrl
      || existing.etag !== input.expectedEtag
    )) {
      return { ok: false as const, reason: "conflict" as const };
    }
    const data = patchTripPreflight(creation, {
      calendarProvider: "icloud",
      calendarStatus: "scheduled",
      calendarRefreshRequired: false,
      iCloudCalendarUrl: a.calendarEvent.calendarUrl,
      iCloudCalendarEventUrl: a.calendarEvent.eventUrl,
    });
    if (!data || !creation) return { ok: false as const, reason: "trip_missing" as const };
    const committedAt = Date.now();
    await ctx.db.patch(creation._id, { data, updatedAt: committedAt });
    await ctx.db.patch(row._id, {
      iCloudCalendarEvent: { ...a.calendarEvent, committedAt },
      iCloudCalendarAttempt: undefined,
      updatedAt: committedAt,
    });
    return { ok: true as const };
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
    // A receipt is invalidated only when the Calendar event's own contents
    // changed. `row.updatedAt` still advances below, so concurrent workers
    // retain their normal compare-and-swap protection.
    const calendarApproval = calendarApprovalState(creation);
    const approvalRevision = !a.calendarRefreshRequired
      ? calendarApproval.revision
      : undefined;
    // A background no-op check must not clear the owner-visible re-approval
    // requirement left by a previous itinerary change. Only an explicit
    // foreground re-prepare writes it back to false.
    const calendarRefreshRequired = a.calendarRefreshRequired || calendarApproval.refreshRequired;
    const data = patchTripPreflight(creation, {
      ...a.preflight,
      sourceKey: row.sourceKey,
      flightSelectionId: a.flightIdentity.selectionId,
      refreshState: a.refreshState,
      lastCheckedAt: a.checkedAt,
      nextRefreshAt: a.nextRefreshAt,
      refreshError: a.refreshError,
      todoStatus: a.todoStatus,
      calendarRefreshRequired,
      updatedAt: approvalRevision ?? a.checkedAt,
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
    // A post-Gmail, protected-window cutoff can have observed a changed
    // itinerary even though it cannot safely replace the durable reminder.
    // Keep this optional so pure timing/provider status bookkeeping retains
    // the current Calendar approval receipt.
    calendarRefreshRequired: v.optional(v.boolean()),
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
    // Gmail has either reported an identity problem or a new preflight could
    // not be persisted. In both cases, do not leave an approval for the prior
    // Calendar snapshot usable. A pure provider outage has no observed
    // itinerary change, so that one deliberately keeps the current receipt.
    const calendarApprovalStale = a.calendarRefreshRequired === true
      || a.state === "pending_refresh"
      || a.state === "needs_flight_confirmation"
      || a.state === "needs_city_confirmation";
    const data = patchTripPreflight(creation, {
      refreshState: a.state,
      refreshError: a.error,
      lastCheckedAt: a.checkedAt,
      nextRefreshAt: a.nextRefreshAt,
      ...(calendarApprovalStale ? { calendarRefreshRequired: true } : {}),
      // A missing Gmail connection or a final-window status does not alter
      // the Calendar payload already shown to the owner, so preserve its
      // receipt binding when one exists. Observed/unpersisted itinerary
      // changes instead get a fresh revision and require re-approval.
      updatedAt: calendarApprovalStale
        ? a.checkedAt
        : calendarApprovalState(creation).revision ?? a.checkedAt,
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
