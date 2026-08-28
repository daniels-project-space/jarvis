import { describe, expect, it } from "vitest";
import {
  extractGmailSendApproval,
  extractICloudCalendarApproval,
  hasAssistantApproval,
  sanitizeAssistantText,
  stripAssistantApprovals,
  stripGmailSendApproval,
  stripICloudCalendarApproval,
} from "./sanitize";

const iCloudToken = `${"e".repeat(48)}.${"f".repeat(43)}`;
const iCloudMarker = `[JARVIS_ICLOUD_CALENDAR_APPROVAL:${iCloudToken}]`;
const gmailToken = `${"c".repeat(64)}.${"d".repeat(43)}`;
const gmailMarker = `[jarvis-gmail-send-approval:${gmailToken}]`;

describe("assistant text sanitization", () => {
  it("keeps an iCloud Calendar receipt out of chat and retains it only for the protected card", () => {
    const text = `Ready to add the iCloud event.\n${iCloudMarker}`;

    expect(extractICloudCalendarApproval(text)).toBe(iCloudToken);
    expect(stripICloudCalendarApproval(text)).toBe("Ready to add the iCloud event.");
    expect(hasAssistantApproval(text)).toBe(true);
    expect(stripAssistantApprovals(`Ready.\n${iCloudMarker}`)).toBe("Ready.");
    expect(sanitizeAssistantText(text)).toBe("Ready to add the iCloud event.");
  });

  it("keeps a Gmail send receipt out of chat and retains it only for the owner approval button", () => {
    const text = `Your Gmail draft is ready.\n${gmailMarker}`;

    expect(extractGmailSendApproval(text)).toBe(gmailToken);
    expect(hasAssistantApproval(text)).toBe(true);
    expect(hasAssistantApproval("No approval needed.")).toBe(false);
    expect(stripGmailSendApproval(text)).toBe("Your Gmail draft is ready.");
    expect(stripAssistantApprovals(`Ready to add the event.\n${gmailMarker}`)).toBe("Ready to add the event.");
    expect(sanitizeAssistantText(text)).toBe("Your Gmail draft is ready.");
  });
});
