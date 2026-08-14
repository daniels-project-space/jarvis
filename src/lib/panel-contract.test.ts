import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveEmbedLayoutMode, resolvePanelRoute } from "./panel-contract";

describe("semantic panel routing", () => {
  it.each([
    ["board", "board"], ["scene", "scene"], ["canvas", "canvas"], ["creations", "creations"], ["travel", "travel"],
    ["list", "list"], ["site", "site"], ["video", "iframe"], ["image", "image"], ["code", "code"],
  ])("routes %s content through its one renderer", (type, renderer) => {
    expect(resolvePanelRoute({ type, value: "" }).renderer).toBe(renderer);
  });

  it("routes widget presentation from its semantic payload", () => {
    const chart = resolvePanelRoute({ type: "widget", value: JSON.stringify({ kind: "candles" }) });
    const briefing = resolvePanelRoute({ type: "widget", value: JSON.stringify({ kind: "briefing2" }) });
    expect(chart.semanticKind).toBe("widget:candles");
    expect(chart.size).not.toBe(briefing.size);
    expect(chart.presentation).toBe("wide");
    expect(briefing.presentation).toBe("wide");
    expect(chart.keepOrbVisible).toBe(false);
    expect(briefing.keepOrbVisible).toBe(false);
  });

  it("falls unknown content back to safe markdown instead of raw JSON", () => {
    const route = resolvePanelRoute({ type: "future", value: "hello" });
    expect(route.renderer).toBe("markdown");
    expect(route.presentation).toBe("wide");
    expect(route.keepOrbVisible).toBe(false);
  });

  it.each(["trip", "travel", "fleet", "pdf", "site", "url"])(
    "gives %s the complete workspace instead of a squeezed side stage",
    (type) => {
      expect(resolvePanelRoute({ type, value: "" }).presentation).toBe("workspace");
      expect(resolvePanelRoute({ type, value: "" }).keepOrbVisible).toBe(false);
    },
  );

  it("keeps only genuinely compact tools beside the orb", () => {
    expect(resolvePanelRoute({ type: "widget", value: JSON.stringify({ kind: "timer" }) }).keepOrbVisible).toBe(true);
    expect(resolvePanelRoute({ type: "widget", value: JSON.stringify({ kind: "calendar" }) }).keepOrbVisible).toBe(false);
  });

  it("expands ordinary wide and workspace panels at the embed host boundary", () => {
    expect(resolveEmbedLayoutMode({ expanded: false, panelVisible: true, panelFull: true, presentation: "workspace" })).toBe("compact");
    expect(resolveEmbedLayoutMode({ expanded: true, panelVisible: false, panelFull: false })).toBe("chat");
    expect(resolveEmbedLayoutMode({ expanded: true, panelVisible: true, panelFull: false, presentation: "compact" })).toBe("chat");
    expect(resolveEmbedLayoutMode({ expanded: true, panelVisible: true, panelFull: false, presentation: "wide" })).toBe("workspace");
    expect(resolveEmbedLayoutMode({ expanded: true, panelVisible: true, panelFull: false, presentation: "workspace" })).toBe("workspace");
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
