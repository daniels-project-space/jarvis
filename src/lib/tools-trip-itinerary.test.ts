import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  discoverTripPlaces: vi.fn(),
  activateTripCityContext: vi.fn(),
  refreshTripCityContextBookings: vi.fn(),
  selectTripCityContext: vi.fn(),
  tripActivityId: vi.fn((activity: { id?: string; name: string }) => activity.id ?? `osm:${activity.name}`),
  tripStayId: vi.fn((stay: { id?: string; name: string }) => stay.id ?? `stay:${stay.name}`),
  bookingsForTripWindow: vi.fn(),
  normalizeTripCityContexts: vi.fn(),
  replaceConfirmedBookings: vi.fn(),
  setTripCityContextBookingReference: vi.fn(),
  verifyTripCityBookingReference: vi.fn(),
  scanGmailBookingConfirmations: vi.fn(),
  searchOpenStreetMapPlaces: vi.fn(),
}));

vi.mock("./context", () => ({ convexMutation: mock.convexMutation, convexQuery: mock.convexQuery }));
vi.mock("./control-context", () => ({
  withAdminSession: async (_authTokenHash: unknown, operation: () => Promise<unknown>) => await operation(),
}));
vi.mock("./vault", () => ({ getSecret: vi.fn(), getServiceSecrets: vi.fn() }));
vi.mock("./booking-email", () => ({ lookupGmailBookingsReadOnly: vi.fn(), scanGmailBookingConfirmations: mock.scanGmailBookingConfirmations }));
vi.mock("./icloud-calendar", () => ({ createICloudEvent: vi.fn(), deleteICloudEvent: vi.fn(), findICloudEvents: vi.fn(), listICloudEvents: vi.fn() }));
vi.mock("./openstreetmap", () => ({ searchOpenStreetMapPlaces: mock.searchOpenStreetMapPlaces }));
vi.mock("./travel", () => ({
  getTrip: mock.getTrip,
  saveTrip: mock.saveTrip,
  computeTransfer: mock.computeTransfer,
  hubAction: mock.hubAction,
  scheduleTripDay: mock.scheduleTripDay,
  addTripPlaceToDay: mock.addTripPlaceToDay,
  discoverTripPlaces: mock.discoverTripPlaces,
  activateTripCityContext: mock.activateTripCityContext,
  refreshTripCityContextBookings: mock.refreshTripCityContextBookings,
  selectTripCityContext: mock.selectTripCityContext,
  tripActivityId: mock.tripActivityId,
  tripStayId: mock.tripStayId,
  bookingsForTripWindow: mock.bookingsForTripWindow,
  normalizeTripCityContexts: mock.normalizeTripCityContexts,
  replaceConfirmedBookings: mock.replaceConfirmedBookings,
  setTripCityContextBookingReference: mock.setTripCityContextBookingReference,
  verifyTripCityBookingReference: mock.verifyTripCityBookingReference,
}));

import { extractGoogleCalendarApproval } from "./sanitize";
import { executeTool } from "./tools";

const APPROVAL_KEY = Buffer.alloc(32, 9).toString("base64");

afterEach(() => {
  delete process.env.GOOGLE_TOKEN_ENCRYPTION_KEY;
});

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
    mock.scanGmailBookingConfirmations.mockResolvedValue([]);
    mock.bookingsForTripWindow.mockReturnValue([]);
    mock.normalizeTripCityContexts.mockReturnValue([]);
    mock.replaceConfirmedBookings.mockReturnValue(0);
    mock.setTripCityContextBookingReference.mockReturnValue(undefined);
    mock.verifyTripCityBookingReference.mockResolvedValue(undefined);
    mock.activateTripCityContext.mockResolvedValue({ context: { id: "city:lisbon", city: "Lisbon" }, refreshed: true });
    mock.selectTripCityContext.mockReturnValue({ id: "city:lisbon", city: "Lisbon" });
    mock.refreshTripCityContextBookings.mockResolvedValue({ context: { id: "city:lisbon", city: "Lisbon" }, refreshed: true });
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

  it("refreshes a live draft's booked-location facts through its exact draft id", async () => {
    const bookingTrip = {
      ...doc,
      departDate: "2026-09-01",
      returnDate: "2026-09-04",
      destinationCenter: { lat: 38.7223, lng: -9.1393 },
      discoveries: [],
      bookingReferences: [],
    };
    mock.getTrip.mockResolvedValueOnce({ id: "draft-1", doc: bookingTrip, storage: "draft" });
    mock.scanGmailBookingConfirmations.mockResolvedValueOnce([{ marker: "stay-1", kind: "stay", location: "Lisbon", start: Date.parse("2026-09-02T14:00:00Z"), end: Date.parse("2026-09-03T11:00:00Z") }]);
    mock.bookingsForTripWindow.mockReturnValueOnce([{ marker: "stay-1", kind: "stay", location: "Lisbon", start: Date.parse("2026-09-02T14:00:00Z"), end: Date.parse("2026-09-03T11:00:00Z") }]);
    mock.normalizeTripCityContexts.mockReturnValueOnce([{ id: "city:lisbon", city: "Lisbon", center: { lat: 38.7223, lng: -9.1393 } }]);
    mock.convexMutation.mockResolvedValue({});

    await expect(executeTool("bookings_check", { draft_id: "draft-1" })).resolves.toContain("refreshed into");

    expect(mock.getTrip).toHaveBeenCalledWith("draft-1", expect.objectContaining({ storage: "draft" }));
    expect(mock.saveTrip).toHaveBeenCalledWith("draft-1", bookingTrip, true, expect.objectContaining({ storage: "draft" }));
    expect(mock.verifyTripCityBookingReference).toHaveBeenCalledWith(expect.objectContaining({ city: "Lisbon" }));
    expect(mock.setTripCityContextBookingReference).toHaveBeenCalledWith(bookingTrip, "city:lisbon", undefined, expect.any(Number));
  });

  it("persists an explicit city-base selection and refreshes its time-valid booking reference", async () => {
    mock.getTrip.mockResolvedValueOnce({ id: "trip-1", doc });
    mock.selectTripCityContext.mockReturnValueOnce({ id: "city:granada", city: "Granada" });
    mock.refreshTripCityContextBookings.mockResolvedValueOnce({
      context: { id: "city:granada", city: "Granada" },
      refreshed: true,
      bookingReference: { title: "Hotel Albaicín" },
    });

    await expect(executeTool("trip_update", {
      trip_id: "trip-1",
      action: "select_city_context",
      city_context_id: "city:granada",
    })).resolves.toContain("Granada is now the active map base");

    expect(mock.selectTripCityContext).toHaveBeenCalledWith(doc, "city:granada");
    expect(mock.refreshTripCityContextBookings).toHaveBeenCalledWith({ doc, cityContextId: "city:granada" });
    expect(mock.saveTrip).toHaveBeenCalledWith("trip-1", doc);
  });

  it("prepares one Gmail booking as a time-zone-aware owner approval without writing Calendar", async () => {
    process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = APPROVAL_KEY;
    const booking = {
      id: "gmail-stay-1",
      marker: "jarvis-gmail-booking:gmail-stay-1",
      kind: "stay" as const,
      title: "🏨 Hotel Aurora · confirmed",
      provider: "Booking.com",
      start: Date.parse("2026-09-02T14:00:00+02:00"),
      end: Date.parse("2026-09-05T11:00:00+02:00"),
      allDay: false,
      confirmationCode: "PRIVATE-REF",
      location: "Calle Aurora 12, Madrid",
      timeZone: "Europe/Madrid",
    };
    mock.scanGmailBookingConfirmations.mockResolvedValue([booking]);

    const result = await executeTool("bookings_check", { sync_calendar: true });
    const token = extractGoogleCalendarApproval(result);
    expect(result).toContain("Ready for your approval");
    expect(token).toBeTruthy();
    const { verifyGoogleCalendarApprovalProposal } = await import("./google-calendar-approval.server");
    const firstApproval = verifyGoogleCalendarApprovalProposal(token!);
    expect(firstApproval.proposal.action).toBe("create");
    if (firstApproval.proposal.action !== "create") throw new Error("expected create approval");
    expect(firstApproval.proposal.event).toMatchObject({
      title: booking.title,
      start: booking.start,
      end: booking.end,
      allDay: false,
      timeZone: "Europe/Madrid",
      location: booking.location,
      sourceDedupeKey: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(firstApproval.proposal.event.notes).not.toContain(booking.confirmationCode);

    const retryToken = extractGoogleCalendarApproval(await executeTool("bookings_check", { sync_calendar: true }));
    const retryApproval = verifyGoogleCalendarApprovalProposal(retryToken!);
    if (retryApproval.proposal.action !== "create") throw new Error("expected create approval");
    expect(retryApproval.proposal.event.sourceDedupeKey).toBe(firstApproval.proposal.event.sourceDedupeKey);
  });

  it("requires an explicit opaque booking choice before preparing a multi-booking import", async () => {
    process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = APPROVAL_KEY;
    mock.scanGmailBookingConfirmations.mockResolvedValue([
      {
        id: "gmail-stay-1", marker: "jarvis-gmail-booking:gmail-stay-1", kind: "stay", title: "🏨 Hotel Aurora · confirmed", provider: "Booking.com",
        start: Date.parse("2026-09-02T14:00:00+02:00"), end: Date.parse("2026-09-05T11:00:00+02:00"), allDay: false, timeZone: "Europe/Madrid",
      },
      {
        id: "gmail-flight-2", marker: "jarvis-gmail-booking:gmail-flight-2", kind: "flight", title: "✈ Iberia 123 · confirmed", provider: "Iberia",
        start: Date.parse("2026-09-01T09:00:00+01:00"), end: Date.parse("2026-09-01T12:00:00+02:00"), allDay: false, timeZone: "Europe/Madrid",
      },
    ]);

    const needsChoice = await executeTool("bookings_check", { sync_calendar: true });
    expect(needsChoice).toContain("needs one explicit booking_id");
    expect(extractGoogleCalendarApproval(needsChoice)).toBeNull();
    const bookingId = needsChoice.match(/booking-[a-f0-9]{16}/)?.[0];
    expect(bookingId).toBeTruthy();

    const selectedResult = await executeTool("bookings_check", { sync_calendar: true, booking_id: bookingId });
    const { verifyGoogleCalendarApprovalProposal } = await import("./google-calendar-approval.server");
    const selectedApproval = verifyGoogleCalendarApprovalProposal(extractGoogleCalendarApproval(selectedResult)!);
    expect(selectedApproval.proposal).toMatchObject({
      action: "create",
      event: { title: "🏨 Hotel Aurora · confirmed" },
    });
  });
});
