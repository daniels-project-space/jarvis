import { describe, expect, it } from "vitest";
import {
  extractGmailSendApproval,
  extractGoogleCalendarApproval,
  hasAssistantApproval,
  sanitizeAssistantText,
  stripAssistantApprovals,
  stripGmailSendApproval,
  stripGoogleCalendarApproval,
} from "./sanitize";

const token = `${"a".repeat(32)}.${"b".repeat(43)}`;
const marker = `[JARVIS_GOOGLE_CALENDAR_APPROVAL:${token}]`;
const gmailToken = `${"c".repeat(64)}.${"d".repeat(43)}`;
const gmailMarker = `[jarvis-gmail-send-approval:${gmailToken}]`;

describe("assistant text sanitization", () => {
  it("keeps the calendar approval receipt out of chat, speech, and host text while retaining it for the button", () => {
    const text = `Ready to add the event.\n${marker}`;

    expect(extractGoogleCalendarApproval(text)).toBe(token);
    expect(stripGoogleCalendarApproval(text)).toBe("Ready to add the event.");
    expect(sanitizeAssistantText(text)).toBe("Ready to add the event.");
  });

  it("keeps a Gmail send receipt out of chat and retains it only for the owner approval button", () => {
    const text = `Your Gmail draft is ready.\n${gmailMarker}`;

    expect(extractGmailSendApproval(text)).toBe(gmailToken);
    expect(hasAssistantApproval(text)).toBe(true);
    expect(hasAssistantApproval("No approval needed.")).toBe(false);
    expect(stripGmailSendApproval(text)).toBe("Your Gmail draft is ready.");
    expect(stripAssistantApprovals(`Ready to add the event.\n${marker}\n${gmailMarker}`)).toBe("Ready to add the event.");
    expect(sanitizeAssistantText(text)).toBe("Your Gmail draft is ready.");
  });
});
