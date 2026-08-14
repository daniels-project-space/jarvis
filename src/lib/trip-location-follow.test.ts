import { describe, expect, it } from "vitest";

import { followTripCityContext, tripLocationDistanceKm } from "./trip-location-follow";

const contexts = [
  { id: "seville", center: { lat: 37.3891, lng: -5.9845 } },
  { id: "cordoba", center: { lat: 37.8882, lng: -4.7794 } },
];

describe("trip location following", () => {
  it("matches the nearest saved city without exposing the browser position", () => {
    expect(followTripCityContext({
      contexts,
      currentContextId: "cordoba",
      position: { lat: 37.3891, lng: -5.9845, accuracyMeters: 18 },
    })?.id).toBe("seville");
  });

  it("does not turn a distant or inaccurate reading into a city change", () => {
    expect(followTripCityContext({
      contexts,
      position: { lat: 40.4168, lng: -3.7038, accuracyMeters: 120 },
    })).toBeNull();
    expect(followTripCityContext({
      contexts,
      position: { lat: 37.3891, lng: -5.9845, accuracyMeters: 10_001 },
    })).toBeNull();
  });

  it("retains the current city through the wider exit radius when no saved city is close enough to acquire", () => {
    expect(followTripCityContext({
      contexts,
      currentContextId: "seville",
      position: { lat: 37.78, lng: -5.86, accuracyMeters: 20 },
    })?.id).toBe("seville");
  });

  it("keeps the active city near a boundary until another saved city is decisively closer", () => {
    const nearby = [
      { id: "west", center: { lat: 51.5, lng: -0.2 } },
      { id: "east", center: { lat: 51.5, lng: -0.1 } },
    ];
    expect(followTripCityContext({
      contexts: nearby,
      currentContextId: "west",
      position: { lat: 51.5, lng: -0.148 },
    })?.id).toBe("west");
    expect(followTripCityContext({
      contexts: nearby,
      currentContextId: "west",
      position: { lat: 51.5, lng: -0.101 },
    })?.id).toBe("east");
  });

  it("uses a great-circle distance for city-scale thresholds", () => {
    expect(tripLocationDistanceKm(contexts[0].center, contexts[1].center)).toBeGreaterThan(100);
    expect(tripLocationDistanceKm(contexts[0].center, contexts[1].center)).toBeLessThan(150);
  });
});
