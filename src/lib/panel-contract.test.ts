import { describe, expect, it } from "vitest";
import { panelIdentity, resolvePanelRoute } from "./panel-contract";

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

  it.each(["trip", "fleet", "pdf", "site", "url", "code", "markdown"])(
    "keeps Jarvis visible beside %s",
    (type) => {
      expect(resolvePanelRoute({ type, value: "" }).keepOrbVisible).toBe(true);
    },
  );

  it("reserves the full stage only for video playback", () => {
    expect(resolvePanelRoute({ type: "video", value: "https://example.com" }).keepOrbVisible).toBe(false);
  });

  it("does not confuse visual revisions that only differ after a long JSON prefix", () => {
    const prefix = "{" + "x".repeat(200);
    expect(panelIdentity({ type: "scene", title: "Launch board", value: `${prefix}A` }))
      .not.toBe(panelIdentity({ type: "scene", title: "Launch board", value: `${prefix}B` }));
  });
});
