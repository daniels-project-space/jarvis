import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mock = vi.hoisted(() => ({
  convexMutation: vi.fn(),
  convexQuery: vi.fn(),
  getTrip: vi.fn(),
  saveTrip: vi.fn(),
  computeTransfer: vi.fn(),
  hubAction: vi.fn(),
  scheduleTripDay: vi.fn(),
  addTripPlaceToDay: vi.fn(),
  searchOpenStreetMapPlaces: vi.fn(),
}));

vi.mock("./context", () => ({ convexMutation: mock.convexMutation, convexQuery: mock.convexQuery }));
vi.mock("./control-context", () => ({
  withAdminSession: async (_authTokenHash: unknown, operation: () => Promise<unknown>) => await operation(),
}));
vi.mock("./vault", () => ({ getSecret: vi.fn(), getServiceSecrets: vi.fn() }));
vi.mock("./booking-email", () => ({ lookupGmailBookingsReadOnly: vi.fn(), scanGmailBookingConfirmations: vi.fn() }));
vi.mock("./icloud-calendar", () => ({ createICloudEvent: vi.fn(), deleteICloudEvent: vi.fn(), findICloudEvents: vi.fn(), listICloudEvents: vi.fn() }));
vi.mock("./openstreetmap", () => ({ searchOpenStreetMapPlaces: mock.searchOpenStreetMapPlaces }));
vi.mock("./travel", () => ({
  getTrip: mock.getTrip,
  saveTrip: mock.saveTrip,
  computeTransfer: mock.computeTransfer,
  hubAction: mock.hubAction,
  scheduleTripDay: mock.scheduleTripDay,
  addTripPlaceToDay: mock.addTripPlaceToDay,
}));

import { executeTool } from "./tools";

const doc = {
  title: "Lisbon · Sep",
  destination: "Lisbon",
  activities: [
    { name: "Tile Museum", lat: 38.716, lng: -9.13, mapsLink: "https://www.openstreetmap.org/node/1" },
    { name: "Riverside Market", lat: 38.709, lng: -9.137, mapsLink: "https://www.openstreetmap.org/node/2" },
  ],
  locked: { activities: [], stay: { name: "Hotel Tejo", lat: 38.714, lng: -9.142 } },
};

const routed = {
  ...doc,
  itinerary: [{
    date: "2026-09-02",
    label: "Wed 2 Sep",
    items: [{ id: "museum", title: "Tile Museum", kind: "activity" }],
    route: { mode: "walking", status: "ready", durationSeconds: 720, distanceMeters: 800 },
  }],
};

describe("trip itinerary tool actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.getTrip.mockResolvedValue({ id: "trip-1", doc });
    mock.scheduleTripDay.mockResolvedValue(routed);
    mock.addTripPlaceToDay.mockResolvedValue(routed);
    mock.searchOpenStreetMapPlaces.mockResolvedValue([{
      name: "Neighbourhood Gallery",
      address: "Alfama, Lisbon",
      lat: 38.713,
      lng: -9.128,
      mapsUri: "https://www.openstreetmap.org/node/3",
    }]);
  });

  it("saves an ordered day through the exact trip id and reports only real route facts", async () => {
    await expect(executeTool("trip_update", {
      trip_id: "trip-1",
      action: "schedule_day",
      date: "2026-09-02",
      activities: ["Tile Museum", "Riverside Market"],
      times: ["10:00", "13:00"],
      transport_mode: "walking",
    })).resolves.toContain("Real walking route: 12 min across 0.8 km");

    expect(mock.scheduleTripDay).toHaveBeenCalledWith(expect.objectContaining({
      id: "trip-1",
      doc,
      date: "2026-09-02",
      activityNames: ["Tile Museum", "Riverside Market"],
      times: ["10:00", "13:00"],
      mode: "walking",
    }));
  });

  it("geocodes a newly requested place before it ever reaches the saved day", async () => {
    await expect(executeTool("trip_update", {
      trip_id: "trip-1",
      action: "add_place",
      date: "2026-09-02",
      place: "Neighbourhood Gallery",
      time: "16:15",
      transport_mode: "walking",
    })).resolves.toContain("Added Neighbourhood Gallery · Alfama, Lisbon");

    expect(mock.searchOpenStreetMapPlaces).toHaveBeenCalledWith("Neighbourhood Gallery in Lisbon", { maxResults: 5 });
    expect(mock.addTripPlaceToDay).toHaveBeenCalledWith(expect.objectContaining({
      id: "trip-1",
      date: "2026-09-02",
      time: "16:15",
      place: expect.objectContaining({
        name: "Neighbourhood Gallery",
        lat: 38.713,
        lng: -9.128,
        note: "OpenStreetMap · Alfama, Lisbon",
      }),
    }));
  });
});
