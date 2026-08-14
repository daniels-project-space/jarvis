import { afterEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  accessToken: vi.fn(async () => "calendar-test-token"),
}));

vi.mock("server-only", () => ({}));
vi.mock("./google-oauth", () => ({ getGoogleAccessTokenForScopes: mock.accessToken }));

import {
  createGooglePrimaryCalendarEvent,
  deleteManagedGooglePrimaryCalendarEvent,
  getManagedGooglePrimaryCalendarEvent,
  listGooglePrimaryCalendarEvents,
  updateManagedGooglePrimaryCalendarEvent,
} from "./google-calendar";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  mock.accessToken.mockClear();
});

const start = Date.UTC(2026, 7, 20, 9, 0);
const end = Date.UTC(2026, 7, 20, 10, 0);

function remoteEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "jarvisabcdef0123456789",
    summary: "Planning session",
    start: { dateTime: new Date(start).toISOString() },
    end: { dateTime: new Date(end).toISOString() },
    status: "confirmed",
    ...overrides,
  };
}

describe("Google Calendar primary-calendar boundary", () => {
  it("bounds reads before loading an OAuth token", async () => {
    await expect(listGooglePrimaryCalendarEvents({
      start,
      end: start + 32 * 86_400_000,
    })).rejects.toThrow(/31-day window/i);
    expect(mock.accessToken).not.toHaveBeenCalled();
  });

  it("lists only the primary calendar with a bounded selected response", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ items: [remoteEvent()] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listGooglePrimaryCalendarEvents({ start, end, maxResults: 2 })).resolves.toEqual([
      expect.objectContaining({ id: "jarvisabcdef0123456789", title: "Planning session", allDay: false }),
    ]);

    const [input] = fetchMock.mock.calls[0] as unknown as [URL];
    const url = new URL(String(input));
    expect(url.pathname).toBe("/calendar/v3/calendars/primary/events");
    expect(url.searchParams.get("maxResults")).toBe("2");
    expect(url.searchParams.get("singleEvents")).toBe("true");
    expect(url.searchParams.get("fields")).toContain("items(id,summary,start,end");
  });

  it("creates a deterministic, non-inviting primary event without sending updates", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(remoteEvent()), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await createGooglePrimaryCalendarEvent({
      title: "Planning session",
      start,
      end,
      allDay: false,
      location: "Studio",
      notes: "Discuss launch plans",
      reminderMinutesBefore: 15,
    });

    expect(result.created).toBe(true);
    const [input, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    const url = new URL(String(input));
    expect(url.pathname).toBe("/calendar/v3/calendars/primary/events");
    expect(url.searchParams.get("sendUpdates")).toBe("none");
    expect(url.searchParams.get("conferenceDataVersion")).toBe("0");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.id).toMatch(/^jarvis[a-v0-9]{64}$/);
    expect(body.attendees).toBeUndefined();
    expect(body.conferenceData).toBeUndefined();
    expect(body.extendedProperties).toMatchObject({ private: { jarvisManaged: "jarvis-google-calendar-v1" } });
  });

  it("turns a post-commit retry into a verified idempotent result", async () => {
    let createdBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        createdBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(null, { status: 409 });
      }
      return new Response(JSON.stringify({
        ...remoteEvent({ id: createdBody!.id }),
        extendedProperties: createdBody!.extendedProperties,
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(createGooglePrimaryCalendarEvent({
      title: "Planning session",
      start,
      end,
      allDay: false,
    })).resolves.toMatchObject({ created: false, event: { id: expect.stringMatching(/^jarvis/) } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refuses to delete an event without Jarvis's private management marker", async () => {
    const eventId = "jarvisabcdef0123456789";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(remoteEvent({ id: eventId })), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(deleteManagedGooglePrimaryCalendarEvent(eventId, "\"revision-1\"")).rejects.toThrow(/managed Google Calendar event/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mock.accessToken).toHaveBeenCalledTimes(1);
  });

  it("only exposes a managed event after provider-marker verification", async () => {
    const eventId = "jarvisabcdef0123456789";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(remoteEvent({
      id: eventId,
      etag: "\"revision-1\"",
      extendedProperties: { private: { jarvisManaged: "jarvis-google-calendar-v1" } },
    })), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getManagedGooglePrimaryCalendarEvent(eventId)).resolves.toMatchObject({
      event: { id: eventId, title: "Planning session" },
      etag: "\"revision-1\"",
    });
  });

  it("updates only a revision-matched managed event without sending invitations", async () => {
    const eventId = "jarvisabcdef0123456789";
    const managed = remoteEvent({
      id: eventId,
      etag: "\"revision-1\"",
      extendedProperties: { private: { jarvisManaged: "jarvis-google-calendar-v1", jarvisDedupeKey: "keep" } },
    });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return new Response(JSON.stringify(remoteEvent({ ...managed, summary: "Rescheduled", etag: "\"revision-2\"" })), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(managed), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(updateManagedGooglePrimaryCalendarEvent({
      eventId,
      expectedEtag: "\"revision-1\"",
      event: { title: "Rescheduled", start, end, allDay: false, location: "Studio" },
    })).resolves.toMatchObject({ event: { id: eventId, title: "Rescheduled" } });

    const [input, init] = fetchMock.mock.calls[1] as unknown as [URL, RequestInit];
    const url = new URL(String(input));
    expect(url.pathname).toBe(`/calendar/v3/calendars/primary/events/${eventId}`);
    expect(url.searchParams.get("sendUpdates")).toBe("none");
    expect(new Headers(init.headers).get("if-match")).toBe("\"revision-1\"");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.attendees).toBeUndefined();
    expect(body.extendedProperties).toMatchObject({ private: { jarvisManaged: "jarvis-google-calendar-v1", jarvisDedupeKey: "keep" } });
  });

  it("rejects a stale approval before issuing a provider write", async () => {
    const eventId = "jarvisabcdef0123456789";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(remoteEvent({
      id: eventId,
      etag: "\"revision-2\"",
      extendedProperties: { private: { jarvisManaged: "jarvis-google-calendar-v1" } },
    })), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(updateManagedGooglePrimaryCalendarEvent({
      eventId,
      expectedEtag: "\"revision-1\"",
      event: { title: "Rescheduled", start, end, allDay: false },
    })).rejects.toThrow(/changed after the approval was prepared/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("deletes only a revision-matched managed event without sending invitations", async () => {
    const eventId = "jarvisabcdef0123456789";
    const managed = remoteEvent({
      id: eventId,
      etag: "\"revision-1\"",
      extendedProperties: { private: { jarvisManaged: "jarvis-google-calendar-v1" } },
    });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return new Response(JSON.stringify(managed), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(deleteManagedGooglePrimaryCalendarEvent(eventId, "\"revision-1\"")).resolves.toEqual({ id: eventId, deleted: true });
    const [, init] = fetchMock.mock.calls[1] as unknown as [URL, RequestInit];
    expect(new Headers(init.headers).get("if-match")).toBe("\"revision-1\"");
  });
});
