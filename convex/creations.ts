import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// JARVIS's atelier — everything he makes (mind maps, charts, images, PDFs,
// docs) is saved here so nothing he creates is ever lost. The UI lists it
// reactively; tools upsert while he works.

export const list = query({
  args: { kind: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, a) => {
    const limit = Math.min(a.limit ?? 40, 100);
    const rows = a.kind
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
    return rows;
  },
});

export const get = query({
  args: { id: v.id("creations") },
  handler: async (ctx, a) => ctx.db.get(a.id),
});

// Find the most recently touched creation (optionally by kind/title match) —
// lets the brain say "add X to the mind map" without tracking ids.
export const latest = query({
  args: { kind: v.optional(v.string()), titleMatch: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const rows = await ctx.db.query("creations").withIndex("by_updatedAt").order("desc").take(50);
    const t = (a.titleMatch ?? "").toLowerCase();
    return (
      rows.find(
        (r: any) => (!a.kind || r.kind === a.kind) && (!t || r.title.toLowerCase().includes(t)),
      ) ?? null
    );
  },
});

export const create = mutation({
  args: {
    kind: v.string(),
    title: v.string(),
    data: v.optional(v.string()),
    url: v.optional(v.string()),
    thumb: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    return await ctx.db.insert("creations", {
      kind: a.kind,
      title: a.title.slice(0, 120),
      data: a.data,
      url: a.url,
      thumb: a.thumb,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  },
});

export const update = mutation({
  args: {
    id: v.id("creations"),
    title: v.optional(v.string()),
    data: v.optional(v.string()),
    url: v.optional(v.string()),
    thumb: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (a.title !== undefined) patch.title = a.title.slice(0, 120);
    if (a.data !== undefined) patch.data = a.data;
    if (a.url !== undefined) patch.url = a.url;
    if (a.thumb !== undefined) patch.thumb = a.thumb;
    await ctx.db.patch(a.id, patch);
    return a.id;
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
  },
  handler: async (ctx, a) => {
    const row = await ctx.db.get(a.id);
    if (!row || row.kind !== "trip" || !row.data) return false;
    let doc: any;
    try {
      doc = JSON.parse(row.data);
    } catch {
      return false;
    }
    const now = Date.now();
    doc.providers = doc.providers ?? {};
    const count = Array.isArray(a.items) ? a.items.length : a.items ? 1 : 0;
    doc.providers[a.provider] = {
      status: a.status,
      source: a.source,
      count,
      checkedAt: now,
      error: a.error?.slice(0, 300),
    };
    if (a.items !== undefined) {
      if (a.provider === "airport") doc.airport = a.items || undefined;
      else doc[a.provider] = a.items;
    }
    const points = [...(doc.stays ?? []), ...(doc.activities ?? [])].filter(
      (item: any) => Number.isFinite(item?.lat) && Number.isFinite(item?.lng),
    );
    if (points.length) {
      doc.center = {
        lat: points.reduce((sum: number, item: any) => sum + item.lat, 0) / points.length,
        lng: points.reduce((sum: number, item: any) => sum + item.lng, 0) / points.length,
      };
    }
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
    await ctx.db.patch(a.id, {
      data: JSON.stringify(doc),
      thumb: row.thumb ?? doc.stays?.[0]?.thumb ?? doc.activities?.[0]?.photo,
      updatedAt: now,
    });
    return true;
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
  },
  handler: async (ctx, a) => {
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

export const remove = mutation({
  args: { id: v.id("creations") },
  handler: async (ctx, a) => {
    await ctx.db.delete(a.id);
  },
});
