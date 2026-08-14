import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { refreshAppleMapsOfflinePreflights } from "./apple-maps-offline-refresh";

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
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: "todo-1" }), { status: 200 }));
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
