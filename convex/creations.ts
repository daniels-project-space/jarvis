import { mutation, query } from "./_generated/server";
import { type Id } from "./_generated/dataModel";
import { ConvexError, v } from "convex/values";
import { actorAuthArgs, requireActor, requireViewer, viewerAuthArgs } from "./controlAuth";
import { inferCreationFiling } from "./creationFiling";
import { linkExplicitFilesToCreation, linkMessageFilesToCreation } from "./fileHelpers";
import { MAX_TRIP_CANVAS_BYTES, tripCanvas, type TripCanvasRecord } from "./tripCanvas";
import {
  CREATION_ASSET_STORE_V1,
  CREATION_ASSET_STORE_V2,
  creationAssetLocatorFromInput,
  creationAssetLocatorFromWriteInput,
  creationAssetLocatorFromRow,
  isPrivateCreationAssetKey,
} from "./creationAssetLocator";
import { redactLegacyCreationUrls, trustedLegacyCreationUrl } from "../src/lib/legacy-creation-url";

// JARVIS's atelier — everything he makes (mind maps, charts, images, PDFs,
// docs) is saved here so nothing he creates is ever lost. The UI lists it
// reactively; tools upsert while he works.

type TripCanvasWrite = {
  id: Id<"creations">;
  title: string;
  data: string;
};

function creationMediaUrl(id: Id<"creations">): string {
  return `/api/creation-media?id=${encodeURIComponent(String(id))}&variant=asset`;
}

export { isPrivateCreationAssetKey } from "./creationAssetLocator";

function isCreationAssetWriterEpoch(value: string | undefined): value is string {
  return Boolean(value && /^[a-zA-Z0-9_-]{16,120}$/.test(value));
}

export function viewerCreation(row: any) {
  const {
    assetR2Key: _assetR2Key,
    assetStore: _assetStore,
    assetLocator: _assetLocator,
    assetContentType: _assetContentType,
    ...publicRow
  } = row;
  for (const field of ["title", "data", "category", "folder", "project", "inquiry"] as const) {
    if (typeof publicRow[field] === "string") publicRow[field] = redactLegacyCreationUrls(publicRow[field]);
  }
  const filing = inferCreationFiling(row);
  const mediaUrl = creationMediaUrl(row._id);
  if (creationAssetLocatorFromRow(row)) {
    return {
      ...publicRow,
      ...filing,
      url: mediaUrl,
      thumb: mediaUrl,
      hasPrivateAsset: true,
    };
  }
  // Historical public objects remain readable through the owner-authorized
  // media route, but never leave Convex as raw public bucket URLs.
  if (trustedLegacyCreationUrl(row.url) || trustedLegacyCreationUrl(row.thumb)) {
    return { ...publicRow, ...filing, url: mediaUrl, thumb: mediaUrl, hasPrivateAsset: false };
  }
  return { ...publicRow, ...filing, hasPrivateAsset: false };
}

function isRecord(value: unknown): value is TripCanvasRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

type TripCenter = { lat: number; lng: number };
type DestinationCityContext = { id: string; knownIds: Set<string> };

function tripCenter(value: unknown): TripCenter | undefined {
  if (!isRecord(value) || !Number.isFinite(value.lat) || !Number.isFinite(value.lng)) return undefined;
  const lat = Number(value.lat);
  const lng = Number(value.lng);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : undefined;
}

function compactCityKey(value: unknown): string {
  return typeof value === "string"
    ? value.trim().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase().replace(/[^a-z0-9]+/g, "")
    : "";
}

function cityContextId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 180 && !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : undefined;
}

function activeCityContextCenter(doc: TripCanvasRecord): TripCenter | undefined {
  const activeId = cityContextId(doc.activeCityContextId);
  if (!activeId || !Array.isArray(doc.cityContexts)) return undefined;
  for (const rawContext of doc.cityContexts) {
    if (!isRecord(rawContext) || rawContext.id !== activeId) continue;
    return tripCenter(rawContext.center);
  }
  return undefined;
}

function destinationCityContext(doc: TripCanvasRecord): DestinationCityContext | undefined {
  if (!Array.isArray(doc.cityContexts)) return undefined;
  const contexts = doc.cityContexts
    .filter(isRecord)
    .flatMap((context) => cityContextId(context.id) ? [context] : []);
  const knownIds = new Set(contexts.map((context) => String(context.id)));
  if (!knownIds.size) return undefined;
  const destination = compactCityKey(doc.destination);
  const selected = contexts.find((context) => context.source === "destination" && compactCityKey(context.city) === destination)
    ?? contexts.find((context) => compactCityKey(context.city) === destination)
    ?? contexts.find((context) => context.source === "destination");
  return selected ? { id: String(selected.id), knownIds } : undefined;
}

function scopePrimaryDestinationCandidates(value: unknown, destination: DestinationCityContext | undefined): unknown {
  if (!destination || !Array.isArray(value)) return value;
  return value.map((rawCandidate) => {
    if (!isRecord(rawCandidate)) return rawCandidate;
    const existingId = cityContextId(rawCandidate.cityContextId);
    return existingId && destination.knownIds.has(existingId)
      ? rawCandidate
      : { ...rawCandidate, cityContextId: destination.id };
  });
}

function tripCanvasTitle(canvas: TripCanvasRecord, fallback: string): string {
  return typeof canvas.title === "string" ? canvas.title.slice(0, 120) : fallback.slice(0, 120);
}

/**
 * A linked travel map is an integrity boundary: only the canvas created for
 * this exact trip and conversation can be rewritten.  The caller performs
 * both patches inside one Convex mutation, so rejection leaves the plan and
 * map unchanged together.
 */
async function linkedTripCanvasWrite(
  ctx: { db: any },
  trip: { _id: Id<"creations">; title: string; threadId?: string },
  doc: TripCanvasRecord,
): Promise<{ ok: true; write?: TripCanvasWrite } | { ok: false; reason: "invalid_mindmap" | "invalid_trip" }> {
  const mindmapCreationId = typeof doc.mindmapCreationId === "string" ? doc.mindmapCreationId : undefined;
  if (!mindmapCreationId) return { ok: true };

  let canvasRow: any;
  try {
    canvasRow = await ctx.db.get(mindmapCreationId as Id<"creations">);
  } catch {
    return { ok: false, reason: "invalid_mindmap" };
  }
  // Older client-created maps predate thread filing. They are safe to repair
  // only when unthreaded; a conflicting thread is never adopted.
  const conflictingThread = canvasRow?.threadId !== undefined && canvasRow.threadId !== trip.threadId;
  if (!canvasRow || canvasRow.kind !== "canvas" || conflictingThread || typeof canvasRow.data !== "string") {
    return { ok: false, reason: "invalid_mindmap" };
  }

  let existing: unknown;
  try {
    existing = JSON.parse(canvasRow.data);
  } catch {
    return { ok: false, reason: "invalid_mindmap" };
  }
  if (!isRecord(existing) || existing.tripId !== String(trip._id)) return { ok: false, reason: "invalid_mindmap" };

  const canvas = tripCanvas(doc);
  if (!canvas) return { ok: false, reason: "invalid_trip" };
  canvas.tripId = String(trip._id);
  const data = JSON.stringify(canvas);
  if (data.length > MAX_TRIP_CANVAS_BYTES) return { ok: false, reason: "invalid_trip" };
  return { ok: true, write: { id: canvasRow._id, title: tripCanvasTitle(canvas, trip.title), data } };
}

async function patchLinkedTripCanvas(
  ctx: { db: any },
  write: TripCanvasWrite | undefined,
  trip: { threadId?: string },
  updatedAt: number,
): Promise<void> {
  if (!write) return;
  await ctx.db.patch(write.id, {
    title: write.title,
    data: write.data,
    category: "mind maps",
    folder: "Travel / Plans",
    ...(trip.threadId ? { threadId: trip.threadId } : {}),
    updatedAt,
  });
}

export const list = query({
  args: {
    kind: v.optional(v.string()),
    category: v.optional(v.string()),
    folder: v.optional(v.string()),
    project: v.optional(v.string()),
    limit: v.optional(v.number()),
    ...viewerAuthArgs,
  },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    const limit = Math.min(a.limit ?? 40, 100);
    const rows = a.project
      ? await ctx.db
          .query("creations")
          .withIndex("by_project", (q: any) => q.eq("project", a.project))
          .order("desc")
          .take(limit)
      : a.folder
        ? await ctx.db
            .query("creations")
            .withIndex("by_folder", (q: any) => q.eq("folder", a.folder))
            .order("desc")
            .take(limit)
        : a.category
          ? await ctx.db
              .query("creations")
              .withIndex("by_category", (q: any) => q.eq("category", a.category))
              .order("desc")
              .take(limit)
          : a.kind
      ? await ctx.db
          .query("creations")
          .withIndex("by_kind", (q: any) => q.eq("kind", a.kind))
          .order("desc")
          .take(limit)
      : await ctx.db
          .query("creations")
          .withIndex("by_updatedAt")
          .order("desc")
          .take(limit);
    return rows.map(viewerCreation);
  },
});

export const get = query({
  args: { id: v.id("creations"), ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    const row = await ctx.db.get(a.id);
    return row ? viewerCreation(row) : null;
  },
});

// A deliberately narrow server-side lookup for the authenticated media and
// download routes. Viewer-facing reads above never disclose private R2 keys.
export const getForMedia = query({
  args: { id: v.id("creations"), ...actorAuthArgs },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const row = await ctx.db.get(a.id);
    if (!row) return null;
    const asset = creationAssetLocatorFromRow(row);
    if (asset) {
      return {
        assetStore: asset.assetStore,
        assetLocator: asset.assetLocator,
        assetContentType: typeof row.assetContentType === "string" ? row.assetContentType.slice(0, 160) : undefined,
        title: row.title,
        kind: row.kind,
      };
    }
    const legacyUrl = trustedLegacyCreationUrl(row.url) || trustedLegacyCreationUrl(row.thumb);
    if (!legacyUrl) return null;
    return { legacyUrl, title: row.title, kind: row.kind };
  },
});

// This lookup is intentionally narrower than `getForMedia`: recovery needs
// only a durable creation receipt, never the private object coordinate or the
// rest of the library row. It is owner/worker-only so an opaque asset key is
// never an unauthenticated existence oracle.
export const getByAssetR2Key = query({
  args: { assetR2Key: v.string(), ...actorAuthArgs },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    if (!isPrivateCreationAssetKey(a.assetR2Key)) {
      throw new ConvexError({ code: "INVALID_CREATION_ASSET_KEY", message: "Private creation asset identity is invalid" });
    }
    const row = await ctx.db
      .query("creations")
      .withIndex("by_assetR2Key", (q: any) => q.eq("assetR2Key", a.assetR2Key))
      .first();
    return row ? String(row._id) : null;
  },
});

// The locator form is authoritative for V2. The legacy key query remains for
// already deployed producers during the additive rollout, but no V2 reader
// may downgrade to it as a storage selection mechanism.
export const getByAssetLocator = query({
  args: { assetStore: v.string(), assetLocator: v.string(), ...actorAuthArgs },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const asset = creationAssetLocatorFromInput({ assetStore: a.assetStore, assetLocator: a.assetLocator });
    if (!asset) {
      throw new ConvexError({ code: "INVALID_CREATION_ASSET_LOCATOR", message: "Private creation asset locator is invalid" });
    }
    const row = await ctx.db
      .query("creations")
      .withIndex("by_assetStoreLocator", (q: any) => q.eq("assetStore", asset.assetStore).eq("assetLocator", asset.assetLocator))
      .first();
    return row ? String(row._id) : null;
  },
});

// Find the most recently touched creation (optionally by kind/title match) —
// lets the brain say "add X to the mind map" without tracking ids.
export const latest = query({
  args: { kind: v.optional(v.string()), titleMatch: v.optional(v.string()), ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    const rows = await ctx.db.query("creations").withIndex("by_updatedAt").order("desc").take(50);
    const t = (a.titleMatch ?? "").toLowerCase();
    const row = (
      rows.find(
        (r: any) => (!a.kind || r.kind === a.kind) && (!t || r.title.toLowerCase().includes(t)),
      ) ?? null
    );
    return row ? viewerCreation(row) : null;
  },
});

export const create = mutation({
  args: {
    kind: v.string(),
    title: v.string(),
    data: v.optional(v.string()),
    url: v.optional(v.string()),
    thumb: v.optional(v.string()),
    assetR2Key: v.optional(v.string()),
    assetStore: v.optional(v.string()),
    assetLocator: v.optional(v.string()),
    assetContentType: v.optional(v.string()),
    assetWriteEpoch: v.optional(v.string()),
    category: v.optional(v.string()),
    folder: v.optional(v.string()),
    project: v.optional(v.string()),
    inquiry: v.optional(v.string()),
    threadId: v.optional(v.string()),
    sourceMessageId: v.optional(v.id("chatMessages")),
    sourceFiles: v.optional(v.array(v.object({ fileId: v.id("files"), name: v.string() }))),
    ...actorAuthArgs,
  },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const hasAssetIdentity = a.assetR2Key !== undefined || a.assetStore !== undefined || a.assetLocator !== undefined;
    const asset = creationAssetLocatorFromWriteInput(a);
    if (hasAssetIdentity && !asset) {
      throw new Error("invalid private creation asset key");
    }
    if (a.assetContentType !== undefined && !asset) {
      throw new Error("private creation asset content type requires an asset key");
    }
    if (a.assetWriteEpoch !== undefined && (!asset || !isCreationAssetWriterEpoch(a.assetWriteEpoch))) {
      throw new Error("private creation asset writer epoch is invalid");
    }

    // The migration's first durable transition freezes private creation
    // writes before its paginated snapshot. After cutover, only an explicit
    // V2 locator is legal, so an old Vercel/Trigger process cannot silently
    // create a new V1 row outside the verified manifest.
    if (asset) {
      const migration = await ctx.db
        .query("creationAssetStoreMigrations")
        .withIndex("by_key", (q: any) => q.eq("key", "private-creation-r2-v2"))
        .first();
      if (asset.assetStore === CREATION_ASSET_STORE_V2 && migration?.state !== "activated") {
        throw new ConvexError({
          code: "CREATION_ASSET_V2_NOT_ACTIVATED",
          message: "Private creation V2 assets are unavailable until the durable migration activation completes",
        });
      }
      if (
        asset.assetStore === CREATION_ASSET_STORE_V1
        && migration
        && migration.state !== "aborted"
        && migration.state !== "activated"
      ) {
        throw new ConvexError({
          code: "CREATION_ASSET_MIGRATION_FROZEN",
          message: "Private creation assets are frozen for their controlled storage migration",
        });
      }
      if (migration?.state === "activated" && asset.assetStore !== CREATION_ASSET_STORE_V2) {
        throw new ConvexError({
          code: "CREATION_ASSET_V2_REQUIRED",
          message: "Private creation assets must use the activated V2 store",
        });
      }
    }

    // A lost response is indistinguishable from a rejected request to a
    // caller. For a private asset, the exact authenticated owner + opaque key
    // is therefore the durable idempotency identity—not title, route, or any
    // caller-controlled request body that could accidentally merge work.
    if (asset) {
      let existing = await ctx.db
        .query("creations")
        .withIndex("by_assetStoreLocator", (q: any) => q.eq("assetStore", asset.assetStore).eq("assetLocator", asset.assetLocator))
        .first();
      // Historical V1 rows predate explicit locator fields. This bridge is
      // deliberately V1-only: a V2 locator may never fall back to the old
      // key index or old bucket semantics.
      if (!existing && asset.assetStore === CREATION_ASSET_STORE_V1) {
        existing = await ctx.db
          .query("creations")
          .withIndex("by_assetR2Key", (q: any) => q.eq("assetR2Key", asset.assetLocator))
          .first();
      }
      if (existing) {
        let staleIntent = await ctx.db
          .query("creationAssetCleanupIntents")
          .withIndex("by_assetStoreLocator", (q: any) => q.eq("assetStore", asset.assetStore).eq("assetLocator", asset.assetLocator))
          .first();
        if (!staleIntent && asset.assetStore === CREATION_ASSET_STORE_V1) {
          staleIntent = await ctx.db
            .query("creationAssetCleanupIntents")
            .withIndex("by_assetR2Key", (q: any) => q.eq("assetR2Key", asset.assetLocator))
            .first();
        }
        if (staleIntent) {
          if (staleIntent.cleanupDeletionTicketId) await ctx.db.delete(staleIntent.cleanupDeletionTicketId);
          await ctx.db.delete(staleIntent._id);
        }
        return existing._id;
      }
    }
    const now = Date.now();
    let assetIntent = asset
      ? await ctx.db
        .query("creationAssetCleanupIntents")
        .withIndex("by_assetStoreLocator", (q: any) => q.eq("assetStore", asset.assetStore).eq("assetLocator", asset.assetLocator))
        .first()
      : null;
    if (!assetIntent && asset?.assetStore === CREATION_ASSET_STORE_V1) {
      assetIntent = await ctx.db
        .query("creationAssetCleanupIntents")
        .withIndex("by_assetR2Key", (q: any) => q.eq("assetR2Key", asset.assetLocator))
        .first();
    }
    if (assetIntent) {
      // Cleanup owns every state except a live writer lease. Refusing a late
      // commit is what prevents a delayed request from creating a row after
      // recovery has deleted its private object.
      if (
        assetIntent.state !== "writing"
        || assetIntent.recoveryKind === "deletion"
        || assetIntent.writerEpoch !== a.assetWriteEpoch
        || Number(assetIntent.nextActionAt) <= now
      ) {
        throw new ConvexError({
          code: "CREATION_ASSET_RECOVERY_OWNED",
          message: "Private creation asset is no longer writable",
        });
      }
    } else if (asset && a.assetWriteEpoch) {
      // New producers never write without a reservation. Legacy producers
      // omit the epoch during a staged Convex rollout and retain their old
      // behavior; an epoch-bearing request fails closed if its fence vanished.
      throw new ConvexError({
        code: "CREATION_ASSET_RESERVATION_MISSING",
        message: "Private creation asset reservation is unavailable",
      });
    }
    const filing = inferCreationFiling(a);
    const creationId = await ctx.db.insert("creations", {
      kind: a.kind,
      title: a.title.slice(0, 120),
      data: a.data,
      url: a.url,
      thumb: a.thumb,
      // assetR2Key remains a compatibility mirror for rolled-out readers and
      // indexes. It never selects a store once explicit fields are present.
      assetR2Key: asset?.assetLocator,
      assetStore: asset?.assetStore,
      assetLocator: asset?.assetLocator,
      assetContentType: a.assetContentType?.slice(0, 160),
      ...filing,
      threadId: a.threadId?.slice(0, 120),
      sourceFiles: a.sourceFiles,
      createdAt: now,
      updatedAt: now,
    });
    await linkExplicitFilesToCreation(ctx, creationId, a.sourceFiles);
    await linkMessageFilesToCreation(ctx, creationId, a.sourceMessageId);
    // The asset write intent and creation insert are one Convex transaction.
    // A cleanup claim that races this mutation retries and observes either the
    // committed creation or its own cleanup ownership, never a half-state.
    if (assetIntent) await ctx.db.delete(assetIntent._id);
    return creationId;
  },
});

export const update = mutation({
  args: {
    id: v.id("creations"),
    title: v.optional(v.string()),
    data: v.optional(v.string()),
    url: v.optional(v.string()),
    thumb: v.optional(v.string()),
    category: v.optional(v.string()),
    folder: v.optional(v.string()),
    project: v.optional(v.string()),
    inquiry: v.optional(v.string()),
    threadId: v.optional(v.string()),
    sourceMessageId: v.optional(v.id("chatMessages")),
    ...actorAuthArgs,
  },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const existing = a.data !== undefined ? await ctx.db.get(a.id) : null;
    let tripData = a.data;
    let canvasWrite: TripCanvasWrite | undefined;
    if (existing?.kind === "trip" && a.data !== undefined) {
      let candidate: unknown;
      let persisted: unknown;
      try {
        candidate = JSON.parse(a.data);
        persisted = existing.data ? JSON.parse(existing.data) : undefined;
      } catch {
        throw new Error("Trip plan data must be valid JSON before it can update its linked map.");
      }
      if (!isRecord(candidate) || candidate.kind !== "trip") {
        throw new Error("Trip plan data must remain a trip document.");
      }
      // A generic save should never accidentally sever a durable map link
      // merely because a caller was holding an older TripDoc snapshot.
      if (typeof candidate.mindmapCreationId !== "string" && isRecord(persisted) && typeof persisted.mindmapCreationId === "string") {
        candidate.mindmapCreationId = persisted.mindmapCreationId;
        tripData = JSON.stringify(candidate);
      }
      const linked = await linkedTripCanvasWrite(ctx, existing, candidate);
      if (!linked.ok) throw new Error(`Trip plan could not update its linked map: ${linked.reason}`);
      canvasWrite = linked.write;
    }
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (a.title !== undefined) patch.title = a.title.slice(0, 120);
    if (tripData !== undefined) patch.data = tripData;
    if (a.url !== undefined) patch.url = a.url;
    if (a.thumb !== undefined) patch.thumb = a.thumb;
    if (a.category !== undefined) patch.category = a.category.slice(0, 80);
    if (a.folder !== undefined) patch.folder = a.folder.slice(0, 160);
    if (a.project !== undefined) patch.project = a.project.slice(0, 80);
    if (a.inquiry !== undefined) patch.inquiry = a.inquiry.slice(0, 80);
    if (a.threadId !== undefined) patch.threadId = a.threadId.slice(0, 120);
    await ctx.db.patch(a.id, patch);
    await patchLinkedTripCanvas(ctx, canvasWrite, existing ?? {}, Number(patch.updatedAt));
    await linkMessageFilesToCreation(ctx, a.id, a.sourceMessageId);
    return a.id;
  },
});

// Compare-and-swap for composable visual scenes. Multiple agents may patch a
// scene while Daniel is talking; a stale writer must merge again instead of
// silently erasing the other agent's blocks.
export const updateScene = mutation({
  args: {
    id: v.id("creations"),
    expectedUpdatedAt: v.number(),
    title: v.string(),
    data: v.string(),
    sourceMessageId: v.optional(v.id("chatMessages")),
    ...actorAuthArgs,
  },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const row = await ctx.db.get(a.id);
    if (!row || row.kind !== "scene") return { ok: false as const, reason: "not_found" as const };
    if (row.updatedAt !== a.expectedUpdatedAt)
      return { ok: false as const, reason: "conflict" as const, data: row.data, title: row.title, updatedAt: row.updatedAt };
    const updatedAt = Date.now();
    await ctx.db.patch(a.id, { title: a.title.slice(0, 120), data: a.data, updatedAt });
    await linkMessageFilesToCreation(ctx, a.id, a.sourceMessageId);
    return { ok: true as const, updatedAt };
  },
});

// Layout is a collaborative property of stable scene blocks. Merge only grid
// coordinates so a browser resize cannot clobber fresh live data or blocks
// that Jarvis is patching concurrently.
export const sceneLayoutSave = mutation({
  args: {
    id: v.id("creations"),
    layout: v.string(),
    ...actorAuthArgs,
  },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const row = await ctx.db.get(a.id);
    if (!row?.data || row.kind !== "scene") return false;
    let data: any;
    let layout: Array<{ i: string; x: number; y: number; w: number; h: number }>;
    try {
      data = JSON.parse(row.data);
      layout = JSON.parse(a.layout);
    } catch {
      return false;
    }
    if (!Array.isArray(data.blocks) || !Array.isArray(layout)) return false;
    const byId = new Map(layout.slice(0, 100).map((item) => [String(item?.i ?? ""), item]));
    for (const block of data.blocks) {
      const item = byId.get(String(block?.id ?? ""));
      if (!item || ![item.x, item.y, item.w, item.h].every(Number.isFinite)) continue;
      block.grid = {
        x: Math.max(0, Math.round(item.x)),
        y: Math.max(0, Math.round(item.y)),
        w: Math.max(1, Math.min(12, Math.round(item.w))),
        h: Math.max(2, Math.min(24, Math.round(item.h))),
      };
    }
    await ctx.db.patch(a.id, { data: JSON.stringify(data), updatedAt: Date.now() });
    return true;
  },
});

// Atomic progressive travel patch. Provider calls finish independently; doing
// read/modify/write in the Vercel route let two simultaneous results overwrite
// one another. Keeping the merge in one Convex mutation makes each arrival
// reactive and race-safe.
export const updateTripProvider = mutation({
  args: {
    id: v.id("creations"),
    provider: v.union(v.literal("flights"), v.literal("stays"), v.literal("activities"), v.literal("airport")),
    status: v.union(v.literal("queued"), v.literal("searching"), v.literal("ready"), v.literal("error"), v.literal("skipped")),
    source: v.string(),
    items: v.optional(v.any()),
    error: v.optional(v.string()),
    ...actorAuthArgs,
  },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const row = await ctx.db.get(a.id);
    if (!row || row.kind !== "trip" || !row.data) return false;
    let rawDoc: unknown;
    try {
      rawDoc = JSON.parse(row.data);
    } catch {
      return false;
    }
    if (!isRecord(rawDoc)) return false;
    // Existing provider payloads are deliberately opaque. Keep the writable
    // JSON record separate from the structural guard so unrelated future
    // fields remain intact while this mutation updates its own subtrees.
    const doc: any = rawDoc;
    const now = Date.now();
    doc.providers = doc.providers ?? {};
    const items = a.provider === "stays" || a.provider === "activities"
      ? scopePrimaryDestinationCandidates(a.items, destinationCityContext(doc))
      : a.items;
    const count = Array.isArray(items) ? items.length : items ? 1 : 0;
    doc.providers[a.provider] = {
      status: a.status,
      source: a.source,
      count,
      checkedAt: now,
      error: a.error?.slice(0, 300),
    };
    if (items !== undefined) {
      if (a.provider === "airport") doc.airport = items || undefined;
      else doc[a.provider] = items;
    }
    const preferredCenter = activeCityContextCenter(doc) ?? tripCenter(doc.destinationCenter) ?? tripCenter(doc.center);
    if (preferredCenter) doc.center = preferredCenter;
    const nights = Math.max(1, Math.round((Date.parse(doc.returnDate) - Date.parse(doc.departDate)) / 86_400_000) || 1);
    const flightOption = doc.locked?.flight ?? doc.flights?.[0];
    const projectedStay = doc.locked?.stay ?? doc.stays?.[0];
    const flights = (flightOption?.priceGbp ?? 0) * (doc.adults ?? 1);
    const stay = projectedStay?.totalGbp ?? (projectedStay?.priceGbp ?? 0) * nights;
    const activitiesEst = (doc.locked?.activities?.length ?? 0) * 25 * (doc.adults ?? 1);
    const lockedFlights = (doc.locked?.flight?.priceGbp ?? 0) * (doc.adults ?? 1);
    const lockedStay = doc.locked?.stay?.totalGbp ?? (doc.locked?.stay?.priceGbp ?? 0) * nights;
    doc.totals = {
      flights: Math.round(flights),
      stay: Math.round(stay),
      activitiesEst: Math.round(activitiesEst),
      total: Math.round(flights + stay + activitiesEst),
      projectedTotal: Math.round(flights + stay + activitiesEst),
      lockedTotal: Math.round(lockedFlights + lockedStay + activitiesEst),
    };
    const states = Object.values(doc.providers).map((provider: any) => provider?.status);
    if (states.length && states.every((state) => ["ready", "error", "skipped"].includes(String(state)))) {
      doc.searchCompletedAt = now;
    }
    const linked = isRecord(doc) ? await linkedTripCanvasWrite(ctx, row, doc) : { ok: false as const, reason: "invalid_trip" as const };
    if (!linked.ok) return false;
    await ctx.db.patch(a.id, {
      data: JSON.stringify(doc),
      thumb: row.thumb ?? doc.stays?.[0]?.thumb ?? doc.activities?.[0]?.photo,
      updatedAt: now,
    });
    await patchLinkedTripCanvas(ctx, linked.write, row, now);
    return true;
  },
});

function validItineraryDate(value: unknown): boolean {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T12:00:00Z`));
}

function validItineraryString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}

function validItineraryCoordinate(value: unknown, max: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= max;
}

/**
 * Convex accepts a JSON string for backwards-compatible TripDoc storage, but
 * it must still be a bounded, render-safe itinerary rather than arbitrary
 * agent-shaped data. The server-side normalizer adds legacy defaults later;
 * this gate protects the durable document at its write boundary.
 */
function validTripItineraryPayload(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 45) return false;
  let coordinates = 0;
  for (const day of value) {
    if (!day || typeof day !== "object" || Array.isArray(day)) return false;
    const record = day as Record<string, unknown>;
    if (!validItineraryDate(record.date) || !validItineraryString(record.label, 80)) return false;
    if (record.status !== undefined && record.status !== "draft" && record.status !== "locked") return false;
    if (!Array.isArray(record.items) || record.items.length > 24) return false;
    for (const item of record.items) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      const stop = item as Record<string, unknown>;
      if (
        !validItineraryString(stop.id, 180) ||
        !validItineraryDate(stop.date) ||
        !validItineraryString(stop.title, 180) ||
        !["flight", "hotel", "transfer", "activity", "booking"].includes(String(stop.kind)) ||
        !["generated", "owner", "gmail", "recommendation"].includes(String(stop.source))
      ) return false;
      if (stop.time !== undefined && (typeof stop.time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(stop.time))) return false;
      if (stop.durationMinutes !== undefined && (!Number.isFinite(stop.durationMinutes) || Number(stop.durationMinutes) <= 0 || Number(stop.durationMinutes) > 1_440)) return false;
      if ((stop.lat === undefined) !== (stop.lng === undefined)) return false;
      if (stop.lat !== undefined && (!validItineraryCoordinate(stop.lat, 90) || !validItineraryCoordinate(stop.lng, 180))) return false;
      if (stop.placeId !== undefined && !validItineraryString(stop.placeId, 180)) return false;
      // A stop can remain tied to its original city/base even after another
      // town becomes the active map context. The ID is opaque here on purpose:
      // legacy plans may not have city contexts yet, and context ownership is
      // established by the surrounding TripDoc rather than this route write.
      if (stop.cityContextId !== undefined && !validItineraryString(stop.cityContextId, 180)) return false;
      if (stop.link !== undefined && (!validItineraryString(stop.link, 1_600) || !/^https?:\/\//.test(stop.link))) return false;
      if (stop.note !== undefined && !validItineraryString(stop.note, 400)) return false;
      if (stop.locked !== undefined && typeof stop.locked !== "boolean") return false;
    }
    if (record.route === undefined) continue;
    if (!record.route || typeof record.route !== "object" || Array.isArray(record.route)) return false;
    const route = record.route as Record<string, unknown>;
    if (!["walking", "bicycling", "driving", "transit"].includes(String(route.mode)) || !["ready", "unavailable", "stale"].includes(String(route.status))) return false;
    if (route.coordinates !== undefined) {
      if (!Array.isArray(route.coordinates) || route.coordinates.length > 2_000) return false;
      coordinates += route.coordinates.length;
      if (coordinates > 12_000) return false;
      for (const point of route.coordinates) {
        if (!Array.isArray(point) || point.length < 2 || !validItineraryCoordinate(point[0], 180) || !validItineraryCoordinate(point[1], 90)) return false;
      }
    }
    for (const metric of ["durationSeconds", "distanceMeters"]) {
      if (route[metric] !== undefined && (!Number.isFinite(route[metric]) || Number(route[metric]) < 0)) return false;
    }
    if (route.status === "ready" && (!Array.isArray(route.coordinates) || route.coordinates.length < 2 || !Number.isFinite(route.durationSeconds) || !Number.isFinite(route.distanceMeters))) return false;
    if (route.legs !== undefined) {
      if (!Array.isArray(route.legs) || route.legs.length > 24) return false;
      for (const leg of route.legs) {
        if (!leg || typeof leg !== "object" || Array.isArray(leg)) return false;
        const edge = leg as Record<string, unknown>;
        if (!validItineraryString(edge.fromItemId, 180) || !validItineraryString(edge.toItemId, 180) || !Number.isFinite(edge.durationSeconds) || Number(edge.durationSeconds) < 0 || !Number.isFinite(edge.distanceMeters) || Number(edge.distanceMeters) < 0) return false;
      }
    }
    if (route.attribution !== undefined && !validItineraryString(route.attribution, 320)) return false;
    if (route.directionsUrl !== undefined && (!validItineraryString(route.directionsUrl, 1_600) || !/^https?:\/\//.test(route.directionsUrl))) return false;
    if (route.calculatedAt !== undefined && (!Number.isFinite(route.calculatedAt) || Number(route.calculatedAt) < 0)) return false;
  }
  return true;
}

// A day-plan write must not replace provider results that are still arriving
// from independent scouting tasks. This mutation reads the live TripDoc and
// changes only its itinerary metadata in the same Convex transaction.
export const updateTripItinerary = mutation({
  args: {
    id: v.id("creations"),
    // JSON array of day plans. Keeping this encoded lets the TripDoc remain
    // backward-compatible while still validating the bounded payload here.
    itinerary: v.string(),
    // Strictly increasing client/server plan revision; stale route results are
    // rejected instead of overwriting a newer itinerary.
    planRevision: v.number(),
    mindmapCreationId: v.optional(v.string()),
    // Used only when finalizing a legacy permanent plan that predates
    // conversation-scoped drafts and therefore has no linked travel map yet.
    ensureMindmap: v.optional(v.boolean()),
    ...actorAuthArgs,
  },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    if (
      a.itinerary.length > 120_000 ||
      !Number.isSafeInteger(a.planRevision) ||
      a.planRevision < 1 ||
      a.planRevision > 1_000_000 ||
      (a.mindmapCreationId !== undefined && (a.mindmapCreationId.length < 1 || a.mindmapCreationId.length > 160))
    ) {
      return { ok: false as const, reason: "invalid" as const };
    }

    let itinerary: unknown;
    try {
      itinerary = JSON.parse(a.itinerary);
    } catch {
      return { ok: false as const, reason: "invalid" as const };
    }
    if (
      !validTripItineraryPayload(itinerary)
    ) {
      return { ok: false as const, reason: "invalid" as const };
    }

    const row = await ctx.db.get(a.id);
    if (!row) return { ok: false as const, reason: "not_found" as const };
    if (row.kind !== "trip" || !row.data) return { ok: false as const, reason: "not_trip" as const };

    let doc: any;
    try {
      doc = JSON.parse(row.data);
    } catch {
      return { ok: false as const, reason: "invalid_trip" as const };
    }
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
      return { ok: false as const, reason: "invalid_trip" as const };
    }

    const currentRevision = Number.isSafeInteger(doc.planRevision) && doc.planRevision >= 0 ? doc.planRevision : 0;
    if (a.planRevision <= currentRevision) {
      return { ok: false as const, reason: "stale" as const, planRevision: currentRevision, updatedAt: row.updatedAt };
    }

    const currentMindmapCreationId = typeof doc.mindmapCreationId === "string" ? doc.mindmapCreationId : undefined;
    if (a.mindmapCreationId !== undefined && currentMindmapCreationId && a.mindmapCreationId !== currentMindmapCreationId) {
      return { ok: false as const, reason: "invalid_mindmap" as const };
    }
    doc.itinerary = itinerary;
    doc.planRevision = a.planRevision;
    if (a.mindmapCreationId !== undefined) doc.mindmapCreationId = a.mindmapCreationId;

    const updatedAt = Date.now();
    let canvasWrite: TripCanvasWrite | undefined;
    if (typeof doc.mindmapCreationId === "string") {
      const linked = await linkedTripCanvasWrite(ctx, row, doc);
      if (!linked.ok) return { ok: false as const, reason: linked.reason };
      canvasWrite = linked.write;
    } else if (a.ensureMindmap) {
      // Reserve the largest accepted ID before inserting. A failing size check
      // must happen before any canvas write, and the final guard below throws
      // so Convex rolls the whole transaction back if this assumption changes.
      const prospectiveData = JSON.stringify({ ...doc, mindmapCreationId: "x".repeat(160) });
      if (prospectiveData.length > MAX_TRIP_CANVAS_BYTES) return { ok: false as const, reason: "invalid_trip" as const };
      const canvas = tripCanvas(doc);
      if (!canvas) return { ok: false as const, reason: "invalid_trip" as const };
      canvas.tripId = String(a.id);
      const canvasData = JSON.stringify(canvas);
      if (canvasData.length > MAX_TRIP_CANVAS_BYTES) return { ok: false as const, reason: "invalid_trip" as const };
      const mindmapCreationId = await ctx.db.insert("creations", {
        kind: "canvas",
        title: tripCanvasTitle(canvas, row.title),
        data: canvasData,
        category: "mind maps",
        folder: "Travel / Plans",
        threadId: row.threadId,
        createdAt: updatedAt,
        updatedAt,
      });
      doc.mindmapCreationId = String(mindmapCreationId);
    }

    const data = JSON.stringify(doc);
    if (data.length > MAX_TRIP_CANVAS_BYTES) throw new Error("Trip plan exceeded its safe size after map creation");
    await ctx.db.patch(a.id, {
      // Retain the durable creation title; an itinerary patch must not roll
      // back an unrelated title edit encoded in a stale TripDoc payload.
      title: row.title.slice(0, 120),
      data,
      updatedAt,
    });
    await patchLinkedTripCanvas(ctx, canvasWrite, row, updatedAt);
    return {
      ok: true as const,
      planRevision: a.planRevision,
      updatedAt,
      ...(typeof doc.mindmapCreationId === "string" ? { mindmapCreationId: doc.mindmapCreationId } : {}),
    };
  },
});

// Board persistence with op-queue merge: the client saves its full element
// state but must NOT clobber ops the brain queued while it was drawing —
// ops newer than appliedUpTo survive the save.
export const boardSave = mutation({
  args: {
    id: v.id("creations"),
    elements: v.string(), // JSON array of full excalidraw elements
    imageUrls: v.string(), // JSON map fileId -> public url
    appliedUpTo: v.number(),
    ...actorAuthArgs,
  },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const row = await ctx.db.get(a.id);
    if (!row?.data) return;
    let data: any;
    try {
      data = JSON.parse(row.data);
    } catch {
      return;
    }
    data.elements = JSON.parse(a.elements);
    data.imageUrls = JSON.parse(a.imageUrls);
    data.pendingOps = (data.pendingOps ?? []).filter((op: any) => (op.ts ?? 0) > a.appliedUpTo);
    await ctx.db.patch(a.id, { data: JSON.stringify(data), updatedAt: Date.now() });
  },
});

// React Flow persists only semantic node positions. Merge them into the live
// board document atomically so dragging a concept can never overwrite new
// concepts or Excalidraw operations queued by Jarvis at the same moment.
export const boardLayoutSave = mutation({
  args: {
    id: v.id("creations"),
    nodes: v.string(),
    ...actorAuthArgs,
  },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const row = await ctx.db.get(a.id);
    if (!row?.data || row.kind !== "board") return false;
    let data: any;
    let positions: Array<{ id: string; x: number; y: number }>;
    try {
      data = JSON.parse(row.data);
      positions = JSON.parse(a.nodes);
    } catch {
      return false;
    }
    if (!Array.isArray(positions) || !data.semanticNodes) return false;
    for (const position of positions.slice(0, 500)) {
      const node = data.semanticNodes[String(position?.id ?? "")];
      if (!node || !Number.isFinite(position?.x) || !Number.isFinite(position?.y)) continue;
      node.x = Math.round(position.x);
      node.y = Math.round(position.y);
    }
    await ctx.db.patch(a.id, { data: JSON.stringify(data), updatedAt: Date.now() });
    return true;
  },
});

export const remove = mutation({
  args: { id: v.id("creations"), ...actorAuthArgs },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const creation = await ctx.db.get(a.id);
    // The browser may retry after R2 deletion completed but the response from
    // this final metadata mutation was interrupted. Exact owner retries are
    // therefore a successful no-op once this creation is already gone.
    if (!creation) return true;
    const refs = await ctx.db.query("creationFileRefs").withIndex("by_creation", (q) => q.eq("creationId", a.id)).collect();
    for (const ref of refs) await ctx.db.delete(ref._id);
    const asset = creationAssetLocatorFromRow(creation);
    if (asset) {
      const migration = await ctx.db
        .query("creationAssetStoreMigrations")
        .withIndex("by_key", (q: any) => q.eq("key", "private-creation-r2-v2"))
        .first();
      if (migration && migration.state !== "activated" && migration.state !== "aborted") {
        throw new ConvexError({
          code: "CREATION_ASSET_MIGRATION_FROZEN",
          message: "Private creation assets are frozen for their controlled storage migration",
        });
      }
      // Deleting R2 before this metadata mutation can leave a committed row
      // pointing to a missing asset when its response is lost. Put a durable
      // cleanup intent in the same transaction as removal instead: from this
      // point forward the worker may delete only after rechecking that no
      // canonical creation still references the opaque key.
      const now = Date.now();
      let existingIntent = await ctx.db
        .query("creationAssetCleanupIntents")
        .withIndex("by_assetStoreLocator", (q: any) => q.eq("assetStore", asset.assetStore).eq("assetLocator", asset.assetLocator))
        .first();
      if (!existingIntent && asset.assetStore === CREATION_ASSET_STORE_V1) {
        existingIntent = await ctx.db
          .query("creationAssetCleanupIntents")
          .withIndex("by_assetR2Key", (q: any) => q.eq("assetR2Key", asset.assetLocator))
          .first();
      }
      if (existingIntent) {
        if (existingIntent.cleanupDeletionTicketId) await ctx.db.delete(existingIntent.cleanupDeletionTicketId);
        await ctx.db.patch(existingIntent._id, {
          state: "cleanup_ready",
          nextActionAt: now,
          cleanupDeletionTicketId: undefined,
          cleanupClaimToken: undefined,
          cleanupClaimExpiresAt: undefined,
          updatedAt: now,
        });
      } else {
        await ctx.db.insert("creationAssetCleanupIntents", {
          assetR2Key: asset.assetLocator,
          assetStore: asset.assetStore,
          assetLocator: asset.assetLocator,
          recoveryKind: "deletion",
          state: "cleanup_ready",
          nextActionAt: now,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
    await ctx.db.delete(a.id);
    return true;
  },
});
