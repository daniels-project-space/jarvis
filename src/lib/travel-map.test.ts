import { describe, expect, it } from "vitest";

import {
  normalizeTravelMapRequest,
  orderTravelMapPoints,
  placeSearchTextQuery,
} from "./travel-map";
import { openStreetMapDirectionsUrl } from "./openstreetmap";

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
    expect(placeSearchTextQuery(request)).toBe(
      "not touristy; give me something more niche attractions in the city in Sevilla",
    );
  });

  it("keeps worldwide keyless multi-stop navigation", () => {
    const origin = { lat: 37.39, lng: -5.99 };
    const points = [
      { id: "far", lat: 37.43, lng: -6.00 },
      { id: "near", lat: 37.391, lng: -5.989 },
      { id: "middle", lat: 37.40, lng: -5.98 },
    ];
    const ordered = orderTravelMapPoints(origin, points);
    expect(ordered.map((point) => point.id)).toEqual(["near", "middle", "far"]);
    const routeUrl = openStreetMapDirectionsUrl({ origin, destination: ordered.at(-1)!, mode: "walking" });
    expect(routeUrl).toContain("https://www.openstreetmap.org/directions?");
    expect(routeUrl).toContain("fossgis_osrm_foot");
  });
});
