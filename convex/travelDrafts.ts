import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { actorAuthArgs, hasWorkerCapability, requireActor, requireViewer, viewerAuthArgs } from "./controlAuth";
import { tripCanvas } from "./tripCanvas";

// V2 adds durable multi-city context metadata inside the opaque TripDoc. The
// document parser deliberately still accepts V1 rows so they are upgraded only
// when the owner or a provider writes them again.
const SCHEMA_VERSION = 2;
const MAX_DATA_BYTES = 120_000;
const MAX_THREAD_LENGTH = 120;
const MAX_TITLE_LENGTH = 120;
const MAX_DESTINATION_LENGTH = 180;
const MAX_SOURCE_LENGTH = 160;
const MAX_PROVIDER_ERROR_LENGTH = 300;
const MAX_PLAN_REVISION = 1_000_000;
const DEFAULT_DRAFT_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_DRAFT_LIFETIME_MS = 90 * 24 * 60 * 60 * 1_000;
const LOCK_RECEIPT_LIFETIME_MS = 365 * 24 * 60 * 60 * 1_000;

const providerValidator = v.union(
  v.literal("flights"),
  v.literal("stays"),
  v.literal("activities"),
  v.literal("airport"),
);

const providerStatusValidator = v.union(
  v.literal("queued"),
  v.literal("searching"),
  v.literal("ready"),
  v.literal("error"),
  v.literal("skipped"),
);

type Provider = "flights" | "stays" | "activities" | "airport";
type ProviderStatus = "queued" | "searching" | "ready" | "error" | "skipped";
type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, max: number, min = 0): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

function validThread(value: unknown): value is string {
  return boundedString(value, MAX_THREAD_LENGTH, 1);
}

function validRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= MAX_PLAN_REVISION;
}

/**
 * Keep a JSON TripDoc bounded before it becomes reactive data. The detailed
 * itinerary validator stays at the permanent-trip boundary; drafts also need
 * a structural guard so malformed model output cannot become an oversized or
 * prototype-shaped live document.
 */
function validJsonValue(value: unknown, budget: { nodes: number }, depth = 0): boolean {
  budget.nodes += 1;
  if (budget.nodes > 40_000 || depth > 18) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= 3_000;
  if (Array.isArray(value)) {
    if (value.length > 12_000) return false;
    return value.every((entry) => validJsonValue(entry, budget, depth + 1));
  }
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  if (entries.length > 120) return false;
  return entries.every(([key, entry]) => (
    boundedString(key, 120, 1) && key !== "__proto__" && key !== "prototype" && key !== "constructor" && validJsonValue(entry, budget, depth + 1)
  ));
}

function parseTripDoc(
  data: string,
  title: string,
  destination: string,
  threadId: string,
  planRevision: number,
  status: "scouting" | "planned",
): { doc: JsonRecord; data: string } | null {
  if (!boundedString(data, MAX_DATA_BYTES, 2) || !boundedString(title, MAX_TITLE_LENGTH, 1) || !boundedString(destination, MAX_DESTINATION_LENGTH, 1) || !validThread(threadId) || !validRevision(planRevision)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.kind !== "trip" || parsed.title !== title || parsed.destination !== destination || !validJsonValue(parsed, { nodes: 0 })) {
    return null;
  }
  if (parsed.threadId !== undefined && parsed.threadId !== threadId) return null;
  if (parsed.planRevision !== undefined && !validRevision(parsed.planRevision)) return null;
  const doc: JsonRecord = {
    ...parsed,
    kind: "trip",
    title,
    destination,
    threadId,
    planRevision,
    status,
  };
  const normalized = JSON.stringify(doc);
  return normalized.length <= MAX_DATA_BYTES ? { doc, data: normalized } : null;
}

function parseProviderItems(itemsJson: string | undefined): unknown | undefined | null {
  if (itemsJson === undefined) return undefined;
  if (!boundedString(itemsJson, MAX_DATA_BYTES, 1)) return null;
  try {
    const parsed = JSON.parse(itemsJson);
    return validJsonValue(parsed, { nodes: 0 }) ? parsed : null;
  } catch {
    return null;
  }
}

function itemCount(value: unknown): number {
  return Array.isArray(value) ? value.length : value === null ? 0 : 1;
}

async function sourceMessageMatchesThread(ctx: { db: any }, sourceMessageId: unknown, threadId: string): Promise<boolean> {
  if (sourceMessageId === undefined) return true;
  const message = await ctx.db.get(sourceMessageId);
  return Boolean(message && message.threadId === threadId && message.role === "user");
}

function draftUnavailable(row: any, now: number): "locked" | "expired" | null {
  if (row.state === "locked") return "locked";
  if (row.state !== "draft" || row.expiresAt <= now) return "expired";
  return null;
}

function sourceMessageRequired(workerToken: string | undefined, sourceMessageId: unknown): boolean {
  return hasWorkerCapability(workerToken) && sourceMessageId === undefined;
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

type TripCenter = { lat: number; lng: number };

function tripCenter(value: unknown): TripCenter | undefined {
  if (!isRecord(value) || !Number.isFinite(value.lat) || !Number.isFinite(value.lng)) return undefined;
  const lat = Number(value.lat);
  const lng = Number(value.lng);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : undefined;
}

/**
 * `center` drives the live map, so it must mean one selected city rather than
 * an arithmetic midpoint between unrelated scouting result sets. A missing or
 * stale selection intentionally falls back to the immutable destination
 * geocode, then the document's existing centre for V1 compatibility.
 */
function activeCityContextCenter(doc: JsonRecord): TripCenter | undefined {
  const activeId = typeof doc.activeCityContextId === "string" ? doc.activeCityContextId : undefined;
  if (!activeId || !Array.isArray(doc.cityContexts)) return undefined;
  for (const rawContext of doc.cityContexts) {
    if (!isRecord(rawContext) || rawContext.id !== activeId) continue;
    return tripCenter(rawContext.center);
  }
  return undefined;
}

function compactCityKey(value: unknown): string {
  return typeof value === "string"
    ? value.trim().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase().replace(/[^a-z0-9]+/g, "")
    : "";
}

/**
 * Provider searches in this mutation are for the trip's primary destination.
 * They must not silently turn an explicit valid cross-city candidate into a
 * destination result, but missing or stale IDs need the durable destination
 * context so the globe never receives an unscoped primary result.
 */
function destinationCityContext(doc: JsonRecord): { id: string; knownIds: Set<string> } | undefined {
  if (!Array.isArray(doc.cityContexts)) return undefined;
  const contexts = doc.cityContexts
    .filter(isRecord)
    .flatMap((context) => boundedString(context.id, 180, 1) ? [context] : []);
  const knownIds = new Set(contexts.map((context) => String(context.id)));
  if (!knownIds.size) return undefined;
  const destination = compactCityKey(doc.destination);
  const destinationContext = contexts.find((context) => context.source === "destination" && compactCityKey(context.city) === destination)
    ?? contexts.find((context) => compactCityKey(context.city) === destination)
    ?? contexts.find((context) => context.source === "destination");
  return destinationContext ? { id: String(destinationContext.id), knownIds } : undefined;
}

function scopePrimaryDestinationCandidates(value: unknown, destination: { id: string; knownIds: Set<string> } | undefined): unknown {
  if (!destination || !Array.isArray(value)) return value;
  return value.map((rawCandidate) => {
    if (!isRecord(rawCandidate)) return rawCandidate;
    const cityContextId = boundedString(rawCandidate.cityContextId, 180, 1) ? rawCandidate.cityContextId : undefined;
    return cityContextId && destination.knownIds.has(cityContextId)
      ? rawCandidate
      : { ...rawCandidate, cityContextId: destination.id };
  });
}

function safeText(value: unknown, max: number, fallback = ""): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max) : fallback;
}

/** Mirrors the derived live-map fields on permanent trips without touching the owner-plan revision. */
function refreshProviderDerivedState(doc: JsonRecord, providers: JsonRecord, now: number): void {
  const stays = Array.isArray(doc.stays) ? doc.stays.filter(isRecord) : [];
  const previousCenter = tripCenter(doc.center);
  const preferredCenter = activeCityContextCenter(doc) ?? tripCenter(doc.destinationCenter) ?? previousCenter;
  if (preferredCenter) doc.center = preferredCenter;

  const locked = isRecord(doc.locked) ? doc.locked : {};
  const flight = isRecord(locked.flight) ? locked.flight : stays[0];
  const stay = isRecord(locked.stay) ? locked.stay : stays[0];
  const nights = Math.max(1, Math.round((Date.parse(String(doc.returnDate ?? "")) - Date.parse(String(doc.departDate ?? ""))) / 86_400_000) || 1);
  const adults = Math.max(1, finiteNumber(doc.adults) || 1);
  const flightCost = finiteNumber(flight?.priceGbp) * adults;
  const stayCost = finiteNumber(stay?.totalGbp) || finiteNumber(stay?.priceGbp) * nights;
  const activityCount = Array.isArray(locked.activities) ? locked.activities.length : 0;
  const activitiesEst = activityCount * 25 * adults;
  const lockedFlightCost = finiteNumber(isRecord(locked.flight) ? locked.flight.priceGbp : undefined) * adults;
  const lockedStayRecord = isRecord(locked.stay) ? locked.stay : undefined;
  const lockedStayCost = finiteNumber(lockedStayRecord?.totalGbp) || finiteNumber(lockedStayRecord?.priceGbp) * nights;
  doc.totals = {
    flights: Math.round(flightCost),
    stay: Math.round(stayCost),
    activitiesEst: Math.round(activitiesEst),
    total: Math.round(flightCost + stayCost + activitiesEst),
    projectedTotal: Math.round(flightCost + stayCost + activitiesEst),
    lockedTotal: Math.round(lockedFlightCost + lockedStayCost + activitiesEst),
  };

  const states = Object.values(providers).filter(isRecord).map((provider) => provider.status);
  if (states.length && states.every((status) => ["ready", "error", "skipped"].includes(String(status)))) {
    doc.searchCompletedAt = now;
  } else {
    delete doc.searchCompletedAt;
  }
}


/** Creates an opaque, conversation-scoped draft; it is intentionally absent from creations. */
export const createDraft = mutation({
  args: {
    threadId: v.string(),
    title: v.string(),
    destination: v.string(),
    data: v.string(),
    expiresAt: v.optional(v.number()),
    sourceMessageId: v.optional(v.id("chatMessages")),
    ...actorAuthArgs,
  },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const now = Date.now();
    if (!validThread(a.threadId) || !boundedString(a.title, MAX_TITLE_LENGTH, 1) || !boundedString(a.destination, MAX_DESTINATION_LENGTH, 1)) {
      return { ok: false as const, reason: "invalid" as const };
    }
    if (sourceMessageRequired(a.workerToken, a.sourceMessageId)) {
      return { ok: false as const, reason: "source_message_required" as const };
    }
    if (!(await sourceMessageMatchesThread(ctx, a.sourceMessageId, a.threadId))) {
      return { ok: false as const, reason: "source_message_mismatch" as const };
    }
    const expiresAt = a.expiresAt ?? now + DEFAULT_DRAFT_LIFETIME_MS;
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + MAX_DRAFT_LIFETIME_MS) {
      return { ok: false as const, reason: "invalid" as const };
    }
    const parsed = parseTripDoc(a.data, a.title, a.destination, a.threadId, 0, "scouting");
    if (!parsed) return { ok: false as const, reason: "invalid" as const };
    const id = await ctx.db.insert("travelDrafts", {
      threadId: a.threadId,
      state: "draft",
      schemaVersion: SCHEMA_VERSION,
      title: a.title,
      destination: a.destination,
      data: parsed.data,
      planRevision: 0,
      sourceMessageId: a.sourceMessageId,
      createdAt: now,
      updatedAt: now,
      expiresAt,
    });
    return { ok: true as const, id, planRevision: 0, expiresAt };
  },
});

/** Exact-ID only: drafts are never listed broadly or surfaced in the saved library. */
export const get = query({
  args: { id: v.id("travelDrafts"), sourceMessageId: v.optional(v.id("chatMessages")), ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    const row = await ctx.db.get(a.id);
    if (!row) return null;
    if (row.state === "draft" && row.expiresAt <= Date.now()) return null;
    if (sourceMessageRequired(a.workerToken, a.sourceMessageId)) return null;
    if (hasWorkerCapability(a.workerToken) && !(await sourceMessageMatchesThread(ctx, a.sourceMessageId, row.threadId))) return null;
    return row;
  },
});

/** CAS plan write. Provider arrivals never increment this owner-plan revision. */
export const updatePlan = mutation({
  args: {
    id: v.id("travelDrafts"),
    expectedPlanRevision: v.number(),
    title: v.string(),
    destination: v.string(),
    data: v.string(),
    sourceMessageId: v.optional(v.id("chatMessages")),
    ...actorAuthArgs,
  },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    if (!validRevision(a.expectedPlanRevision) || !boundedString(a.title, MAX_TITLE_LENGTH, 1) || !boundedString(a.destination, MAX_DESTINATION_LENGTH, 1)) {
      return { ok: false as const, reason: "invalid" as const };
    }
    const row = await ctx.db.get(a.id);
    if (!row) return { ok: false as const, reason: "not_found" as const };
    if (sourceMessageRequired(a.workerToken, a.sourceMessageId)) {
      return { ok: false as const, reason: "source_message_required" as const };
    }
    if (!(await sourceMessageMatchesThread(ctx, a.sourceMessageId, row.threadId))) {
      return { ok: false as const, reason: "source_message_mismatch" as const };
    }
    const unavailable = draftUnavailable(row, Date.now());
    if (unavailable === "locked") return { ok: false as const, reason: "locked" as const, lockedCreationId: row.lockedCreationId };
    if (unavailable) return { ok: false as const, reason: unavailable };
    if (a.expectedPlanRevision !== row.planRevision) {
      return { ok: false as const, reason: "stale" as const, planRevision: row.planRevision, updatedAt: row.updatedAt };
    }
    const planRevision = row.planRevision + 1;
    const parsed = parseTripDoc(a.data, a.title, a.destination, row.threadId, planRevision, "scouting");
    if (!parsed) return { ok: false as const, reason: "invalid" as const };
    const updatedAt = Date.now();
    await ctx.db.patch(a.id, {
      title: a.title,
      destination: a.destination,
      data: parsed.data,
      schemaVersion: SCHEMA_VERSION,
      planRevision,
      updatedAt,
    });
    return { ok: true as const, planRevision, updatedAt };
  },
});

/**
 * Provider results merge only their own subtree, so a late scout response
 * cannot erase owner-set times, locks, routes, or a newer plan revision.
 */
export const patchProvider = mutation({
  args: {
    id: v.id("travelDrafts"),
    provider: providerValidator,
    status: providerStatusValidator,
    source: v.string(),
    itemsJson: v.optional(v.string()),
    error: v.optional(v.string()),
    sourceMessageId: v.optional(v.id("chatMessages")),
    ...actorAuthArgs,
  },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    if (!boundedString(a.source, MAX_SOURCE_LENGTH, 1) || (a.error !== undefined && !boundedString(a.error, MAX_PROVIDER_ERROR_LENGTH))) {
      return { ok: false as const, reason: "invalid" as const };
    }
    const parsedItems = parseProviderItems(a.itemsJson);
    if (parsedItems === null) return { ok: false as const, reason: "invalid" as const };
    const row = await ctx.db.get(a.id);
    if (!row) return { ok: false as const, reason: "not_found" as const };
    if (sourceMessageRequired(a.workerToken, a.sourceMessageId)) {
      return { ok: false as const, reason: "source_message_required" as const };
    }
    if (!(await sourceMessageMatchesThread(ctx, a.sourceMessageId, row.threadId))) {
      return { ok: false as const, reason: "source_message_mismatch" as const };
    }
    const unavailable = draftUnavailable(row, Date.now());
    if (unavailable === "locked") return { ok: false as const, reason: "locked" as const, lockedCreationId: row.lockedCreationId };
    if (unavailable) return { ok: false as const, reason: unavailable };
    const parsed = parseTripDoc(row.data, row.title, row.destination, row.threadId, row.planRevision, "scouting");
    if (!parsed) return { ok: false as const, reason: "invalid_draft" as const };
    const doc = parsed.doc;
    const items = (a.provider === "stays" || a.provider === "activities")
      ? scopePrimaryDestinationCandidates(parsedItems, destinationCityContext(doc))
      : parsedItems;
    const providers = isRecord(doc.providers) ? { ...doc.providers } : {};
    const now = Date.now();
    providers[a.provider as Provider] = {
      status: a.status as ProviderStatus,
      source: a.source,
      count: items === undefined ? Number((providers[a.provider as Provider] as JsonRecord | undefined)?.count ?? 0) || 0 : itemCount(items),
      checkedAt: now,
      ...(a.error !== undefined ? { error: a.error } : {}),
    };
    doc.providers = providers;
    if (items !== undefined) {
      const target = a.provider === "airport" ? "airport" : a.provider;
      doc[target] = items;
    }
    refreshProviderDerivedState(doc, providers, now);
    const data = JSON.stringify(doc);
    if (data.length > MAX_DATA_BYTES) return { ok: false as const, reason: "invalid" as const };
    const updatedAt = now;
    await ctx.db.patch(a.id, { data, schemaVersion: SCHEMA_VERSION, updatedAt });
    return { ok: true as const, planRevision: row.planRevision, updatedAt };
  },
});

/**
 * One atomic draft-to-creation promotion. The locked receipt makes retries
 * idempotent and prevents an incidental conversation from producing multiple
 * permanent travel records.
 */
export const lockDraft = mutation({
  args: {
    id: v.id("travelDrafts"),
    expectedPlanRevision: v.number(),
    sourceMessageId: v.optional(v.id("chatMessages")),
    ...actorAuthArgs,
  },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    if (!validRevision(a.expectedPlanRevision)) return { ok: false as const, reason: "invalid" as const };
    const row = await ctx.db.get(a.id);
    if (!row) return { ok: false as const, reason: "not_found" as const };
    if (sourceMessageRequired(a.workerToken, a.sourceMessageId)) {
      return { ok: false as const, reason: "source_message_required" as const };
    }
    if (!(await sourceMessageMatchesThread(ctx, a.sourceMessageId, row.threadId))) {
      return { ok: false as const, reason: "source_message_mismatch" as const };
    }
    if (row.state === "locked" && row.lockedCreationId) {
      const existing = await ctx.db.get(row.lockedCreationId);
      let mindmapCreationId: unknown;
      try {
        mindmapCreationId = existing?.data ? JSON.parse(existing.data)?.mindmapCreationId : undefined;
      } catch {
        mindmapCreationId = undefined;
      }
      return {
        ok: true as const,
        creationId: row.lockedCreationId,
        ...(typeof mindmapCreationId === "string" ? { mindmapCreationId } : {}),
        alreadyLocked: true as const,
        planRevision: row.planRevision,
      };
    }
    if (row.state !== "draft" || row.expiresAt <= Date.now()) return { ok: false as const, reason: "expired" as const };
    if (a.expectedPlanRevision !== row.planRevision) {
      return { ok: false as const, reason: "stale" as const, planRevision: row.planRevision, updatedAt: row.updatedAt };
    }
    const parsed = parseTripDoc(row.data, row.title, row.destination, row.threadId, row.planRevision, "planned");
    if (!parsed) return { ok: false as const, reason: "invalid_draft" as const };
    const canvas = tripCanvas(parsed.doc);
    if (!canvas) return { ok: false as const, reason: "invalid_draft" as const };
    const now = Date.now();
    const creationId = await ctx.db.insert("creations", {
      kind: "trip",
      title: row.title,
      data: parsed.data,
      category: "travel plans",
      folder: "Travel / Plans",
      threadId: row.threadId,
      createdAt: now,
      updatedAt: now,
    });
    canvas.tripId = String(creationId);
    const canvasData = JSON.stringify(canvas);
    if (canvasData.length > MAX_DATA_BYTES) throw new Error("Travel canvas exceeded its safe size");
    const mindmapCreationId = await ctx.db.insert("creations", {
      kind: "canvas",
      title: safeText(canvas.title, MAX_TITLE_LENGTH, `Trip map · ${row.destination}`),
      data: canvasData,
      category: "mind maps",
      folder: "Travel / Plans",
      threadId: row.threadId,
      createdAt: now,
      updatedAt: now,
    });
    parsed.doc.mindmapCreationId = String(mindmapCreationId);
    const data = JSON.stringify(parsed.doc);
    if (data.length > MAX_DATA_BYTES) throw new Error("Locked trip exceeded its safe size");
    await ctx.db.patch(creationId, { data, updatedAt: now });
    await ctx.db.patch(a.id, {
      state: "locked",
      lockedCreationId: creationId,
      schemaVersion: SCHEMA_VERSION,
      updatedAt: now,
      expiresAt: Math.max(row.expiresAt, now + LOCK_RECEIPT_LIFETIME_MS),
    });
    return { ok: true as const, creationId, mindmapCreationId, alreadyLocked: false as const, planRevision: row.planRevision };
  },
});
