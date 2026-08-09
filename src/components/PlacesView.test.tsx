import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Briefing2View, CandlesView, PlacesView, WeatherView, WebResultsView } from "./Views";

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
