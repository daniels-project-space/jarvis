import { describe, expect, it } from "vitest";
import {
  normalizeForegroundBrowserErrandExecution,
  normalizeToolInvocationContext,
  TOOL_INVOCATION_ID_MAX_LENGTH,
} from "./tool-invocation-context";

describe("tool invocation context", () => {
  it("normalizes bounded durable identifiers without adding model arguments", () => {
    expect(normalizeToolInvocationContext({
      requestId: " request-1 ",
      userMessageId: " message-1 ",
    }, { allowUserMessageId: true })).toEqual({
      requestId: "request-1",
      userMessageId: "message-1",
    });
    expect(normalizeToolInvocationContext({})).toBeUndefined();
  });

  it("rejects oversized, control-character, and unknown metadata", () => {
    expect(() => normalizeToolInvocationContext({
      requestId: "x".repeat(TOOL_INVOCATION_ID_MAX_LENGTH + 1),
    })).toThrow("requestId is invalid");
    expect(() => normalizeToolInvocationContext({ requestId: "turn\nspoof" }))
      .toThrow("requestId is invalid");
    expect(() => normalizeToolInvocationContext({ requestId: "safe", extra: true }))
      .toThrow("unknown fields");
  });

  it("requires an authoritative caller before accepting a chat user message id", () => {
    expect(() => normalizeToolInvocationContext({ userMessageId: "message-1" }))
      .toThrow("user message provenance");
    expect(normalizeToolInvocationContext(
      { userMessageId: "message-1" },
      { allowUserMessageId: true },
    )).toEqual({ userMessageId: "message-1" });
  });

  it("accepts only a bounded host-only browser execution receipt key", () => {
    expect(normalizeForegroundBrowserErrandExecution({ receiptKey: "assistant-1:call-1" }))
      .toEqual({ receiptKey: "assistant-1:call-1" });
    expect(() => normalizeForegroundBrowserErrandExecution({ receiptKey: "bad key" }))
      .toThrow(/receipt is invalid/i);
    expect(() => normalizeForegroundBrowserErrandExecution({ receiptKey: "ok", errandId: "attacker" }))
      .toThrow(/unknown fields/i);
  });
});
