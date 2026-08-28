import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mock = vi.hoisted(() => ({
  convexMutation: vi.fn(),
  convexQuery: vi.fn(),
  openTrip: vi.fn(),
  scoutTrip: vi.fn(),
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
  iCloudCalendarConfigured: vi.fn(),
  resolveICloudTravelCalendar: vi.fn(),
  inspectICloudTravelCalendarAttempt: vi.fn(),
}));

vi.mock("./context", () => ({ convexMutation: mock.convexMutation, convexQuery: mock.convexQuery }));
vi.mock("./control-context", () => ({
  withAdminSession: async (_authTokenHash: unknown, operation: () => Promise<unknown>) => await operation(),
}));
vi.mock("./vault", () => ({ getSecret: vi.fn(), getServiceSecrets: vi.fn() }));
vi.mock("./booking-email", () => ({ lookupGmailBookingsReadOnly: vi.fn(), scanGmailBookingConfirmations: mock.scanGmailBookingConfirmations }));
vi.mock("./icloud-calendar", () => ({
  createICloudEvent: vi.fn(),
  deleteICloudEvent: vi.fn(),
  findICloudEvents: vi.fn(),
  listICloudEvents: vi.fn(),
  iCloudCalendarConfigured: mock.iCloudCalendarConfigured,
  inspectICloudTravelCalendarAttempt: mock.inspectICloudTravelCalendarAttempt,
  resolveICloudTravelCalendar: mock.resolveICloudTravelCalendar,
}));
vi.mock("./openstreetmap", () => ({ searchOpenStreetMapPlaces: mock.searchOpenStreetMapPlaces }));
vi.mock("./travel", () => ({
  openTrip: mock.openTrip,
  scoutTrip: mock.scoutTrip,
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

import { extractICloudCalendarApproval } from "./sanitize";
import { executeTool } from "./tools";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
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

function opaqueBookingChoiceId(booking: { id: string; marker: string }): string {
  const digest = createHash("sha256")
    .update("jarvis-gmail-booking-v1\0")
    .update(booking.id)
    .update("\0")
    .update(booking.marker)
    .digest("hex");
  return `booking-${digest.slice(0, 16)}`;
}

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
    vi.stubEnv("JARVIS_HUB_ACTIONS_TOKEN", "dedicated-jarvis-actions-token");
    mock.openTrip.mockResolvedValue({ id: "draft-new", storage: "draft", doc: {} });
    mock.scoutTrip.mockResolvedValue({
      id: "draft-plan",
      storage: "draft",
      doc: { flights: [], stays: [], activities: [], providers: {} },
    });
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
    mock.iCloudCalendarConfigured.mockReturnValue(false);
    mock.resolveICloudTravelCalendar.mockResolvedValue({ name: "Calendar", url: "https://caldav.icloud.com/123/calendars/home/" });
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

  it("binds new trip workspaces to the triggering chat instead of the currently selected UI chat", async () => {
    await executeTool("trip_open", { destination: "Tokyo", dest_iata: "HND" }, {
      invocationContext: { threadId: "thread-origin", userMessageId: "message-origin" },
    });
    await executeTool("trip_plan", {
      destination: "Tokyo",
      dest_iata: "HND",
      origin_iata: "LHR",
      depart_date: "2030-09-10",
      return_date: "2030-09-14",
      adults: 1,
      budget_total_gbp: 1500,
      include_flights: true,
    }, {
      invocationContext: { threadId: "thread-origin", userMessageId: "message-origin" },
    });

    expect(mock.openTrip).toHaveBeenCalledWith(expect.objectContaining({
      sourceMessageId: "message-origin",
      threadId: "thread-origin",
    }));
    expect(mock.scoutTrip).toHaveBeenCalledWith(expect.objectContaining({
      sourceMessageId: "message-origin",
      threadId: "thread-origin",
    }));
  });

  it("keeps a booking widget card in the triggering chat when the UI has moved elsewhere", async () => {
    mock.convexQuery.mockImplementation(async (path: string) => path === "ui:getActiveThread" ? "thread-now-active" : null);
    mock.convexMutation.mockResolvedValue(undefined);

    await executeTool("bookings_check", { days: 30 }, {
      invocationContext: { threadId: "thread-origin", userMessageId: "message-origin" },
    });

    expect(mock.convexMutation).toHaveBeenCalledWith("chatQueue:postCard", expect.objectContaining({
      threadId: "thread-origin",
      type: "widget",
    }));
  });

  it("keeps an existing trip's booking card in that trip's original chat", async () => {
    const savedTrip = {
      ...doc,
      threadId: "thread-trip-origin",
      departDate: "2030-09-10",
      returnDate: "2030-09-14",
    };
    mock.getTrip.mockResolvedValueOnce({ id: "trip-1", doc: savedTrip, storage: "creation" });
    mock.convexMutation.mockResolvedValue(undefined);

    await executeTool("bookings_check", { creation_id: "trip-1", days: 30 }, {
      invocationContext: { threadId: "thread-later-invocation", userMessageId: "message-later" },
    });

    expect(mock.convexMutation).toHaveBeenCalledWith("chatQueue:postCard", expect.objectContaining({
      threadId: "thread-trip-origin",
      type: "widget",
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

  it("prepares one Gmail booking as an iCloud owner approval without writing Calendar", async () => {
    vi.stubEnv("ICLOUD_CALENDAR_APPLE_ID", "calendar-owner@example.test");
    vi.stubEnv("ICLOUD_CALENDAR_APP_PASSWORD", "test-app-password");
    mock.iCloudCalendarConfigured.mockResolvedValue(true);
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
    const token = extractICloudCalendarApproval(result);
    expect(result).toContain("Ready for your approval");
    expect(token).toBeTruthy();
    const { verifyICloudCalendarApproval } = await import("./icloud-calendar-approval.server");
    const firstApproval = verifyICloudCalendarApproval(token!);
    expect(firstApproval.event).toMatchObject({
      title: booking.title,
      start: booking.start,
      end: booking.end,
      allDay: false,
      location: booking.location,
    });
    expect(firstApproval.event.notes).not.toContain(booking.confirmationCode);

    const retryToken = extractICloudCalendarApproval(await executeTool("bookings_check", { sync_calendar: true }));
    const retryApproval = verifyICloudCalendarApproval(retryToken!);
    expect(retryApproval.event).toMatchObject({ title: booking.title, start: booking.start, end: booking.end });
  });

  it("requires an explicit opaque booking choice before preparing a multi-booking import", async () => {
    vi.stubEnv("ICLOUD_CALENDAR_APPLE_ID", "calendar-owner@example.test");
    vi.stubEnv("ICLOUD_CALENDAR_APP_PASSWORD", "test-app-password");
    mock.iCloudCalendarConfigured.mockResolvedValue(true);
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
    expect(extractICloudCalendarApproval(needsChoice)).toBeNull();
    const bookingId = needsChoice.match(/booking-[a-f0-9]{16}/)?.[0];
    expect(bookingId).toBeTruthy();

    const selectedResult = await executeTool("bookings_check", { sync_calendar: true, booking_id: bookingId });
    const { verifyICloudCalendarApproval } = await import("./icloud-calendar-approval.server");
    const selectedApproval = verifyICloudCalendarApproval(extractICloudCalendarApproval(selectedResult)!);
    expect(selectedApproval.event).toMatchObject({ title: "🏨 Hotel Aurora · confirmed" });
  });

  it("keeps a draft Apple Maps preflight calendar-free while persisting its reminder and to-do", async () => {
    const flight = {
      id: "gmail-flight-1",
      marker: "jarvis-gmail-booking:gmail-flight-1",
      kind: "flight" as const,
      title: "✈ Iberia 123 · confirmed",
      provider: "Iberia",
      start: Date.parse("2030-09-10T09:15:00+02:00"),
      allDay: false,
      timeZone: "Europe/Madrid",
    };
    const automationTrip = {
      ...doc,
      destination: "Seville",
      departDate: "2030-09-10",
      returnDate: "2030-09-14",
      cityContexts: [{
        id: "city:seville",
        city: "Seville",
        source: "destination",
        center: { lat: 37.389, lng: -5.984 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
        bookingReference: {
          city: "Seville",
          title: "Hotel Seville · confirmed",
          location: "Seville, Spain",
          start: Date.parse("2030-09-10T12:00:00+02:00"),
          end: Date.parse("2030-09-14T12:00:00+02:00"),
          lat: 37.389,
          lng: -5.984,
          distanceKm: 0.2,
          state: "upcoming",
          verifiedAt: Date.now(),
        },
      }],
    };
    mock.getTrip.mockResolvedValueOnce({ id: "draft-apple", doc: automationTrip, storage: "draft" });
    mock.scanGmailBookingConfirmations.mockResolvedValueOnce([flight]);
    mock.bookingsForTripWindow.mockReturnValueOnce([flight]);
    mock.convexQuery.mockImplementation(async (path: string) => {
      if (path === "ui:getActiveThread") return "thread-apple";
      return null;
    });
    mock.convexMutation.mockResolvedValue(undefined);
    const hubFetch = vi.fn(async (input: string | URL, _init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/query") return new Response(JSON.stringify({ value: [] }), { headers: { "content-type": "application/json" } });
      if (url.pathname === "/api/mutation") return new Response(JSON.stringify({ value: "todo-apple" }), { headers: { "content-type": "application/json" } });
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", hubFetch);

    const result = await executeTool("travel_offline_maps_prepare", { draft_id: "draft-apple" }, {
      invocationContext: { threadId: "thread-origin", userMessageId: "message-origin" },
    });

    expect(result).toContain("Apple Maps preflight is scheduled for Seville");
    expect(result).toContain("Calendar stays untouched until you save the trip");
    expect(extractICloudCalendarApproval(result)).toBeNull();
    expect(mock.convexMutation).toHaveBeenCalledWith("reminders:add", expect.objectContaining({
      sourceKey: expect.stringMatching(/^[a-f0-9]{64}$/),
      originThreadId: "thread-origin",
    }));
    expect(mock.convexMutation).toHaveBeenCalledWith("chatQueue:postCard", expect.objectContaining({
      threadId: "thread-origin",
      type: "url",
      value: "https://maps.apple.com/search?query=Seville",
    }));
    expect(hubFetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(hubFetch.mock.calls[1]?.[1]?.body))).toMatchObject({
      path: "jarvisActions:createTodo",
      args: expect.objectContaining({
        tags: expect.arrayContaining([expect.stringMatching(/^src-[a-f0-9]{36}$/)]),
        vaultToken: "dedicated-jarvis-actions-token",
      }),
    });
    expect(mock.saveTrip).toHaveBeenCalledWith("draft-apple", expect.objectContaining({
      offlineMapPreflight: expect.objectContaining({
        city: "Seville",
        reminderStatus: "scheduled",
        todoStatus: "created",
        calendarStatus: "needs_connection",
      }),
    }), true, expect.objectContaining({ storage: "draft" }));
  });

  it("does not prepare a provider fallback for a saved Apple Maps preflight", async () => {
    const sourceKey = "a".repeat(64);
    const flight = {
      id: "gmail-flight-rescheduled",
      marker: "jarvis-gmail-booking:gmail-flight-rescheduled",
      kind: "flight" as const,
      title: "✈ Iberia 987 · confirmed",
      provider: "Iberia",
      start: Date.parse("2030-09-12T11:15:00+02:00"),
      allDay: false,
      timeZone: "Europe/Madrid",
    };
    const refreshedTrip = {
      ...doc,
      destination: "Seville",
      departDate: "2030-09-12",
      returnDate: "2030-09-15",
      offlineMapPreflight: { sourceKey, calendarRefreshRequired: true },
      cityContexts: [{
        id: "city:seville",
        city: "Seville",
        source: "destination",
        center: { lat: 37.389, lng: -5.984 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
        bookingReference: {
          city: "Seville",
          title: "Hotel Seville · confirmed",
          location: "Seville, Spain",
          start: Date.parse("2030-09-12T12:00:00+02:00"),
          end: Date.parse("2030-09-15T12:00:00+02:00"),
          lat: 37.389,
          lng: -5.984,
          distanceKm: 0.2,
          state: "upcoming",
          verifiedAt: Date.now(),
        },
      }],
    };
    mock.getTrip.mockResolvedValueOnce({ id: "creation-apple", doc: refreshedTrip, storage: "creation" });
    mock.scanGmailBookingConfirmations.mockResolvedValueOnce([flight]);
    mock.bookingsForTripWindow.mockReturnValueOnce([flight]);
    mock.convexQuery.mockImplementation(async (path: string) => {
      if (path === "ui:getActiveThread") return "thread-apple";
      return null;
    });
    mock.convexMutation.mockResolvedValue(undefined);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/query") return new Response(JSON.stringify({ value: [] }), { headers: { "content-type": "application/json" } });
      if (url.pathname === "/api/mutation") return new Response(JSON.stringify({ value: "todo-rescheduled" }), { headers: { "content-type": "application/json" } });
      throw new Error(`unexpected fetch ${url}`);
    }));

    const result = await executeTool("travel_offline_maps_prepare", { creation_id: "creation-apple" });

    expect(result).toContain("iCloud Calendar is not ready");
    expect(extractICloudCalendarApproval(result)).toBeNull();
  });

  it("issues saved-trip iCloud create and update receipts only after the durable preflight registry is ready", async () => {
    vi.stubEnv("ICLOUD_CALENDAR_APPLE_ID", "calendar-owner@example.test");
    vi.stubEnv("ICLOUD_CALENDAR_APP_PASSWORD", "test-app-password");
    const sourceKey = "f".repeat(64);
    const calendarUrl = "https://caldav.icloud.com/123/calendars/home/";
    const eventUrl = `${calendarUrl}jarvis-apple-maps-${sourceKey}@jarvis.ics`;
    const flight = {
      id: "gmail-flight-icloud",
      marker: "jarvis-gmail-booking:gmail-flight-icloud",
      kind: "flight" as const,
      title: "✈ Iberia 432 · confirmed",
      provider: "Iberia",
      start: Date.parse("2030-09-18T09:15:00+02:00"),
      allDay: false,
      timeZone: "Europe/Madrid",
    };
    const stay = {
      id: "gmail-stay-icloud",
      marker: "jarvis-gmail-booking:gmail-stay-icloud",
      kind: "stay" as const,
      title: "Hotel Seville · confirmed",
      provider: "Booking",
      start: Date.parse("2030-09-18T12:00:00+02:00"),
      end: Date.parse("2030-09-21T12:00:00+02:00"),
      allDay: false,
      timeZone: "Europe/Madrid",
      location: "Seville, Spain",
    };
    const savedTrip = {
      ...doc,
      destination: "Seville",
      departDate: "2030-09-18",
      returnDate: "2030-09-21",
      offlineMapPreflight: { sourceKey, calendarRefreshRequired: true },
      cityContexts: [{
        id: "city:seville",
        city: "Seville",
        source: "destination",
        center: { lat: 37.389, lng: -5.984 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
        bookingReference: {
          city: "Seville",
          title: "Hotel Seville · confirmed",
          location: "Seville, Spain",
          start: Date.parse("2030-09-18T12:00:00+02:00"),
          end: Date.parse("2030-09-21T12:00:00+02:00"),
          lat: 37.389,
          lng: -5.984,
          distanceKm: 0.2,
          state: "upcoming",
          verifiedAt: Date.now(),
        },
      }],
    };
    mock.iCloudCalendarConfigured.mockReturnValue(true);
    mock.resolveICloudTravelCalendar.mockResolvedValue({ name: "Home", url: calendarUrl });
    mock.getTrip.mockResolvedValue({ id: "creation-icloud", doc: savedTrip, storage: "creation" });
    mock.scanGmailBookingConfirmations.mockResolvedValue([flight, stay]);
    mock.bookingsForTripWindow.mockReturnValue([flight, stay]);
    mock.convexQuery.mockImplementation(async (path: string) => path === "ui:getActiveThread" ? "thread-icloud" : null);
    let registryWrites = 0;
    mock.convexMutation.mockImplementation(async (path: string) => {
      if (path === "appleMapsOfflinePreflights:reconcileICloudCalendarAttempt") return { ok: true };
      if (path !== "appleMapsOfflinePreflights:upsert") return undefined;
      registryWrites += 1;
      return registryWrites === 1
        ? { ok: true }
        : registryWrites === 2 ? {
          ok: true,
          iCloudCalendarEvent: {
            calendarUrl,
            eventUrl,
            etag: '"etag-1"',
            revision: 1_780_000_000_000,
            nonce: "priorReceiptNonce_123456",
            committedAt: 1_780_000_000_000,
          },
        } : {
          ok: true,
          iCloudCalendarAttempt: {
            sourceKey,
            calendarUrl,
            eventUrl,
            revision: 1_780_000_000_111,
            nonce: "orphanedReceiptNonce_123456",
            action: "create",
            startedAt: 1_780_000_000_111,
          },
        };
    });
    mock.inspectICloudTravelCalendarAttempt.mockResolvedValue({
      state: "present",
      revision: 1_780_000_000_111,
      nonce: "orphanedReceiptNonce_123456",
      etag: '"orphan-etag-1"',
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/query") return new Response(JSON.stringify({ value: [] }), { headers: { "content-type": "application/json" } });
      if (url.pathname === "/api/mutation") return new Response(JSON.stringify({ value: "todo-icloud" }), { headers: { "content-type": "application/json" } });
      throw new Error(`unexpected fetch ${url}`);
    }));

    const first = await executeTool("travel_offline_maps_prepare", { creation_id: "creation-icloud", calendar: "Home" });
    const { verifyICloudCalendarTravelApproval } = await import("./icloud-calendar-approval.server");
    const create = verifyICloudCalendarTravelApproval(extractICloudCalendarApproval(first)!);
    expect(create.proposal).toMatchObject({
      action: "create",
      appleMapsOfflinePreflight: {
        tripId: "creation-icloud",
        storage: "creation",
        sourceKey,
        updatedAt: expect.any(Number),
        calendarUrl,
      },
    });
    expect(first).toContain("iCloud Calendar is ready for your protected one-click approval");

    const second = await executeTool("travel_offline_maps_prepare", { creation_id: "creation-icloud" });
    const update = verifyICloudCalendarTravelApproval(extractICloudCalendarApproval(second)!);
    expect(update.proposal).toMatchObject({
      action: "update",
      eventUrl,
      expectedEtag: '"etag-1"',
      appleMapsOfflinePreflight: {
        tripId: "creation-icloud",
        storage: "creation",
        sourceKey,
        updatedAt: expect.any(Number),
        calendarUrl,
      },
    });
    expect(mock.convexMutation).toHaveBeenCalledWith("appleMapsOfflinePreflights:upsert", expect.objectContaining({
      creationId: "creation-icloud",
      sourceKey,
    }));
    expect(mock.resolveICloudTravelCalendar).toHaveBeenLastCalledWith(calendarUrl);
    expect(mock.saveTrip).toHaveBeenLastCalledWith("creation-icloud", expect.objectContaining({
      offlineMapPreflight: expect.objectContaining({
        calendarProvider: "icloud",
        calendarStatus: "approval_required",
      }),
    }), true, expect.objectContaining({ storage: "creation" }));

    const recovered = await executeTool("travel_offline_maps_prepare", { creation_id: "creation-icloud" });
    const recoveredUpdate = verifyICloudCalendarTravelApproval(extractICloudCalendarApproval(recovered)!);
    expect(recoveredUpdate.proposal).toMatchObject({
      action: "update",
      eventUrl,
      expectedEtag: '"orphan-etag-1"',
    });
    expect(mock.inspectICloudTravelCalendarAttempt).toHaveBeenCalledWith(expect.objectContaining({
      calendarUrl,
      eventUrl,
      sourceKey,
      markers: [{ revision: 1_780_000_000_111, nonce: "orphanedReceiptNonce_123456" }],
    }));
    expect(mock.convexMutation).toHaveBeenCalledWith("appleMapsOfflinePreflights:reconcileICloudCalendarAttempt", expect.objectContaining({
      state: "present",
      etag: '"orphan-etag-1"',
    }));
  });

  it("keeps a durable retry state when iCloud Calendar is unavailable", async () => {
    const flight = {
      id: "gmail-flight-2", marker: "jarvis-gmail-booking:gmail-flight-2", kind: "flight" as const,
      title: "✈ Iberia 456 · confirmed", provider: "Iberia", start: Date.parse("2030-09-12T09:15:00+02:00"), allDay: false, timeZone: "Europe/Madrid",
    };
    const automationTrip = {
      ...doc,
      destination: "Seville",
      departDate: "2030-09-12",
      returnDate: "2030-09-14",
      cityContexts: [{
        id: "city:seville",
        city: "Seville",
        source: "destination",
        center: { lat: 37.389, lng: -5.984 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
        bookingReference: {
          city: "Seville",
          title: "Hotel Seville · confirmed",
          location: "Seville, Spain",
          start: Date.parse("2030-09-12T12:00:00+02:00"),
          end: Date.parse("2030-09-14T12:00:00+02:00"),
          lat: 37.389,
          lng: -5.984,
          distanceKm: 0.2,
          state: "upcoming",
          verifiedAt: Date.now(),
        },
      }],
    };
    mock.getTrip.mockResolvedValueOnce({ id: "draft-no-icloud", doc: automationTrip, storage: "draft" });
    mock.scanGmailBookingConfirmations.mockResolvedValueOnce([flight]);
    mock.bookingsForTripWindow.mockReturnValueOnce([flight]);
    mock.convexQuery.mockImplementation(async (path: string) => path === "ui:getActiveThread" ? "thread-apple" : { connected: false });
    mock.convexMutation.mockResolvedValue(undefined);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ value: [] }), { headers: { "content-type": "application/json" } })));

    const result = await executeTool("travel_offline_maps_prepare", { draft_id: "draft-no-icloud" });

    expect(result).toContain("Calendar stays untouched until you save the trip");
    expect(mock.saveTrip).toHaveBeenCalledWith("draft-no-icloud", expect.objectContaining({
      offlineMapPreflight: expect.objectContaining({ calendarStatus: "needs_connection" }),
    }), true, expect.objectContaining({ storage: "draft" }));
  });

  it("never attaches a date-only Gmail flight to a trip without a fresh city-verified booking", async () => {
    const flight = {
      id: "gmail-unrelated-flight", marker: "jarvis-gmail-booking:gmail-unrelated-flight", kind: "flight" as const,
      title: "✈ A flight that merely shares the date", provider: "Example Air", start: Date.parse("2030-09-15T09:15:00+02:00"), allDay: false, timeZone: "Europe/Madrid",
    };
    const tripWithoutDestinationProof = { ...doc, destination: "Seville", departDate: "2030-09-15", returnDate: "2030-09-18" };
    mock.getTrip.mockResolvedValueOnce({ id: "draft-no-city-proof", doc: tripWithoutDestinationProof, storage: "draft" });
    mock.scanGmailBookingConfirmations.mockResolvedValueOnce([flight]);
    mock.bookingsForTripWindow.mockReturnValueOnce([flight]);

    await expect(executeTool("travel_offline_maps_prepare", {
      draft_id: "draft-no-city-proof",
      flight_id: opaqueBookingChoiceId(flight),
    }))
      .resolves.toContain("fresh, city-verified Gmail stay reference");
    expect(mock.convexMutation).not.toHaveBeenCalled();
  });

  it("requires and accepts an opaque Gmail flight choice when outbound and return flights both match", async () => {
    const outbound = {
      id: "gmail-outbound", marker: "jarvis-gmail-booking:gmail-outbound", kind: "flight" as const,
      title: "✈ Outbound · confirmed", provider: "Example Air", start: Date.parse("2030-09-15T09:15:00+02:00"), allDay: false, timeZone: "Europe/Madrid",
    };
    const returning = {
      id: "gmail-return", marker: "jarvis-gmail-booking:gmail-return", kind: "flight" as const,
      title: "✈ Return · confirmed", provider: "Example Air", start: Date.parse("2030-09-18T18:15:00+02:00"), allDay: false, timeZone: "Europe/Madrid",
    };
    const trip = {
      ...doc,
      destination: "Seville",
      departDate: "2030-09-15",
      returnDate: "2030-09-18",
      bookingReferences: [{
        city: "Seville", title: "Hotel Seville · confirmed", location: "Seville, Spain",
        start: Date.parse("2030-09-15T12:00:00+02:00"), end: Date.parse("2030-09-18T12:00:00+02:00"),
        lat: 37.389, lng: -5.984, distanceKm: 0.2, state: "upcoming", verifiedAt: Date.now(),
      }],
    };
    mock.getTrip.mockResolvedValue({ id: "draft-flight-choice", doc: trip, storage: "draft" });
    mock.scanGmailBookingConfirmations.mockResolvedValue([outbound, returning]);
    mock.bookingsForTripWindow.mockReturnValue([outbound, returning]);

    const prompt = await executeTool("travel_offline_maps_prepare", { draft_id: "draft-flight-choice" });
    expect(prompt).toContain("Choose the exact confirmed Gmail flight");
    expect(prompt).toContain(opaqueBookingChoiceId(outbound));
    expect(mock.convexMutation).not.toHaveBeenCalled();

    mock.convexQuery.mockImplementation(async (path: string) => path === "ui:getActiveThread" ? "thread-choice" : { connected: false });
    mock.convexMutation.mockResolvedValue(undefined);
    const hubFetch = vi.fn(async (input: string | URL, _init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/query") return new Response(JSON.stringify({ value: [] }), { headers: { "content-type": "application/json" } });
      if (url.pathname === "/api/mutation") return new Response(JSON.stringify({ value: "todo-choice" }), { headers: { "content-type": "application/json" } });
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", hubFetch);

    await expect(executeTool("travel_offline_maps_prepare", {
      draft_id: "draft-flight-choice",
      flight_id: opaqueBookingChoiceId(outbound),
    })).resolves.toContain("Apple Maps preflight is scheduled for Seville");
    expect(mock.convexMutation).toHaveBeenCalledWith("reminders:add", expect.objectContaining({
      text: expect.stringContaining("before flight 2030-09-15"),
    }));
  });

  it("updates the one source-tagged Hub to-do when a verified trip is refreshed", async () => {
    const flight = {
      id: "gmail-flight-update", marker: "jarvis-gmail-booking:gmail-flight-update", kind: "flight" as const,
      title: "✈ Iberia 789 · confirmed", provider: "Iberia", start: Date.parse("2030-09-18T10:15:00+02:00"), allDay: false, timeZone: "Europe/Madrid",
    };
    const sourceKey = createHash("sha256")
      .update("jarvis-apple-maps-offline-preflight-v1\0")
      .update(flight.marker)
      .update("\0")
      .update("seville")
      .digest("hex");
    const automationTrip = {
      ...doc,
      destination: "Seville",
      departDate: "2030-09-18",
      returnDate: "2030-09-21",
      bookingReferences: [{
        city: "Seville", title: "Hotel Seville · confirmed", location: "Seville, Spain",
        start: Date.parse("2030-09-18T12:00:00+02:00"), end: Date.parse("2030-09-21T12:00:00+02:00"),
        lat: 37.389, lng: -5.984, distanceKm: 0.2, state: "upcoming", verifiedAt: Date.now(),
      }],
    };
    mock.getTrip.mockResolvedValueOnce({ id: "draft-update-todo", doc: automationTrip, storage: "draft" });
    mock.scanGmailBookingConfirmations.mockResolvedValueOnce([flight]);
    mock.bookingsForTripWindow.mockReturnValueOnce([flight]);
    mock.convexQuery.mockImplementation(async (path: string) => path === "ui:getActiveThread" ? "thread-apple" : { connected: false });
    mock.convexMutation.mockResolvedValue(undefined);
    const hubFetch = vi.fn(async (input: string | URL, _init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/query") {
        return new Response(JSON.stringify({ value: [{ id: "todo-existing", done: false, tags: [`source:${sourceKey}`] }] }), { headers: { "content-type": "application/json" } });
      }
      if (url.pathname === "/api/mutation") return new Response(JSON.stringify({ value: "todo-existing" }), { headers: { "content-type": "application/json" } });
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", hubFetch);

    await expect(executeTool("travel_offline_maps_prepare", { draft_id: "draft-update-todo" })).resolves.toContain("matching Hub to-do already exists");
    expect(JSON.parse(String(hubFetch.mock.calls[1]?.[1]?.body))).toMatchObject({
      path: "jarvisActions:updateTodo",
      args: expect.objectContaining({ id: "todo-existing", dueDate: flight.start - 86_400_000, vaultToken: "dedicated-jarvis-actions-token" }),
    });
  });
});
