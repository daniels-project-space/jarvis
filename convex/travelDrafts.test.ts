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
const WORKER = "travel-drafts-test-worker";
const OWNER = "c".repeat(64);
const travelDrafts = (api as any).travelDrafts;

beforeEach(() => {
  process.env.JARVIS_WORKER_TOKEN = WORKER;
});

afterEach(() => {
  delete process.env.JARVIS_WORKER_TOKEN;
});

function draftData(title = "Lisbon · planning", destination = "Lisbon") {
  return JSON.stringify({
    kind: "trip",
    title,
    destination,
    status: "scouting",
    center: { lat: 38.72, lng: -9.14 },
    providers: { stays: { status: "queued", source: "Google Hotels" } },
    itinerary: [{ date: "2026-09-12", items: [{ id: "museum", title: "Tile Museum", kind: "activity", time: "10:00" }] }],
  });
}

async function sourceMessage(t: ReturnType<typeof convexTest>, threadId: string) {
  return await t.run((ctx) => ctx.db.insert("chatMessages", {
    threadId,
    role: "user",
    text: "Plan a trip",
    status: "done",
    createdAt: Date.now(),
  }));
}

describe("conversation-scoped travel drafts", () => {
  it("keeps exact-CAS plan writes separate from atomically merged provider results", async () => {
    const t = convexTest(schema, modules);
    const messageId = await sourceMessage(t, "thread-lisbon");
    const created = await t.mutation(travelDrafts.createDraft, {
      threadId: "thread-lisbon",
      title: "Lisbon · planning",
      destination: "Lisbon",
      data: draftData(),
      sourceMessageId: messageId,
      workerToken: WORKER,
    });
    expect(created).toMatchObject({ ok: true, planRevision: 0 });

    const saved = await t.mutation(travelDrafts.updatePlan, {
      id: created.id,
      expectedPlanRevision: 0,
      title: "Lisbon · planning",
      destination: "Lisbon",
      data: draftData(),
      sourceMessageId: messageId,
      workerToken: WORKER,
    });
    expect(saved).toMatchObject({ ok: true, planRevision: 1 });

    await expect(t.mutation(travelDrafts.updatePlan, {
      id: created.id,
      expectedPlanRevision: 0,
      title: "Lisbon · planning",
      destination: "Lisbon",
      data: draftData(),
      sourceMessageId: messageId,
      workerToken: WORKER,
    })).resolves.toMatchObject({ ok: false, reason: "stale", planRevision: 1 });

    await expect(t.mutation(travelDrafts.patchProvider, {
      id: created.id,
      provider: "stays",
      status: "ready",
      source: "Google Hotels",
      itemsJson: JSON.stringify([{ name: "Hotel Tejo", totalGbp: 420 }]),
      sourceMessageId: messageId,
      workerToken: WORKER,
    })).resolves.toMatchObject({ ok: true, planRevision: 1 });

    const draft = await t.run((ctx) => ctx.db.get(created.id)) as { data?: string } | null;
    const data = JSON.parse(draft?.data ?? "{}");
    expect(data).toMatchObject({
      planRevision: 1,
      itinerary: [{ items: [{ title: "Tile Museum", time: "10:00" }] }],
      stays: [{ name: "Hotel Tejo", totalGbp: 420 }],
      providers: { stays: { status: "ready", source: "Google Hotels", count: 1 } },
    });
  });

  it("keeps a selected CityContext centre stable across multi-city provider arrivals and upgrades V1 rows lazily", async () => {
    const t = convexTest(schema, modules);
    const messageId = await sourceMessage(t, "thread-multi-city");
    const now = Date.now();
    const created = await t.mutation(travelDrafts.createDraft, {
      threadId: "thread-multi-city",
      title: "Lisbon and Edinburgh · planning",
      destination: "Lisbon",
      data: JSON.stringify({
        kind: "trip",
        title: "Lisbon and Edinburgh · planning",
        destination: "Lisbon",
        destinationCenter: { lat: 38.7223, lng: -9.1393 },
        center: { lat: 38.7223, lng: -9.1393 },
        cityContexts: [{
          id: "lisbon",
          city: "Lisbon",
          center: { lat: 38.7223, lng: -9.1393 },
          source: "destination",
          createdAt: now,
          updatedAt: now,
        }, {
          id: "edinburgh",
          city: "Edinburgh",
          center: { lat: 55.9533, lng: -3.1883 },
          source: "explore",
          createdAt: now,
          updatedAt: now,
          futureCityField: "preserve me",
        }],
        activeCityContextId: "edinburgh",
        futureTripExtension: { version: 3 },
      }),
      sourceMessageId: messageId,
      workerToken: WORKER,
    });
    await t.run((ctx) => ctx.db.patch(created.id, { schemaVersion: 1 }));

    await expect(t.mutation(travelDrafts.patchProvider, {
      id: created.id,
      provider: "stays",
      status: "ready",
      source: "Google Hotels",
      itemsJson: JSON.stringify([
        { name: "Hotel Tejo", lat: 38.72, lng: -9.14 },
        { name: "Old Town Rooms", lat: 55.95, lng: -3.19, cityContextId: "edinburgh" },
      ]),
      sourceMessageId: messageId,
      workerToken: WORKER,
    })).resolves.toMatchObject({ ok: true });
    await expect(t.mutation(travelDrafts.patchProvider, {
      id: created.id,
      provider: "activities",
      status: "ready",
      source: "OpenStreetMap",
      itemsJson: JSON.stringify([{ name: "Belém Tower", lat: 38.6916, lng: -9.216 }]),
      sourceMessageId: messageId,
      workerToken: WORKER,
    })).resolves.toMatchObject({ ok: true });

    const row = await t.run((ctx) => ctx.db.get(created.id)) as { data?: string; schemaVersion?: number } | null;
    const data = JSON.parse(row?.data ?? "{}");
    expect(row?.schemaVersion).toBe(2);
    expect(data).toMatchObject({
      activeCityContextId: "edinburgh",
      center: { lat: 55.9533, lng: -3.1883 },
      futureTripExtension: { version: 3 },
      stays: [
        { name: "Hotel Tejo", cityContextId: "lisbon" },
        { name: "Old Town Rooms", cityContextId: "edinburgh" },
      ],
      activities: [{ name: "Belém Tower", cityContextId: "lisbon" }],
    });
    expect(data.cityContexts[1]).toMatchObject({ id: "edinburgh", futureCityField: "preserve me" });
  });

  it("falls back from a missing CityContext to destinationCenter, then the legacy centre", async () => {
    const t = convexTest(schema, modules);
    const messageId = await sourceMessage(t, "thread-city-fallback");
    const destinationFallback = await t.mutation(travelDrafts.createDraft, {
      threadId: "thread-city-fallback",
      title: "Lisbon · planning",
      destination: "Lisbon",
      data: JSON.stringify({
        kind: "trip",
        title: "Lisbon · planning",
        destination: "Lisbon",
        destinationCenter: { lat: 38.7223, lng: -9.1393 },
        center: { lat: 51.5072, lng: -0.1276 },
        cityContexts: [{ id: "lisbon", city: "Lisbon", center: { lat: 38.7223, lng: -9.1393 }, source: "destination", createdAt: 1, updatedAt: 1 }],
        activeCityContextId: "missing-city",
      }),
      sourceMessageId: messageId,
      workerToken: WORKER,
    });
    await t.mutation(travelDrafts.patchProvider, {
      id: destinationFallback.id,
      provider: "activities",
      status: "ready",
      source: "OpenStreetMap",
      itemsJson: JSON.stringify([{ name: "Unrelated venue", lat: 48.8566, lng: 2.3522 }]),
      sourceMessageId: messageId,
      workerToken: WORKER,
    });
    const destinationFallbackRow = await t.run((ctx) => ctx.db.get(destinationFallback.id)) as { data?: string } | null;
    const afterDestinationFallback = JSON.parse(destinationFallbackRow?.data ?? "{}");
    expect(afterDestinationFallback.center).toEqual({ lat: 38.7223, lng: -9.1393 });

    const legacyFallback = await t.mutation(travelDrafts.createDraft, {
      threadId: "thread-city-fallback",
      title: "Legacy trip · planning",
      destination: "Legacy trip",
      data: JSON.stringify({
        kind: "trip",
        title: "Legacy trip · planning",
        destination: "Legacy trip",
        center: { lat: 51.5072, lng: -0.1276 },
      }),
      sourceMessageId: messageId,
      workerToken: WORKER,
    });
    await t.mutation(travelDrafts.patchProvider, {
      id: legacyFallback.id,
      provider: "activities",
      status: "ready",
      source: "OpenStreetMap",
      itemsJson: JSON.stringify([{ name: "Elsewhere", lat: 48.8566, lng: 2.3522 }]),
      sourceMessageId: messageId,
      workerToken: WORKER,
    });
    const legacyFallbackRow = await t.run((ctx) => ctx.db.get(legacyFallback.id)) as { data?: string } | null;
    const afterLegacyFallback = JSON.parse(legacyFallbackRow?.data ?? "{}");
    expect(afterLegacyFallback.center).toEqual({ lat: 51.5072, lng: -0.1276 });
  });

  it("validates message provenance, permits exact authenticated reads, and locks only once", async () => {
    const t = convexTest(schema, modules);
    const lisbonMessage = await sourceMessage(t, "thread-lisbon");
    const parisMessage = await sourceMessage(t, "thread-paris");

    await expect(t.mutation(travelDrafts.createDraft, {
      threadId: "thread-lisbon",
      title: "Lisbon · planning",
      destination: "Lisbon",
      data: draftData(),
      sourceMessageId: parisMessage,
      workerToken: WORKER,
    })).resolves.toEqual({ ok: false, reason: "source_message_mismatch" });

    await expect(t.mutation(travelDrafts.createDraft, {
      threadId: "thread-lisbon",
      title: "Lisbon · planning",
      destination: "Lisbon",
      data: draftData(),
      workerToken: WORKER,
    })).resolves.toEqual({ ok: false, reason: "source_message_required" });

    const created = await t.mutation(travelDrafts.createDraft, {
      threadId: "thread-lisbon",
      title: "Lisbon · planning",
      destination: "Lisbon",
      data: draftData(),
      sourceMessageId: lisbonMessage,
      workerToken: WORKER,
    });
    expect(await t.run((ctx) => ctx.db.query("creations").collect())).toHaveLength(0);

    await expect(t.query(travelDrafts.get, { id: created.id, workerToken: WORKER })).resolves.toBeNull();
    await expect(t.query(travelDrafts.get, { id: created.id, sourceMessageId: parisMessage, workerToken: WORKER })).resolves.toBeNull();
    await expect(t.query(travelDrafts.get, { id: created.id, sourceMessageId: lisbonMessage, workerToken: WORKER }))
      .resolves.toMatchObject({ _id: created.id, threadId: "thread-lisbon", state: "draft" });

    await expect(t.mutation(travelDrafts.updatePlan, {
      id: created.id,
      expectedPlanRevision: 0,
      title: "Lisbon · planning",
      destination: "Lisbon",
      data: draftData(),
      workerToken: WORKER,
    })).resolves.toEqual({ ok: false, reason: "source_message_required" });

    await expect(t.mutation(travelDrafts.patchProvider, {
      id: created.id,
      provider: "activities",
      status: "ready",
      source: "OpenStreetMap",
      itemsJson: "[]",
      sourceMessageId: parisMessage,
      workerToken: WORKER,
    })).resolves.toEqual({ ok: false, reason: "source_message_mismatch" });

    await expect(t.mutation(travelDrafts.patchProvider, {
      id: created.id,
      provider: "activities",
      status: "ready",
      source: "OpenStreetMap",
      itemsJson: "[]",
      workerToken: WORKER,
    })).resolves.toEqual({ ok: false, reason: "source_message_required" });

    await expect(t.mutation(travelDrafts.lockDraft, {
      id: created.id,
      expectedPlanRevision: 0,
      workerToken: WORKER,
    })).resolves.toEqual({ ok: false, reason: "source_message_required" });

    await t.mutation(api.controlAuth.createOpenSession, {
      ownerTokenHash: OWNER,
      workerToken: WORKER,
    });
    await expect(t.query(travelDrafts.get, { id: created.id, authTokenHash: OWNER }))
      .resolves.toMatchObject({ _id: created.id, threadId: "thread-lisbon", state: "draft" });

    const firstLock = await t.mutation(travelDrafts.lockDraft, {
      id: created.id,
      expectedPlanRevision: 0,
      sourceMessageId: lisbonMessage,
      workerToken: WORKER,
    });
    const retry = await t.mutation(travelDrafts.lockDraft, {
      id: created.id,
      expectedPlanRevision: 0,
      sourceMessageId: lisbonMessage,
      workerToken: WORKER,
    });
    expect(firstLock).toMatchObject({ ok: true, alreadyLocked: false, planRevision: 0, mindmapCreationId: expect.any(String) });
    expect(retry).toMatchObject({
      ok: true,
      alreadyLocked: true,
      creationId: firstLock.creationId,
      mindmapCreationId: firstLock.mindmapCreationId,
    });

    const creation = await t.run((ctx) => ctx.db.get(firstLock.creationId)) as {
      kind?: string;
      category?: string;
      folder?: string;
      data?: string;
    } | null;
    expect(creation?.kind).toBe("trip");
    expect(creation?.category).toBe("travel plans");
    expect(creation?.folder).toBe("Travel / Plans");
    expect(JSON.parse(creation?.data ?? "{}")).toMatchObject({
      status: "planned",
      threadId: "thread-lisbon",
      planRevision: 0,
      mindmapCreationId: firstLock.mindmapCreationId,
    });
    const mindmap = await t.run((ctx) => ctx.db.get(firstLock.mindmapCreationId)) as {
      kind?: string;
      category?: string;
      folder?: string;
      threadId?: string;
      data?: string;
    } | null;
    expect(mindmap).toMatchObject({ kind: "canvas", category: "mind maps", folder: "Travel / Plans", threadId: "thread-lisbon" });
    expect(JSON.parse(mindmap?.data ?? "{}")).toMatchObject({ tripId: firstLock.creationId, title: "Trip map · Lisbon" });
    const allTrips = await t.run((ctx) => ctx.db.query("creations").collect());
    expect(allTrips).toHaveLength(2);

    await expect(t.mutation(travelDrafts.patchProvider, {
      id: created.id,
      provider: "stays",
      status: "ready",
      source: "Google Hotels",
      itemsJson: "[]",
      sourceMessageId: lisbonMessage,
      workerToken: WORKER,
    })).resolves.toMatchObject({ ok: false, reason: "locked", lockedCreationId: firstLock.creationId });
  });
});
