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
      id: "osm:jarvis-test-museum:38.72000:-9.14000",
      name: "Jarvis Test Museum",
      address: "1 Test Square, Lisbon, Portugal",
      lat: 38.72,
      lng: -9.14,
      mapsLink: "https://www.openstreetmap.org/?mlat=38.72&mlon=-9.14",
      city: "Lisbon",
      source: "OpenStreetMap",
    }]);
  });

  it("keeps source-backed venue details and Wikimedia attribution with the activity", async () => {
    mock.searchOpenStreetMapPlaces.mockResolvedValueOnce([
      {
        name: "Museu Nacional do Azulejo",
        address: "Rua da Madre de Deus, Lisbon, Portugal",
        lat: 38.725,
        lng: -9.113,
        dist: null,
        mapsUri: "https://www.openstreetmap.org/?mlat=38.725&mlon=-9.113",
        openingHours: "Tu-Su 10:00-18:00",
        charge: "€10",
        websiteUrl: "https://www.museudoazulejo.gov.pt/",
        wikipedia: {
          language: "en",
          title: "National Tile Museum",
          articleUrl: "https://en.wikipedia.org/wiki/National_Tile_Museum",
        },
        wikipediaArticle: {
          title: "National Tile Museum",
          articleUrl: "https://en.wikipedia.org/wiki/National_Tile_Museum",
          thumbnailUrl: "https://upload.wikimedia.org/example.jpg",
          attribution: "Wikimedia Commons",
        },
      },
    ]);

    const [activity] = await placesActivities("Lisbon", undefined, 1);

    expect(activity).toMatchObject({
      name: "Museu Nacional do Azulejo",
      openingHours: "Tu-Su 10:00-18:00",
      charge: "€10",
      websiteUrl: "https://www.museudoazulejo.gov.pt/",
      wikipedia: {
        language: "en",
        title: "National Tile Museum",
        articleUrl: "https://en.wikipedia.org/wiki/National_Tile_Museum",
      },
      wikipediaArticle: {
        title: "National Tile Museum",
        articleUrl: "https://en.wikipedia.org/wiki/National_Tile_Museum",
        thumbnailUrl: "https://upload.wikimedia.org/example.jpg",
        attribution: "Wikimedia Commons",
      },
      photo: "https://upload.wikimedia.org/example.jpg",
    });
    expect(activity).not.toHaveProperty("rating");
    expect(activity).not.toHaveProperty("ratings");
  });

});
