import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mock = vi.hoisted(() => ({
  searchOpenStreetMapPlaces: vi.fn(),
}));

vi.mock("./context", () => ({ convexMutation: vi.fn(), convexQuery: vi.fn() }));
vi.mock("./openstreetmap", () => ({ searchOpenStreetMapPlaces: mock.searchOpenStreetMapPlaces }));

import { placesActivities } from "./travel";

describe("trip activity discovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.searchOpenStreetMapPlaces.mockResolvedValue([
      {
        name: "Jarvis Test Museum",
        address: "1 Test Square, Lisbon, Portugal",
        lat: 38.72,
        lng: -9.14,
        dist: null,
        mapsUri: "https://www.openstreetmap.org/?mlat=38.72&mlon=-9.14",
      },
    ]);
  });

  it("uses keyless OpenStreetMap activity results without inventing ratings or photos", async () => {
    const activities = await placesActivities("Lisbon", "contemporary art", 4);

    expect(mock.searchOpenStreetMapPlaces).toHaveBeenCalledWith("attractions in Lisbon", { maxResults: 4 });
    expect(mock.searchOpenStreetMapPlaces).toHaveBeenCalledWith("contemporary art in Lisbon", { maxResults: 4 });
    expect(activities).toEqual([{
      name: "Jarvis Test Museum",
      address: "1 Test Square, Lisbon, Portugal",
      lat: 38.72,
      lng: -9.14,
      mapsLink: "https://www.openstreetmap.org/?mlat=38.72&mlon=-9.14",
    }]);
  });

});
