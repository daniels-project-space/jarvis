import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const CALENDAR_URL = "https://caldav.icloud.com/123/calendars/home/";
const SOURCE_KEY = "a".repeat(64);
const NONCE = "calendarReceiptNonce_123456";
const EVENT_URL = `${CALENDAR_URL}jarvis-apple-maps-${SOURCE_KEY}@jarvis.ics`;

const principalResponse = `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">
  <D:response><D:href>/</D:href><D:propstat><D:prop><D:current-user-principal><D:href>/123/principal/</D:href></D:current-user-principal></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
</D:multistatus>`;
const homeResponse = `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response><D:href>/123/principal/</D:href><D:propstat><D:prop><C:calendar-home-set><D:href>/123/calendars/</D:href></C:calendar-home-set></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
</D:multistatus>`;
const calendarsResponse = `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response><D:href>/123/calendars/home/</D:href><D:propstat><D:prop><D:displayname>Home</D:displayname><D:resourcetype><C:calendar/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
</D:multistatus>`;

type FetchCall = { url: string; init: RequestInit };

function calendarEventIcs(revision = 99, nonce = NONCE): string {
  return [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    `X-JARVIS-APPLE-MAPS-SOURCE-KEY:${SOURCE_KEY}`,
    `X-JARVIS-APPLE-MAPS-REVISION:${revision}`,
    `X-JARVIS-APPLE-MAPS-NONCE:${nonce}`,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

function mockCalDav(options: {
  putStatus: number;
  putEtag?: string;
  putRedirect?: string;
  getIcs?: string;
  getEtag?: string;
  getRedirect?: string;
}) {
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const request = init ?? {};
    calls.push({ url, init: request });
    if (request.method === "PROPFIND" && url === "https://caldav.icloud.com/") {
      return new Response(principalResponse, { status: 207 });
    }
    if (request.method === "PROPFIND" && url === "https://caldav.icloud.com/123/principal/") {
      return new Response(homeResponse, { status: 207 });
    }
    if (request.method === "PROPFIND" && url === "https://caldav.icloud.com/123/calendars/") {
      return new Response(calendarsResponse, { status: 207 });
    }
    if (request.method === "PUT" && url === EVENT_URL) {
      if (options.putRedirect) return new Response("", { status: 302, headers: { Location: options.putRedirect } });
      return new Response("", { status: options.putStatus, headers: options.putEtag ? { ETag: options.putEtag } : undefined });
    }
    if (request.method === "GET" && url === EVENT_URL) {
      if (options.getRedirect) return new Response("", { status: 302, headers: { Location: options.getRedirect } });
      return new Response(options.getIcs ?? "", { status: options.getIcs === undefined ? 404 : 200, headers: options.getEtag ? { ETag: options.getEtag } : undefined });
    }
    throw new Error(`unexpected CalDAV request: ${request.method ?? "GET"} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

function travelInput(action: "create" | "update" = "create") {
  return {
    action,
    calendarUrl: CALENDAR_URL,
    sourceKey: SOURCE_KEY,
    revision: 99,
    nonce: NONCE,
    event: {
      title: "Apple Maps offline · Seville",
      start: 1_780_000_000_000,
      end: 1_780_001_800_000,
      allDay: false,
      location: "Seville",
      reminderMinutesBefore: 5,
    },
    ...(action === "update" ? { eventUrl: EVENT_URL, expectedEtag: '"etag-1"' } : {}),
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("ICLOUD_CALENDAR_APPLE_ID", "calendar-owner@example.test");
  vi.stubEnv("ICLOUD_CALENDAR_APP_PASSWORD", "test-app-password");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("iCloud saved-trip CalDAV writes", () => {
  it("creates the deterministic resource with If-None-Match and sealed provenance", async () => {
    const { calls } = mockCalDav({ putStatus: 201, putEtag: '"etag-1"' });
    const { writeICloudTravelCalendarEvent } = await import("./icloud-calendar");

    const result = await writeICloudTravelCalendarEvent(travelInput());

    expect(result).toMatchObject({
      created: true,
      eventUrl: EVENT_URL,
      calendarUrl: CALENDAR_URL,
      etag: '"etag-1"',
      revision: 99,
    });
    const put = calls.find((call) => call.init.method === "PUT");
    expect(put).toBeDefined();
    expect(new Headers(put?.init.headers).get("if-none-match")).toBe("*");
    const body = String(put?.init.body);
    expect(body).toContain(`X-JARVIS-APPLE-MAPS-SOURCE-KEY:${SOURCE_KEY}`);
    expect(body).toContain("X-JARVIS-APPLE-MAPS-REVISION:99");
    expect(body).toContain(`X-JARVIS-APPLE-MAPS-NONCE:${NONCE}`);
  });

  it("accepts a 412 only when a follow-up read proves this receipt's exact write", async () => {
    mockCalDav({ putStatus: 412, getIcs: calendarEventIcs(), getEtag: '"etag-1"' });
    const { writeICloudTravelCalendarEvent } = await import("./icloud-calendar");

    await expect(writeICloudTravelCalendarEvent(travelInput())).resolves.toMatchObject({
      created: false,
      eventUrl: EVENT_URL,
      etag: '"etag-1"',
    });
  });

  it("keeps a successful no-ETag create marked as newly created after exact verification", async () => {
    mockCalDav({ putStatus: 201, getIcs: calendarEventIcs(), getEtag: '"verified-etag"' });
    const { writeICloudTravelCalendarEvent } = await import("./icloud-calendar");

    await expect(writeICloudTravelCalendarEvent(travelInput())).resolves.toMatchObject({
      created: true,
      etag: '"verified-etag"',
    });
  });

  it("fails a foreign 412 and uses If-Match for an existing event update", async () => {
    mockCalDav({ putStatus: 412, getIcs: calendarEventIcs(98, "otherReceiptNonce_123456"), getEtag: '"etag-foreign"' });
    const first = await import("./icloud-calendar");

    await expect(first.writeICloudTravelCalendarEvent(travelInput())).rejects.toBeInstanceOf(first.ICloudCalendarConflictError);

    vi.resetModules();
    const { calls } = mockCalDav({ putStatus: 412, getIcs: calendarEventIcs(), getEtag: '"etag-2"' });
    const second = await import("./icloud-calendar");
    await expect(second.writeICloudTravelCalendarEvent(travelInput("update"))).resolves.toMatchObject({
      created: false,
      etag: '"etag-2"',
    });
    const put = calls.find((call) => call.init.method === "PUT");
    expect(new Headers(put?.init.headers).get("if-match")).toBe('"etag-1"');
    expect(new Headers(put?.init.headers).get("if-none-match")).toBeNull();
  });

  it("never follows an off-provider redirect with the iCloud credential", async () => {
    const calls: FetchCall[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response("", { status: 302, headers: { Location: "https://attacker.example/steal" } });
    }));
    const { resolveICloudTravelCalendar } = await import("./icloud-calendar");

    await expect(resolveICloudTravelCalendar()).rejects.toThrow(/outside its CalDAV service/i);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://caldav.icloud.com/");
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toMatch(/^Basic /);
  });

  it("rejects malformed provider locations before any authenticated request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { writeICloudTravelCalendarEvent } = await import("./icloud-calendar");

    for (const calendarUrl of [
      "https://caldav.icloud.com:444/123/calendars/home/",
      "https://calendar-owner@caldav.icloud.com/123/calendars/home/",
      "http://caldav.icloud.com/123/calendars/home/",
      "https://127.0.0.1/123/calendars/home/",
    ]) {
      await expect(writeICloudTravelCalendarEvent({ ...travelInput(), calendarUrl })).rejects.toThrow(/Calendar URL is invalid|outside its CalDAV service/i);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malicious principal, home, and calendar hrefs before credential replay", async () => {
    const scenarios = [
      {
        root: principalResponse.replace("/123/principal/", "https://attacker.example/principal/"),
        principal: homeResponse,
        calendars: calendarsResponse,
        expectedCalls: 1,
      },
      {
        root: principalResponse,
        principal: homeResponse.replace("/123/calendars/", "https://attacker.example/calendars/"),
        calendars: calendarsResponse,
        expectedCalls: 2,
      },
      {
        root: principalResponse,
        principal: homeResponse,
        calendars: calendarsResponse.replace("/123/calendars/home/", "https://attacker.example/calendars/home/"),
        expectedCalls: 3,
      },
    ];
    for (const scenario of scenarios) {
      vi.resetModules();
      const calls: FetchCall[] = [];
      vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init: init ?? {} });
        if (url === "https://caldav.icloud.com/") return new Response(scenario.root, { status: 207 });
        if (url === "https://caldav.icloud.com/123/principal/") return new Response(scenario.principal, { status: 207 });
        if (url === "https://caldav.icloud.com/123/calendars/") return new Response(scenario.calendars, { status: 207 });
        throw new Error(`unexpected request ${url}`);
      }));
      const { resolveICloudTravelCalendar } = await import("./icloud-calendar");
      await expect(resolveICloudTravelCalendar()).rejects.toThrow(/outside its CalDAV service/i);
      expect(calls).toHaveLength(scenario.expectedCalls);
      expect(calls.some((call) => call.url.includes("attacker.example"))).toBe(false);
    }
  });

  it("does not replay a sealed PUT or GET after a resource-changing redirect", async () => {
    const put = mockCalDav({ putStatus: 201, putRedirect: `${CALENDAR_URL}other.ics` });
    const first = await import("./icloud-calendar");
    await expect(first.writeICloudTravelCalendarEvent(travelInput())).rejects.toBeInstanceOf(first.ICloudCalendarConflictError);
    expect(put.calls.some((call) => call.url.endsWith("other.ics"))).toBe(false);

    vi.resetModules();
    const get = mockCalDav({ putStatus: 412, getRedirect: `${CALENDAR_URL}other.ics` });
    const second = await import("./icloud-calendar");
    await expect(second.writeICloudTravelCalendarEvent(travelInput())).rejects.toBeInstanceOf(second.ICloudCalendarConflictError);
    expect(get.calls.some((call) => call.url.endsWith("other.ics"))).toBe(false);
  });

  it("rejects wildcard and weak ETags for conditional travel writes", async () => {
    const { calls } = mockCalDav({ putStatus: 201, putEtag: 'W/"weak"', getIcs: calendarEventIcs(), getEtag: 'W/"weak"' });
    const { writeICloudTravelCalendarEvent, ICloudCalendarError } = await import("./icloud-calendar");

    await expect(writeICloudTravelCalendarEvent(travelInput("update") as any)).rejects.toBeInstanceOf(ICloudCalendarError);
    const putCallsAfterWeakResponse = calls.filter((call) => call.init.method === "PUT").length;
    await expect(writeICloudTravelCalendarEvent({ ...travelInput("update"), expectedEtag: "*" })).rejects.toBeInstanceOf(ICloudCalendarError);
    await expect(writeICloudTravelCalendarEvent({ ...travelInput("update"), expectedEtag: 'W/"etag-1"' })).rejects.toBeInstanceOf(ICloudCalendarError);
    expect(calls.filter((call) => call.init.method === "PUT")).toHaveLength(putCallsAfterWeakResponse);
  });
});
