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

  it("carries page controls and a confirmed source target without exposing them in chat", () => {
    const modelText = withHostContext("Make this card less cramped", {
      hostId: "host-project-hub-tab",
      url: "https://project-hub.example/",
      title: "Project Hub",
      app: "project-hub",
      route: "/",
      elements: [{ id: "widget:wealth", label: "Wealth widget", role: "region" }],
      editTarget: {
        id: "widget:wealth",
        label: "Wealth widget",
        source: "src/components/widgets/wealth-widget.tsx",
        selector: "#w-wealth",
      },
    });
    expect(modelText).toContain("wealth-widget.tsx");
    expect(modelText).toContain("host-project-hub-tab");
    expect(visibleTurnText(modelText)).toBe("Make this card less cramped");
  });
});
