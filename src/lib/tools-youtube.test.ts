import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mock = vi.hoisted(() => ({
  convexMutation: vi.fn(),
  convexQuery: vi.fn(),
  iCloudConfigured: vi.fn(),
  issueICloudApproval: vi.fn(() => "signed-icloud-calendar-receipt"),
  iCloudCreate: vi.fn(),
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
  createICloudEvent: mock.iCloudCreate,
  deleteICloudEvent: vi.fn(),
  findICloudEvents: vi.fn(),
  listICloudEvents: vi.fn(),
  iCloudCalendarConfigured: mock.iCloudConfigured,
}));
vi.mock("./icloud-calendar-approval.server", () => ({
  issueICloudCalendarApproval: mock.issueICloudApproval,
  iCloudCalendarApprovalMarker: (token: string) => `[JARVIS_ICLOUD_CALENDAR_APPROVAL:${token}]`,
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

describe("iCloud Calendar creation approval boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.iCloudConfigured.mockReturnValue(true);
    mock.issueICloudApproval.mockReturnValue("signed-icloud-calendar-receipt");
  });

  it("prepares a real-date iCloud event without writing until the owner clicks the receipt", async () => {
    const result = await executeTool("icloud_calendar_create", {
      title: "Planning session",
      date: "2026-08-20",
      time: "09:00",
      reminder_minutes_before: 15,
    });

    expect(result).toContain("Nothing has been added yet");
    expect(result).toContain("JARVIS_ICLOUD_CALENDAR_APPROVAL:signed-icloud-calendar-receipt");
    expect(mock.issueICloudApproval).toHaveBeenCalledWith(expect.objectContaining({
      title: "Planning session", allDay: false, reminderMinutesBefore: 15,
    }));
    expect(mock.iCloudCreate).not.toHaveBeenCalled();
  });

  it("fails closed without an iCloud cloud-runtime credential pair", async () => {
    mock.iCloudConfigured.mockReturnValue(false);

    await expect(executeTool("icloud_calendar_create", {
      title: "Planning session",
      date: "2026-08-20",
      time: "09:00",
    })).resolves.toMatch(/not configured.*no approval receipt was created/i);

    expect(mock.issueICloudApproval).not.toHaveBeenCalled();
    expect(mock.iCloudCreate).not.toHaveBeenCalled();
  });

  it("rejects a nonexistent London wall-clock time before issuing an iCloud receipt", async () => {
    await expect(executeTool("icloud_calendar_create", {
      title: "DST gap",
      date: "2026-03-29",
      time: "01:30",
    })).resolves.toMatch(/does not exist in Europe\/London/i);

    expect(mock.issueICloudApproval).not.toHaveBeenCalled();
    expect(mock.iCloudCreate).not.toHaveBeenCalled();
  });
});
