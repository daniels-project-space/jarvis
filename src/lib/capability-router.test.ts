import { describe, expect, it } from "vitest";
import { rankCapabilities } from "./capability-router";

describe("capability router", () => {
  it.each([
    ["I'm in Sevilla right now, can you show me a map with some attractions in the city?", "travel", "travel_map"],
    ["Venice to London", "travel", "travel_map"],
    ["What is Bitcoin doing today?", "business", "price_chart"],
    ["How is Ethereum looking?", "business", "price_chart"],
    ["Show me the weather in Seville", "core", "weather"],
    ["Give me my morning briefing", "core", "briefing"],
    ["Search the web for the latest LTX release", "core", "web_search"],
    ["Draft an email to Leo about tomorrow", "creative", "draft"],
    ["Plan my day around my calendar", "work", "plan_my_day"],
    ["Make a mind map for the launch", "creative", "mind_map"],
    ["Summarise https://youtu.be/abcDEF12345", "creative", "youtube_transcript"],
    ["Find me a YouTube video about camera lighting", "creative", "youtube_search"],
  ])("routes %s to %s/%s", (intent, belt, tool) => {
    const ranking = rankCapabilities(intent);
    expect(ranking.candidates[0]).toMatchObject({ belt, tool });
  });

  it("keeps a visual follow-up on the active specialised tool", () => {
    const ranking = rankCapabilities(
      "I'm not looking for touristy stuff, give me something more niche.",
      { activeTool: "travel_map" },
    );
    expect(ranking.candidates[0]).toMatchObject({
      belt: "travel",
      tool: "travel_map",
      reason: "active_visual_follow_up",
    });
  });

  it("routes the day planner with the existing renderer it needs to finish", () => {
    const ranking = rankCapabilities("Plan my day around my calendar");
    expect(ranking.candidates.slice(0, 2).map(({ belt, tool }) => ({ belt, tool }))).toEqual([
      { belt: "work", tool: "plan_my_day" },
      { belt: "work", tool: "show" },
    ]);
  });

  it("never treats an explicit visual request as unknown", () => {
    const ranking = rankCapabilities("Show me that visually");
    expect(ranking.explicitVisual).toBe(true);
    expect(ranking.candidates[0]).toMatchObject({ belt: "core", tool: "show", visual: true });
  });

  it("does not force a tool for ordinary conversation", () => {
    expect(rankCapabilities("What do you think about that?").candidates).toEqual([]);
  });

  it("does not divert YouTube Studio work into public video discovery", () => {
    expect(rankCapabilities("Open YouTube Studio and show the latest upload").candidates.map(({ tool }) => tool))
      .not.toContain("youtube_search");
  });
});
