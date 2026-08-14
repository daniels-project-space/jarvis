import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import schema from "./schema";
import { LEGACY_CREATION_URL_REDACTION, LEGACY_PUBLIC_CREATION_ORIGIN } from "../src/lib/legacy-creation-url";

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>;
  }
}

const modules = import.meta.glob("./**/*.ts");
const WORKER = "brain-context-travel-worker";
const brainContext = (api as any).brainContext;

beforeEach(() => {
  process.env.JARVIS_WORKER_TOKEN = WORKER;
});

afterEach(() => {
  delete process.env.JARVIS_WORKER_TOKEN;
});

async function insertPanelAndDraft(
  t: ReturnType<typeof convexTest>,
  options: { threadId?: string; activeThreadId?: string; state?: "draft" | "locked"; expiresAt?: number; data?: Record<string, unknown> } = {},
) {
  const now = Date.now();
  const threadId = options.threadId ?? "thread-sevilla";
  const activeThreadId = options.activeThreadId ?? threadId;
  const state = options.state ?? "draft";
  const data = options.data ?? {
    kind: "trip",
    title: "Sevilla · planning",
    destination: "Sevilla",
    departDate: "2026-09-12",
    returnDate: "2026-09-16",
    status: "planned",
  };
  return await t.run(async (ctx) => {
    const draftId = await ctx.db.insert("travelDrafts", {
      threadId,
      state,
      schemaVersion: 1,
      title: "Sevilla · planning",
      destination: "Sevilla",
      data: JSON.stringify(data),
      planRevision: 3,
      createdAt: now - 60_000,
      updatedAt: now,
      expiresAt: options.expiresAt ?? now + 3_600_000,
    });
    await ctx.db.insert("ui", {
      key: "activeThread",
      type: "thread",
      value: activeThreadId,
      updatedAt: now,
    });
    await ctx.db.insert("ui", {
      key: "panel",
      type: "trip",
      value: JSON.stringify({ draftId: String(draftId) }),
      title: "trip · Sevilla",
      updatedAt: now,
    });
    return String(draftId);
  });
}

describe("brain context active travel workspace", () => {
  it("returns only the active thread's live workspace with current city bookings", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const draftId = await insertPanelAndDraft(t, {
      data: {
        kind: "trip",
        title: "Sevilla · planning",
        destination: "Sevilla",
        departDate: "2026-09-12",
        returnDate: "2026-09-16",
        status: "planned",
        planRevision: 3,
        itinerary: [{
          date: "2026-09-12",
          label: "Fri 12 Sep",
          items: [{ title: "Alcázar", time: "10:00", kind: "activity", durationMinutes: 90 }],
          route: { mode: "walking", status: "ready", durationSeconds: 720, distanceMeters: 700 },
        }],
        discoveries: [{
          city: "Córdoba",
          query: "patios",
          items: [{ id: "patio-1" }, { id: "patio-2" }],
          route: { mode: "train", status: "ready", durationSeconds: 2_400, distanceMeters: 140_000 },
        }],
        bookingReferences: [
          {
            city: "Sevilla",
            bookingName: "Riverside Apartments",
            location: "42 Calle del Agua, Sevilla",
            start: now - 3_600_000,
            end: now + 86_400_000,
            verifiedAt: now - 60_000,
            timeZone: "Europe/Madrid",
            distanceKm: 0.8,
          },
          {
            city: "Sevilla",
            bookingName: "Stale Confirmation",
            location: "Old address",
            start: now - 3_600_000,
            end: now + 86_400_000,
            verifiedAt: now - 24 * 60 * 60_000 - 1,
          },
        ],
      },
    });

    const snapshot = await t.query(brainContext.snapshot, { workerToken: WORKER, userText: "Show attractions in Sevilla" });

    expect(snapshot.activeTravel).toMatchObject({
      draftId,
      destination: "Sevilla",
      planRevision: 3,
      itinerary: [{ date: "2026-09-12", items: [{ title: "Alcázar", time: "10:00" }] }],
      discoveries: [{ city: "Córdoba", query: "patios", itemCount: 2 }],
      bookingReferences: [{ city: "Sevilla", bookingName: "Riverside Apartments", state: "active" }],
    });
    expect(JSON.stringify(snapshot.activeTravel)).not.toContain("Stale Confirmation");
  });

  it("does not leak a stale, locked, or cross-thread panel draft into context", async () => {
    const wrongThread = convexTest(schema, modules);
    await insertPanelAndDraft(wrongThread, { threadId: "thread-sevilla", activeThreadId: "thread-london" });
    await expect(wrongThread.query(brainContext.snapshot, { workerToken: WORKER })).resolves.toMatchObject({ activeTravel: null });

    const locked = convexTest(schema, modules);
    await insertPanelAndDraft(locked, { state: "locked" });
    await expect(locked.query(brainContext.snapshot, { workerToken: WORKER })).resolves.toMatchObject({ activeTravel: null });

    const expired = convexTest(schema, modules);
    await insertPanelAndDraft(expired, { expiresAt: Date.now() - 1 });
    await expect(expired.query(brainContext.snapshot, { workerToken: WORKER })).resolves.toMatchObject({ activeTravel: null });
  });

  it("projects trip and draft media through the safe creation view", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const legacyUrl = `${LEGACY_PUBLIC_CREATION_ORIGIN}/creations/2026-08/legacy-draft.png`;
    const privateKey = "owners/daniel/creations/f47ac10b-58cc-4372-a567-0e02b2c3d479/asset";
    const ids = await t.run(async (ctx) => ({
      tripId: String(await ctx.db.insert("creations", {
        kind: "trip",
        title: "Private Sevilla plan",
        data: JSON.stringify({ imageUrls: { cover: legacyUrl } }),
        url: legacyUrl,
        thumb: legacyUrl,
        assetR2Key: privateKey,
        assetContentType: "image/png",
        createdAt: now,
        updatedAt: now,
      })),
      draftId: String(await ctx.db.insert("creations", {
        kind: "doc",
        title: "Legacy travel draft",
        data: JSON.stringify({ imageUrls: { cover: legacyUrl } }),
        url: legacyUrl,
        thumb: legacyUrl,
        createdAt: now,
        updatedAt: now,
      })),
    }));

    const snapshot = await t.query(brainContext.snapshot, { workerToken: WORKER, userText: "continue my travel plan" });
    const serialized = JSON.stringify({ trip: snapshot.trip, draft: snapshot.draft });

    expect(snapshot.trip).toMatchObject({
      url: `/api/creation-media?id=${ids.tripId}&variant=asset`,
      thumb: `/api/creation-media?id=${ids.tripId}&variant=asset`,
      hasPrivateAsset: true,
    });
    expect(snapshot.draft).toMatchObject({
      url: `/api/creation-media?id=${ids.draftId}&variant=asset`,
      thumb: `/api/creation-media?id=${ids.draftId}&variant=asset`,
      hasPrivateAsset: false,
    });
    expect(snapshot.draft?.data).toContain(LEGACY_CREATION_URL_REDACTION);
    expect(serialized).not.toContain(legacyUrl);
    expect(serialized).not.toContain(privateKey);
  });
});
