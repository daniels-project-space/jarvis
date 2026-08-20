import { createRoot } from "react-dom/client";
import { useMemo, useState } from "react";
import { cityScopedItineraryDays, itineraryMapMarkers, TripTimeline } from "../../src/components/TripView";
import "./trip-timeline.fixture.css";

// Static, local-only input deliberately contains two valid city days plus one
// discussion day with stops from both. The fixture uses the production city
// projection helpers, without loading MapLibre or a saved trip.
const cityContexts = [
  { id: "amsterdam", city: "Amsterdam", center: { lat: 52.3676, lng: 4.9041 } },
  { id: "berlin", city: "Berlin", center: { lat: 52.52, lng: 13.405 } },
];

const fixtureDays = [
  {
    date: "2026-09-12",
    label: "Amsterdam day",
    status: "draft",
    items: [
      { id: "ams-museum", cityContextId: "amsterdam", time: "10:00", title: "Amsterdam Museum", kind: "activity", lat: 52.36, lng: 4.9, source: "fixture" },
      { id: "ams-market", cityContextId: "amsterdam", time: "12:00", title: "Amsterdam Market", kind: "activity", lat: 52.37, lng: 4.91, source: "fixture" },
    ],
    route: {
      mode: "walking",
      status: "ready",
      coordinates: [[4.9, 52.36], [4.91, 52.37]] as [number, number][],
      durationSeconds: 900,
      distanceMeters: 1_100,
      attribution: "Fixture route",
    },
  },
  {
    date: "2026-09-13",
    label: "Berlin day",
    status: "draft",
    items: [
      { id: "ber-island", cityContextId: "berlin", time: "10:00", title: "Museum Island", kind: "activity", lat: 52.52, lng: 13.4, source: "fixture" },
      { id: "ber-park", cityContextId: "berlin", time: "13:00", title: "Tiergarten", kind: "activity", lat: 52.51, lng: 13.35, source: "fixture" },
    ],
    route: {
      mode: "walking",
      status: "ready",
      coordinates: [[13.4, 52.52], [13.35, 52.51]] as [number, number][],
      durationSeconds: 1_200,
      distanceMeters: 1_600,
      attribution: "Fixture route",
    },
  },
  {
    date: "2026-09-14",
    label: "Cross-city discussion",
    status: "draft",
    items: [
      { id: "ams-canal", cityContextId: "amsterdam", title: "Canal walk", kind: "activity", lat: 52.38, lng: 4.89, source: "fixture" },
      { id: "ber-gate", cityContextId: "berlin", title: "Brandenburg Gate", kind: "activity", lat: 52.5163, lng: 13.3777, source: "fixture" },
    ],
    route: {
      mode: "driving",
      status: "ready",
      coordinates: [[4.89, 52.38], [13.3777, 52.5163]] as [number, number][],
      durationSeconds: 22_000,
      distanceMeters: 650_000,
      attribution: "Fixture intercity route",
    },
  },
];

function TripCityItineraryScopeFixture() {
  const [activeCityId, setActiveCityId] = useState("amsterdam");
  const [activeDate, setActiveDate] = useState("2026-09-12");
  const activeCity = cityContexts.find((context) => context.id === activeCityId) ?? cityContexts[0];
  const cityDays = useMemo(
    () => cityScopedItineraryDays(fixtureDays, activeCity, cityContexts),
    [activeCity],
  );
  const visibleDate = cityDays.some((day) => day.date === activeDate) ? activeDate : cityDays[0]?.date ?? null;
  const activeDay = cityDays.find((day) => day.date === visibleDate) ?? cityDays[0];
  const markers = useMemo(() => itineraryMapMarkers(cityDays, { status: "planned" }), [cityDays]);

  const selectCity = (cityContextId: string) => {
    const nextContext = cityContexts.find((context) => context.id === cityContextId) ?? cityContexts[0];
    const nextDays = cityScopedItineraryDays(fixtureDays, nextContext, cityContexts);
    setActiveCityId(nextContext.id);
    setActiveDate(nextDays[0]?.date ?? "");
  };

  return (
    <main className="fixture-shell" aria-label="Fixture city-scoped itinerary">
      <div className="fixture-backdrop" aria-hidden />
      <section className="fixture-card" aria-label="Fixture-only city itinerary validation">
        <p className="fixture-eyebrow">Local fixture · production city projection</p>
        <h1>City-scoped itinerary and map stops</h1>
        <p className="fixture-copy">Switching the globe city retains valid same-city plans while hiding another city’s tiles, markers, and intercity geometry.</p>
        <label className="grid gap-1 text-[11px] text-slate">
          Active fixture city
          <select aria-label="Active fixture itinerary city" value={activeCity.id} onChange={(event) => selectCity(event.target.value)}>
            {cityContexts.map((context) => <option key={context.id} value={context.id}>{context.city}</option>)}
          </select>
        </label>

        <div className="mt-5">
          <TripTimeline days={cityDays} activeDate={visibleDate} onSelectDay={setActiveDate} />
        </div>

        <section className="fixture-controls" aria-label="City-scoped map projection">
          <h2>Map projection</h2>
          <output aria-label="Visible route geometry">
            {activeDay?.route?.coordinates?.length ? `${activeDay.route.coordinates.length} route geometry points` : "No city-scoped route geometry"}
          </output>
          <ul aria-label="Visible itinerary map markers" className="mt-3 grid gap-1 text-[12px] text-ice">
            {markers.map((marker) => <li key={marker.key}>Map marker: {marker.name}</li>)}
          </ul>
        </section>
      </section>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Trip city itinerary scope fixture root is missing.");

createRoot(root).render(<TripCityItineraryScopeFixture />);
