import { describe, expect, it } from "vitest";
import { findHostApp, parseEmbeddedHostIntent } from "./host-actions";

describe("embedded host intents", () => {
  it("opens Daniel's known apps through the host instead of a dead iframe card", () => {
    expect(parseEmbeddedHostIntent("open my YouTube Studio")).toMatchObject({
      action: { action: "open_app", target: "YouTube Studio AI", url: "https://youtube-studio-ai.vercel.app" },
    });
    expect(findHostApp("youtube studio")?.name).toBe("YouTube Studio AI");
  });

  it("reveals an existing Hub widget immediately", () => {
    expect(parseEmbeddedHostIntent("show me the wealth widget")).toMatchObject({
      action: { action: "show_widget", target: "wealth" },
    });
  });

  it("starts selection-first edit mode for a page change", () => {
    expect(parseEmbeddedHostIntent("edit this page")).toMatchObject({
      action: { action: "edit", instruction: "edit this page" },
    });
  });

  it("leaves compound requests to the full model so scope is not discarded", () => {
    expect(parseEmbeddedHostIntent("open YouTube Studio and then show the latest video")).toBeNull();
  });
});
