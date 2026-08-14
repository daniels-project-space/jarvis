import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Briefing2View, CandlesView, PlacesView, WeatherView, WebResultsView } from "./Views";

describe("PlacesView travel presentation", () => {
  it("labels the city centre, Gmail base, timed street route and source-backed entry price", () => {
    const value = JSON.stringify({
      kind: "places",
      query: "niche attractions",
      provider: "openstreetmap",
      preferences: "local and non-touristy",
      locationLabel: "Sevilla",
      center: { lat: 37.3891, lng: -5.9845, label: "Sevilla", detail: "Sevilla, Spain", source: "openstreetmap" },
      base: {
        lat: 37.386,
        lng: -5.9902,
        label: "Hotel Casa 1800 Sevilla",
        address: "Rodrigo Caro, 6, 41004 Sevilla, Spain",
        source: "Read-only Gmail booking",
      },
      route: {
        label: "Suggested walking route · street geometry",
        note: "Timed route follows public OpenStreetMap road/path data through the numbered stops in order.",
        mode: "walking",
        coordinates: [[-5.9902, 37.386], [-5.998, 37.3858], [-6.006, 37.3855]],
        distanceMeters: 1500,
        durationSeconds: 900,
        legs: [{ to: "Centro Cerámica Triana", distanceMeters: 1500, durationSeconds: 900 }],
        attribution: "Route data © OpenStreetMap contributors · FOSSGIS OSRM",
        directionsUrl: "https://www.openstreetmap.org/directions?engine=fossgis_osrm_foot&route=37.386%2C-5.9902%3B37.3855%2C-6.006",
      },
      items: [{
        name: "Centro Cerámica Triana",
        address: "Calle Callao, Sevilla",
        lat: 37.3855,
        lng: -6.006,
        dist: 1.5,
        charge: "6 EUR",
        mapsUri: "https://www.openstreetmap.org/?mlat=37.3855&mlon=-6.006",
      }],
    });

    const html = renderToStaticMarkup(<PlacesView value={value} />);
    expect(html).toContain("map centre");
    expect(html).toContain("Sevilla, Spain");
    expect(html).toContain("OpenStreetMap contributors");
    expect(html).toContain("Read-only Gmail booking");
    expect(html).toContain("Hotel Casa 1800 Sevilla");
    expect(html).toContain("street geometry");
    expect(html).toContain("15 min");
    expect(html).toContain("1.5 km");
    expect(html).toContain("FOSSGIS OSRM");
    expect(html).toContain("Entry (OpenStreetMap; verify): 6 EUR");
    expect(html).toContain("open multi-stop route");
    expect(html).toContain("Centro Cerámica Triana");
  });

  it("shows an explicit city-centre fallback when no Gmail stay was verified", () => {
    const html = renderToStaticMarkup(<PlacesView value={JSON.stringify({
      kind: "places",
      query: "niche places",
      locationLabel: "Sevilla",
      center: { lat: 37.3891, lng: -5.9845, label: "Sevilla", source: "current_state" },
      booking: {
        requested: true,
        status: "unavailable",
        message: "Gmail booking lookup is currently unavailable; the route starts from the map centre.",
      },
      route: { label: "Suggested walking order", mode: "walking", coordinates: [] },
      items: [{ name: "Casa de Pilatos", address: "Sevilla", lat: 37.39, lng: -5.988 }],
    })} />);

    expect(html).toContain("Gmail booking lookup is currently unavailable");
    expect(html).toContain("route starts from the map centre");
    expect(html).not.toContain("starting base");
  });

  it("renders a time-sensitive booked-city reference even when no route is requested", () => {
    const html = renderToStaticMarkup(<PlacesView value={JSON.stringify({
      kind: "places",
      query: "galleries",
      locationLabel: "Sevilla",
      center: { lat: 37.3891, lng: -5.9845, label: "Sevilla", source: "openstreetmap" },
      base: {
        lat: 37.386,
        lng: -5.9902,
        label: "Hotel Casa 1800 Sevilla",
        address: "Rodrigo Caro, 6, 41004 Sevilla, Spain",
        source: "Read-only Gmail booking",
        stayStatus: "upcoming",
        start: Date.UTC(2026, 7, 9, 13),
        end: Date.UTC(2026, 7, 12, 9),
        timeZone: "Europe/Madrid",
        checkedAt: Date.UTC(2026, 7, 1),
      },
      booking: { requested: true, status: "matched", stayStatus: "upcoming" },
      items: [{ name: "Casa de Pilatos", address: "Sevilla", lat: 37.39, lng: -5.988, dist: 0.7, mapsUri: "https://www.openstreetmap.org/" }],
    })} />);

    expect(html).toContain("booked stay · reference");
    expect(html).toContain("upcoming");
    expect(html).toContain("9 Aug 2026 – 12 Aug 2026");
    expect(html).toContain("Refreshed from connected Gmail for this map");
    expect(html).not.toContain("starting base");
  });

  it("attributes source-backed travel data even when a saved location sets the map centre", () => {
    const html = renderToStaticMarkup(<PlacesView value={JSON.stringify({
      kind: "places",
      query: "historic places",
      provider: "openstreetmap",
      locationLabel: "Sevilla",
      center: { lat: 37.3891, lng: -5.9845, label: "Live device location", source: "saved_location", capturedAt: Date.now() },
      items: [{
        name: "Real Alcázar de Sevilla",
        address: "Plaza del Triunfo, Sevilla",
        lat: 37.383,
        lng: -5.99,
        dist: 0.8,
        mapsUri: "https://www.openstreetmap.org/?mlat=37.383&mlon=-5.99",
        openingHours: "Oct-Mar: 09:30-17:00",
        websiteUrl: "https://www.alcazarsevilla.org/",
        wikipedia: {
          language: "es",
          title: "Real Alcázar de Sevilla",
          articleUrl: "https://es.wikipedia.org/wiki/Real_Alc%C3%A1zar_de_Sevilla",
        },
        wikipediaArticle: {
          title: "Real Alcázar de Sevilla",
          articleUrl: "https://es.wikipedia.org/wiki/Real_Alc%C3%A1zar_de_Sevilla",
          thumbnailUrl: "https://upload.wikimedia.org/example/alcazar.jpg",
          attribution: "Wikipedia (es) · image via Wikimedia",
        },
      }],
    })} />);

    expect(html).toContain("Place data © OpenStreetMap contributors");
    expect(html).toContain("live device location · expires automatically when stale");
    expect(html).toContain("Hours (OpenStreetMap): Oct-Mar: 09:30-17:00");
    expect(html).toContain("site (OSM) ↗");
    expect(html).toContain("Wikipedia ↗");
    expect(html).toContain("Wikipedia (es) · image via Wikimedia");
    expect(html).toContain("https://upload.wikimedia.org/example/alcazar.jpg");
    expect(html).toContain("https://es.wikipedia.org/wiki/Real_Alc%C3%A1zar_de_Sevilla");
    expect(html).toContain("Expand image for Real Alcázar de Sevilla");
  });
});

describe("restored live-data view contracts", () => {
  it("renders weather, search, briefing and market payloads as views rather than raw JSON", () => {
    const weather = renderToStaticMarkup(<WeatherView w={{
      place: "Sevilla, ES", lat: 37.3891, lng: -5.9845, icon: "☀️", temp: 31,
      desc: "clear sky", feels: 32, wind: 9, humidity: 31,
      hours: [{ h: "12:00", t: 31, icon: "☀️", rain: 0 }],
      days: [{ day: "Sun", icon: "☀️", max: 37, min: 21, rain: 0 }],
    }} />);
    expect(weather).toContain("Sevilla, ES");
    expect(weather).toContain("live map");
    expect(weather).toContain("the week");

    const search = renderToStaticMarkup(<WebResultsView value={JSON.stringify({
      query: "Sevilla niche architecture",
      answer: "Start with adaptive reuse and contemporary spaces.",
      items: [{
        title: "Seville Architecture City Guide", url: "https://example.com/sevilla",
        snippet: "Independent architecture guide", domain: "example.com",
        image: "https://example.com/shot.png", favicon: "https://example.com/favicon.ico",
      }],
    })} />);
    expect(search).toContain("Sevilla niche architecture");
    expect(search).toContain("Seville Architecture City Guide");

    const briefing = renderToStaticMarkup(<Briefing2View value={JSON.stringify({
      date: "Sunday 9 August", weather: { location: "Sevilla", icon: "☀️", temp: 31, desc: "clear", hours: [] },
      wealth: 123_456, rentals: [{ time: "15:00", kind: "pickup", name: "Sony FX3" }], awayCount: 1,
      todos: [{ text: "Confirm route", why: "due soon" }],
      calendar: [{ title: "Hotel check-in", when: "Sun 9 15:00" }],
      markets: [{ label: "Bitcoin", price: 65_000, change: 1.4, unit: "$", spark: [64_000, 65_000] }],
    })} />);
    expect(briefing).toContain("Sevilla");
    expect(briefing).toContain("Sony FX3");
    expect(briefing).toContain("Bitcoin");

    const candles = renderToStaticMarkup(<CandlesView w={{
      asset: "Bitcoin", interval: "1h", unit: "USDT", last: 65_000, changePct: 1.4,
      candles: [[1, 64_000, 65_200, 63_900, 65_000, 120], [2, 65_000, 65_500, 64_800, 65_300, 140]],
      sma20: [64_500, 64_700], sma50: [64_200, 64_300], sma200: [63_000, 63_100], rsi: [55, 58],
      levels: [{ price: 64_000, kind: "support", touches: 3 }],
    }} />);
    expect(candles).toContain("Bitcoin");
    expect(candles).toContain("1h · USDT");
    expect(candles).toContain("RSI");
  });
});
