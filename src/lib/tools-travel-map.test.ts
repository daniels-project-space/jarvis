import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { extractGoogleCalendarApproval } from "./sanitize";
import { executeTool, TOOL_DEFS } from "./tools";

afterEach(() => {
  delete process.env.GOOGLE_TOKEN_ENCRYPTION_KEY;
});

function osmPlace(name: string, address: string, lat: number, lng: number) {
  return { name, display_name: address, lat: String(lat), lon: String(lng), type: "attraction" };
}

describe("travel_map tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const now = Date.now();
    mock.convexQuery.mockImplementation(async (path: string) =>
      path === "currentState:getActive" ? { value: "Sevilla", observedAt: now } : "thread-1",
    );
    mock.convexMutation.mockResolvedValue(undefined);
    mock.lookupBookings.mockResolvedValue([{
      id: "gmail-booking-1",
      kind: "stay",
      title: "🏨 Hotel Casa 1800 Sevilla · confirmed",
      provider: "Booking",
      bookingName: "Hotel Casa 1800 Sevilla",
      location: "Rodrigo Caro, 6, 41004 Sevilla, Spain",
      start: now + 24 * 60 * 60_000,
      end: now + 4 * 24 * 60 * 60_000,
      timeZone: "Europe/Madrid",
      allDay: false,
      marker: "jarvis-gmail-booking:gmail-booking-1",
    }]);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.hostname === "routing.openstreetmap.de") {
        return new Response(JSON.stringify({
          code: "Ok",
          routes: [{
            distance: 2150,
            duration: 1430,
            geometry: { coordinates: [[-5.9902, 37.386], [-5.997, 37.387], [-6.006, 37.3855], [-5.993, 37.394], [-5.997, 37.401]] },
            legs: [
              { distance: 600, duration: 400 },
              { distance: 820, duration: 530 },
              { distance: 730, duration: 500 },
            ],
          }],
        }), { status: 200 });
      }
      const query = url.searchParams.get("q") ?? "";
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
      travel_mode: "walking",
    });

    expect(result).toContain("Interactive OpenStreetMap opened for Sevilla");
    expect(result).toContain("Opening hours and entry prices are shown only when OpenStreetMap tags them");
    expect(result).toContain("about 24 minutes across 3 legs");
    expect(result).toContain("read-only booked-location reference");
    expect(mock.lookupBookings).toHaveBeenCalledWith({ days: 730, maxResults: 24 });
    const requests = vi.mocked(fetch).mock.calls.map(([url]) => new URL(String(url)));
    expect(requests.some((url) => url.hostname === "nominatim.openstreetmap.org")).toBe(true);
    expect(requests.some((url) => url.hostname === "routing.openstreetmap.de")).toBe(true);

    const panelCall = mock.convexMutation.mock.calls.find(([path]) => path === "ui:setPanel");
    expect(panelCall).toBeTruthy();
    const panel = JSON.parse(String(panelCall?.[1]?.value));
    expect(panel).toMatchObject({
      kind: "places",
      locationLabel: "Sevilla",
      provider: "openstreetmap",
      center: { label: "Sevilla", source: "openstreetmap" },
      base: { label: "Hotel Casa 1800 Sevilla", source: "Read-only Gmail booking" },
      booking: { requested: true, status: "matched", stayStatus: "upcoming" },
      route: { mode: "walking" },
    });
    expect(panel.items).toHaveLength(3);
    expect(panel.route.coordinates).toHaveLength(5);
    expect(panel.route.durationSeconds).toBe(1430);
    expect(panel.route.legs).toHaveLength(3);
    expect(panel.route.directionsUrl).toContain("openstreetmap.org/directions");
  });

  it("refreshes a time-valid booked stay as a city reference even without a route", async () => {
    const result = await executeTool("travel_map", {
      location: "Sevilla",
      query: "quiet galleries",
    });

    expect(result).toContain("booked-location reference");
    expect(mock.lookupBookings).toHaveBeenCalledWith({ days: 730, maxResults: 24 });
    const panelCall = mock.convexMutation.mock.calls.find(([path]) => path === "ui:setPanel");
    const panel = JSON.parse(String(panelCall?.[1]?.value));
    expect(panel).toMatchObject({
      base: {
        label: "Hotel Casa 1800 Sevilla",
        source: "Read-only Gmail booking",
        stayStatus: "upcoming",
        timeZone: "Europe/Madrid",
      },
      booking: { requested: true, status: "matched", stayStatus: "upcoming" },
    });
    expect(panel.base.start).toEqual(expect.any(Number));
    expect(panel.base.checkedAt).toEqual(expect.any(Number));
    expect(panel.route).toBeUndefined();
  });

  it("tries a small ranked set and shows only the time-valid stay verified in this city", async () => {
    const now = Date.now();
    mock.lookupBookings.mockResolvedValue([
      {
        id: "gmail-active-other-city", kind: "stay", title: "🏨 Elsewhere · confirmed", provider: "Booking",
        bookingName: "Outside Hotel", location: "Outside Road 1, London, England",
        start: now - 60 * 60_000, end: now + 60 * 60_000, allDay: false,
        marker: "jarvis-gmail-booking:gmail-active-other-city",
      },
      {
        id: "gmail-local-alias", kind: "stay", title: "🏨 City stay · confirmed", provider: "Booking",
        bookingName: "Calle Local Hotel", location: "Calle Local 7, Sevilla, Spain",
        start: now + 24 * 60 * 60_000, end: now + 3 * 24 * 60 * 60_000, allDay: false,
        marker: "jarvis-gmail-booking:gmail-local-alias",
      },
    ]);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const query = url.searchParams.get("q") ?? "";
      if (query === "Seville") return new Response(JSON.stringify([osmPlace("Sevilla", "Sevilla, Spain", 37.3891, -5.9845)]), { status: 200 });
      if (query.includes("Outside Road")) return new Response(JSON.stringify([osmPlace("Outside Hotel", "London, England", 51.5072, -0.1276)]), { status: 200 });
      if (query.includes("Calle Local")) return new Response(JSON.stringify([osmPlace("Calle Local Hotel", "Calle Local 7, Sevilla", 37.386, -5.9902)]), { status: 200 });
      return new Response(JSON.stringify([osmPlace("Local Gallery", "Sevilla, Spain", 37.3855, -6.006)]), { status: 200 });
    }));

    await executeTool("travel_map", { location: "Seville", query: "galleries" });

    const panelCall = mock.convexMutation.mock.calls.find(([path]) => path === "ui:setPanel");
    const panelText = String(panelCall?.[1]?.value);
    const panel = JSON.parse(panelText);
    expect(panel.base).toMatchObject({ label: "Calle Local Hotel", stayStatus: "upcoming" });
    expect(panelText).not.toContain("Outside Hotel");
    expect(vi.mocked(fetch).mock.calls.map(([url]) => new URL(String(url)).searchParams.get("q"))).toEqual(expect.arrayContaining([
      "Outside Road 1, London, England",
      "Calle Local 7, Sevilla, Spain",
    ]));
  });

  it("carries only exact OpenStreetMap-backed attraction sources into the map card", async () => {
    const city = "Jarvis Source City 204";
    const exactArticle = "Real Alcázar de Sevilla";
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.hostname === "nominatim.openstreetmap.org") {
        if (url.searchParams.get("q") === city) {
          return new Response(JSON.stringify([osmPlace(city, `${city}, Spain`, 37.3891, -5.9845)]), { status: 200 });
        }
        return new Response(JSON.stringify([{
          ...osmPlace("Real Alcázar de Sevilla", "Plaza del Triunfo, Sevilla", 37.383, -5.99),
          extratags: {
            wikipedia: `es:${exactArticle}`,
            opening_hours: "Oct-Mar: 09:30-17:00; Apr-Sep: 09:30-19:00",
            website: "https://www.alcazarsevilla.org/",
            charge: "18 EUR",
          },
        }]), { status: 200 });
      }
      if (url.hostname === "es.wikipedia.org") {
        expect(url.pathname).toBe("/w/api.php");
        expect(url.searchParams.get("action")).toBe("query");
        expect(url.searchParams.get("titles")).toBe(exactArticle);
        expect(url.searchParams.get("list")).toBeNull();
        expect(url.searchParams.get("generator")).toBeNull();
        return new Response(JSON.stringify({
          query: {
            pages: [{
              title: exactArticle,
              fullurl: "https://es.wikipedia.org/wiki/Real_Alc%C3%A1zar_de_Sevilla",
              thumbnail: { source: "https://upload.wikimedia.org/example/alcazar.jpg" },
            }],
          },
        }), { status: 200 });
      }
      throw new Error(`unexpected public source: ${url.hostname}`);
    }));

    const result = await executeTool("travel_map", {
      location: city,
      query: "historic attractions",
      include_bookings: false,
    });

    expect(result).toContain("entry prices are shown only when OpenStreetMap tags them");
    const panelCall = mock.convexMutation.mock.calls.find(([path]) => path === "ui:setPanel");
    const panel = JSON.parse(String(panelCall?.[1]?.value));
    expect(panel.items[0]).toMatchObject({
      openingHours: "Oct-Mar: 09:30-17:00; Apr-Sep: 09:30-19:00",
      websiteUrl: "https://www.alcazarsevilla.org/",
      wikipedia: {
        language: "es",
        title: exactArticle,
        articleUrl: "https://es.wikipedia.org/wiki/Real_Alc%C3%A1zar_de_Sevilla",
      },
      wikipediaArticle: {
        title: exactArticle,
        articleUrl: "https://es.wikipedia.org/wiki/Real_Alc%C3%A1zar_de_Sevilla",
        thumbnailUrl: "https://upload.wikimedia.org/example/alcazar.jpg",
        attribution: "Wikipedia (es) · image via Wikimedia",
      },
    });
    expect(panel.items[0].charge).toBe("18 EUR");
    expect(JSON.stringify(panel)).toContain("18 EUR");
    const sources = vi.mocked(fetch).mock.calls.map(([url]) => new URL(String(url)).hostname);
    expect(sources.filter((hostname) => hostname === "es.wikipedia.org")).toHaveLength(1);
  });

  it("keeps proactive booking lookup read-only", async () => {
    const result = await executeTool("bookings_lookup", { query: "Sevilla" });
    expect(result).toContain("Calendar and trip data were left untouched");
    expect(mock.createICloudEvent).not.toHaveBeenCalled();
    expect(mock.convexMutation.mock.calls.every(([path]) => path === "ui:setPanel" || path === "chatQueue:postCard")).toBe(true);
  });

  it("keeps the exact niche follow-up on Sevilla without requiring the model to repeat the city", async () => {
    const observedAt = Date.now() - 1_000;
    mock.convexQuery.mockImplementation(async (path: string) =>
      path === "currentState:getActive" ? { value: "Sevilla", observedAt } : "thread-1",
    );
    const result = await executeTool("travel_map", {
      query: "attractions in the city",
      preferences: "I'm not looking for touristy stuff; give me something more niche",
      include_bookings: false,
    });
    console.log("LOCATION DEBUG", vi.mocked(fetch).mock.calls.map(([input]) => String(input)));

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
      center: { label: "Sevilla", source: "current_state", capturedAt: observedAt },
      preferences: "I'm not looking for touristy stuff; give me something more niche",
    });
  });

  it("uses a newer live device location instead of an older conversational city", async () => {
    const now = Date.now();
    mock.convexQuery.mockImplementation(async (path: string) => {
      if (path === "currentState:getActive") return { value: "Sevilla", observedAt: now - 10 * 60_000 };
      if (path === "ui:getLocation") return { value: "51.5074,-0.1278", updatedAt: now - 60_000 };
      return "thread-1";
    });

    const result = await executeTool("travel_map", { query: "quiet bookshops", include_bookings: false });

    expect(result).toContain("Interactive OpenStreetMap opened for Live device location");
    expect(mock.lookupBookings).not.toHaveBeenCalled();
    const panelCall = mock.convexMutation.mock.calls.find(([path]) => path === "ui:setPanel");
    const panel = JSON.parse(String(panelCall?.[1]?.value));
    expect(panel.center).toMatchObject({
      lat: 51.5074,
      lng: -0.1278,
      label: "Live device location",
      source: "saved_location",
      capturedAt: now - 60_000,
    });
  });

  it("fails closed for stale device coordinates in literal near-me searches", async () => {
    mock.convexQuery.mockImplementation(async (path: string) =>
      path === "ui:getLocation"
        ? { value: "51.5074,-0.1278", updatedAt: Date.now() - 16 * 60_000 }
        : "thread-1",
    );

    const result = await executeTool("places_near", { query: "pizza" });

    expect(result).toContain("live location is out of date");
    expect(mock.lookupBookings).not.toHaveBeenCalled();
    expect(mock.convexMutation).not.toHaveBeenCalledWith("ui:setPanel", expect.anything());
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
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

  it("keeps Gmail read-only while a calendar sync only creates an owner approval", async () => {
    process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 8).toString("base64");
    const result = await executeTool("bookings_check", { sync_calendar: true });

    expect(result).toContain("Ready for your approval");
    expect(extractGoogleCalendarApproval(result)).toBeTruthy();
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
