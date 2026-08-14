import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  enrichOpenStreetMapPlacesWithWikimedia,
  openStreetMapDirectionsUrl,
  routeOpenStreetMapItinerary,
  searchOpenStreetMapPlaces,
  type OpenStreetMapPlace,
} from "./openstreetmap";

describe("OpenStreetMap provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([
      {
        name: "Jarvis Test Cafe",
        display_name: "Jarvis Test Cafe, Test Street, London, England",
        lat: "51.501",
        lon: "-0.141",
        type: "cafe",
      },
    ]), { status: 200 })));
  });

  it("uses a bounded, attributed keyless lookup and caches repeated searches", async () => {
    const options = { center: { lat: 51.5, lng: -0.14 }, radiusMetres: 2_000, maxResults: 6 };
    const first = await searchOpenStreetMapPlaces("jarvis test cafe", options);
    const second = await searchOpenStreetMapPlaces("jarvis test cafe", options);

    expect(first).toEqual(second);
    expect(first[0]).toMatchObject({ name: "Jarvis Test Cafe", type: "cafe", dist: expect.any(Number) });
    expect(first[0]?.mapsUri).toContain("openstreetmap.org");
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    const search = new URL(String(url)).searchParams;
    expect(search.get("q")).toBe("jarvis test cafe");
    expect(search.get("bounded")).toBe("1");
    expect(search.get("limit")).toBe("6");
    expect(new Headers(init?.headers).get("user-agent")).toContain("Jarvis owner-operated assistant");
  });

  it("creates a free multi-stop walking route link and declines fake transit", () => {
    const url = openStreetMapDirectionsUrl({
      origin: { lat: 51.5, lng: -0.14 },
      waypoints: [{ lat: 51.5005, lng: -0.1405 }],
      destination: { lat: 51.501, lng: -0.141 },
      mode: "walking",
    });
    expect(url).toContain("openstreetmap.org/directions");
    expect(url).toContain("fossgis_osrm_foot");
    expect(url).toContain("51.5005");
    expect(openStreetMapDirectionsUrl({
      origin: { lat: 51.5, lng: -0.14 },
      destination: { lat: 51.501, lng: -0.141 },
      mode: "transit",
    })).toBeUndefined();
  });

  it("returns bounded street geometry and per-leg timing from the public router", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.hostname).toBe("routing.openstreetmap.de");
      expect(url.pathname).toContain("/routed-foot/route/v1/driving/");
      expect(url.searchParams.get("geometries")).toBe("geojson");
      expect(url.searchParams.get("overview")).toBe("full");
      return new Response(JSON.stringify({
        code: "Ok",
        routes: [{
          distance: 1240,
          duration: 860,
          geometry: { coordinates: [[-0.14, 51.5], [-0.1405, 51.5005], [-0.141, 51.501]] },
          legs: [
            { distance: 500, duration: 360 },
            { distance: 740, duration: 500 },
          ],
        }],
      }), { status: 200 });
    }));

    const route = await routeOpenStreetMapItinerary({
      mode: "walking",
      points: [
        { lat: 51.5, lng: -0.14 },
        { lat: 51.5005, lng: -0.1405 },
        { lat: 51.501, lng: -0.141 },
      ],
    });

    expect(route).toMatchObject({
      distanceMeters: 1240,
      durationSeconds: 860,
      coordinates: [[-0.14, 51.5], [-0.1405, 51.5005], [-0.141, 51.501]],
      legs: [{ distanceMeters: 500, durationSeconds: 360 }, { distanceMeters: 740, durationSeconds: 500 }],
      attribution: expect.stringContaining("FOSSGIS OSRM"),
    });
    expect(await routeOpenStreetMapItinerary({
      mode: "transit",
      points: [{ lat: 51.5, lng: -0.14 }, { lat: 51.501, lng: -0.141 }],
    })).toBeUndefined();
  });

  it("retains only bounded source-backed OSM tags", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([
      {
        name: "Tagged attraction",
        display_name: "Tagged attraction, Sevilla, Spain",
        lat: "37.383",
        lon: "-5.99",
        type: "attraction",
        extratags: {
          wikipedia: "es:Real Alcázar de Sevilla",
          opening_hours: "Oct-Mar: 09:30-17:00; Apr-Sep: 09:30-19:00",
          website: "https://www.alcazarsevilla.org/",
          charge: "18 EUR",
          phone: "+34 000 000 000",
        },
      },
    ]), { status: 200 })));

    const [place] = await searchOpenStreetMapPlaces("jarvis source tags 204", { maxResults: 1 });

    expect(place).toMatchObject({
      openingHours: "Oct-Mar: 09:30-17:00; Apr-Sep: 09:30-19:00",
      websiteUrl: "https://www.alcazarsevilla.org/",
      wikipedia: {
        language: "es",
        title: "Real Alcázar de Sevilla",
        articleUrl: "https://es.wikipedia.org/wiki/Real_Alc%C3%A1zar_de_Sevilla",
      },
    });
    expect(place).not.toHaveProperty("extratags");
    expect(place.charge).toBe("18 EUR");
    expect(place).not.toHaveProperty("phone");
  });

  it("enriches at most four exact Wikipedia tags and caches the public results", async () => {
    const places: OpenStreetMapPlace[] = Array.from({ length: 5 }, (_, index) => ({
      name: `Exact source ${index + 1}`,
      address: "Sevilla, Spain",
      lat: 37.38 + index / 1000,
      lng: -5.99,
      dist: null,
      mapsUri: "https://www.openstreetmap.org/",
      wikipedia: {
        language: "es",
        title: `Jarvis Exact Source ${index + 1}`,
        articleUrl: `https://es.wikipedia.org/wiki/Jarvis_Exact_Source_${index + 1}`,
      },
    }));
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.hostname).toBe("es.wikipedia.org");
      expect(url.pathname).toBe("/w/api.php");
      expect(url.searchParams.get("action")).toBe("query");
      expect(url.searchParams.get("list")).toBeNull();
      expect(url.searchParams.get("generator")).toBeNull();
      const title = url.searchParams.get("titles")!;
      return new Response(JSON.stringify({
        query: {
          pages: [{
            title,
            fullurl: `https://es.wikipedia.org/wiki/${encodeURIComponent(title.replaceAll(" ", "_"))}`,
            thumbnail: { source: `https://upload.wikimedia.org/jarvis/${encodeURIComponent(title)}.jpg` },
          }],
        },
      }), { status: 200 });
    }));

    const enriched = await enrichOpenStreetMapPlacesWithWikimedia(places);
    await enrichOpenStreetMapPlacesWithWikimedia(places.slice(0, 4));

    const titles = vi.mocked(fetch).mock.calls.map(([url]) => new URL(String(url)).searchParams.get("titles"));
    expect(titles).toEqual([
      "Jarvis Exact Source 1",
      "Jarvis Exact Source 2",
      "Jarvis Exact Source 3",
      "Jarvis Exact Source 4",
    ]);
    expect(enriched[0]?.wikipediaArticle).toMatchObject({
      articleUrl: "https://es.wikipedia.org/wiki/Jarvis_Exact_Source_1",
      thumbnailUrl: "https://upload.wikimedia.org/jarvis/Jarvis%20Exact%20Source%201.jpg",
      attribution: "Wikipedia (es) · image via Wikimedia",
    });
    expect(enriched[4]?.wikipediaArticle).toBeUndefined();
  });

  it("never searches Wikimedia from a place name without an exact OSM Wikipedia tag", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([
      {
        name: "Seville Cathedral",
        display_name: "Seville Cathedral, Sevilla, Spain",
        lat: "37.3858",
        lon: "-5.9930",
        type: "attraction",
        extratags: { wikipedia: "Seville Cathedral" },
      },
    ]), { status: 200 })));

    const places = await searchOpenStreetMapPlaces("jarvis no fuzzy fallback 204", { maxResults: 1 });
    const enriched = await enrichOpenStreetMapPlacesWithWikimedia(places);

    expect(enriched[0]?.wikipedia).toBeUndefined();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect(new URL(String(vi.mocked(fetch).mock.calls[0]?.[0])).hostname).toBe("nominatim.openstreetmap.org");
  });
});
