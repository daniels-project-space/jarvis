import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  APPLE_MAPS_OFFLINE_REFRESH_INTERVAL_MS,
  APPLE_MAPS_OFFLINE_RETRY_INTERVAL_MS,
  appleMapsCitySearchUrl,
  buildAppleMapsOfflinePreflight,
  nextAppleMapsOfflinePreflightRefreshAt,
} from "./apple-maps-offline";

describe("Apple Maps offline preflight", () => {
  it("retries a failed scoped to-do promptly without entering the protected reminder window", () => {
    const now = Date.parse("2030-09-01T08:00:00Z");
    const preflightAt = now + 2 * 86_400_000;
    expect(nextAppleMapsOfflinePreflightRefreshAt(preflightAt, now)).toBe(
      now + APPLE_MAPS_OFFLINE_REFRESH_INTERVAL_MS,
    );
    expect(nextAppleMapsOfflinePreflightRefreshAt(preflightAt, now, true)).toBe(
      now + APPLE_MAPS_OFFLINE_RETRY_INTERVAL_MS,
    );
    expect(nextAppleMapsOfflinePreflightRefreshAt(now + 7 * 60_000, now, true)).toBe(now + 60_000);
    expect(nextAppleMapsOfflinePreflightRefreshAt(now + 3 * 60_000, now, true)).toBeNull();
  });

  it("uses the next confirmed flight and schedules the preceding local calendar day", () => {
    const result = buildAppleMapsOfflinePreflight({
      city: "Seville, Spain",
      now: Date.parse("2030-09-01T08:00:00Z"),
      flights: [{
        id: "gmail-flight-1",
        marker: "jarvis-gmail-booking:gmail-flight-1",
        kind: "flight",
        tripVerified: true,
        title: "Iberia 123 · confirmed",
        start: Date.parse("2030-09-03T09:15:00+02:00"),
        timeZone: "Europe/Madrid",
      }],
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("expected preflight");
    expect(new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).format(result.preflight.at)).toBe("02/09/2030, 09:15");
    expect(result.preflight.mapUrl).toBe("https://maps.apple.com/search?query=Seville%2C+Spain");
    expect(result.preflight.todoText).toContain("remove the old unused map");
  });

  it("never derives an action from an unconfirmed or already-too-close flight", () => {
    expect(buildAppleMapsOfflinePreflight({ city: "Lisbon", now: Date.parse("2030-09-01T08:00:00Z"), flights: [] })).toMatchObject({
      status: "needs_flight_confirmation",
    });
    expect(buildAppleMapsOfflinePreflight({
      city: "Lisbon",
      now: Date.parse("2030-09-02T09:30:00+01:00"),
      flights: [{ id: "f", kind: "flight", tripVerified: true, start: Date.parse("2030-09-03T09:00:00+01:00"), timeZone: "Europe/London" }],
    })).toMatchObject({ status: "too_late" });
  });

  it("requires exactly one trip-verified flight with an explicit IANA zone", () => {
    const now = Date.parse("2030-09-01T08:00:00Z");
    expect(buildAppleMapsOfflinePreflight({
      city: "Lisbon",
      now,
      flights: [{ id: "missing-zone", kind: "flight", tripVerified: true, start: Date.parse("2030-09-03T09:00:00Z") }],
    })).toMatchObject({ status: "needs_flight_confirmation", reason: expect.stringMatching(/IANA time zone/i) });
    expect(buildAppleMapsOfflinePreflight({
      city: "Lisbon",
      now,
      flights: [
        { id: "one", kind: "flight", tripVerified: true, start: Date.parse("2030-09-03T09:00:00+01:00"), timeZone: "Europe/Lisbon" },
        { id: "two", kind: "flight", tripVerified: true, start: Date.parse("2030-09-04T09:00:00+01:00"), timeZone: "Europe/Lisbon" },
      ],
    })).toMatchObject({ status: "needs_flight_confirmation", reason: expect.stringMatching(/choose one/i) });
  });

  it("makes a current HTTPS Apple Maps search handoff", () => {
    expect(appleMapsCitySearchUrl("Málaga & coast")).toBe("https://maps.apple.com/search?query=M%C3%A1laga+%26+coast");
  });
});
