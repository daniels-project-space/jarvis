import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const KEY = Buffer.alloc(32, 7).toString("base64");
const event = {
  title: "Planning session",
  start: Date.UTC(2026, 7, 20, 9, 0),
  end: Date.UTC(2026, 7, 20, 10, 0),
  allDay: false,
  location: "Studio",
  reminderMinutesBefore: 15,
};

afterEach(() => {
  delete process.env.GOOGLE_TOKEN_ENCRYPTION_KEY;
  vi.resetModules();
});

describe("Google Calendar owner-approval receipt", () => {
  it("round-trips a bounded event only while the receipt is fresh", async () => {
    process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = KEY;
    const { issueGoogleCalendarApproval, verifyGoogleCalendarApproval } = await import("./google-calendar-approval.server");
    const token = issueGoogleCalendarApproval(event, 1_000);

    expect(verifyGoogleCalendarApproval(token, 1_000 + 60_000)).toEqual(event);
    expect(() => verifyGoogleCalendarApproval(token, 1_000 + 600_001)).toThrow(/invalid or expired/i);
  });

  it("rejects a tampered token before returning an event payload", async () => {
    process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = KEY;
    const { issueGoogleCalendarApproval, verifyGoogleCalendarApproval } = await import("./google-calendar-approval.server");
    const token = issueGoogleCalendarApproval(event, 1_000);
    const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;

    expect(() => verifyGoogleCalendarApproval(tampered, 1_000)).toThrow(/invalid or expired/i);
  });

  it("seals a managed-event revision into update and delete proposals", async () => {
    process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = KEY;
    const { issueGoogleCalendarApprovalProposal, verifyGoogleCalendarApprovalProposal } = await import("./google-calendar-approval.server");
    const proposal = {
      action: "update" as const,
      eventId: "jarvisabcdef0123456789",
      expectedEtag: "\"revision-1\"",
      event,
    };
    const token = issueGoogleCalendarApprovalProposal(proposal, 1_000);

    expect(verifyGoogleCalendarApprovalProposal(token, 1_000 + 60_000)).toEqual(expect.objectContaining({
      proposal,
      expiresAt: 1_000 + 600_000,
      nonce: expect.stringMatching(/^[A-Za-z0-9_-]{16,64}$/),
    }));
  });
});
