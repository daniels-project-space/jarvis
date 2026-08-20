import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mock = vi.hoisted(() => ({
  convexMutation: vi.fn(),
  convexQuery: vi.fn(),
  googleOAuthReadiness: vi.fn(),
  issueCalendarApproval: vi.fn(() => "signed-calendar-receipt"),
  issueCalendarProposal: vi.fn(() => "signed-calendar-change-receipt"),
  googleCalendarCreate: vi.fn(),
  googleCalendarGetManaged: vi.fn(),
}));
vi.mock("./context", () => ({ convexMutation: mock.convexMutation, convexQuery: mock.convexQuery }));
vi.mock("./control-context", () => ({
  withAdminSession: async (_authTokenHash: unknown, operation: () => Promise<unknown>) => await operation(),
}));
vi.mock("./vault", () => ({ getSecret: vi.fn(), getServiceSecrets: vi.fn() }));
vi.mock("./booking-email", () => ({
  lookupGmailBookingsReadOnly: vi.fn(), scanGmailBookingConfirmations: vi.fn(),
}));
vi.mock("./icloud-calendar", () => ({
  createICloudEvent: vi.fn(), deleteICloudEvent: vi.fn(), findICloudEvents: vi.fn(), listICloudEvents: vi.fn(),
}));
vi.mock("./google-calendar", () => ({
  createGooglePrimaryCalendarEvent: mock.googleCalendarCreate,
  getManagedGooglePrimaryCalendarEvent: mock.googleCalendarGetManaged,
  listGooglePrimaryCalendarEvents: vi.fn(),
}));
vi.mock("./google-calendar-approval.server", () => ({
  issueGoogleCalendarApproval: mock.issueCalendarApproval,
  issueGoogleCalendarApprovalProposal: mock.issueCalendarProposal,
  googleCalendarApprovalMarker: (token: string) => `[JARVIS_GOOGLE_CALENDAR_APPROVAL:${token}]`,
}));
vi.mock("./google-oauth", () => ({
  googleOAuthStoredConnectionReadiness: mock.googleOAuthReadiness,
}));

import { executeTool } from "./tools";

describe("YouTube transcript handoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.convexMutation.mockResolvedValue(undefined);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("opens the existing non-autoplay video panel and reports that captions need an authorised source", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://www.youtube.com/oembed?")) {
        return Response.json({
          title: "Jarvis walkthrough",
          author_name: "OpenAI",
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetcher);

    await expect(executeTool("youtube_transcript", { video: "https://youtu.be/abcDEF12345" }))
      .resolves.toContain("do not have an authorised caption or transcript source");

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toMatch(/^https:\/\/www\.youtube\.com\/oembed\?/);
    expect(String(fetcher.mock.calls[0]?.[0])).not.toContain("youtubei/");

    expect(mock.convexMutation).toHaveBeenCalledWith("ui:setPanel", {
      type: "video",
      value: "https://www.youtube.com/embed/abcDEF12345?enablejsapi=1&rel=0",
      title: "YouTube video",
    });
    expect(mock.convexMutation.mock.calls[0]?.[1]?.value).not.toContain("autoplay");
  });

  it("keeps the video open but refuses content analysis when public metadata is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 503 })));

    await expect(executeTool("youtube_transcript", { video: "abcDEF12345" }))
      .resolves.toContain("cannot truthfully summarise or analyse its spoken content");

    expect(mock.convexMutation).toHaveBeenCalledWith("ui:setPanel", expect.objectContaining({
      type: "video",
      value: "https://www.youtube.com/embed/abcDEF12345?enablejsapi=1&rel=0",
    }));
  });
});

describe("Google Calendar creation approval boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.googleOAuthReadiness.mockResolvedValue("readable");
    mock.convexQuery.mockResolvedValue({ connected: true, capabilities: { calendar: true } });
    mock.issueCalendarApproval.mockReturnValue("signed-calendar-receipt");
    mock.issueCalendarProposal.mockReturnValue("signed-calendar-change-receipt");
    mock.googleCalendarGetManaged.mockResolvedValue({
      event: { id: "jarvisabcdef0123456789", title: "Planning session", start: "2026-08-20T09:00:00.000Z", end: "2026-08-20T10:00:00.000Z", allDay: false },
      etag: "\"revision-1\"",
    });
  });

  it("prepares a real-date event without writing until the owner clicks the receipt", async () => {
    const result = await executeTool("google_calendar_create", {
      title: "Planning session",
      date: "2026-08-20",
      time: "09:00",
      reminder_minutes_before: 15,
    });

    expect(result).toContain("Nothing has been added yet");
    expect(result).toContain("JARVIS_GOOGLE_CALENDAR_APPROVAL:signed-calendar-receipt");
    expect(mock.issueCalendarApproval).toHaveBeenCalledWith(expect.objectContaining({
      title: "Planning session", allDay: false, reminderMinutesBefore: 15,
    }));
    expect(mock.googleCalendarCreate).not.toHaveBeenCalled();
  });

  it("does not issue a receipt when Google OAuth runtime configuration is absent", async () => {
    mock.googleOAuthReadiness.mockResolvedValueOnce("not_configured");

    await expect(executeTool("google_calendar_create", {
      title: "Planning session",
      date: "2026-08-20",
      time: "09:00",
    })).resolves.toMatch(/not configured.*no approval receipt was created/i);

    expect(mock.convexQuery).not.toHaveBeenCalled();
    expect(mock.issueCalendarApproval).not.toHaveBeenCalled();
    expect(mock.googleCalendarCreate).not.toHaveBeenCalled();
  });

  it("does not issue a receipt when the saved Google connection needs reconnecting", async () => {
    mock.googleOAuthReadiness.mockResolvedValueOnce("needs_reconnect");

    await expect(executeTool("google_calendar_create", {
      title: "Planning session",
      date: "2026-08-20",
      time: "09:00",
    })).resolves.toMatch(/needs a reconnect.*no approval receipt was created/i);

    expect(mock.convexQuery).not.toHaveBeenCalled();
    expect(mock.issueCalendarApproval).not.toHaveBeenCalled();
    expect(mock.googleCalendarCreate).not.toHaveBeenCalled();
  });

  it("does not issue a receipt when the saved account lacks the limited Calendar scope", async () => {
    mock.convexQuery.mockResolvedValueOnce({ connected: true, capabilities: { calendar: false } });

    await expect(executeTool("google_calendar_create", {
      title: "Planning session",
      date: "2026-08-20",
      time: "09:00",
    })).resolves.toMatch(/needs a reconnect.*no approval receipt was created/i);

    expect(mock.issueCalendarApproval).not.toHaveBeenCalled();
    expect(mock.googleCalendarCreate).not.toHaveBeenCalled();
  });

  it("does not issue a receipt when the protected Calendar capability is malformed", async () => {
    mock.convexQuery.mockResolvedValueOnce({ connected: true, capabilities: { calendar: "yes" } });

    await expect(executeTool("google_calendar_create", {
      title: "Planning session",
      date: "2026-08-20",
      time: "09:00",
    })).resolves.toMatch(/could not be verified right now.*no approval receipt was created/i);

    expect(mock.issueCalendarApproval).not.toHaveBeenCalled();
    expect(mock.googleCalendarCreate).not.toHaveBeenCalled();
  });

  it("does not issue a receipt when the protected connection-status read resolves unavailable", async () => {
    mock.convexQuery.mockResolvedValueOnce(null);

    await expect(executeTool("google_calendar_create", {
      title: "Planning session",
      date: "2026-08-20",
      time: "09:00",
    })).resolves.toMatch(/could not be verified right now.*no approval receipt was created/i);

    expect(mock.convexQuery).toHaveBeenCalledWith("googleAuth:getConnectionStatus", {});
    expect(mock.issueCalendarApproval).not.toHaveBeenCalled();
    expect(mock.googleCalendarCreate).not.toHaveBeenCalled();
  });

  it("does not issue a receipt when the protected connection-status read rejects", async () => {
    mock.convexQuery.mockRejectedValueOnce(new Error("Convex unavailable"));

    await expect(executeTool("google_calendar_create", {
      title: "Planning session",
      date: "2026-08-20",
      time: "09:00",
    })).resolves.toMatch(/could not be verified right now.*no approval receipt was created/i);

    expect(mock.convexQuery).toHaveBeenCalledWith("googleAuth:getConnectionStatus", {});
    expect(mock.issueCalendarApproval).not.toHaveBeenCalled();
    expect(mock.googleCalendarCreate).not.toHaveBeenCalled();
  });

  it("rejects a calendar-looking date that does not exist", async () => {
    await expect(executeTool("google_calendar_create", {
      title: "Impossible date",
      date: "2026-02-31",
    })).resolves.toMatch(/real date/i);
    expect(mock.issueCalendarApproval).not.toHaveBeenCalled();
    expect(mock.googleCalendarCreate).not.toHaveBeenCalled();
  });

  it("rejects a nonexistent London wall-clock time instead of silently moving it over DST", async () => {
    await expect(executeTool("google_calendar_create", {
      title: "DST gap",
      date: "2026-03-29",
      time: "01:30",
    })).resolves.toMatch(/does not exist in Europe\/London/i);
    expect(mock.issueCalendarApproval).not.toHaveBeenCalled();
  });

  it("prepares a managed calendar update without writing until the owner clicks", async () => {
    const result = await executeTool("google_calendar_update", {
      event_id: "jarvisabcdef0123456789",
      title: "Rescheduled planning",
      date: "2026-08-20",
      time: "10:00",
    });

    expect(result).toContain("Ready for your approval: update Jarvis-managed");
    expect(result).toContain("JARVIS_GOOGLE_CALENDAR_APPROVAL:signed-calendar-change-receipt");
    expect(mock.googleCalendarGetManaged).toHaveBeenCalledWith("jarvisabcdef0123456789");
    expect(mock.issueCalendarProposal).toHaveBeenCalledWith(expect.objectContaining({
      action: "update", eventId: "jarvisabcdef0123456789", expectedEtag: "\"revision-1\"",
    }));
    expect(mock.googleCalendarCreate).not.toHaveBeenCalled();
  });

  it("prepares a managed calendar removal without writing until the owner clicks", async () => {
    const result = await executeTool("google_calendar_delete", { event_id: "jarvisabcdef0123456789" });

    expect(result).toContain("Ready for your approval: remove Jarvis-managed");
    expect(mock.issueCalendarProposal).toHaveBeenCalledWith({
      action: "delete", eventId: "jarvisabcdef0123456789", expectedEtag: "\"revision-1\"",
    });
    expect(mock.googleCalendarCreate).not.toHaveBeenCalled();
  });
});
