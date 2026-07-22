import { describe, expect, it } from "vitest";
import { resolvePanelRoute, shouldHideOrbForPanel } from "./panel-contract";

describe("semantic panel routing", () => {
  it.each([
    ["board", "board"], ["scene", "scene"], ["canvas", "canvas"], ["creations", "creations"],
    ["list", "list"], ["site", "site"], ["video", "iframe"], ["image", "image"], ["code", "code"],
  ])("routes %s content through its one renderer", (type, renderer) => {
    expect(resolvePanelRoute({ type, value: "" }).renderer).toBe(renderer);
  });

  it("routes widget presentation from its semantic payload", () => {
    const chart = resolvePanelRoute({ type: "widget", value: JSON.stringify({ kind: "candles" }) });
    const briefing = resolvePanelRoute({ type: "widget", value: JSON.stringify({ kind: "briefing2" }) });
    expect(chart.semanticKind).toBe("widget:candles");
    expect(chart.size).not.toBe(briefing.size);
    expect(chart.keepOrbVisible).toBe(true);
    expect(briefing.keepOrbVisible).toBe(true);
  });

  it("falls unknown content back to safe markdown instead of raw JSON", () => {
    const route = resolvePanelRoute({ type: "future", value: "hello" });
    expect(route.renderer).toBe("markdown");
    expect(route.keepOrbVisible).toBe(true);
  });

  it.each(["board", "canvas", "scene", "creations", "trip", "fleet", "pdf", "site", "url", "code", "markdown"])(
    "keeps Jarvis visible beside %s",
    (type) => {
      expect(resolvePanelRoute({ type, value: "" }).keepOrbVisible).toBe(true);
    },
  );

  it("reserves the full stage only for video playback", () => {
    expect(resolvePanelRoute({ type: "video", value: "https://example.com" }).keepOrbVisible).toBe(false);
  });

  it("keeps the orb contract when a workspace is expanded", () => {
    // Fullscreen is intentionally not an argument: it is a layout state and
    // cannot override a route's keepOrbVisible promise.
    expect(shouldHideOrbForPanel({ type: "creations", value: "" })).toBe(false);
    expect(shouldHideOrbForPanel({ type: "board", value: "" })).toBe(false);
    expect(shouldHideOrbForPanel({ type: "video", value: "" })).toBe(true);
  });
});
