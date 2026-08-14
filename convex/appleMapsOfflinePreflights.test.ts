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
  });
});
