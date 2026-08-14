import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mock = vi.hoisted(() => ({
  convexMutation: vi.fn(),
  convexQuery: vi.fn(),
  routeOpenStreetMapItinerary: vi.fn(),
  openStreetMapDirectionsUrl: vi.fn(),
  searchOpenStreetMapPlaces: vi.fn(),
  enrichOpenStreetMapPlacesWithWikimedia: vi.fn(),
  openStreetMapDistanceKm: vi.fn(),
  lookupGmailBookingsReadOnly: vi.fn(),
}));

vi.mock("./context", () => ({ convexMutation: mock.convexMutation, convexQuery: mock.convexQuery }));
vi.mock("./booking-email", () => ({ lookupGmailBookingsReadOnly: mock.lookupGmailBookingsReadOnly }));
vi.mock("./openstreetmap", () => ({
  routeOpenStreetMapItinerary: mock.routeOpenStreetMapItinerary,
  openStreetMapDirectionsUrl: mock.openStreetMapDirectionsUrl,
  searchOpenStreetMapPlaces: mock.searchOpenStreetMapPlaces,
  enrichOpenStreetMapPlacesWithWikimedia: mock.enrichOpenStreetMapPlacesWithWikimedia,
  openStreetMapDistanceKm: mock.openStreetMapDistanceKm,
}));

import { addTripPlaceToDay, bookingsForTripWindow, buildItinerary, discoverTripPlaces, scheduleTripDay, type TripDoc } from "./travel";

function trip(): TripDoc {
  return {
    kind: "trip",
    title: "Lisbon · Sep",
    destination: "Lisbon",
    destIata: "LIS",
    origin: "LHR",
    departDate: "2026-09-01",
    returnDate: "2026-09-04",
    adults: 2,
    budgetGbp: 1200,
    status: "scouting",
    center: { lat: 38.72, lng: -9.14 },
    flights: [],
    stays: [],
    activities: [
      { name: "Tile Museum", lat: 38.716, lng: -9.13, mapsLink: "https://www.openstreetmap.org/node/1" },
      { name: "Riverside Market", lat: 38.709, lng: -9.137, mapsLink: "https://www.openstreetmap.org/node/2" },
    ],
    locked: {
      stay: { name: "Hotel Tejo", lat: 38.714, lng: -9.142, link: "https://example.com/stay" },
      activities: ["Tile Museum", "Riverside Market"],
    },
  };
}

describe("durable trip day scheduling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.convexMutation.mockImplementation(async (name: string) => name === "creations:updateTripItinerary" ? { ok: true } : name === "creations:create" ? "canvas-1" : undefined);
    mock.openStreetMapDirectionsUrl.mockReturnValue("https://www.openstreetmap.org/directions?route=test");
    mock.enrichOpenStreetMapPlacesWithWikimedia.mockImplementation(async (places) => places);
    mock.openStreetMapDistanceKm.mockReturnValue(0.8);
    mock.lookupGmailBookingsReadOnly.mockResolvedValue([]);
    mock.routeOpenStreetMapItinerary.mockResolvedValue({
      coordinates: [[-9.142, 38.714], [-9.13, 38.716], [-9.137, 38.709]],
      durationSeconds: 1_260,
      distanceMeters: 1_800,
      legs: [
        { durationSeconds: 480, distanceMeters: 620 },
        { durationSeconds: 780, distanceMeters: 1_180 },
      ],
      attribution: "Route data © OpenStreetMap contributors · FOSSGIS OSRM",
    });
  });

  it("keeps only Gmail confirmations that overlap the exact trip window", () => {
    const matches = bookingsForTripWindow([
      { id: "overlap", kind: "stay", title: "Overlapping stay", provider: "Mail", start: Date.parse("2026-08-31T20:00:00Z"), end: Date.parse("2026-09-01T10:00:00Z"), allDay: false, location: "Lisbon", marker: "overlap" },
      { id: "inside", kind: "stay", title: "Inside stay", provider: "Mail", start: Date.parse("2026-09-02T14:00:00Z"), end: Date.parse("2026-09-03T11:00:00Z"), allDay: false, location: "Lisbon", marker: "inside" },
      { id: "outside", kind: "stay", title: "Other city week", provider: "Mail", start: Date.parse("2026-09-06T14:00:00Z"), end: Date.parse("2026-09-07T11:00:00Z"), allDay: false, location: "Porto", marker: "outside" },
    ], "2026-09-01", "2026-09-04");

    expect(matches.map((booking) => booking.marker)).toEqual(["overlap", "inside"]);
  });

  it("uses each Gmail booking's own time zone and preserves an owner-locked day", () => {
    const doc = trip();
    doc.itinerary = [{
      date: "2026-09-01",
      label: "Tue 1 Sep",
      status: "locked",
      items: [{
        id: "owner-dinner",
        date: "2026-09-01",
        time: "20:00",
        title: "Owner dinner",
        kind: "booking",
        source: "owner",
        locked: true,
      }],
    }];
    doc.confirmedBookings = [{
      id: "mail-1",
      kind: "reservation",
      title: "West-coast reservation",
      provider: "Test",
      start: Date.parse("2026-09-02T00:30:00Z"),
      allDay: false,
      timeZone: "America/Los_Angeles",
      marker: "mail-1",
    }];

    const firstDay = buildItinerary(doc).find((day) => day.date === "2026-09-01");
    expect(firstDay?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "owner-dinner", time: "20:00", source: "owner" }),
      expect.objectContaining({ id: "gmail:mail-1", time: "17:30", source: "gmail", locked: true }),
    ]));
  });

  it("persists real OSRM route geometry and per-stop legs atomically", async () => {
    const updated = await scheduleTripDay({
      id: "trip-1",
      doc: trip(),
      date: "2026-09-02",
      activityNames: ["Tile Museum", "Riverside Market"],
      times: ["10:00", "13:00"],
      mode: "walking",
    });

    const day = updated.itinerary?.find((candidate) => candidate.date === "2026-09-02");
    expect(mock.routeOpenStreetMapItinerary).toHaveBeenCalledWith(expect.objectContaining({ mode: "walking" }));
    expect(day?.route).toMatchObject({
      status: "ready",
      mode: "walking",
      durationSeconds: 1_260,
      distanceMeters: 1_800,
      legs: [
        expect.objectContaining({ toItemId: expect.stringContaining("tile-museum"), durationSeconds: 480 }),
        expect.objectContaining({ toItemId: expect.stringContaining("riverside-market"), durationSeconds: 780 }),
      ],
    });
    expect(mock.convexMutation).toHaveBeenCalledWith("creations:updateTripItinerary", expect.objectContaining({
      id: "trip-1",
      planRevision: 1,
      itinerary: expect.stringContaining("Route data © OpenStreetMap contributors"),
    }));
  });

  it("leaves transit visibly unavailable instead of substituting a driving estimate", async () => {
    const updated = await scheduleTripDay({
      id: "trip-1",
      doc: trip(),
      date: "2026-09-02",
      activityNames: ["Tile Museum", "Riverside Market"],
      mode: "transit",
    });

    expect(mock.routeOpenStreetMapItinerary).not.toHaveBeenCalled();
    expect(updated.itinerary?.find((day) => day.date === "2026-09-02")?.route).toMatchObject({
      mode: "transit",
      status: "unavailable",
    });
  });

  it("adds a newly discovered mapped place to a day without requiring it in the original scout list", async () => {
    const updated = await addTripPlaceToDay({
      id: "trip-1",
      doc: trip(),
      date: "2026-09-02",
      time: "16:15",
      mode: "walking",
      place: {
        name: "Neighbourhood Gallery",
        lat: 38.713,
        lng: -9.128,
        link: "https://www.openstreetmap.org/node/3",
        note: "OpenStreetMap · Alfama",
      },
    });

    const day = updated.itinerary?.find((candidate) => candidate.date === "2026-09-02");
    expect(day?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "Neighbourhood Gallery", time: "16:15", source: "owner" }),
    ]));
    expect(day?.route).toMatchObject({ status: "ready", mode: "walking" });
  });

  it("keeps an exact cross-town discovery selectable after the day is saved", async () => {
    const doc = trip();
    doc.activities.push({
      id: "discovery:granada:alhambra",
      name: "Alhambra",
      lat: 37.1761,
      lng: -3.5881,
      mapsLink: "https://www.openstreetmap.org/node/4",
      city: "Granada",
    });
    const updated = await addTripPlaceToDay({
      id: "trip-1",
      doc,
      date: "2026-09-02",
      mode: "walking",
      place: { id: "discovery:granada:alhambra", name: "Alhambra", lat: 37.1761, lng: -3.5881 },
    });

    const rescheduled = await scheduleTripDay({
      id: "trip-1",
      doc: updated,
      date: "2026-09-02",
      activityNames: ["discovery:granada:alhambra", "Tile Museum"],
      times: ["09:30", "13:00"],
      mode: "walking",
    });
    const day = rescheduled.itinerary?.find((entry) => entry.date === "2026-09-02");
    expect(day?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "Alhambra", placeId: "discovery:granada:alhambra", time: "09:30" }),
      expect.objectContaining({ title: "Tile Museum" }),
    ]));
  });

  it("anchors a selected city's day at its verified Gmail stay, never an unrelated locked hotel", async () => {
    const doc = trip();
    const verifiedAt = Date.now();
    const departDate = new Date(verifiedAt + 7 * 86_400_000).toISOString().slice(0, 10);
    const routeDate = new Date(verifiedAt + 8 * 86_400_000).toISOString().slice(0, 10);
    const returnDate = new Date(verifiedAt + 10 * 86_400_000).toISOString().slice(0, 10);
    const lisbonId = "city:lisbon:38.720:-9.140";
    const granadaId = "city:granada:37.177:-3.599";
    doc.departDate = departDate;
    doc.returnDate = returnDate;
    doc.destinationCenter = { lat: 38.72, lng: -9.14 };
    doc.cityContexts = [
      { id: lisbonId, city: "Lisbon", center: { lat: 38.72, lng: -9.14 }, source: "destination", createdAt: verifiedAt, updatedAt: verifiedAt },
      {
        id: granadaId,
        city: "Granada",
        center: { lat: 37.1773, lng: -3.5986 },
        source: "explore",
        createdAt: verifiedAt,
        updatedAt: verifiedAt,
        bookingReference: {
          cityContextId: granadaId,
          city: "Granada",
          title: "Hotel Albaicín confirmation",
          location: "Calle Gran Vía 1, Granada",
          lat: 37.1761,
          lng: -3.5892,
          start: Date.parse(`${departDate}T14:00:00Z`),
          end: Date.parse(`${returnDate}T11:00:00Z`),
          distanceKm: 0.8,
          state: "upcoming",
          verifiedAt,
        },
      },
    ];
    doc.activeCityContextId = granadaId;
    doc.locked.stay = { ...doc.locked.stay!, city: "Lisbon", cityContextId: lisbonId };
    doc.activities = [{
      id: "granada-alhambra",
      name: "Alhambra",
      lat: 37.176,
      lng: -3.5881,
      mapsLink: "https://www.openstreetmap.org/node/alhambra",
      city: "Granada",
      cityContextId: granadaId,
    }];
    doc.locked.activities = ["granada-alhambra"];
    mock.routeOpenStreetMapItinerary.mockResolvedValueOnce({
      coordinates: [[-3.5892, 37.1761], [-3.5881, 37.176]],
      durationSeconds: 540,
      distanceMeters: 620,
      legs: [{ durationSeconds: 540, distanceMeters: 620 }],
      attribution: "Route data © OpenStreetMap contributors · FOSSGIS OSRM",
    });

    const updated = await scheduleTripDay({
      id: "trip-1",
      doc,
      date: routeDate,
      activityNames: ["granada-alhambra"],
      mode: "walking",
    });

    expect(mock.routeOpenStreetMapItinerary).toHaveBeenCalledWith(expect.objectContaining({
      points: [
        { lat: 37.1761, lng: -3.5892 },
        { lat: 37.176, lng: -3.5881 },
      ],
    }));
    const day = updated.itinerary?.find((candidate) => candidate.date === routeDate);
    expect(day?.route?.legs?.[0]).toMatchObject({ fromItemId: `booking:${granadaId}:${routeDate}` });
  });

  it("persists an arbitrary city discovery with a booking-aware route and selected map base", async () => {
    const now = Date.now();
    const departDate = new Date(now + 7 * 86_400_000).toISOString().slice(0, 10);
    const returnDate = new Date(now + 10 * 86_400_000).toISOString().slice(0, 10);
    const bookingStart = Date.parse(`${departDate}T14:00:00Z`);
    const bookingEnd = Date.parse(`${returnDate}T11:00:00Z`);
    const doc: TripDoc = {
      ...trip(),
      departDate,
      returnDate,
      destinationCenter: { lat: 38.72, lng: -9.14 },
      activities: [],
      locked: { activities: [] },
    };
    mock.lookupGmailBookingsReadOnly.mockResolvedValueOnce([{
      id: "gmail-granada-stay",
      marker: "gmail-granada-stay",
      kind: "stay",
      title: "Hotel Albaicín confirmation",
      provider: "Booking.com",
      location: "Calle Gran Vía 1, Granada",
      start: bookingStart,
      end: bookingEnd,
      allDay: false,
    }]);
    mock.searchOpenStreetMapPlaces.mockImplementation(async (query: string) => {
      if (query === "Granada") return [{ name: "Granada", address: "Granada, Spain", lat: 37.1773, lng: -3.5986, mapsUri: "https://osm.test/granada" }];
      if (query === "tapas bars in Granada") return [{ name: "Taberna Test", address: "Plaza Nueva, Granada", lat: 37.176, lng: -3.5881, mapsUri: "https://osm.test/taberna" }];
      if (query === "Calle Gran Vía 1, Granada") return [{ name: "Hotel Albaicín", address: "Calle Gran Vía 1, Granada", lat: 37.1761, lng: -3.5892, mapsUri: "https://osm.test/hotel" }];
      return [];
    });
    mock.routeOpenStreetMapItinerary.mockResolvedValueOnce({
      coordinates: [[-3.5892, 37.1761], [-3.5881, 37.176]],
      durationSeconds: 540,
      distanceMeters: 620,
      legs: [{ durationSeconds: 540, distanceMeters: 620 }],
      attribution: "Route data © OpenStreetMap contributors · FOSSGIS OSRM",
    });

    const result = await discoverTripPlaces({
      id: "trip-1",
      doc,
      city: "Granada",
      query: "tapas bars",
      mode: "walking",
    });

    const context = result.doc.cityContexts?.find((entry) => entry.city === "Granada");
    expect(context).toBeDefined();
    expect(result.doc.activeCityContextId).toBe(context?.id);
    expect(result.discovery).toMatchObject({ city: "Granada", cityContextId: context?.id });
    expect(result.discovery.items[0]).toMatchObject({ cityContextId: context?.id, city: "Granada" });
    expect(mock.routeOpenStreetMapItinerary).toHaveBeenCalledWith(expect.objectContaining({
      points: [{ lat: 37.1761, lng: -3.5892 }, { lat: 37.176, lng: -3.5881 }],
    }));
    expect(result.discovery.route?.legs?.[0]?.fromItemId).toContain("booking:");
  });

  it("persists route legs for the server-owned durable trip mind map", async () => {
    await scheduleTripDay({
      id: "trip-1",
      doc: trip(),
      date: "2026-09-02",
      activityNames: ["Tile Museum", "Riverside Market"],
      mode: "walking",
    });

    const payload = mock.convexMutation.mock.calls.find(([name]) => name === "creations:updateTripItinerary")?.[1];
    const persisted = JSON.parse(payload?.itinerary ?? "[]");
    const persistedDay = persisted.find((day: { date?: string }) => day.date === "2026-09-02");
    expect(persistedDay?.route?.legs).toEqual(expect.arrayContaining([
      expect.objectContaining({ durationSeconds: 480, distanceMeters: 620 }),
      expect.objectContaining({ durationSeconds: 780, distanceMeters: 1180 }),
    ]));
  });
});
