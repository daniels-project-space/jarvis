import { describe, expect, it } from "vitest";
import { AUTO_MOOD_HOLD_MS, freshAutomaticOrbMood, inferConversationMood, isOrbMood } from "./conversation-mood";

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

  it("accepts only a fresh model-selected mood and then returns control to the local conversation", () => {
    const now = 1_700_000_000_000;
    const modelMood = { title: "auto", source: "model", threadId: "thread-a", value: "tender", updatedAt: now } as const;
    expect(freshAutomaticOrbMood(modelMood, "thread-a", now)).toBe("tender");
    expect(freshAutomaticOrbMood({ ...modelMood, value: "alert" }, "thread-a", now + AUTO_MOOD_HOLD_MS)).toBe("alert");
    expect(freshAutomaticOrbMood({ ...modelMood, value: "alert" }, "thread-a", now + AUTO_MOOD_HOLD_MS + 1)).toBeNull();
    expect(freshAutomaticOrbMood({ ...modelMood, source: "cleared" }, "thread-a", now)).toBeNull();
    expect(freshAutomaticOrbMood({ ...modelMood, title: "manual" }, "thread-a", now)).toBeNull();
    expect(freshAutomaticOrbMood({ ...modelMood, value: "not-a-mood" }, "thread-a", now)).toBeNull();
    expect(freshAutomaticOrbMood(modelMood, "thread-b", now)).toBeNull();
    expect(isOrbMood("focused")).toBe(true);
    expect(isOrbMood("not-a-mood")).toBe(false);
  });
});
