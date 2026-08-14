import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mock = vi.hoisted(() => ({
  convexMutation: vi.fn(),
  convexQuery: vi.fn(),
  routeOpenStreetMapItinerary: vi.fn(),
  openStreetMapDirectionsUrl: vi.fn(),
  searchOpenStreetMapPlaces: vi.fn(),
}));

vi.mock("./context", () => ({ convexMutation: mock.convexMutation, convexQuery: mock.convexQuery }));
vi.mock("./openstreetmap", () => ({
  routeOpenStreetMapItinerary: mock.routeOpenStreetMapItinerary,
  openStreetMapDirectionsUrl: mock.openStreetMapDirectionsUrl,
  searchOpenStreetMapPlaces: mock.searchOpenStreetMapPlaces,
}));

import { addTripPlaceToDay, bookingsForTripWindow, buildItinerary, scheduleTripDay, type TripDoc } from "./travel";

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
