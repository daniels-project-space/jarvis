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
