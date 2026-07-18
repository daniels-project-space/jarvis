import { describe, expect, it } from "vitest";
import { needsHostContext, visibleTurnText, withHostContext } from "./host-context";

describe("Project Hub page context", () => {
  it("requests context only for screen-aware turns", () => {
    expect(needsHostContext("What can you see on this page?")).toBe(true);
    expect(needsHostContext("Add milk to my to-do list")).toBe(false);
  });

  it("keeps host evidence out of the visible conversation", () => {
    const modelText = withHostContext("Fix what is wrong on this screen", {
      url: "https://project-hub.example/returns",
      title: "Return Hub",
      text: "Three returns are outstanding",
    });
    expect(modelText).toContain("[JARVIS_HOST_CONTEXT]");
    expect(visibleTurnText(modelText)).toBe("Fix what is wrong on this screen");
  });
});
