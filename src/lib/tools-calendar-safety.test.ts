import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mock = vi.hoisted(() => ({
  convexMutation: vi.fn(),
  convexQuery: vi.fn(),
  createICloudEvent: vi.fn(),
  deleteICloudEvent: vi.fn(),
  findICloudEvents: vi.fn(),
  listICloudEvents: vi.fn(),
  getTrip: vi.fn(),
  saveTrip: vi.fn(),
  computeTransfer: vi.fn(),
  buildItinerary: vi.fn(),
  refreshTripItineraryRoutes: vi.fn(),
  saveTripItinerary: vi.fn(),
  tripToCalendar: vi.fn(),
  lockTripDraft: vi.fn(),
  tripStayId: vi.fn(),
}));

vi.mock("./context", () => ({
  convexMutation: mock.convexMutation,
  convexQuery: mock.convexQuery,
}));
vi.mock("./control-context", () => ({
  withAdminSession: async (_authTokenHash: unknown, operation: () => Promise<unknown>) => await operation(),
}));
vi.mock("./vault", () => ({ getSecret: vi.fn(), getServiceSecrets: vi.fn() }));
vi.mock("./booking-email", () => ({
  lookupGmailBookingsReadOnly: vi.fn(),
  scanGmailBookingConfirmations: vi.fn(),
}));
vi.mock("./icloud-calendar", () => ({
  createICloudEvent: mock.createICloudEvent,
  deleteICloudEvent: mock.deleteICloudEvent,
  findICloudEvents: mock.findICloudEvents,
  listICloudEvents: mock.listICloudEvents,
}));
vi.mock("./travel", () => ({
  getTrip: mock.getTrip,
  saveTrip: mock.saveTrip,
  computeTransfer: mock.computeTransfer,
  buildItinerary: mock.buildItinerary,
  refreshTripItineraryRoutes: mock.refreshTripItineraryRoutes,
  saveTripItinerary: mock.saveTripItinerary,
  tripToCalendar: mock.tripToCalendar,
  lockTripDraft: mock.lockTripDraft,
  tripStayId: mock.tripStayId,
}));

import { executeTool, TOOL_DEFS } from "./tools";

function reviewedTrip() {
  return {
    id: "trip-1",
    doc: {
      title: "Sevilla",
      includeFlights: false,
      flights: [],
      locked: { stay: { name: "Hotel Casa 1800" }, activities: [] },
      budgetGbp: 1200,
      totals: { total: 640 },
      status: "draft",
    },
  };
}

describe("legacy calendar write boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.getTrip.mockResolvedValue(reviewedTrip());
    mock.computeTransfer.mockResolvedValue({ durationText: "25 min", distanceText: "8 km" });
    mock.buildItinerary.mockReturnValue([]);
    mock.refreshTripItineraryRoutes.mockResolvedValue([]);
    mock.saveTripItinerary.mockResolvedValue(undefined);
    mock.saveTrip.mockResolvedValue(undefined);
  });

  it("does not advertise legacy iCloud calendar mutation tools", () => {
    const names = new Set(TOOL_DEFS.map((tool) => tool.name));
    expect(names.has("calendar_add")).toBe(false);
    expect(names.has("calendar_remove")).toBe(false);
    expect(names.has("trip_finalize")).toBe(true);
    expect(TOOL_DEFS.find((tool) => tool.name === "trip_finalize")?.parameters.properties)
      .not.toHaveProperty("add_to_calendar");
  });

  it("fails closed for explicit iCloud create and delete requests", async () => {
    await expect(executeTool("calendar_add", {
      title: "Meeting", date: "2026-08-20", confirmed: true,
    })).resolves.toContain("protected owner approval");
    await expect(executeTool("calendar_remove", {
      match: "Meeting", confirmed: true,
    })).resolves.toContain("protected owner approval");

    expect(mock.createICloudEvent).not.toHaveBeenCalled();
    expect(mock.deleteICloudEvent).not.toHaveBeenCalled();
    expect(mock.findICloudEvents).not.toHaveBeenCalled();
  });

  it("finalizes the reviewed trip but never calls the legacy Hub calendar sync", async () => {
    await expect(executeTool("trip_finalize", {
      trip_id: "trip-1", add_to_calendar: true, confirmed: true,
    })).resolves.toContain("no calendar items were created");

    expect(mock.saveTrip).toHaveBeenCalledWith("trip-1", expect.objectContaining({ status: "planned" }));
    expect(mock.tripToCalendar).not.toHaveBeenCalled();
  });

  it("still finalizes a reviewed trip when calendars are left untouched", async () => {
    await expect(executeTool("trip_finalize", {
      trip_id: "trip-1", add_to_calendar: false,
    })).resolves.toContain("Trip locked in");

    expect(mock.saveTrip).toHaveBeenCalledWith("trip-1", expect.objectContaining({ status: "planned" }));
    expect(mock.tripToCalendar).not.toHaveBeenCalled();
  });
});
