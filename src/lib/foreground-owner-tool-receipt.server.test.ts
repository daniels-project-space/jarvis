import { describe, expect, it } from "vitest";
import {
  issueForegroundOwnerToolReceipt,
  verifyForegroundOwnerToolReceipt,
} from "./foreground-owner-tool-receipt.server";

const SECRET = "s".repeat(48);
const turn = {
  messageId: "message-1",
  assistantId: "assistant-1",
  claimToken: "claim-1",
};

describe("foreground owner tool receipt", () => {
  it("binds the exact turn, dynamic call, operation, and target", () => {
    const receipt = issueForegroundOwnerToolReceipt({
      secret: SECRET,
      turn,
      callId: "call-1",
      operation: "invoke",
      target: "gmail_search",
      now: 1_000,
    });
    expect(verifyForegroundOwnerToolReceipt(receipt, SECRET, 1_001)).toMatchObject({
      ...turn,
      callId: "call-1",
      operation: "invoke",
      target: "gmail_search",
      expiresAt: 151_000,
    });
  });

  it("rejects tampering, a different authority, and expired receipts", () => {
    const receipt = issueForegroundOwnerToolReceipt({
      secret: SECRET,
      turn,
      callId: "call-2",
      operation: "discover",
      target: "work",
      now: 1_000,
    });
    const [prefix, payload, signature] = receipt.split(".");
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    decoded.target = "core";
    const tampered = `${prefix}.${Buffer.from(JSON.stringify(decoded)).toString("base64url")}.${signature}`;
    expect(verifyForegroundOwnerToolReceipt(tampered, SECRET, 1_001)).toBeNull();
    expect(verifyForegroundOwnerToolReceipt(receipt, "x".repeat(48), 1_001)).toBeNull();
    expect(verifyForegroundOwnerToolReceipt(receipt, SECRET, 151_000)).toBeNull();
  });
});
