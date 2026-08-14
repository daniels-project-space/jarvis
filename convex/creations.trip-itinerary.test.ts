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
      link: "https://www.openstreetmap.org/node/1",
      source: "owner",
    }],
    route: { mode: "walking", status: "unavailable", calculatedAt: Date.now() },
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
        providers: { stays: { status: "ready", source: "Google Hotels", count: 8 } },
        stays: [{ name: "Hotel Tejo" }],
        planRevision: 0,
      }),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }));

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
      itinerary: [expect.objectContaining({ date: "2026-09-12" })],
    });

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
  });
});
