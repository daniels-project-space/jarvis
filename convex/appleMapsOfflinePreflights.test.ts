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
const OWNER = "c".repeat(64);
const ICLOUD_CALENDAR_URL = "https://caldav.icloud.com/123/calendars/home/";
const ICLOUD_EVENT_URL = `${ICLOUD_CALENDAR_URL}jarvis-apple-maps-${SOURCE_KEY}.ics`;
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
      kind: "trip", title: "Seville", data: JSON.stringify({
        kind: "trip", title: "Seville", destination: "Seville",
        offlineMapPreflight: { sourceKey: SOURCE_KEY, updatedAt: 99, calendarRefreshRequired: false },
      }), workerToken: WORKER,
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
    expect(JSON.parse(String(saved?.data))).toMatchObject({ offlineMapPreflight: {
      refreshState: "pending_google", nextRefreshAt: 200, updatedAt: 99,
    } });

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
      updatedAt: 99,
    } });
  });

  it("rotates the Calendar approval revision only when the Calendar payload changed", async () => {
    const t = convexTest(schema, modules);
    const creationId = await t.mutation(api.creations.create, {
      kind: "trip",
      title: "Seville",
      data: JSON.stringify({
        kind: "trip",
        title: "Seville",
        destination: "Seville",
        offlineMapPreflight: { sourceKey: SOURCE_KEY, updatedAt: 99, calendarRefreshRequired: false },
      }),
      workerToken: WORKER,
    });
    const registry = (api as any).appleMapsOfflinePreflights;
    await t.mutation(registry.upsert, {
      creationId,
      sourceKey: SOURCE_KEY,
      preflight,
      flightIdentity: identity,
      cityProofIdentity: { ...identity, messageId: "stay-1", marker: "jarvis-gmail-booking:stay-1", selectionId: "stay-opaque", kind: "stay", provider: "Booking", confirmationCode: "STAY123" },
      cityProof: proof,
      nextRefreshAt: 100,
      workerToken: WORKER,
    });
    const [due] = await t.query(registry.due, { now: 100, limit: 8, workerToken: WORKER });
    await expect(t.mutation(registry.completeRefresh, {
      id: due._id,
      expectedUpdatedAt: due.updatedAt,
      preflight,
      flightIdentity: identity,
      cityProofIdentity: { ...identity, messageId: "stay-1", marker: "jarvis-gmail-booking:stay-1", selectionId: "stay-opaque", kind: "stay", provider: "Booking", confirmationCode: "STAY123" },
      cityProof: proof,
      checkedAt: 101,
      nextRefreshAt: 200,
      refreshState: "scheduled",
      todoStatus: "existing",
      calendarRefreshRequired: true,
      workerToken: WORKER,
    })).resolves.toEqual({ ok: true });

    const saved = await t.query(api.creations.get, { id: creationId, workerToken: WORKER });
    expect(JSON.parse(String(saved?.data))).toMatchObject({ offlineMapPreflight: {
      updatedAt: 101,
      calendarRefreshRequired: true,
    } });

    const [unchangedDue] = await t.query(registry.due, { now: 200, limit: 8, workerToken: WORKER });
    await expect(t.mutation(registry.completeRefresh, {
      id: unchangedDue._id,
      expectedUpdatedAt: unchangedDue.updatedAt,
      preflight,
      flightIdentity: identity,
      cityProofIdentity: { ...identity, messageId: "stay-1", marker: "jarvis-gmail-booking:stay-1", selectionId: "stay-opaque", kind: "stay", provider: "Booking", confirmationCode: "STAY123" },
      cityProof: proof,
      checkedAt: 201,
      nextRefreshAt: 300,
      refreshState: "scheduled",
      todoStatus: "existing",
      calendarRefreshRequired: false,
      workerToken: WORKER,
    })).resolves.toEqual({ ok: true });

    const retained = await t.query(api.creations.get, { id: creationId, workerToken: WORKER });
    expect(JSON.parse(String(retained?.data))).toMatchObject({ offlineMapPreflight: {
      updatedAt: 101,
      calendarRefreshRequired: true,
    } });
  });

  it("invalidates the Calendar approval when Gmail needs an exact itinerary confirmation", async () => {
    const t = convexTest(schema, modules);
    const creationId = await t.mutation(api.creations.create, {
      kind: "trip",
      title: "Seville",
      data: JSON.stringify({
        kind: "trip",
        title: "Seville",
        destination: "Seville",
        offlineMapPreflight: { sourceKey: SOURCE_KEY, updatedAt: 99, calendarRefreshRequired: false },
      }),
      workerToken: WORKER,
    });
    const registry = (api as any).appleMapsOfflinePreflights;
    await t.mutation(registry.upsert, {
      creationId,
      sourceKey: SOURCE_KEY,
      preflight,
      flightIdentity: identity,
      cityProofIdentity: { ...identity, messageId: "stay-1", marker: "jarvis-gmail-booking:stay-1", selectionId: "stay-opaque", kind: "stay", provider: "Booking", confirmationCode: "STAY123" },
      cityProof: proof,
      nextRefreshAt: 100,
      workerToken: WORKER,
    });
    const [due] = await t.query(registry.due, { now: 100, limit: 8, workerToken: WORKER });
    await expect(t.mutation(registry.markPending, {
      id: due._id,
      expectedUpdatedAt: due.updatedAt,
      state: "needs_flight_confirmation",
      error: "The selected Gmail flight could not be confirmed",
      checkedAt: 101,
      workerToken: WORKER,
    })).resolves.toEqual({ ok: true });

    const saved = await t.query(api.creations.get, { id: creationId, workerToken: WORKER });
    expect(JSON.parse(String(saved?.data))).toMatchObject({ offlineMapPreflight: {
      updatedAt: 101,
      calendarRefreshRequired: true,
      refreshState: "needs_flight_confirmation",
    } });
  });

  it("rotates a Calendar approval for an observed post-Gmail too-late change, but not timing-only bookkeeping", async () => {
    const t = convexTest(schema, modules);
    const registry = (api as any).appleMapsOfflinePreflights;
    const setup = async (sourceKey: string) => {
      const creationId = await t.mutation(api.creations.create, {
        kind: "trip",
        title: "Seville",
        data: JSON.stringify({
          kind: "trip",
          title: "Seville",
          destination: "Seville",
          offlineMapPreflight: { sourceKey, updatedAt: 99, calendarRefreshRequired: false },
        }),
        workerToken: WORKER,
      });
      await t.mutation(registry.upsert, {
        creationId,
        sourceKey,
        preflight,
        flightIdentity: identity,
        cityProofIdentity: { ...identity, messageId: `stay-${sourceKey[0]}`, marker: `jarvis-gmail-booking:stay-${sourceKey[0]}`, selectionId: `stay-opaque-${sourceKey[0]}`, kind: "stay", provider: "Booking", confirmationCode: "STAY123" },
        cityProof: proof,
        nextRefreshAt: 100,
        workerToken: WORKER,
      });
      const [due] = await t.query(registry.due, { now: 100, limit: 8, workerToken: WORKER });
      return { creationId, due };
    };

    const timingOnly = await setup("d".repeat(64));
    await expect(t.mutation(registry.markPending, {
      id: timingOnly.due._id,
      expectedUpdatedAt: timingOnly.due.updatedAt,
      state: "too_late",
      error: "The safe preflight refresh window has passed",
      checkedAt: 101,
      workerToken: WORKER,
    })).resolves.toEqual({ ok: true });
    const retained = await t.query(api.creations.get, { id: timingOnly.creationId, workerToken: WORKER });
    expect(JSON.parse(String(retained?.data))).toMatchObject({ offlineMapPreflight: {
      updatedAt: 99,
      calendarRefreshRequired: false,
      refreshState: "too_late",
    } });

    const changed = await setup("e".repeat(64));
    await expect(t.mutation(registry.markPending, {
      id: changed.due._id,
      expectedUpdatedAt: changed.due.updatedAt,
      state: "too_late",
      error: "The one-day-before preparation time has passed",
      checkedAt: 101,
      calendarRefreshRequired: true,
      workerToken: WORKER,
    })).resolves.toEqual({ ok: true });
    const invalidated = await t.query(api.creations.get, { id: changed.creationId, workerToken: WORKER });
    expect(JSON.parse(String(invalidated?.data))).toMatchObject({ offlineMapPreflight: {
      updatedAt: 101,
      calendarRefreshRequired: true,
      refreshState: "too_late",
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

  it("commits iCloud event provenance atomically, enforces ETags, and makes refresh require reapproval", async () => {
    const t = convexTest(schema, modules);
    const registry = (api as any).appleMapsOfflinePreflights;
    const creationId = await t.mutation(api.creations.create, {
      kind: "trip",
      title: "Seville",
      data: JSON.stringify({
        kind: "trip",
        title: "Seville",
        destination: "Seville",
        offlineMapPreflight: { sourceKey: SOURCE_KEY, updatedAt: 99, calendarRefreshRequired: false },
      }),
      workerToken: WORKER,
    });
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("adminSessions", {
        tokenHash: OWNER,
        enrolledAt: now,
        createdAt: now,
        expiresAt: now + 60_000,
      });
    });
    await expect(t.mutation(registry.upsert, {
      creationId,
      sourceKey: SOURCE_KEY,
      preflight,
      flightIdentity: identity,
      cityProofIdentity: { ...identity, messageId: "stay-1", marker: "jarvis-gmail-booking:stay-1", selectionId: "stay-opaque", kind: "stay", provider: "Booking", confirmationCode: "STAY123" },
      cityProof: proof,
      nextRefreshAt: 100,
      workerToken: WORKER,
    })).resolves.toMatchObject({ ok: true });

    const createReceipt = {
      creationId,
      sourceKey: SOURCE_KEY,
      expectedPreflightUpdatedAt: 99,
      calendarUrl: ICLOUD_CALENDAR_URL,
      action: "create" as const,
      nonce: "calendarReceiptNonce_123456",
      authTokenHash: OWNER,
    };
    await expect(t.query(registry.validateICloudCalendarApproval, createReceipt)).resolves.toEqual({ ok: true });
    await expect(t.mutation(registry.commitICloudCalendarApproval, {
      creationId,
      sourceKey: SOURCE_KEY,
      expectedPreflightUpdatedAt: 99,
      calendarUrl: ICLOUD_CALENDAR_URL,
      action: "create",
      authTokenHash: OWNER,
      calendarEvent: {
        calendarUrl: ICLOUD_CALENDAR_URL,
        eventUrl: ICLOUD_EVENT_URL,
        etag: '"etag-1"',
        revision: 99,
        nonce: createReceipt.nonce,
      },
    })).resolves.toEqual({ ok: true });

    const savedAfterCreate = await t.query(api.creations.get, { id: creationId, workerToken: WORKER });
    expect(JSON.parse(String(savedAfterCreate?.data))).toMatchObject({ offlineMapPreflight: {
      calendarProvider: "icloud",
      calendarStatus: "scheduled",
      calendarRefreshRequired: false,
      iCloudCalendarUrl: ICLOUD_CALENDAR_URL,
      iCloudCalendarEventUrl: ICLOUD_EVENT_URL,
    } });
    const [rowAfterCreate] = await t.query(registry.due, { now: 100, limit: 1, workerToken: WORKER });
    expect(rowAfterCreate.iCloudCalendarEvent).toEqual({
      calendarUrl: ICLOUD_CALENDAR_URL,
      eventUrl: ICLOUD_EVENT_URL,
      etag: '"etag-1"',
      revision: 99,
      nonce: createReceipt.nonce,
      committedAt: expect.any(Number),
    });
    // A lost HTTP response can retry its exact nonce/revision, but no sibling
    // receipt can claim the deterministic resource as a generic create.
    await expect(t.query(registry.validateICloudCalendarApproval, createReceipt)).resolves.toEqual({ ok: true });
    await expect(t.query(registry.validateICloudCalendarApproval, {
      ...createReceipt,
      nonce: "differentReceiptNonce_123456",
    })).resolves.toEqual({ ok: false, reason: "conflict" });

    // Simulate the foreground re-prepare that sealed an updated trip revision
    // while retaining the prior durable CalDAV ETag for its conditional write.
    await t.run(async (ctx) => {
      const creation = await ctx.db.get(creationId);
      const doc = JSON.parse(String(creation?.data));
      doc.offlineMapPreflight.updatedAt = 100;
      doc.offlineMapPreflight.calendarRefreshRequired = false;
      await ctx.db.patch(creationId, { data: JSON.stringify(doc), updatedAt: 100 });
    });
    const updateReceipt = {
      creationId,
      sourceKey: SOURCE_KEY,
      expectedPreflightUpdatedAt: 100,
      calendarUrl: ICLOUD_CALENDAR_URL,
      action: "update" as const,
      eventUrl: ICLOUD_EVENT_URL,
      expectedEtag: '"etag-1"',
      nonce: "updateReceiptNonce_123456",
      authTokenHash: OWNER,
    };
    await expect(t.query(registry.validateICloudCalendarApproval, updateReceipt)).resolves.toEqual({ ok: true });
    await expect(t.query(registry.validateICloudCalendarApproval, {
      ...updateReceipt,
      expectedEtag: '"wrong-etag"',
    })).resolves.toEqual({ ok: false, reason: "conflict" });
    await expect(t.mutation(registry.commitICloudCalendarApproval, {
      creationId,
      sourceKey: SOURCE_KEY,
      expectedPreflightUpdatedAt: 100,
      calendarUrl: ICLOUD_CALENDAR_URL,
      action: "update",
      expectedEtag: updateReceipt.expectedEtag,
      authTokenHash: OWNER,
      calendarEvent: {
        calendarUrl: ICLOUD_CALENDAR_URL,
        eventUrl: ICLOUD_EVENT_URL,
        etag: '"etag-2"',
        revision: 100,
        nonce: updateReceipt.nonce,
      },
    })).resolves.toEqual({ ok: true });

    const [rowAfterUpdate] = await t.query(registry.due, { now: 100, limit: 1, workerToken: WORKER });
    await expect(t.mutation(registry.markPending, {
      id: rowAfterUpdate._id,
      expectedUpdatedAt: rowAfterUpdate.updatedAt,
      state: "pending_refresh",
      error: "Retry the saved reminder refresh",
      checkedAt: 101,
      nextRefreshAt: 200,
      calendarRefreshRequired: true,
      workerToken: WORKER,
    })).resolves.toEqual({ ok: true });
    const savedAfterRefresh = await t.query(api.creations.get, { id: creationId, workerToken: WORKER });
    expect(JSON.parse(String(savedAfterRefresh?.data))).toMatchObject({ offlineMapPreflight: {
      calendarRefreshRequired: true,
      iCloudCalendarUrl: ICLOUD_CALENDAR_URL,
      iCloudCalendarEventUrl: ICLOUD_EVENT_URL,
    } });
    const [rowAfterRefresh] = await t.query(registry.due, { now: 200, limit: 1, workerToken: WORKER });
    expect(rowAfterRefresh.iCloudCalendarEvent).toMatchObject({ etag: '"etag-2"', revision: 100, nonce: updateReceipt.nonce });
    await expect(t.query(registry.validateICloudCalendarApproval, updateReceipt)).resolves.toEqual({ ok: false, reason: "stale" });
  });
});
