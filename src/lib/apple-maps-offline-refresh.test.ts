import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  appleMapsOfflineGmailIdentity,
  appleMapsOfflinePreflightSourceKey,
  currentAppleMapsOfflineCityProof,
  matchesAppleMapsOfflineGmailIdentity,
  matchesAppleMapsOfflineCityProof,
} from "./apple-maps-offline-refresh";

const flight = {
  id: "gmail-flight-1", marker: "jarvis-gmail-booking:gmail-flight-1", threadId: "thread-1",
  kind: "flight" as const, title: "✈ Iberia · confirmed", provider: "Iberia", start: 1_900_000_000_000,
  end: 1_900_000_900_000, allDay: false, confirmationCode: "ABC123", timeZone: "Europe/Madrid",
};

const proof = {
  city: "Seville", title: "🏨 Casa · confirmed", bookingName: "Casa", location: "Calle Example 1, Seville",
  start: 1_899_000_000_000, end: 1_901_000_000_000, timeZone: "Europe/Madrid", lat: 37.39, lng: -5.99,
  distanceKm: 0.4, verifiedAt: 1_899_000_100_000,
};

describe("saved Apple Maps preflight refresh identity", () => {
  it("keeps a saved-trip source key stable when Gmail replaces an itinerary message", () => {
    expect(appleMapsOfflinePreflightSourceKey("creation-1")).toBe(appleMapsOfflinePreflightSourceKey("creation-1"));
    expect(appleMapsOfflinePreflightSourceKey("creation-1")).not.toBe(appleMapsOfflinePreflightSourceKey("creation-2"));
  });

  it("permits only the exact booking or a provider-matched replacement with the same confirmation", () => {
    const identity = appleMapsOfflineGmailIdentity(flight, "booking-opaque");
    expect(matchesAppleMapsOfflineGmailIdentity(flight, identity)).toBe(true);
    expect(matchesAppleMapsOfflineGmailIdentity({ ...flight, id: "gmail-flight-2", marker: "jarvis-gmail-booking:gmail-flight-2" }, identity)).toBe(true);
    expect(matchesAppleMapsOfflineGmailIdentity({ ...flight, id: "other", marker: "other", confirmationCode: "OTHER" }, identity)).toBe(false);
  });

  it("fails closed when the stored stay proof no longer matches the exact stay", () => {
    const stay = {
      id: "gmail-stay-1", marker: "jarvis-gmail-booking:gmail-stay-1", threadId: "stay-thread",
      kind: "stay" as const, title: proof.title, provider: "Booking", start: proof.start, end: proof.end,
      allDay: false, confirmationCode: "STAY123", bookingName: proof.bookingName, location: proof.location,
    };
    expect(matchesAppleMapsOfflineCityProof(stay, proof)).toBe(true);
    expect(matchesAppleMapsOfflineCityProof({ ...stay, location: "Elsewhere, Madrid" }, proof)).toBe(false);
    expect(currentAppleMapsOfflineCityProof(proof, proof.verifiedAt + 1)).toEqual(proof);
    expect(currentAppleMapsOfflineCityProof({ ...proof, end: proof.verifiedAt - 1 }, proof.verifiedAt)).toBeUndefined();
  });
});
