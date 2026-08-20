import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const tripViewFixture = vi.hoisted(() => ({ doc: null as unknown }));

vi.mock("../../convex/_generated/api", () => ({
  api: {
    creations: { get: { _name: "creations:get" } },
    travelDrafts: { get: { _name: "travelDrafts:get" } },
  },
}));

vi.mock("@/lib/secure-convex", () => ({
  useJarvisQuery: (_query: unknown, args: unknown) =>
    args === "skip" || !tripViewFixture.doc ? undefined : { data: JSON.stringify(tripViewFixture.doc) },
}));

import TripView, { bookedStayMapMarker, cityScopedItineraryDays, isFreshTripBookedStayReference, itineraryMapMarkers, mergeTripMapMarker, TripBookedStayReference, TripDayControls, TripOfflineMapPreflight, TripTimeline } from "./TripView";

describe("TripTimeline", () => {
  it("keeps a time-valid Gmail stay visibly distinct from a hotel candidate", () => {
    const now = Date.UTC(2026, 8, 12, 12, 0);
    const markup = renderToStaticMarkup(
      <TripBookedStayReference
        now={now}
        checkedAt={now - 60_000}
        booking={{
          bookingName: "Canal House",
          location: "42 Water Street, Amsterdam, Netherlands",
          start: now - 3_600_000,
          end: now + 86_400_000,
          timeZone: "Europe/Amsterdam",
        }}
      />,
    );

    expect(markup).toContain("booked location · active");
    expect(markup).toContain("Canal House");
    expect(markup).toContain("42 Water Street, Amsterdam, Netherlands");
    expect(markup).toContain("Read-only Gmail");
  });

  it("hides an expired booked-location reference instead of relabelling it as upcoming", () => {
    const now = Date.UTC(2026, 8, 12, 12, 0);
    const markup = renderToStaticMarkup(
      <TripBookedStayReference
        now={now}
        booking={{
          city: "Amsterdam",
          bookingName: "Old Canal House",
          location: "42 Water Street, Amsterdam, Netherlands",
          start: now - 172_800_000,
          end: now - 86_400_000,
          verifiedAt: now - 60_000,
        }}
      />,
    );

    expect(markup).toBe("");
  });

  it("keeps discovery and map references scoped to a fresh matching city", () => {
    const now = Date.UTC(2026, 8, 12, 12, 0);
    const booking = {
      city: "Amsterdam",
      location: "42 Water Street, Amsterdam, Netherlands",
      start: now - 3_600_000,
      end: now + 86_400_000,
      verifiedAt: now - 60_000,
    };

    expect(isFreshTripBookedStayReference(booking, "Amsterdam", now)).toBe(true);
    expect(isFreshTripBookedStayReference(booking, "Rotterdam", now)).toBe(false);
    expect(isFreshTripBookedStayReference({ ...booking, verifiedAt: now - 24 * 60 * 60_000 - 1 }, "Amsterdam", now)).toBe(false);
  });

  it("pins a canonical city booking even when the legacy booking projection is absent", () => {
    const now = Date.UTC(2026, 8, 12, 12, 0);
    const context = { id: "amsterdam", city: "Amsterdam" };
    const booking = {
      bookingName: "Canal House",
      location: "42 Water Street, Amsterdam, Netherlands",
      start: now - 3_600_000,
      end: now + 86_400_000,
      lat: 52.369,
      lng: 4.9,
      verifiedAt: now - 60_000,
    };

    expect(bookedStayMapMarker(booking, context, now)).toMatchObject({
      key: `booking:amsterdam:${booking.start}`,
      name: "Booked location · Amsterdam",
      kind: "stay",
      lat: 52.369,
      lng: 4.9,
      locked: true,
    });
    expect(bookedStayMapMarker({ ...booking, cityContextId: "berlin" }, context, now)).toBeNull();
  });

  it("keeps a verified booked pin visible when it shares coordinates with a suggested stay", () => {
    const bookingPin = {
      key: "booking:amsterdam:1789200000000",
      lat: 52.369,
      lng: 4.9,
      kind: "stay" as const,
      name: "Booked location · Amsterdam",
      locked: true,
    };
    const markers = mergeTripMapMarker([
      {
        key: "stay:suggested-canal-house",
        lat: 52.369,
        lng: 4.9,
        kind: "stay",
        name: "Suggested Canal House",
      },
    ], bookingPin);

    expect(markers).toEqual([bookingPin]);
  });

  it("renders persisted stop and transfer timing without drawing a made-up connection", () => {
    const markup = renderToStaticMarkup(
      <TripTimeline
        activeDate="2026-09-12"
        onSelectDay={vi.fn()}
        days={[
          {
            date: "2026-09-12",
            label: "Fri 12 Sep",
            items: [
              { id: "museum", time: "10:00", durationMinutes: 90, title: "City Museum", kind: "activity" },
              { id: "market", time: "12:00", durationMinutes: 45, title: "Riverside Market", kind: "activity", source: "saved" },
            ],
            route: {
              mode: "walking",
              status: "ready",
              coordinates: [[-0.12, 51.5], [-0.11, 51.51]],
              durationSeconds: 1_500,
              distanceMeters: 1_800,
              legs: [{ fromItemId: "museum", toItemId: "market", durationSeconds: 720, distanceMeters: 700 }],
              attribution: "OpenStreetMap / OSRM",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("City Museum");
    expect(markup).toContain("allow 1h 30m");
    expect(markup).toContain("walk · 12 min · 700 m");
    expect(markup).toContain("25 min");
    expect(markup).toContain("1.8 km");
    expect(markup).toContain("OpenStreetMap / OSRM");
  });

  it("shows an unavailable route honestly and omits transfer timing that was never returned", () => {
    const markup = renderToStaticMarkup(
      <TripTimeline
        activeDate="2026-09-12"
        onSelectDay={vi.fn()}
        days={[
          {
            date: "2026-09-12",
            label: "Fri 12 Sep",
            items: [{ id: "park", title: "Hill Park", kind: "activity" }],
            route: { mode: "walking", status: "unavailable" },
          },
        ]}
      />,
    );

    expect(markup).toContain("route unavailable");
    expect(markup).toContain("Hill Park");
    expect(markup).toContain("time tbd");
    expect(markup).not.toContain("↓");
    expect(markup).not.toContain("allow ");
  });

  it("offers date, time, order, transport, and explicit lock controls without calendar mutation UI", () => {
    const markup = renderToStaticMarkup(
      <TripDayControls
        busy={false}
        day={{
          date: "2026-09-12",
          label: "Fri 12 Sep",
          items: [{ id: "museum", placeId: "City Museum", time: "10:00", title: "City Museum", kind: "activity" }],
          route: { mode: "walking", status: "ready" },
        }}
        availableActivities={[{ name: "City Museum" }, { name: "Riverside Market" }]}
        onLock={vi.fn()}
        onSave={vi.fn()}
        onSelectDay={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-label="Plan date"');
    expect(markup).toContain('aria-label="Time for City Museum"');
    expect(markup).toContain('aria-label="Transport mode"');
    expect(markup).toContain("save route &amp; times");
    expect(markup).toContain("lock day");
    expect(markup).toContain("Calendar remains separate and requires protected approval.");
  });

  it("renders a saved Apple Maps handoff without pretending it downloaded or deleted a map", () => {
    const markup = renderToStaticMarkup(
      <TripOfflineMapPreflight preflight={{
        city: "Seville",
        at: Date.parse("2026-09-02T09:15:00+02:00"),
        timeZone: "Europe/Madrid",
        mapUrl: "https://maps.apple.com/search?query=Seville",
        todoStatus: "existing",
        reminderStatus: "scheduled",
        calendarStatus: "needs_connection",
        refreshState: "scheduled",
      }} />,
    );

    expect(markup).toContain('aria-label="Apple Maps offline preflight"');
    expect(markup).toContain('href="https://maps.apple.com/search?query=Seville"');
    expect(markup).toContain("Matching Hub to-do is already saved.");
    expect(markup).toContain("Connect Google Calendar");
    expect(markup).toContain("Gmail itinerary refresh is active for this exact saved trip.");
    expect(markup).toContain("Download and deletion remain in Maps");
  });
});

describe("TripView city contexts", () => {
  const now = Date.UTC(2026, 8, 12, 12, 0);
  const renderTrip = () => renderToStaticMarkup(
    <TripView value={JSON.stringify({ creationId: "city-context-trip" })} initialBookingNow={now} />,
  );
  const tripWithActiveCity = (activeCityContextId: "amsterdam" | "berlin") => ({
    destination: "Amsterdam",
    center: { lat: 52.3676, lng: 4.9041 },
    adults: 2,
    budgetGbp: 1200,
    departDate: "2026-09-12",
    returnDate: "2026-09-15",
    cityContexts: [
      {
        id: "amsterdam",
        city: "Amsterdam",
        center: { lat: 52.3676, lng: 4.9041 },
        source: "trip destination",
        createdAt: now - 86_400_000,
        updatedAt: now - 60_000,
        bookingReference: {
          bookingName: "Amsterdam Canal House",
          location: "42 Water Street, Amsterdam",
          start: now - 3_600_000,
          end: now + 86_400_000,
          verifiedAt: now - 60_000,
        },
        bookingCheckedAt: now - 60_000,
      },
      {
        id: "berlin",
        city: "Berlin",
        center: { lat: 52.52, lng: 13.405 },
        source: "saved exploration",
        createdAt: now - 43_200_000,
        updatedAt: now - 30_000,
        bookingReference: {
          bookingName: "Berlin Courtyard Stay",
          location: "8 Museum Lane, Berlin",
          start: now - 3_600_000,
          end: now + 86_400_000,
          verifiedAt: now - 30_000,
        },
        bookingCheckedAt: now - 30_000,
      },
    ],
    activeCityContextId,
    stays: [
      { id: "canal-house", cityContextId: "amsterdam", city: "Amsterdam", name: "Amsterdam Canal Stay", priceGbp: 180, totalGbp: 540, rating: 4.7, amenities: [] },
      { id: "courtyard", cityContextId: "berlin", city: "Berlin", name: "Berlin Courtyard Stay", priceGbp: 160, totalGbp: 480, rating: 4.8, amenities: [] },
    ],
    discoveries: [
      { id: "ams-discovery", cityContextId: "amsterdam", city: "Amsterdam", query: "canals", center: { lat: 52.37, lng: 4.9 }, items: [] },
      { id: "ber-discovery", cityContextId: "berlin", city: "Berlin", query: "museums", center: { lat: 52.52, lng: 13.4 }, items: [] },
    ],
    activities: [],
    flights: [],
    providers: {},
  });

  it("restores the persisted active city and scopes its booked overlay and stay cards", () => {
    tripViewFixture.doc = tripWithActiveCity("berlin");
    const markup = renderTrip();

    expect(markup).toContain('aria-label="Active city"');
    expect(markup).toContain('aria-label="Follow my location"');
    expect(markup).toContain("follow location");
    expect(markup).toMatch(/<option value="berlin" selected="">Berlin<\/option>/);
    expect(markup).toContain("centre 52.520, 13.405");
    expect(markup).toContain("Berlin Courtyard Stay");
    expect(markup).toContain("Berlin Courtyard Stay</div>");
    expect(markup).not.toContain("Amsterdam Canal Stay</span>");
    expect(markup).not.toContain("Amsterdam Canal House");
  });

  it("restores a later persisted city selection without leaking the prior city’s booking or stays", () => {
    tripViewFixture.doc = tripWithActiveCity("amsterdam");
    const markup = renderTrip();

    expect(markup).toMatch(/<option value="amsterdam" selected="">Amsterdam<\/option>/);
    expect(markup).toContain("centre 52.368, 4.904");
    expect(markup).toContain("Amsterdam Canal House");
    expect(markup).toContain("Amsterdam Canal Stay");
    expect(markup).not.toContain("Berlin Courtyard Stay</span>");
    expect(markup).not.toContain("Berlin Courtyard Stay</div>");
  });

  it("keeps each active city’s itinerary tiles, geometry, and map markers isolated", () => {
    const contexts = [
      { id: "amsterdam", city: "Amsterdam", center: { lat: 52.3676, lng: 4.9041 } },
      { id: "berlin", city: "Berlin", center: { lat: 52.52, lng: 13.405 } },
    ];
    const days = [
      {
        date: "2026-09-12",
        label: "Amsterdam day",
        items: [
          { id: "ams-museum", cityContextId: "amsterdam", time: "10:00", title: "Amsterdam Museum", kind: "activity", lat: 52.36, lng: 4.9 },
          { id: "ams-market", cityContextId: "amsterdam", time: "12:00", title: "Amsterdam Market", kind: "activity", lat: 52.37, lng: 4.91 },
        ],
        route: { mode: "walking", status: "ready", coordinates: [[4.9, 52.36], [4.91, 52.37]], durationSeconds: 900, distanceMeters: 1_100 },
      },
      {
        date: "2026-09-13",
        label: "Berlin day",
        items: [
          { id: "ber-island", cityContextId: "berlin", time: "10:00", title: "Museum Island", kind: "activity", lat: 52.52, lng: 13.4 },
          { id: "ber-park", cityContextId: "berlin", time: "13:00", title: "Tiergarten", kind: "activity", lat: 52.51, lng: 13.35 },
        ],
        route: { mode: "walking", status: "ready", coordinates: [[13.4, 52.52], [13.35, 52.51]], durationSeconds: 1_200, distanceMeters: 1_600 },
      },
      {
        date: "2026-09-14",
        label: "Cross-city discussion",
        items: [
          { id: "ams-canal", cityContextId: "amsterdam", title: "Canal walk", kind: "activity", lat: 52.38, lng: 4.89 },
          { id: "ber-gate", cityContextId: "berlin", title: "Brandenburg Gate", kind: "activity", lat: 52.5163, lng: 13.3777 },
        ],
        route: { mode: "driving", status: "ready", coordinates: [[4.89, 52.38], [13.3777, 52.5163]], durationSeconds: 22_000, distanceMeters: 650_000 },
      },
    ];

    const amsterdamDays = cityScopedItineraryDays(days, contexts[0], contexts);
    expect(amsterdamDays.map((day) => day.date)).toEqual(["2026-09-12", "2026-09-14"]);
    expect(amsterdamDays[0].route?.coordinates).toEqual([[4.9, 52.36], [4.91, 52.37]]);
    expect(amsterdamDays[1].items.map((item) => item.title)).toEqual(["Canal walk"]);
    expect(amsterdamDays[1].route).toBeUndefined();
    expect(itineraryMapMarkers(amsterdamDays, { status: "planned" }).map((marker) => marker.name)).toEqual([
      "Amsterdam Museum",
      "Amsterdam Market",
      "Canal walk",
    ]);

    const berlinDays = cityScopedItineraryDays(days, contexts[1], contexts);
    expect(berlinDays.map((day) => day.date)).toEqual(["2026-09-13", "2026-09-14"]);
    expect(berlinDays[0].route?.coordinates).toEqual([[13.4, 52.52], [13.35, 52.51]]);
    expect(berlinDays[1].items.map((item) => item.title)).toEqual(["Brandenburg Gate"]);
    expect(berlinDays[1].route).toBeUndefined();
    expect(itineraryMapMarkers(berlinDays, { status: "planned" }).map((marker) => marker.name)).toEqual([
      "Museum Island",
      "Tiergarten",
      "Brandenburg Gate",
    ]);
  });

  it("keeps legacy destination-only documents usable as their single active city", () => {
    tripViewFixture.doc = {
      destination: "Lisbon",
      center: { lat: 38.7223, lng: -9.1393 },
      adults: 1,
      budgetGbp: 800,
      stays: [{ id: "legacy-stay", name: "Legacy Lisbon Stay", priceGbp: 110, totalGbp: 330, rating: 4.5, amenities: [] }],
      bookingReferences: [{ city: "Lisbon", bookingName: "Legacy Lisbon Booking", location: "1 Tram Street", start: now - 3_600_000, end: now + 86_400_000, verifiedAt: now - 60_000 }],
      activities: [],
      flights: [],
      providers: {},
    };
    const markup = renderTrip();

    expect(markup).toMatch(/<option value="legacy-trip-city" selected="">Lisbon<\/option>/);
    expect(markup).toContain("Legacy Lisbon Stay");
    expect(markup).toContain("Legacy Lisbon Booking");
  });
});
