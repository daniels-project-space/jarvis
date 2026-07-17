import { describe, expect, it } from "vitest";
import { inferConversationMood } from "./conversation-mood";

describe("inferConversationMood", () => {
  it("makes urgent failures immediately visible", () => {
    expect(inferConversationMood("Jarvis is broken and this is urgent")).toBe("alert");
  });

  it("keeps a real emotional register over a vague follow-up", () => {
    expect(inferConversationMood("go on", "tender")).toBe("tender");
  });

  it("recognises work, creative and playful context", () => {
    expect(inferConversationMood("audit and fix the deploy")).toBe("focused");
    expect(inferConversationMood("let's imagine a cinematic film world")).toBe("dreamy");
    expect(inferConversationMood("that joke was funny lol")).toBe("playful");
  });
});
