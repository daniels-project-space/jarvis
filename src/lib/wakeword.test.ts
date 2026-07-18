import { describe, expect, it } from "vitest";
import { commandAfterWake } from "./wakeword";

describe("wake command capture", () => {
  it("preserves a command spoken in the same breath", () => {
    expect(commandAfterWake("Hey Jarvis, add milk to my to-do list"))
      .toBe("add milk to my to-do list");
  });

  it("returns an empty command for a bare wake phrase", () => {
    expect(commandAfterWake("jarvis")).toBe("");
  });
});
