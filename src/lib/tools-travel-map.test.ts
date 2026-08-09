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

function place(name: string, address: string, lat: number, lng: number) {
  return {
    displayName: { text: name },
    formattedAddress: address,
    location: { latitude: lat, longitude: lng },
    rating: 4.7,
    userRatingCount: 120,
    googleMapsUri: `https://maps.google.com/?q=${encodeURIComponent(name)}`,
  };
}

describe("travel_map tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.getSecret.mockResolvedValue("places-key");
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
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.textQuery === "Sevilla") {
        return new Response(JSON.stringify({ places: [place("Sevilla", "Sevilla, Spain", 37.3891, -5.9845)] }), { status: 200 });
      }
      if (body.textQuery.includes("Rodrigo Caro")) {
        return new Response(JSON.stringify({ places: [place("Hotel Casa 1800 Sevilla", "Rodrigo Caro, 6, Sevilla", 37.386, -5.9902)] }), { status: 200 });
      }
      return new Response(JSON.stringify({ places: [
        place("Centro Cerámica Triana", "Calle Callao, Sevilla", 37.3855, -6.006),
        place("Caótica", "Calle José Gestoso, Sevilla", 37.394, -5.993),
        place("Espacio Santa Clara", "Calle Becas, Sevilla", 37.401, -5.997),
      ] }), { status: 200 });
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

    expect(result).toContain("Interactive map opened for Sevilla");
    expect(result).toContain("read-only Gmail booking base");
    expect(mock.lookupBookings).toHaveBeenCalledWith({ days: 730, maxResults: 24 });
    const requestBodies = vi.mocked(fetch).mock.calls.map(([, init]) => JSON.parse(String(init?.body ?? "{}")));
    expect(requestBodies.every((body) => !("regionCode" in body))).toBe(true);

    const panelCall = mock.convexMutation.mock.calls.find(([path]) => path === "ui:setPanel");
    expect(panelCall).toBeTruthy();
    const panel = JSON.parse(String(panelCall?.[1]?.value));
    expect(panel).toMatchObject({
      kind: "places",
      locationLabel: "Sevilla",
      center: { label: "Sevilla", source: "google_places" },
      base: { label: "Hotel Casa 1800 Sevilla", source: "Read-only Gmail booking" },
      booking: { requested: true, status: "matched" },
      route: { mode: "walking" },
    });
    expect(panel.items).toHaveLength(3);
    expect(panel.route.coordinates).toHaveLength(4);
    expect(panel.route.googleMapsUrl).toContain("google.com/maps/dir/");
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

    expect(result).toContain("Interactive map opened for Sevilla");
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
});
