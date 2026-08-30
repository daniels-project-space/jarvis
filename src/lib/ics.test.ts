import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { parseIcsOccurrences, parseIcsVevents } from "./ics";

const RECURRING_CALENDAR = `BEGIN:VCALENDAR\r
VERSION:2.0\r
BEGIN:VTIMEZONE\r
TZID:Europe/London\r
BEGIN:DAYLIGHT\r
DTSTART:19700329T010000\r
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU\r
TZOFFSETFROM:+0000\r
TZOFFSETTO:+0100\r
END:DAYLIGHT\r
BEGIN:STANDARD\r
DTSTART:19701025T020000\r
RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU\r
TZOFFSETFROM:+0100\r
TZOFFSETTO:+0000\r
END:STANDARD\r
END:VTIMEZONE\r
BEGIN:VEVENT\r
UID:daily-focus@example.test\r
DTSTART;TZID=Europe/London:20260824T090000\r
DTEND;TZID=Europe/London:20260824T100000\r
RRULE:FREQ=DAILY;COUNT=10\r
EXDATE;TZID=Europe/London:20260826T090000\r
SUMMARY:Daily focus\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:daily-focus@example.test\r
RECURRENCE-ID;TZID=Europe/London:20260827T090000\r
DTSTART;TZID=Europe/London:20260827T120000\r
DTEND;TZID=Europe/London:20260827T130000\r
SUMMARY:Moved focus\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:daily-focus@example.test\r
RECURRENCE-ID;TZID=Europe/London:20260828T090000\r
DTSTART;TZID=Europe/London:20260828T090000\r
DTEND;TZID=Europe/London:20260828T100000\r
STATUS:CANCELLED\r
SUMMARY:Cancelled focus\r
END:VEVENT\r
END:VCALENDAR\r
`;

describe("iCalendar recurrence expansion", () => {
  it("expands the matching window, applies EXDATE, and uses moved exceptions", () => {
    const start = Date.parse("2026-08-25T00:00:00Z");
    const end = Date.parse("2026-08-29T00:00:00Z");

    const events = parseIcsOccurrences(RECURRING_CALENDAR, start, end);

    expect(events.map((event) => ({ title: event.title, start: new Date(event.start).toISOString() }))).toEqual([
      { title: "Daily focus", start: "2026-08-25T08:00:00.000Z" },
      { title: "Moved focus", start: "2026-08-27T11:00:00.000Z" },
    ]);
    expect(events.every((event) => event.start >= start && event.start < end)).toBe(true);
  });

  it("keeps the lightweight invitation parser unchanged for Gmail", () => {
    const [event] = parseIcsVevents(RECURRING_CALENDAR);

    expect(event).toMatchObject({
      uid: "daily-focus@example.test",
      title: "Daily focus",
      allDay: false,
    });
  });

  it("returns no occurrences for an invalid range", () => {
    expect(parseIcsOccurrences(RECURRING_CALENDAR, 10, 10)).toEqual([]);
  });
});
