import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { actorAuthArgs, requireActor, requireViewer, viewerAuthArgs } from "./controlAuth";
import { inferCreationFiling } from "./creationFiling";
import { requestContextRefresh } from "./contextProjection";
import { materiallyDifferentArtifact } from "./brainContextModel";

// JARVIS's atelier — everything he makes (mind maps, charts, images, PDFs,
// docs) is saved here so nothing he creates is ever lost. The UI lists it
// reactively; tools upsert while he works.

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
    return rows.map((row) => ({ ...row, ...inferCreationFiling(row) }));
  },
});

export const get = query({
  args: { id: v.id("creations"), ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    const row = await ctx.db.get(a.id);
    return row ? { ...row, ...inferCreationFiling(row) } : null;
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
    return row ? { ...row, ...inferCreationFiling(row) } : null;
  },
});

export const create = mutation({
  args: {
    kind: v.string(),
    title: v.string(),
    data: v.optional(v.string()),
    url: v.optional(v.string()),
    thumb: v.optional(v.string()),
    category: v.optional(v.string()),
    folder: v.optional(v.string()),
    project: v.optional(v.string()),
    inquiry: v.optional(v.string()),
    threadId: v.optional(v.string()),
    ...actorAuthArgs,
  },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const filing = inferCreationFiling(a);
    const id = await ctx.db.insert("creations", {
      kind: a.kind,
      title: a.title.slice(0, 120),
      data: a.data,
      url: a.url,
      thumb: a.thumb,
      ...filing,
      threadId: a.threadId?.slice(0, 120),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await requestContextRefresh(ctx, ["artifacts"]);
    return id;
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
    ...actorAuthArgs,
  },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const row = await ctx.db.get(a.id);
    if (!row) return false;
    const patch: Record<string, unknown> = {};
    if (a.title !== undefined) patch.title = a.title.slice(0, 120);
    if (a.data !== undefined) patch.data = a.data;
    if (a.url !== undefined) patch.url = a.url;
    if (a.thumb !== undefined) patch.thumb = a.thumb;
    if (a.category !== undefined) patch.category = a.category.slice(0, 80);
    if (a.folder !== undefined) patch.folder = a.folder.slice(0, 160);
    if (a.project !== undefined) patch.project = a.project.slice(0, 80);
    if (a.inquiry !== undefined) patch.inquiry = a.inquiry.slice(0, 80);
    if (a.threadId !== undefined) patch.threadId = a.threadId.slice(0, 120);
    const changed = Object.entries(patch).some(([key, value]) => row[key as keyof typeof row] !== value);
    if (!changed) return a.id;
    const updatedAt = Date.now();
    const next = { ...row, ...patch, updatedAt };
    await ctx.db.patch(a.id, { ...patch, updatedAt });
    if (materiallyDifferentArtifact(row, next)) await requestContextRefresh(ctx, ["artifacts"]);
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
    ...actorAuthArgs,
  },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const row = await ctx.db.get(a.id);
    if (!row || row.kind !== "scene") return { ok: false as const, reason: "not_found" as const };
    if (row.updatedAt !== a.expectedUpdatedAt)
      return { ok: false as const, reason: "conflict" as const, data: row.data, title: row.title, updatedAt: row.updatedAt };
    if (row.title === a.title.slice(0, 120) && row.data === a.data) {
      return { ok: true as const, updatedAt: row.updatedAt };
    }
    const updatedAt = Date.now();
    const next = { ...row, title: a.title.slice(0, 120), data: a.data, updatedAt };
    await ctx.db.patch(a.id, { title: next.title, data: next.data, updatedAt });
    if (materiallyDifferentArtifact(row, next)) await requestContextRefresh(ctx, ["artifacts"]);
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
    const data = JSON.stringify(doc);
    const thumb = row.thumb ?? doc.stays?.[0]?.thumb ?? doc.activities?.[0]?.photo;
    const next = { ...row, data, thumb, updatedAt: now };
    await ctx.db.patch(a.id, { data, thumb, updatedAt: now });
    if (materiallyDifferentArtifact(row, next)) await requestContextRefresh(ctx, ["artifacts"]);
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
    await ctx.db.delete(a.id);
    await requestContextRefresh(ctx, ["artifacts"]);
  },
});
