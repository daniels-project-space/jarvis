import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { issueGmailSendApproval, verifyGmailSendApproval } from "./gmail-send-approval.server";

const previousKey = process.env.GOOGLE_TOKEN_ENCRYPTION_KEY;

beforeEach(() => {
  process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
});

describe("Gmail send approval receipts", () => {
  it("always issues a maximum-sized proposal that the strict verifier can redeem", () => {
    const token = issueGmailSendApproval({
      draftId: "d".repeat(256),
      to: "t".repeat(320),
      subject: "s".repeat(300),
      preview: "p".repeat(500),
    }, 1_000);

    expect(Buffer.byteLength(token, "utf8")).toBeLessThanOrEqual(2_048);
    expect(verifyGmailSendApproval(token, 1_001)).toMatchObject({
      draftId: "d".repeat(256),
      to: "t".repeat(320),
      subject: "s".repeat(300),
    });
  });
});

afterEach(() => {
  if (previousKey === undefined) delete process.env.GOOGLE_TOKEN_ENCRYPTION_KEY;
  else process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = previousKey;
});
