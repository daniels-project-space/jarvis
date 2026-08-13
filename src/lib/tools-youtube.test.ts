import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mock = vi.hoisted(() => ({
  convexMutation: vi.fn(),
  convexQuery: vi.fn(),
  issueCalendarApproval: vi.fn(() => "signed-calendar-receipt"),
  googleCalendarCreate: vi.fn(),
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
  listGooglePrimaryCalendarEvents: vi.fn(),
}));
vi.mock("./google-calendar-approval.server", () => ({
  issueGoogleCalendarApproval: mock.issueCalendarApproval,
  googleCalendarApprovalMarker: (token: string) => `[JARVIS_GOOGLE_CALENDAR_APPROVAL:${token}]`,
}));

import { executeTool } from "./tools";

describe("YouTube transcript handoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.convexMutation.mockResolvedValue(undefined);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("opens the existing non-autoplay video panel while fetching captions for a pasted URL", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("youtubei/v1/player")) {
        return Response.json({
          videoDetails: { title: "Jarvis walkthrough", author: "OpenAI" },
          captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: "en", baseUrl: "https://captions.example/en" }] } },
        });
      }
      if (url === "https://captions.example/en") {
        return new Response("<transcript><text start=\"0\">Hello &amp; welcome</text></transcript>");
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetcher);

    await expect(executeTool("youtube_transcript", { video: "https://youtu.be/abcDEF12345" }))
      .resolves.toContain("Hello & welcome");

    expect(mock.convexMutation).toHaveBeenCalledWith("ui:setPanel", {
      type: "video",
      value: "https://www.youtube.com/embed/abcDEF12345?enablejsapi=1&rel=0",
      title: "YouTube video",
    });
    expect(mock.convexMutation.mock.calls[0]?.[1]?.value).not.toContain("autoplay");
  });
});

describe("Google Calendar creation approval boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.issueCalendarApproval.mockReturnValue("signed-calendar-receipt");
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
});
