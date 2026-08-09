import { beforeEach, describe, expect, it, vi } from "vitest";

import { openStreetMapDirectionsUrl, searchOpenStreetMapPlaces } from "./openstreetmap";

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

  it("creates a free walking route link", () => {
    const url = openStreetMapDirectionsUrl({
      origin: { lat: 51.5, lng: -0.14 },
      destination: { lat: 51.501, lng: -0.141 },
      mode: "walking",
    });
    expect(url).toContain("openstreetmap.org/directions");
    expect(url).toContain("fossgis_osrm_foot");
  });
});
