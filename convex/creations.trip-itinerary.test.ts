import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import schema from "./schema";

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>;
  }
}

const modules = import.meta.glob("./**/*.ts");
const WORKER = "trip-itinerary-test-worker";

beforeEach(() => {
  process.env.JARVIS_WORKER_TOKEN = WORKER;
});

afterEach(() => {
  delete process.env.JARVIS_WORKER_TOKEN;
});

function day() {
  return [{
    date: "2026-09-12",
    label: "Sat 12 Sep",
    status: "draft",
    items: [{
      id: "2026-09-12:activity:museum:0",
      date: "2026-09-12",
      time: "10:00",
      durationMinutes: 90,
      title: "City Museum",
      kind: "activity",
      lat: 38.72,
      lng: -9.14,
      cityContextId: "lisbon",
      link: "https://www.openstreetmap.org/node/1",
      source: "owner",
    }, {
      id: "2026-09-12:activity:gallery:1",
      date: "2026-09-12",
      time: "12:00",
      durationMinutes: 75,
      title: "Riverside Gallery",
      kind: "activity",
      lat: 38.716,
      lng: -9.13,
      cityContextId: "sintra",
      link: "https://www.openstreetmap.org/node/2",
      source: "owner",
    }],
    route: {
      mode: "walking",
      status: "ready",
      coordinates: [[-9.14, 38.72], [-9.13, 38.716]],
      durationSeconds: 900,
      distanceMeters: 1100,
      legs: [{
        fromItemId: "2026-09-12:activity:museum:0",
        toItemId: "2026-09-12:activity:gallery:1",
        durationSeconds: 900,
        distanceMeters: 1100,
      }],
      calculatedAt: Date.now(),
    },
  }];
}

describe("atomic trip itinerary persistence", () => {
  it("preserves independently arrived provider data and rejects late or malformed route writes", async () => {
    const t = convexTest(schema, modules);
    const id = await t.run((ctx) => ctx.db.insert("creations", {
      kind: "trip",
      title: "Lisbon · planning",
      data: JSON.stringify({
        kind: "trip",
        title: "Lisbon · planning",
        destination: "Lisbon",
        destinationCenter: { lat: 38.7223, lng: -9.1393 },
        center: { lat: 38.7223, lng: -9.1393 },
        cityContexts: [{
          id: "lisbon",
          city: "Lisbon",
          center: { lat: 38.7223, lng: -9.1393 },
          source: "destination",
          createdAt: 1,
          updatedAt: 2,
          bookingReference: { title: "Hotel Tejo", location: "Lisbon", lat: 38.72, lng: -9.14 },
          bookingCheckedAt: 3,
        }, {
          id: "sintra",
          city: "Sintra",
          center: { lat: 38.798, lng: -9.39 },
          source: "explore",
          createdAt: 4,
          updatedAt: 5,
        }],
        activeCityContextId: "lisbon",
        discoveries: [{
          id: "sintra-palaces",
          city: "Sintra",
          query: "palaces",
          center: { lat: 38.798, lng: -9.39 },
          fetchedAt: 6,
          provider: "OpenStreetMap",
          items: [{ id: "pena", name: "Pena Palace", cityContextId: "sintra" }],
        }],
        providers: { stays: { status: "ready", source: "Google Hotels", count: 8 } },
        stays: [{ name: "Hotel Tejo" }],
        planRevision: 0,
      }),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }));
    const mindmapCreationId = await t.run(async (ctx) => {
      const canvasId = await ctx.db.insert("creations", {
        kind: "canvas",
        title: "Trip map · Lisbon",
        data: JSON.stringify({ title: "Trip map · Lisbon", tripId: String(id), nodes: [], edges: [] }),
        category: "mind maps",
        folder: "Travel / Plans",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      const trip = await ctx.db.get(id);
      await ctx.db.patch(id, {
        data: JSON.stringify({ ...JSON.parse(trip?.data ?? "{}"), mindmapCreationId: String(canvasId) }),
      });
      return canvasId;
    });

    await expect(t.mutation(api.creations.updateTripItinerary, {
      id,
      itinerary: JSON.stringify(day()),
      planRevision: 1,
      workerToken: WORKER,
    })).resolves.toMatchObject({ ok: true, planRevision: 1 });

    const afterFirst = await t.run(async (ctx) => ctx.db.get(id));
    const doc = JSON.parse(afterFirst?.data ?? "{}");
    expect(doc).toMatchObject({
      planRevision: 1,
      providers: { stays: { status: "ready", source: "Google Hotels", count: 8 } },
      stays: [{ name: "Hotel Tejo" }],
      mindmapCreationId: String(mindmapCreationId),
      itinerary: [expect.objectContaining({ date: "2026-09-12" })],
    });
    const mapAfterFirst = await t.run(async (ctx) => ctx.db.get(mindmapCreationId));
    const mapData = JSON.parse(mapAfterFirst?.data ?? "{}");
    expect(mapData).toMatchObject({ tripId: String(id), title: "Trip map · Lisbon" });
    expect(mapData.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "city:lisbon", label: "📍 Lisbon · active", detail: expect.stringContaining("booked: Hotel Tejo") }),
      expect.objectContaining({ id: "city:sintra", label: "📍 Sintra" }),
      expect.objectContaining({ id: "discovery:sintra-palaces", label: "⌕ Sintra · palaces" }),
      expect.objectContaining({ id: "day-1:2026-09-12:activity:museum:0", label: "City Museum" }),
      expect.objectContaining({ id: "day-1:2026-09-12:activity:gallery:1", label: "Riverside Gallery" }),
    ]));
    expect(mapData.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: "trip", to: "city:lisbon", label: "active city" }),
      expect.objectContaining({ from: "city:sintra", to: "discovery:sintra-palaces", label: "discoveries" }),
      expect.objectContaining({ from: "city:lisbon", to: "day-1:2026-09-12:activity:museum:0", label: "planned stop" }),
      expect.objectContaining({ label: "walking · 15 min · 1.1 km" }),
    ]));

    await expect(t.mutation(api.creations.updateTripItinerary, {
      id,
      itinerary: JSON.stringify(day()),
      planRevision: 1,
      workerToken: WORKER,
    })).resolves.toMatchObject({ ok: false, reason: "stale", planRevision: 1 });

    await expect(t.mutation(api.creations.updateTripItinerary, {
      id,
      itinerary: JSON.stringify([{ ...day()[0], items: [{ ...day()[0].items[0], link: "javascript:alert(1)" }] }]),
      planRevision: 2,
      workerToken: WORKER,
    })).resolves.toEqual({ ok: false, reason: "invalid" });

    const afterRejected = JSON.parse((await t.run(async (ctx) => ctx.db.get(id)))?.data ?? "{}");
    expect(afterRejected.planRevision).toBe(1);
    expect(afterRejected.itinerary[0].items[0].link).toBe("https://www.openstreetmap.org/node/1");
    const mapAfterRejected = await t.run(async (ctx) => ctx.db.get(mindmapCreationId));
    expect(mapAfterRejected?.data).toBe(mapAfterFirst?.data);
    expect(mapAfterRejected?.updatedAt).toBe(mapAfterFirst?.updatedAt);
  });

  it("scopes permanent primary provider candidates without moving the active city centre", async () => {
    const t = convexTest(schema, modules);
    const id = await t.run((ctx) => ctx.db.insert("creations", {
      kind: "trip",
      title: "Lisbon and Edinburgh · planning",
      data: JSON.stringify({
        kind: "trip",
        title: "Lisbon and Edinburgh · planning",
        destination: "Lisbon",
        destinationCenter: { lat: 38.7223, lng: -9.1393 },
        center: { lat: 55.9533, lng: -3.1883 },
        cityContexts: [{
          id: "lisbon",
          city: "Lisbon",
          center: { lat: 38.7223, lng: -9.1393 },
          source: "destination",
          createdAt: 1,
          updatedAt: 1,
        }, {
          id: "edinburgh",
          city: "Edinburgh",
          center: { lat: 55.9533, lng: -3.1883 },
          source: "explore",
          createdAt: 1,
          updatedAt: 1,
        }],
        activeCityContextId: "edinburgh",
      }),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }));

    await expect(t.mutation(api.creations.updateTripProvider, {
      id,
      provider: "stays",
      status: "ready",
      source: "Google Hotels",
      items: [
        { name: "Hotel Tejo", lat: 38.72, lng: -9.14 },
        { name: "Old Town Rooms", lat: 55.95, lng: -3.19, cityContextId: "edinburgh" },
      ],
      workerToken: WORKER,
    })).resolves.toBe(true);
    await expect(t.mutation(api.creations.updateTripProvider, {
      id,
      provider: "activities",
      status: "ready",
      source: "OpenStreetMap",
      items: [{ name: "Belém Tower", lat: 38.6916, lng: -9.216 }],
      workerToken: WORKER,
    })).resolves.toBe(true);

    const row = await t.run((ctx) => ctx.db.get(id)) as { data?: string } | null;
    expect(JSON.parse(row?.data ?? "{}")).toMatchObject({
      activeCityContextId: "edinburgh",
      center: { lat: 55.9533, lng: -3.1883 },
      stays: [
        { name: "Hotel Tejo", cityContextId: "lisbon" },
        { name: "Old Town Rooms", cityContextId: "edinburgh" },
      ],
      activities: [{ name: "Belém Tower", cityContextId: "lisbon" }],
    });
  });

  it("creates and links a legacy permanent trip map in the itinerary transaction", async () => {
    const t = convexTest(schema, modules);
    const id = await t.run((ctx) => ctx.db.insert("creations", {
      kind: "trip",
      title: "Lisbon · saved plan",
      threadId: "trip-thread",
      data: JSON.stringify({
        kind: "trip",
        title: "Lisbon · saved plan",
        destination: "Lisbon",
        budgetGbp: 900,
        adults: 2,
        planRevision: 0,
      }),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }));

    const result = await t.mutation(api.creations.updateTripItinerary, {
      id,
      itinerary: JSON.stringify(day()),
      planRevision: 1,
      ensureMindmap: true,
      workerToken: WORKER,
    });
    expect(result).toMatchObject({ ok: true, planRevision: 1, mindmapCreationId: expect.any(String) });

    const trip = await t.run((ctx) => ctx.db.get(id));
    const doc = JSON.parse(trip?.data ?? "{}");
    const map = await t.run((ctx) => ctx.db.get(doc.mindmapCreationId as any)) as {
      kind: string;
      category?: string;
      folder?: string;
      threadId?: string;
      updatedAt: number;
      data?: string;
    } | null;
    expect(map).toMatchObject({
      kind: "canvas",
      category: "mind maps",
      folder: "Travel / Plans",
      threadId: "trip-thread",
      updatedAt: trip?.updatedAt,
    });
    expect(JSON.parse(map?.data ?? "{}")).toMatchObject({ tripId: String(id), title: "Trip map · Lisbon" });
  });

  it("preflights an oversized legacy plan before creating a map", async () => {
    const t = convexTest(schema, modules);
    const id = await t.run((ctx) => ctx.db.insert("creations", {
      kind: "trip",
      title: "Lisbon · legacy plan",
      data: JSON.stringify({
        kind: "trip",
        title: "Lisbon · legacy plan",
        destination: "Lisbon",
        notes: "x".repeat(119_500),
        planRevision: 0,
      }),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }));

    await expect(t.mutation(api.creations.updateTripItinerary, {
      id,
      itinerary: JSON.stringify(day()),
      planRevision: 1,
      ensureMindmap: true,
      workerToken: WORKER,
    })).resolves.toEqual({ ok: false, reason: "invalid_trip" });
    const rows = await t.run((ctx) => ctx.db.query("creations").collect());
    expect(rows.filter((row) => row.kind === "canvas")).toHaveLength(0);
  });

  it("keeps the linked map current for later saved-plan changes", async () => {
    const t = convexTest(schema, modules);
    const id = await t.run((ctx) => ctx.db.insert("creations", {
      kind: "trip",
      title: "Lisbon · saved plan",
      threadId: "trip-thread",
      data: JSON.stringify({
        kind: "trip",
        title: "Lisbon · saved plan",
        destination: "Lisbon",
        budgetGbp: 900,
        adults: 2,
        totals: { total: 800 },
        locked: { activities: [], stay: { name: "Old Stay", totalGbp: 350 } },
        itinerary: day(),
        planRevision: 1,
      }),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }));
    const mindmapCreationId = await t.run(async (ctx) => {
      const canvasId = await ctx.db.insert("creations", {
        kind: "canvas",
        title: "Trip map · Lisbon",
        data: JSON.stringify({ title: "Trip map · Lisbon", tripId: String(id), nodes: [], edges: [] }),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      const trip = await ctx.db.get(id);
      await ctx.db.patch(id, {
        data: JSON.stringify({ ...JSON.parse(trip?.data ?? "{}"), mindmapCreationId: String(canvasId) }),
      });
      return canvasId;
    });

    const existing = await t.run((ctx) => ctx.db.get(id));
    await t.mutation(api.creations.update, {
      id,
      title: "Lisbon · saved plan",
      data: JSON.stringify({
        ...JSON.parse(existing?.data ?? "{}"),
        budgetGbp: 1200,
        totals: { total: 975 },
        locked: { activities: [], stay: { name: "New Stay", totalGbp: 420 } },
      }),
      workerToken: WORKER,
    });

    const trip = await t.run((ctx) => ctx.db.get(id));
    const map = await t.run((ctx) => ctx.db.get(mindmapCreationId));
    const mapData = JSON.parse(map?.data ?? "{}");
    expect(map?.updatedAt).toBe(trip?.updatedAt);
    expect(map?.threadId).toBe("trip-thread");
    expect(mapData.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "trip", detail: "£975 of £1200 · 2 adults" }),
      expect.objectContaining({ id: "hotel", label: "🏨 New Stay" }),
    ]));

    await expect(t.mutation(api.creations.update, {
      id,
      data: "not-json",
      workerToken: WORKER,
    })).rejects.toThrow("Trip plan data must be valid JSON");
    const afterRejectedTrip = await t.run((ctx) => ctx.db.get(id));
    const afterRejectedMap = await t.run((ctx) => ctx.db.get(mindmapCreationId));
    expect(afterRejectedTrip?.data).toBe(trip?.data);
    expect(afterRejectedMap?.data).toBe(map?.data);
  });
});
