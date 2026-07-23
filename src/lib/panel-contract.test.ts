import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolvePanelRoute } from "./panel-contract";

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

  it("opens the Goal launcher only from the explicit UI action, never mission admission or status", () => {
    const tools = readFileSync(new URL("./tools.ts", import.meta.url), "utf8");
    const goalRoute = readFileSync(new URL("../app/api/goal-mode/route.ts", import.meta.url), "utf8");
    const jarvis = readFileSync(new URL("../components/JarvisUI.tsx", import.meta.url), "utf8");
    const goalModeCase = tools.slice(
      tools.indexOf('case "goal_mode"'),
      tools.indexOf('case "orchestrate"'),
    );
    const orchestrateCase = tools.slice(
      tools.indexOf('case "orchestrate"'),
      tools.indexOf('case "work_control"'),
    );

    expect(goalModeCase).not.toContain('"ui:setPanel"');
    expect(orchestrateCase).not.toContain('"ui:setPanel"');
    expect(goalRoute).not.toContain('"ui:setPanel"');
    expect(jarvis.match(/setPanel\(\{ type: "fleet"/g)).toHaveLength(1);
    expect(jarvis).toMatch(/onOpenGoals[\s\S]{0,300}setPanel\(\{ type: "fleet"/);
  });
});
