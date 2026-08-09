import { describe, expect, it } from "vitest";
import { visualInitiativeDirective } from "./visual-initiative";

describe("proactive visual intent", () => {
  it("routes scavenger-hunt discussion to its editable board", () => {
    expect(visualInitiativeDirective("Let's compare the scavenger hunt clues")).toContain("scavenger template");
  });

  it("nudges structured discussions into a useful visual", () => {
    expect(visualInitiativeDirective("Compare these three options for the launch")).toContain("visual_scene");
  });

  it("routes creative speech into multi-label semantic board capture", () => {
    const directive = visualInitiativeDirective("The character Anna sits on a hill behind her house");
    expect(directive).toContain("board/capture");
    expect(directive).toContain("EVERY category");
  });

  it("does not clutter ordinary conversation", () => {
    expect(visualInitiativeDirective("Morning, how are you?")).toBe("");
  });

  it.each([
    ["I'm in Sevilla right now, can you show me a map with some attractions in the city?", "travel_map"],
    ["What is Bitcoin doing today?", "price_chart"],
    ["Show me the weather in Sevilla", "weather"],
    ["Show me search results for the latest LTX release", "web_search"],
    ["Give me my morning briefing", "briefing"],
  ])("names the specialised visual instead of a generic scene for %s", (intent, tool) => {
    const directive = visualInitiativeDirective(intent);
    expect(directive).toContain(tool);
    expect(directive).toContain("do not substitute");
  });
});
