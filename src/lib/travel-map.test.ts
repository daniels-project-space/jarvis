import { describe, expect, it } from "vitest";

import {
  googleDirectionsUrl,
  googlePlacesSearchBody,
  googlePlacesTextQuery,
  normalizeTravelMapRequest,
  orderTravelMapPoints,
} from "./travel-map";

describe("travel map requests", () => {
  it("turns the exact Sevilla transcript into a general niche-attraction search", () => {
    const args = {
      location: "Sevilla",
      query: "attractions in the city",
      preferences: "not touristy; give me something more niche",
      route: true,
      include_bookings: true,
      travel_mode: "walking",
    };
    const request = normalizeTravelMapRequest(args);
    expect(request).toEqual({
      location: "Sevilla",
      query: "attractions in the city",
      preferences: "not touristy; give me something more niche",
      includeBookings: true,
      route: true,
      travelMode: "walking",
    });
    expect(googlePlacesTextQuery(request)).toBe(
      "not touristy; give me something more niche attractions in the city in Sevilla",
    );
  });

  it("does not impose a GB region and supports live-location searches", () => {
    const body = googlePlacesSearchBody("ceramics studios", {
      center: { lat: 37.3891, lng: -5.9845 },
      radiusMetres: 8_000,
    });
    expect(body).not.toHaveProperty("regionCode");
    expect(body).toMatchObject({
      textQuery: "ceramics studios",
      locationBias: { circle: { center: { latitude: 37.3891, longitude: -5.9845 }, radius: 8_000 } },
    });
  });

  it("orders route stops deterministically and creates one Google route", () => {
    const origin = { lat: 37.39, lng: -5.99 };
    const points = [
      { id: "far", lat: 37.43, lng: -6.00 },
      { id: "near", lat: 37.391, lng: -5.989 },
      { id: "middle", lat: 37.40, lng: -5.98 },
    ];
    const ordered = orderTravelMapPoints(origin, points);
    expect(ordered.map((point) => point.id)).toEqual(["near", "middle", "far"]);
    const url = googleDirectionsUrl({ origin, stops: ordered, mode: "walking" });
    expect(url).toContain("https://www.google.com/maps/dir/?");
    expect(url).toContain("travelmode=walking");
    expect(url).toContain("waypoints=");
  });
});
