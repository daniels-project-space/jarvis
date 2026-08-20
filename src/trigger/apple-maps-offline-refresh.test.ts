import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  APPLE_MAPS_OFFLINE_REFRESH_INTERVAL_MS,
  refreshAppleMapsOfflinePreflights,
} from "./apple-maps-offline-refresh";
import { buildAppleMapsOfflinePreflight } from "../lib/apple-maps-offline";

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
      nextRefreshAt: now + APPLE_MAPS_OFFLINE_REFRESH_INTERVAL_MS,
      refreshState: "scheduled",
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

  it("requires a fresh Calendar approval when the exact itinerary's time zone changes without moving the instant", async () => {
    const mutation = vi.fn().mockResolvedValue({ ok: true });
    const originalFlight = {
      ...flight,
      id: flightIdentity.messageId,
      marker: preflight.flightMarker,
      start: preflight.flightStart,
      title: preflight.flightTitle,
      timeZone: "Europe/Madrid",
      tripVerified: true,
    };
    const baseline = buildAppleMapsOfflinePreflight({
      city: preflight.city,
      flights: [originalFlight],
      sourceKey: row.sourceKey,
      now,
    });
    if (baseline.status !== "ready") throw new Error("expected a ready baseline preflight");
    const timeZoneRow = { ...row, preflight: baseline.preflight };
    const timeZoneCorrectedFlight = {
      ...originalFlight,
      timeZone: "Europe/Paris",
    };

    await expect(refreshAppleMapsOfflinePreflights({
      query: vi.fn().mockResolvedValue([timeZoneRow]),
      mutation,
      now: () => now,
      lookupBooking: vi.fn(async (identity) => identity.selectionId === "booking-flight" ? timeZoneCorrectedFlight : stay),
    })).resolves.toEqual({ due: 1, refreshed: 1, pending: 0, skipped: 0 });

    expect(mutation).toHaveBeenCalledWith("appleMapsOfflinePreflights:completeRefresh", expect.objectContaining({
      calendarRefreshRequired: true,
      preflight: expect.objectContaining({
        at: baseline.preflight.at,
        timeZone: "Europe/Paris",
      }),
    }));
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
      nextRefreshAt: now + 10 * 60_000,
      refreshState: "scheduled",
    }));
  });

  it("does not revise a preflight after its protected five-minute window begins", async () => {
    const lateNow = Date.parse("2030-01-01T07:00:00Z");
    const lateFlight = {
      ...flight,
      start: Date.parse("2030-01-02T08:03:00+01:00"),
      end: Date.parse("2030-01-02T11:03:00+01:00"),
    };
    const lateStay = {
      ...stay,
      start: Date.parse("2030-01-01T12:00:00+01:00"),
      end: Date.parse("2030-01-03T12:00:00+01:00"),
    };
    const lateRow = {
      ...row,
      preflight: { ...preflight, at: lateNow + 3 * 60_000, flightStart: lateFlight.start },
      cityProof: {
        ...cityProof,
        start: lateStay.start,
        end: lateStay.end,
        verifiedAt: lateNow - 1_000,
      },
    };
    const mutation = vi.fn().mockResolvedValue({ ok: true });
    const fetch = vi.fn();

    await expect(refreshAppleMapsOfflinePreflights({
      query: vi.fn().mockResolvedValue([lateRow]),
      mutation,
      fetch: fetch as typeof globalThis.fetch,
      now: () => lateNow,
      lookupBooking: vi.fn(async (identity) => identity.selectionId === "booking-flight" ? lateFlight : lateStay),
    })).resolves.toEqual({ due: 1, refreshed: 0, pending: 0, skipped: 1 });

    expect(mutation).toHaveBeenCalledWith("appleMapsOfflinePreflights:markPending", expect.objectContaining({
      state: "too_late",
      error: "The five-minute safe preflight refresh window has passed; the durable reminder stays unchanged.",
    }));
    const [, timingOnlyArgs] = mutation.mock.calls.find(([path]) => path === "appleMapsOfflinePreflights:markPending")!;
    expect(timingOnlyArgs).not.toHaveProperty("calendarRefreshRequired");
    expect(mutation).not.toHaveBeenCalledWith("reminders:add", expect.anything());
    expect(mutation).not.toHaveBeenCalledWith("appleMapsOfflinePreflights:completeRefresh", expect.anything());
    expect(fetch).not.toHaveBeenCalled();
  });

  it("invalidates Calendar approval when Gmail finds an earlier confirmed flight whose preflight is already too late", async () => {
    const postLookupNow = Date.parse("2030-01-10T12:00:00Z");
    const earlierFlight = {
      ...flight,
      id: "flight-replacement",
      marker: "jarvis-gmail-booking:flight-replacement",
      start: Date.parse("2030-01-11T09:00:00+01:00"),
      end: Date.parse("2030-01-11T12:00:00+01:00"),
    };
    const currentStay = {
      ...stay,
      start: Date.parse("2030-01-09T12:00:00+01:00"),
      end: Date.parse("2030-01-12T12:00:00+01:00"),
    };
    const oldPreflight = {
      ...preflight,
      flightStart: Date.parse("2030-01-14T09:00:00+01:00"),
      at: Date.parse("2030-01-13T09:00:00+01:00"),
    };
    const earlierFlightRow = {
      ...row,
      preflight: oldPreflight,
      cityProof: {
        ...cityProof,
        start: currentStay.start,
        end: currentStay.end,
        verifiedAt: postLookupNow - 1_000,
      },
    };
    const mutation = vi.fn().mockResolvedValue({ ok: true });

    await expect(refreshAppleMapsOfflinePreflights({
      query: vi.fn().mockResolvedValue([earlierFlightRow]),
      mutation,
      now: () => postLookupNow,
      lookupBooking: vi.fn(async (identity) => identity.selectionId === "booking-flight" ? earlierFlight : currentStay),
    })).resolves.toEqual({ due: 1, refreshed: 0, pending: 0, skipped: 1 });

    expect(mutation).toHaveBeenCalledWith("appleMapsOfflinePreflights:markPending", expect.objectContaining({
      state: "too_late",
      error: "The one-day-before preparation time has passed",
      calendarRefreshRequired: true,
    }));
    expect(mutation).not.toHaveBeenCalledWith("reminders:add", expect.anything());
    expect(mutation).not.toHaveBeenCalledWith("appleMapsOfflinePreflights:completeRefresh", expect.anything());
  });

  it("invalidates Calendar approval when an exact Gmail flight changes from all-day to timed in the too-late branch", async () => {
    const postLookupNow = Date.parse("2030-01-10T07:30:00Z");
    const allDayFlight = {
      ...flight,
      id: flightIdentity.messageId,
      marker: preflight.flightMarker,
      title: preflight.flightTitle,
      start: Date.parse("2030-01-11T08:00:00+01:00"),
      end: Date.parse("2030-01-11T11:00:00+01:00"),
      allDay: true,
    };
    const allDayPreflight = buildAppleMapsOfflinePreflight({
      city: preflight.city,
      flights: [{ ...allDayFlight, tripVerified: true }],
      sourceKey: row.sourceKey,
      now: postLookupNow - 24 * 60 * 60_000,
    });
    if (allDayPreflight.status !== "ready") throw new Error("expected an all-day baseline preflight");
    const currentStay = {
      ...stay,
      start: Date.parse("2030-01-09T12:00:00+01:00"),
      end: Date.parse("2030-01-12T12:00:00+01:00"),
    };
    const allDayRow = {
      ...row,
      preflight: allDayPreflight.preflight,
      cityProof: {
        ...cityProof,
        start: currentStay.start,
        end: currentStay.end,
        verifiedAt: postLookupNow - 1_000,
      },
    };
    const mutation = vi.fn().mockResolvedValue({ ok: true });

    await expect(refreshAppleMapsOfflinePreflights({
      query: vi.fn().mockResolvedValue([allDayRow]),
      mutation,
      now: () => postLookupNow,
      lookupBooking: vi.fn(async (identity) => identity.selectionId === "booking-flight"
        ? { ...allDayFlight, allDay: false }
        : currentStay),
    })).resolves.toEqual({ due: 1, refreshed: 0, pending: 0, skipped: 1 });

    expect(mutation).toHaveBeenCalledWith("appleMapsOfflinePreflights:markPending", expect.objectContaining({
      state: "too_late",
      error: "The one-day-before preparation time has passed",
      calendarRefreshRequired: true,
    }));
  });

  it.each([
    "selected flight disappears",
    "selected stay no longer matches the city proof",
    "selected flight loses its valid IANA time zone",
  ])("invalidates Calendar approval when %s after Gmail lookup crosses the stored safe window", async (observedInvalidity) => {
    let clock = now;
    const mutation = vi.fn().mockResolvedValue({ ok: true });
    const lookupBooking = vi.fn(async (identity) => {
      if (identity.selectionId === "booking-flight") {
        if (observedInvalidity === "selected flight disappears") {
          clock = row.preflight.at;
          return null;
        }
        if (observedInvalidity === "selected flight loses its valid IANA time zone") {
          clock = row.preflight.at;
          return { ...flight, timeZone: "UTC" };
        }
        return flight;
      }
      clock = row.preflight.at;
      return { ...stay, location: "A different hotel, Seville" };
    });

    await expect(refreshAppleMapsOfflinePreflights({
      query: vi.fn().mockResolvedValue([row]),
      mutation,
      now: () => clock,
      lookupBooking,
    })).resolves.toEqual({ due: 1, refreshed: 0, pending: 0, skipped: 1 });

    expect(mutation).toHaveBeenCalledWith("appleMapsOfflinePreflights:markPending", expect.objectContaining({
      state: "too_late",
      error: "The five-minute safe preflight refresh window has passed; the durable reminder stays unchanged.",
      calendarRefreshRequired: true,
    }));
    expect(mutation).not.toHaveBeenCalledWith("reminders:add", expect.anything());
  });

  it("rechecks the clock after Gmail lookup before it writes the durable reminder", async () => {
    let clock = now;
    const mutation = vi.fn().mockResolvedValue({ ok: true });
    const fetch = vi.fn();
    const lookupBooking = vi.fn(async (identity) => {
      if (identity.selectionId === "booking-flight") {
        // Simulate a lookup that crosses the saved preflight's protected window.
        clock = flight.start;
        return flight;
      }
      return stay;
    });

    await expect(refreshAppleMapsOfflinePreflights({
      query: vi.fn().mockResolvedValue([row]),
      mutation,
      fetch: fetch as typeof globalThis.fetch,
      now: () => clock,
      lookupBooking,
    })).resolves.toEqual({ due: 1, refreshed: 0, pending: 0, skipped: 1 });

    expect(lookupBooking).toHaveBeenCalledTimes(2);
    expect(mutation).toHaveBeenCalledWith("appleMapsOfflinePreflights:markPending", expect.objectContaining({
      state: "too_late",
      error: "The five-minute safe preflight refresh window has passed; the durable reminder stays unchanged.",
      calendarRefreshRequired: true,
    }));
    expect(mutation).not.toHaveBeenCalledWith("reminders:add", expect.anything());
    expect(mutation).not.toHaveBeenCalledWith("appleMapsOfflinePreflights:completeRefresh", expect.anything());
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not let a later moved flight bypass the stored reminder's protected window", async () => {
    let clock = now;
    const mutation = vi.fn().mockResolvedValue({ ok: true });
    const fetch = vi.fn();
    // This row represents the old, already-scheduled reminder. Gmail has
    // moved the exact selected flight later, so the rebuilt preflight is much
    // later than the owner-visible one being replaced.
    const imminentStoredReminder = {
      ...row,
      preflight: { ...preflight, at: now + 6 * 60_000 },
    };
    const lookupBooking = vi.fn(async (identity) => {
      if (identity.selectionId === "booking-flight") {
        // The old reminder's five-minute window begins while Gmail is read.
        clock = now + 2 * 60_000;
        return flight;
      }
      return stay;
    });

    await expect(refreshAppleMapsOfflinePreflights({
      query: vi.fn().mockResolvedValue([imminentStoredReminder]),
      mutation,
      fetch: fetch as typeof globalThis.fetch,
      now: () => clock,
      lookupBooking,
    })).resolves.toEqual({ due: 1, refreshed: 0, pending: 0, skipped: 1 });

    expect(mutation).toHaveBeenCalledWith("appleMapsOfflinePreflights:markPending", expect.objectContaining({
      state: "too_late",
      error: "The five-minute safe preflight refresh window has passed; the durable reminder stays unchanged.",
    }));
    expect(mutation).not.toHaveBeenCalledWith("reminders:add", expect.anything());
    expect(mutation).not.toHaveBeenCalledWith("appleMapsOfflinePreflights:completeRefresh", expect.anything());
    expect(fetch).not.toHaveBeenCalled();
  });

  it("honours the server-side cutoff if the final reminder mutation arrives late", async () => {
    const mutation = vi.fn(async (path: string, args: Record<string, unknown>) => {
      if (path === "reminders:add") {
        expect(args).toMatchObject({
          sourceKey: row.sourceKey,
          sourceKeyUpdateCutoffAt: row.preflight.at - 5 * 60_000,
        });
        // Simulates Convex evaluating its own clock after this worker's
        // caller-side preflight check already succeeded.
        throw new Error("source_update_cutoff_passed");
      }
      return { ok: true };
    });
    const fetch = vi.fn();

    await expect(refreshAppleMapsOfflinePreflights({
      query: vi.fn().mockResolvedValue([row]),
      mutation,
      fetch: fetch as typeof globalThis.fetch,
      now: () => now,
      lookupBooking: vi.fn(async (identity) => identity.selectionId === "booking-flight" ? flight : stay),
    })).resolves.toEqual({ due: 1, refreshed: 0, pending: 0, skipped: 1 });

    expect(mutation).toHaveBeenCalledWith("appleMapsOfflinePreflights:markPending", expect.objectContaining({
      state: "too_late",
      error: "The five-minute safe preflight refresh window has passed; the durable reminder stays unchanged.",
      calendarRefreshRequired: true,
    }));
    expect(mutation).not.toHaveBeenCalledWith("appleMapsOfflinePreflights:completeRefresh", expect.anything());
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rechecks the clock after a Hub read before it mutates the to-do", async () => {
    vi.stubEnv("JARVIS_HUB_ACTIONS_TOKEN", "dedicated-jarvis-actions-token");
    let clock = now;
    const mutation = vi.fn().mockResolvedValue({ ok: true });
    const fetch = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { path?: string };
      if (body.path !== "jarvisActions:listTodos") throw new Error(`unexpected Hub mutation ${body.path}`);
      // The read was slow; no later create/update is allowed to cross the window.
      clock = flight.start;
      return new Response(JSON.stringify({ value: [] }), { headers: { "content-type": "application/json" } });
    });

    await expect(refreshAppleMapsOfflinePreflights({
      query: vi.fn().mockResolvedValue([row]),
      mutation,
      fetch: fetch as typeof globalThis.fetch,
      now: () => clock,
      lookupBooking: vi.fn(async (identity) => identity.selectionId === "booking-flight" ? flight : stay),
    })).resolves.toEqual({ due: 1, refreshed: 1, pending: 0, skipped: 0 });

    expect(mutation).toHaveBeenCalledWith("reminders:add", expect.objectContaining({ sourceKey: row.sourceKey }));
    expect(mutation).toHaveBeenCalledWith("appleMapsOfflinePreflights:completeRefresh", expect.objectContaining({
      id: row._id,
      expectedUpdatedAt: row.updatedAt,
      preflight: expect.objectContaining({ flightStart: flight.start }),
      cityProof: expect.objectContaining({ verifiedAt: flight.start }),
      refreshState: "too_late",
      refreshError: "The durable reminder was refreshed before the safe window closed; the Hub to-do was not changed.",
      todoStatus: "needs_retry",
    }));
    expect(mutation).not.toHaveBeenCalledWith("appleMapsOfflinePreflights:markPending", expect.anything());
    expect(fetch).toHaveBeenCalledTimes(1);
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
