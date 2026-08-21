import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  issueICloudCalendarApproval,
  verifyICloudCalendarApproval,
} from "./icloud-calendar-approval.server";

const originalAppleId = process.env.ICLOUD_CALENDAR_APPLE_ID;
const originalAppPassword = process.env.ICLOUD_CALENDAR_APP_PASSWORD;
const event = {
  title: "Planning session",
  start: 1_780_000_000_000,
  end: 1_780_003_600_000,
  allDay: false,
  location: "Studio",
  reminderMinutesBefore: 15,
};

beforeEach(() => {
  process.env.ICLOUD_CALENDAR_APPLE_ID = "calendar-owner@example.test";
  process.env.ICLOUD_CALENDAR_APP_PASSWORD = "test-app-password";
});

afterEach(() => {
  if (originalAppleId === undefined) delete process.env.ICLOUD_CALENDAR_APPLE_ID;
  else process.env.ICLOUD_CALENDAR_APPLE_ID = originalAppleId;
  if (originalAppPassword === undefined) delete process.env.ICLOUD_CALENDAR_APP_PASSWORD;
  else process.env.ICLOUD_CALENDAR_APP_PASSWORD = originalAppPassword;
});

describe("iCloud Calendar approval receipts", () => {
  it("seals one normalized event and a nonce for the owner-only click", () => {
    const token = issueICloudCalendarApproval(event, 1_000);
    const verified = verifyICloudCalendarApproval(token, 1_000 + 60_000);

    expect(verified).toEqual(expect.objectContaining({
      event,
      expiresAt: 1_000 + 600_000,
      nonce: expect.stringMatching(/^[A-Za-z0-9_-]{16,64}$/),
    }));
  });

  it("rejects expired or tampered receipts", () => {
    const token = issueICloudCalendarApproval(event, 1_000);
    const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;

    expect(() => verifyICloudCalendarApproval(token, 1_000 + 600_000)).toThrow(/invalid or expired/i);
    expect(() => verifyICloudCalendarApproval(tampered, 1_000)).toThrow(/invalid or expired/i);
  });

  it("does not sign a receipt when either iCloud credential is missing", () => {
    delete process.env.ICLOUD_CALENDAR_APP_PASSWORD;

    expect(() => issueICloudCalendarApproval(event, 1_000)).toThrow(/not configured/i);
  });
});
