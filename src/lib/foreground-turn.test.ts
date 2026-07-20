import { describe, expect, it } from "vitest";
import { assistantForRequest, requestIdForAssistant } from "./foreground-turn";

const messages = [
  { _id: "user-1", role: "user", status: "done", requestId: "request-1" },
  { _id: "assistant-1", role: "assistant", status: "streaming", parentMessageId: "user-1" },
  { _id: "user-2", role: "user", status: "done", requestId: "request-2" },
  { _id: "assistant-2", role: "assistant", status: "done", parentMessageId: "user-2" },
];

describe("foreground turn association", () => {
  it("selects the assistant paired with the exact client request", () => {
    expect(assistantForRequest(messages, "request-1")?._id).toBe("assistant-1");
    expect(assistantForRequest(messages, "request-2")?._id).toBe("assistant-2");
  });

  it("does not fall through to an unrelated latest assistant", () => {
    expect(assistantForRequest(messages, "missing")).toBeUndefined();
    expect(requestIdForAssistant(messages, messages[1])).toBe("request-1");
  });
});
