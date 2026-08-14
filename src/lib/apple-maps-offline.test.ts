import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { appleMapsCitySearchUrl, buildAppleMapsOfflinePreflight } from "./apple-maps-offline";

describe("Apple Maps offline preflight", () => {
  it("uses the next confirmed flight and schedules the preceding local calendar day", () => {
    const result = buildAppleMapsOfflinePreflight({
      city: "Seville, Spain",
      now: Date.parse("2030-09-01T08:00:00Z"),
      flights: [{
        id: "gmail-flight-1",
        marker: "jarvis-gmail-booking:gmail-flight-1",
        kind: "flight",
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
      flights: [{ id: "f", kind: "flight", start: Date.parse("2030-09-03T09:00:00+01:00"), timeZone: "Europe/London" }],
    })).toMatchObject({ status: "too_late" });
  });

  it("makes a current HTTPS Apple Maps search handoff", () => {
    expect(appleMapsCitySearchUrl("Málaga & coast")).toBe("https://maps.apple.com/search?query=M%C3%A1laga+%26+coast");
  });
});
