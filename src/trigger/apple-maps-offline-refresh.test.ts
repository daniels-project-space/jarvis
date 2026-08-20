import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { refreshAppleMapsOfflinePreflights } from "./apple-maps-offline-refresh";

afterEach(() => {
  vi.unstubAllEnvs();
});

const now = 1_900_000_000_000;
const preflight = {
  city: "Seville", flightMarker: "jarvis-gmail-booking:flight-1", flightTitle: "✈ Iberia · confirmed",
  flightStart: now + 3 * 86_400_000, at: now + 2 * 86_400_000, timeZone: "Europe/Madrid",
  mapUrl: "https://maps.apple.com/search?query=Seville", todoText: "Download Seville", reminderText: "Download Seville",
};
const flightIdentity = {
  selectionId: "booking-flight", messageId: "flight-1", marker: "jarvis-gmail-booking:flight-1",
  threadId: "flight-thread", kind: "flight", provider: "Iberia", confirmationCode: "ABC123",
};
const cityProof = {
  city: "Seville", title: "🏨 Casa · confirmed", bookingName: "Casa", location: "Calle Example 1, Seville",
  start: now + 2 * 86_400_000, end: now + 5 * 86_400_000, timeZone: "Europe/Madrid", lat: 37.39, lng: -5.99,
  distanceKm: 0.4, verifiedAt: now - 1_000,
};
const stayIdentity = { ...flightIdentity, selectionId: "booking-stay", messageId: "stay-1", marker: "jarvis-gmail-booking:stay-1", threadId: "stay-thread", kind: "stay", provider: "Booking", confirmationCode: "STAY123" };
const row = {
  _id: "preflight-1", updatedAt: 123, sourceKey: "c".repeat(64), preflight, flightIdentity, cityProofIdentity: stayIdentity,
  cityProof, creation: { _id: "trip-1", kind: "trip", data: JSON.stringify({ kind: "trip" }) },
};
const flight = { id: "flight-2", marker: "jarvis-gmail-booking:flight-2", threadId: "flight-thread", kind: "flight" as const, title: "✈ Iberia · confirmed", provider: "Iberia", start: preflight.flightStart + 60 * 60_000, end: preflight.flightStart + 4 * 60 * 60_000, allDay: false, confirmationCode: "ABC123", timeZone: "Europe/Madrid" };
const stay = { id: "stay-1", marker: "jarvis-gmail-booking:stay-1", threadId: "stay-thread", kind: "stay" as const, title: cityProof.title, provider: "Booking", start: cityProof.start, end: cityProof.end, allDay: false, confirmationCode: "STAY123", bookingName: cityProof.bookingName, location: cityProof.location, timeZone: "Europe/Madrid" };

describe("saved Apple Maps preflight maintenance", () => {
  it("updates only the registered reminder and to-do when its exact Gmail itinerary changes", async () => {
    const query = vi.fn().mockResolvedValue([row]);
    const mutation = vi.fn().mockResolvedValue({ ok: true });
    vi.stubEnv("JARVIS_HUB_ACTIONS_TOKEN", "dedicated-jarvis-actions-token");
    const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = JSON.parse(String(init?.body)) as { path?: string; args?: Record<string, unknown> };
      expect(url.pathname).toBe(body.path === "jarvisActions:listTodos" ? "/api/query" : "/api/mutation");
      if (body.path === "jarvisActions:listTodos") {
        return new Response(JSON.stringify({ value: [] }), { headers: { "content-type": "application/json" } });
      }
      if (body.path === "jarvisActions:createTodo") {
        return new Response(JSON.stringify({ value: { id: "todo-1" } }), { headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected Hub path ${body.path}`);
    });
    const result = await refreshAppleMapsOfflinePreflights({
      query, mutation, fetch: fetch as typeof globalThis.fetch, now: () => now,
      lookupBooking: vi.fn(async (identity) => identity.selectionId === "booking-flight" ? flight : stay),
    });
    expect(result).toEqual({ due: 1, refreshed: 1, pending: 0, skipped: 0 });
    expect(query).toHaveBeenCalledWith("appleMapsOfflinePreflights:due", { now, limit: 4 });
    expect(mutation).toHaveBeenCalledWith("reminders:add", expect.objectContaining({ sourceKey: row.sourceKey }));
    expect(mutation).toHaveBeenCalledWith("appleMapsOfflinePreflights:completeRefresh", expect.objectContaining({
      id: row._id, expectedUpdatedAt: row.updatedAt, calendarRefreshRequired: true,
      preflight: expect.objectContaining({ flightStart: flight.start, sourceKey: row.sourceKey }),
    }));
    const payloads = fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as { path: string; args: Record<string, unknown> });
    expect(payloads).toEqual([
      expect.objectContaining({ path: "jarvisActions:listTodos", args: { vaultToken: "dedicated-jarvis-actions-token" } }),
      expect.objectContaining({
        path: "jarvisActions:createTodo",
        args: expect.objectContaining({
          vaultToken: "dedicated-jarvis-actions-token",
          tags: ["jarvis", "travel", "apple-maps", expect.stringMatching(/^src-[a-f0-9]{36}$/)],
        }),
      }),
    ]);
    const createdTags = payloads[1]?.args.tags as string[];
    expect(createdTags.every((tag) => /^[a-z0-9 -]+$/i.test(tag) && tag.length <= 40)).toBe(true);
    expect(createdTags).not.toContain(`source:${row.sourceKey}`);
    expect(payloads.map((payload) => payload.path)).not.toContain("todos:add");
    expect(payloads.map((payload) => payload.path)).not.toContain("todos:list");
  });

  it("reconciles an ambiguous Hub create by its stable tag before a scheduled retry can duplicate it", async () => {
    vi.stubEnv("JARVIS_HUB_ACTIONS_TOKEN", "dedicated-jarvis-actions-token");
    const mutation = vi.fn().mockResolvedValue({ ok: true });
    let listAttempts = 0;
    let acceptedCreate: Record<string, unknown> | undefined;
    const fetch = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { path?: string; args?: Record<string, unknown> };
      if (body.path === "jarvisActions:listTodos") {
        const value = listAttempts++ === 0 ? [] : [{
          id: "todo-1", text: acceptedCreate?.text, dueDate: acceptedCreate?.dueDate, done: false,
          // Old rows remain identifiable so this migration never duplicates
          // them, but no invalid tag is included in a new Hub action payload.
          tags: [`source:${row.sourceKey}`],
        }];
        return new Response(JSON.stringify({ value }), { headers: { "content-type": "application/json" } });
      }
      if (body.path === "jarvisActions:createTodo") {
        // The facade may have accepted the request before a network reset.
        acceptedCreate = body.args;
        throw new Error("connection reset after create");
      }
      throw new Error(`unexpected Hub path ${body.path}`);
    });

    await expect(refreshAppleMapsOfflinePreflights({
      query: vi.fn().mockResolvedValue([row]), mutation, fetch: fetch as typeof globalThis.fetch, now: () => now,
      lookupBooking: vi.fn(async (identity) => identity.selectionId === "booking-flight" ? flight : stay),
    })).resolves.toEqual({ due: 1, refreshed: 1, pending: 0, skipped: 0 });

    const payloads = fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as { path: string; args: Record<string, unknown> });
    expect(payloads.map((payload) => payload.path)).toEqual([
      "jarvisActions:listTodos", "jarvisActions:createTodo", "jarvisActions:listTodos",
    ]);
    expect(payloads.map((payload) => payload.path)).not.toContain("todos:add");
    expect(mutation).toHaveBeenCalledWith("appleMapsOfflinePreflights:completeRefresh", expect.objectContaining({
      todoStatus: "existing",
    }));
  });

  it("fails closed when the dedicated Hub capability is absent and never calls legacy Hub todos", async () => {
    vi.stubEnv("JARVIS_HUB_ACTIONS_TOKEN", "");
    const mutation = vi.fn().mockResolvedValue({ ok: true });
    const fetch = vi.fn();

    await expect(refreshAppleMapsOfflinePreflights({
      query: vi.fn().mockResolvedValue([row]), mutation, fetch: fetch as typeof globalThis.fetch, now: () => now,
      lookupBooking: vi.fn(async (identity) => identity.selectionId === "booking-flight" ? flight : stay),
    })).resolves.toEqual({ due: 1, refreshed: 1, pending: 0, skipped: 0 });

    expect(fetch).not.toHaveBeenCalled();
    expect(mutation).toHaveBeenCalledWith("appleMapsOfflinePreflights:completeRefresh", expect.objectContaining({
      todoStatus: "needs_retry",
    }));
  });

  it("fails closed with a pending Google state and does not touch the reminder when Gmail is unavailable", async () => {
    const mutation = vi.fn().mockResolvedValue({ ok: true });
    const result = await refreshAppleMapsOfflinePreflights({
      query: vi.fn().mockResolvedValue([row]), mutation, now: () => now,
      lookupBooking: vi.fn(async () => { throw new Error("not configured"); }),
    });
    expect(result).toEqual({ due: 1, refreshed: 0, pending: 1, skipped: 0 });
    expect(mutation).toHaveBeenCalledWith("appleMapsOfflinePreflights:markPending", expect.objectContaining({
      state: "pending_google", error: "Gmail itinerary access is unavailable",
    }));
    expect(mutation).not.toHaveBeenCalledWith("reminders:add", expect.anything());
  });
});
