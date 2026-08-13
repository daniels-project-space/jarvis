import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mock = vi.hoisted(() => ({
  convexMutation: vi.fn(),
  convexQuery: vi.fn(),
  getSecret: vi.fn(),
  lookupBookings: vi.fn(),
  createICloudEvent: vi.fn(),
}));

vi.mock("./context", () => ({
  convexMutation: mock.convexMutation,
  convexQuery: mock.convexQuery,
}));
vi.mock("./control-context", () => ({
  withAdminSession: async (_authTokenHash: unknown, operation: () => Promise<unknown>) => await operation(),
}));
vi.mock("./vault", () => ({ getSecret: mock.getSecret, getServiceSecrets: vi.fn() }));
vi.mock("./booking-email", () => ({
  lookupGmailBookingsReadOnly: mock.lookupBookings,
  scanGmailBookingConfirmations: mock.lookupBookings,
}));
vi.mock("./icloud-calendar", () => ({
  createICloudEvent: mock.createICloudEvent,
  deleteICloudEvent: vi.fn(),
  findICloudEvents: vi.fn(),
  listICloudEvents: vi.fn(),
}));

import { executeTool, TOOL_DEFS } from "./tools";

function osmPlace(name: string, address: string, lat: number, lng: number) {
  return { name, display_name: address, lat: String(lat), lon: String(lng), type: "attraction" };
}

describe("travel_map tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.convexQuery.mockImplementation(async (path: string) =>
      path === "currentState:getActive" ? { value: "Sevilla" } : "thread-1",
    );
    mock.convexMutation.mockResolvedValue(undefined);
    mock.lookupBookings.mockResolvedValue([{
      id: "gmail-booking-1",
      kind: "stay",
      title: "🏨 Hotel Casa 1800 Sevilla · confirmed",
      provider: "Booking",
      bookingName: "Hotel Casa 1800 Sevilla",
      location: "Rodrigo Caro, 6, 41004 Sevilla, Spain",
      allDay: false,
      marker: "jarvis-gmail-booking:gmail-booking-1",
    }]);
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const query = new URL(String(url)).searchParams.get("q") ?? "";
      if (query === "Sevilla") {
        return new Response(JSON.stringify([osmPlace("Sevilla", "Sevilla, Spain", 37.3891, -5.9845)]), { status: 200 });
      }
      if (query.includes("Rodrigo Caro")) {
        return new Response(JSON.stringify([osmPlace("Hotel Casa 1800 Sevilla", "Rodrigo Caro, 6, Sevilla", 37.386, -5.9902)]), { status: 200 });
      }
      return new Response(JSON.stringify([
        osmPlace("Centro Cerámica Triana", "Calle Callao, Sevilla", 37.3855, -6.006),
        osmPlace("Caótica", "Calle José Gestoso, Sevilla", 37.394, -5.993),
        osmPlace("Espacio Santa Clara", "Calle Becas, Sevilla", 37.401, -5.997),
      ]), { status: 200 });
    }));
  });

  it("exposes the general tool and executes the exact Sevilla niche-map request", async () => {
    expect(TOOL_DEFS.some((definition) => definition.name === "travel_map")).toBe(true);
    const result = await executeTool("travel_map", {
      location: "Sevilla",
      query: "attractions in the city",
      preferences: "not touristy; give me something more niche",
      route: true,
      include_bookings: true,
      travel_mode: "walking",
    });

    expect(result).toContain("Interactive OpenStreetMap opened for Sevilla");
    expect(result).toContain("Opening hours and ratings are unverified");
    expect(result).toContain("read-only Gmail booking base");
    expect(mock.lookupBookings).toHaveBeenCalledWith({ days: 730, maxResults: 24 });
    const requests = vi.mocked(fetch).mock.calls.map(([url]) => new URL(String(url)));
    expect(requests.every((url) => url.hostname === "nominatim.openstreetmap.org")).toBe(true);

    const panelCall = mock.convexMutation.mock.calls.find(([path]) => path === "ui:setPanel");
    expect(panelCall).toBeTruthy();
    const panel = JSON.parse(String(panelCall?.[1]?.value));
    expect(panel).toMatchObject({
      kind: "places",
      locationLabel: "Sevilla",
      provider: "openstreetmap",
      center: { label: "Sevilla", source: "openstreetmap" },
      base: { label: "Hotel Casa 1800 Sevilla", source: "Read-only Gmail booking" },
      booking: { requested: true, status: "matched" },
      route: { mode: "walking" },
    });
    expect(panel.items).toHaveLength(3);
    expect(panel.route.coordinates).toHaveLength(4);
    expect(panel.route.directionsUrl).toContain("openstreetmap.org/directions");
  });

  it("keeps proactive booking lookup read-only", async () => {
    const result = await executeTool("bookings_lookup", { query: "Sevilla" });
    expect(result).toContain("Calendar and trip data were left untouched");
    expect(mock.createICloudEvent).not.toHaveBeenCalled();
    expect(mock.convexMutation.mock.calls.every(([path]) => path === "ui:setPanel" || path === "chatQueue:postCard")).toBe(true);
  });

  it("keeps the exact niche follow-up on Sevilla without requiring the model to repeat the city", async () => {
    const result = await executeTool("travel_map", {
      query: "attractions in the city",
      preferences: "I'm not looking for touristy stuff; give me something more niche",
    });

    expect(result).toContain("Interactive OpenStreetMap opened for Sevilla");
    expect(mock.convexQuery).toHaveBeenCalledWith("currentState:getActive", {
      key: "profile.current_location",
    });
    const panelCall = mock.convexMutation.mock.calls.find(([path]) => path === "ui:setPanel");
    const panel = JSON.parse(String(panelCall?.[1]?.value));
    expect(panel).toMatchObject({
      kind: "places",
      activeTool: "travel_map",
      locationLabel: "Sevilla",
      center: { label: "Sevilla", source: "current_state" },
      preferences: "I'm not looking for touristy stuff; give me something more niche",
    });
  });

  it("derives a map centre and scoped POI search only from a confirmed active Gmail stay", async () => {
    mock.convexQuery.mockImplementation(async (path: string) => {
      if (path === "currentState:getActive" || path === "ui:getLocation") return null;
      return "thread-1";
    });
    const now = Date.now();
    mock.lookupBookings.mockResolvedValue([{
      id: "gmail-active-stay",
      kind: "stay",
      title: "🏨 Hotel Current · confirmed",
      provider: "Booking",
      bookingName: "Hotel Current",
      location: "Calle Active 12, Sevilla, Spain",
      start: now - 60 * 60_000,
      end: now + 60 * 60_000,
      allDay: false,
      marker: "jarvis-gmail-booking:gmail-active-stay",
    }]);
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const query = new URL(String(url)).searchParams.get("q") ?? "";
      if (query.includes("Calle Active")) {
        return new Response(JSON.stringify([osmPlace("Hotel Current", "Calle Active 12, Sevilla", 37.386, -5.9902)]), { status: 200 });
      }
      return new Response(JSON.stringify([
        osmPlace("Galería Local", "Sevilla, Spain", 37.3855, -6.006),
        osmPlace("Sala Pequeña", "Sevilla, Spain", 37.394, -5.993),
      ]), { status: 200 });
    }));

    const result = await executeTool("travel_map", {
      query: "quiet galleries",
      include_bookings: true,
      route: true,
    });

    expect(result).toContain("confirmed active Gmail stay");
    const requests = vi.mocked(fetch).mock.calls.map(([url]) => new URL(String(url)).searchParams.get("q") ?? "");
    expect(requests).toContain("Calle Active 12, Sevilla, Spain");
    expect(requests.some((query) => query.includes("quiet galleries") && query.includes("Calle Active 12"))).toBe(true);
    const panelCall = mock.convexMutation.mock.calls.find(([path]) => path === "ui:setPanel");
    const panel = JSON.parse(String(panelCall?.[1]?.value));
    expect(panel).toMatchObject({
      center: { label: "Hotel Current", source: "gmail_current_stay" },
      base: { label: "Hotel Current", source: "Read-only Gmail current stay" },
      booking: { requested: true, status: "current_stay" },
    });
  });

  it("never derives location from future or expired Gmail stays", async () => {
    mock.convexQuery.mockImplementation(async (path: string) => {
      if (path === "currentState:getActive" || path === "ui:getLocation") return null;
      return "thread-1";
    });
    const now = Date.now();
    mock.lookupBookings.mockResolvedValue([
      {
        id: "gmail-future-stay", kind: "stay", title: "🏨 Future · confirmed", provider: "Booking",
        location: "Future Road 1, Sevilla", start: now + 60 * 60_000, end: now + 2 * 60 * 60_000, allDay: false,
        marker: "jarvis-gmail-booking:gmail-future-stay",
      },
      {
        id: "gmail-expired-stay", kind: "stay", title: "🏨 Past · confirmed", provider: "Booking",
        location: "Past Road 1, Sevilla", start: now - 3 * 60 * 60_000, end: now - 60 * 60_000, allDay: false,
        marker: "jarvis-gmail-booking:gmail-expired-stay",
      },
    ]);

    const result = await executeTool("travel_map", { query: "attractions", include_bookings: true });

    expect(result).toContain("I don't have a usable current location yet");
    expect(mock.convexMutation).not.toHaveBeenCalledWith("ui:setPanel", expect.anything());
  });

  it("never claims a Gmail booking base when booking lookup is unavailable", async () => {
    mock.lookupBookings.mockRejectedValueOnce(new Error("oauth unavailable"));

    const result = await executeTool("travel_map", {
      location: "Sevilla",
      query: "niche local places",
      route: true,
      include_bookings: true,
      travel_mode: "walking",
    });

    expect(result).toContain("Gmail booking lookup was unavailable");
    expect(result).toContain("Do not claim or imply that a booking address was used");
    const panelCall = mock.convexMutation.mock.calls.find(([path]) => path === "ui:setPanel");
    const panel = JSON.parse(String(panelCall?.[1]?.value));
    expect(panel).toMatchObject({
      kind: "places",
      booking: { requested: true, status: "unavailable" },
      route: { mode: "walking" },
    });
    expect(panel.base).toBeUndefined();
  });

  it("keeps booking imports read-only even when a calendar sync is explicitly requested", async () => {
    const result = await executeTool("bookings_check", { sync_calendar: true });

    expect(result).toContain("no events were created");
    expect(result).toContain("protected owner-approval flow");
    expect(mock.createICloudEvent).not.toHaveBeenCalled();
    const panelCall = mock.convexMutation.mock.calls.find(([path]) => path === "ui:setPanel");
    const panel = JSON.parse(String(panelCall?.[1]?.value));
    expect(panel.calendarAdded).toBe(0);
  });

  it("uses rate-limited OpenStreetMap without a paid-provider fallback", async () => {
    const result = await executeTool("travel_map", {
      location: "Sevilla",
      query: "niche local places",
    });

    expect(result).toContain("Interactive OpenStreetMap opened for Sevilla");
    const panelCall = mock.convexMutation.mock.calls.find(([path]) => path === "ui:setPanel");
    const panel = JSON.parse(String(panelCall?.[1]?.value));
    expect(panel.provider).toBe("openstreetmap");
    expect(panel.center).toMatchObject({ source: "openstreetmap" });
    expect(panel.items).toContainEqual(expect.objectContaining({ provider: "openstreetmap" }));
  });


});
