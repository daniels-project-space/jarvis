import { describe, expect, it } from "vitest";
import { buildResearchLanes, rankResearchSources } from "./research-fabric";

describe("research fabric", () => {
  it("creates a bounded parallel plan with primary and independent checks", () => {
    expect(buildResearchLanes("How does Sesame make conversational speech fast?")).toEqual([
      { id: "direct", query: "How does Sesame make conversational speech fast?" },
      { id: "primary", query: "How does Sesame make conversational speech fast? official documentation primary source" },
      { id: "independent", query: "How does Sesame make conversational speech fast? independent analysis limitations" },
    ]);
  });

  it("deduplicates URLs and prioritizes diverse primary evidence over answer boxes", () => {
    const [direct, primary, independent] = buildResearchLanes("Sesame voice agents");
    const sources = rankResearchSources([
      { lane: direct, results: [
        { title: "Duplicated summary", link: "https://example.com/a", snippet: "Short summary" },
        { title: "Community report", link: "https://www.reddit.com/r/voice/comments/1", snippet: "Experience report" },
      ] },
      { lane: primary, results: [
        { title: "Official technical documentation", link: "https://docs.example.com/voice", snippet: "Reference details and release notes" },
        { title: "Duplicated summary", link: "https://example.com/a", snippet: "Longer duplicate summary" },
      ] },
      { lane: independent, results: [
        { title: "Independent limitations analysis", link: "https://analysis.example.net/voice", snippet: "Tradeoffs and limitations" },
      ] },
    ]);
    expect(sources.map((source) => source.url)).toEqual([
      "https://docs.example.com/voice",
      "https://example.com/a",
      "https://analysis.example.net/voice",
      "https://www.reddit.com/r/voice/comments/1",
    ]);
    expect(sources[1].lanes).toEqual(["direct", "primary"]);
  });
});
