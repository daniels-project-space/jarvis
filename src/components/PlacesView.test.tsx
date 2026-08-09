import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PlacesView } from "./Views";

describe("PlacesView travel presentation", () => {
  it("labels the city centre, Gmail base, suggested connector and real route link honestly", () => {
    const value = JSON.stringify({
      kind: "places",
      query: "niche attractions",
      preferences: "local and non-touristy",
      locationLabel: "Sevilla",
      center: { lat: 37.3891, lng: -5.9845, label: "Sevilla", detail: "Sevilla, Spain", source: "google_places" },
      base: {
        lat: 37.386,
        lng: -5.9902,
        label: "Hotel Casa 1800 Sevilla",
        address: "Rodrigo Caro, 6, 41004 Sevilla, Spain",
        source: "Read-only Gmail booking",
      },
      route: {
        label: "Suggested walking order · straight map connector",
        note: "The line shows stop order, not street geometry; open Google directions for the navigable route.",
        mode: "walking",
        coordinates: [[-5.9902, 37.386], [-6.006, 37.3855]],
        googleMapsUrl: "https://www.google.com/maps/dir/?api=1&origin=37.386,-5.9902&destination=37.3855,-6.006&travelmode=walking",
      },
      items: [{
        name: "Centro Cerámica Triana",
        address: "Calle Callao, Sevilla",
        lat: 37.3855,
        lng: -6.006,
        dist: 1.5,
        mapsUri: "https://maps.google.com/?q=Centro+Ceramica+Triana",
      }],
    });

    const html = renderToStaticMarkup(<PlacesView value={value} />);
    expect(html).toContain("map centre");
    expect(html).toContain("Sevilla, Spain");
    expect(html).toContain("Read-only Gmail booking");
    expect(html).toContain("Hotel Casa 1800 Sevilla");
    expect(html).toContain("straight map connector");
    expect(html).toContain("not street geometry");
    expect(html).toContain("open navigable route");
    expect(html).toContain("Centro Cerámica Triana");
  });
});
