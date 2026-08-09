import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mock = vi.hoisted(() => ({
  convexMutation: vi.fn(),
  convexQuery: vi.fn(),
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
  createICloudEvent: vi.fn(),
  deleteICloudEvent: vi.fn(),
  findICloudEvents: vi.fn(),
  listICloudEvents: vi.fn(),
}));

import { executeTool, TOOL_DEFS } from "./tools";

describe("weather tool current-location fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.convexQuery.mockImplementation(async (path: string) =>
      path === "currentState:getActive" ? { value: "Sevilla" } : "thread-1",
    );
    mock.convexMutation.mockResolvedValue(undefined);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("geocoding-api.open-meteo.com")) {
        return new Response(JSON.stringify({
          results: [{ name: "Sevilla", country_code: "ES", latitude: 37.3891, longitude: -5.9845 }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        current: {
          temperature_2m: 31.4,
          apparent_temperature: 32.1,
          weather_code: 0,
          wind_speed_10m: 9.2,
          relative_humidity_2m: 31,
        },
        hourly: {
          time: ["2026-08-09T12:00"],
          temperature_2m: [31.4],
          weather_code: [0],
          precipitation_probability: [0],
        },
        daily: {
          time: ["2026-08-09"],
          weather_code: [0],
          temperature_2m_max: [37.1],
          temperature_2m_min: [21.2],
          precipitation_probability_max: [0],
        },
      }), { status: 200 });
    }));
  });

  it("uses durable current state when the model omits location and renders the weather panel", async () => {
    const definition = TOOL_DEFS.find((tool) => tool.name === "weather");
    expect(definition?.description).toContain("saved current location");

    const result = await executeTool("weather", {});

    expect(result).toContain("Sevilla, ES");
    expect(mock.convexQuery).toHaveBeenCalledWith("currentState:getActive", {
      key: "profile.current_location",
    });
    expect(vi.mocked(fetch).mock.calls[0]?.[0].toString()).toContain("name=Sevilla");
    const panelCall = mock.convexMutation.mock.calls.find(([path]) => path === "ui:setPanel");
    const panel = JSON.parse(String(panelCall?.[1]?.value));
    expect(panel).toMatchObject({ kind: "weather", place: "Sevilla, ES", lat: 37.3891, lng: -5.9845 });
  });
});
