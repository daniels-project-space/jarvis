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
  getIcs?: string;
  getEtag?: string;
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
      return new Response("", { status: options.putStatus, headers: options.putEtag ? { ETag: options.putEtag } : undefined });
    }
    if (request.method === "GET" && url === EVENT_URL) {
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
});
