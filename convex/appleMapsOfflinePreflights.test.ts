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
const WORKER = "apple-preflight-worker";
const SOURCE_KEY = "b".repeat(64);
const preflight = {
  city: "Seville", flightMarker: "jarvis-gmail-booking:flight-1", flightTitle: "✈ Iberia · confirmed",
  flightStart: 1_900_000_000_000, at: 1_899_913_600_000, timeZone: "Europe/Madrid",
  mapUrl: "https://maps.apple.com/search?query=Seville", todoText: "Download Seville", reminderText: "Download Seville",
};
const identity = {
  selectionId: "booking-opaque", messageId: "flight-1", marker: "jarvis-gmail-booking:flight-1",
  threadId: "thread-1", kind: "flight", provider: "Iberia", confirmationCode: "ABC123",
};
const proof = {
  city: "Seville", title: "🏨 Casa · confirmed", bookingName: "Casa", location: "Calle Example 1, Seville",
  start: 1_899_000_000_000, end: 1_901_000_000_000, timeZone: "Europe/Madrid", lat: 37.39, lng: -5.99,
  distanceKm: 0.4, verifiedAt: 1_899_000_100_000,
};

beforeEach(() => { process.env.JARVIS_WORKER_TOKEN = WORKER; });
afterEach(() => { delete process.env.JARVIS_WORKER_TOKEN; });

describe("saved Apple Maps offline preflight registry", () => {
  it("enumerates only explicit saved-trip preflights and mirrors a pending state onto that TripDoc", async () => {
    const t = convexTest(schema, modules);
    const creationId = await t.mutation(api.creations.create, {
      kind: "trip", title: "Seville", data: JSON.stringify({ kind: "trip", title: "Seville", destination: "Seville" }), workerToken: WORKER,
    });
    const otherTrip = await t.mutation(api.creations.create, {
      kind: "trip", title: "Rome", data: JSON.stringify({ kind: "trip", title: "Rome", destination: "Rome" }), workerToken: WORKER,
    });
    const registry = (api as any).appleMapsOfflinePreflights;
    const scheduled = await t.mutation(registry.upsert, {
      creationId, sourceKey: SOURCE_KEY, preflight, flightIdentity: identity, cityProofIdentity: { ...identity, messageId: "stay-1", marker: "jarvis-gmail-booking:stay-1", selectionId: "stay-opaque", kind: "stay", provider: "Booking", confirmationCode: "STAY123" }, cityProof: proof,
      nextRefreshAt: 100, workerToken: WORKER,
    });
    expect(scheduled).toMatchObject({ ok: true, created: true });
    const due = await t.query(registry.due, { now: 100, limit: 8, workerToken: WORKER });
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ creationId, sourceKey: SOURCE_KEY, creation: { _id: creationId } });
    expect(due[0].creation?._id).not.toBe(otherTrip);

    await expect(t.mutation(registry.markPending, {
      id: due[0]._id, expectedUpdatedAt: due[0].updatedAt, state: "pending_google", error: "Google connection is unavailable", checkedAt: 101, nextRefreshAt: 200, workerToken: WORKER,
    })).resolves.toEqual({ ok: true });
    const saved = await t.query(api.creations.get, { id: creationId, workerToken: WORKER });
    expect(JSON.parse(String(saved?.data))).toMatchObject({ offlineMapPreflight: { refreshState: "pending_google", nextRefreshAt: 200 } });

    const readyToClose = (await t.query(registry.due, { now: 200, limit: 8, workerToken: WORKER }))[0];
    await expect(t.mutation(registry.completeRefresh, {
      id: readyToClose._id,
      expectedUpdatedAt: readyToClose.updatedAt,
      preflight,
      flightIdentity: identity,
      cityProofIdentity: { ...identity, messageId: "stay-1", marker: "jarvis-gmail-booking:stay-1", selectionId: "stay-opaque", kind: "stay", provider: "Booking", confirmationCode: "STAY123" },
      cityProof: proof,
      checkedAt: 201,
      refreshState: "too_late",
      refreshError: "The safe refresh window has closed; the durable reminder stays unchanged.",
      todoStatus: "needs_retry",
      calendarRefreshRequired: false,
      workerToken: WORKER,
    })).resolves.toEqual({ ok: true });
    const finalSaved = await t.query(api.creations.get, { id: creationId, workerToken: WORKER });
    expect(JSON.parse(String(finalSaved?.data))).toMatchObject({ offlineMapPreflight: {
      refreshState: "too_late",
      refreshError: "The safe refresh window has closed; the durable reminder stays unchanged.",
      todoStatus: "needs_retry",
    } });
  });

  it("keeps more than one worker batch of parked records out of the due queue", async () => {
    const t = convexTest(schema, modules);
    const registry = (api as any).appleMapsOfflinePreflights;
    const parkedSourceKeys = ["1", "2", "3", "4", "5", "6"].map((digit) => digit.repeat(64));
    const liveSourceKey = "a".repeat(64);
    const sourceKeys = [...parkedSourceKeys, liveSourceKey];

    for (const [index, sourceKey] of sourceKeys.entries()) {
      const creationId = await t.mutation(api.creations.create, {
        kind: "trip", title: `Trip ${index}`, data: JSON.stringify({ kind: "trip", title: `Trip ${index}`, destination: "Seville" }), workerToken: WORKER,
      });
      await expect(t.mutation(registry.upsert, {
        creationId, sourceKey, preflight, flightIdentity: identity,
        cityProofIdentity: { ...identity, messageId: `stay-${index}`, marker: `jarvis-gmail-booking:stay-${index}`, selectionId: `stay-opaque-${index}`, kind: "stay", provider: "Booking", confirmationCode: "STAY123" },
        cityProof: proof, nextRefreshAt: 100, workerToken: WORKER,
      })).resolves.toMatchObject({ ok: true });
    }

    const initialDue = await t.query(registry.due, { now: 100, limit: 8, workerToken: WORKER });
    expect(initialDue).toHaveLength(7);
    for (const [index, dueRow] of initialDue.filter((dueRow: any) => parkedSourceKeys.includes(dueRow.sourceKey)).entries()) {
      await expect(t.mutation(registry.markPending, {
        id: dueRow._id,
        expectedUpdatedAt: dueRow.updatedAt,
        state: index === 5 ? "needs_city_confirmation" : "too_late",
        error: index === 5 ? "The booked-stay proof needs an exact confirmation" : "The safe preflight refresh window has passed",
        checkedAt: 101,
        workerToken: WORKER,
      })).resolves.toEqual({ ok: true });
    }
    const liveRow = initialDue.find((dueRow: any) => dueRow.sourceKey === liveSourceKey);
    await expect(t.mutation(registry.markPending, {
      id: liveRow._id, expectedUpdatedAt: liveRow.updatedAt,
      state: "pending_refresh", error: "Retry the saved reminder refresh", checkedAt: 101, nextRefreshAt: 100, workerToken: WORKER,
    })).resolves.toEqual({ ok: true });

    const queued = await t.query(registry.due, { now: 100, limit: 4, workerToken: WORKER });
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ sourceKey: liveSourceKey, refreshState: "pending_refresh" });
  });
});
