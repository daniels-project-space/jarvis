import { describe, expect, it } from "vitest";
import { extractGoogleCalendarApproval, sanitizeAssistantText, stripGoogleCalendarApproval } from "./sanitize";

const token = `${"a".repeat(32)}.${"b".repeat(43)}`;
const marker = `[JARVIS_GOOGLE_CALENDAR_APPROVAL:${token}]`;

describe("assistant text sanitization", () => {
  it("keeps the calendar approval receipt out of chat, speech, and host text while retaining it for the button", () => {
    const text = `Ready to add the event.\n${marker}`;

    expect(extractGoogleCalendarApproval(text)).toBe(token);
    expect(stripGoogleCalendarApproval(text)).toBe("Ready to add the event.");
    expect(sanitizeAssistantText(text)).toBe("Ready to add the event.");
  });
});
