import { describe, expect, it } from "vitest";
import { boardZoneForCategory, normalizeBoardCapture, normalizeBoardCategory } from "./board-semantic";

describe("semantic board capture", () => {
  it("routes a multi-label creative thought into distinct visual zones", () => {
    const zones = { characters: {}, locations: {}, plot: {}, timeline: {}, moodboard: {}, notes: {} };
    expect(boardZoneForCategory("character", zones)).toBe("characters");
    expect(boardZoneForCategory("location", zones)).toBe("locations");
    expect(boardZoneForCategory("plot", zones)).toBe("plot");
    expect(boardZoneForCategory("timeline", zones)).toBe("timeline");
    expect(boardZoneForCategory("visual", zones)).toBe("moodboard");
  });

  it("normalizes stable ids, relationships, provenance fields, and aliases", () => {
    expect(normalizeBoardCategory("setting")).toBe("location");
    expect(normalizeBoardCategory("action")).toBe("plot");
    expect(
      normalizeBoardCapture(
        {
          category: "character",
          title: " Anna ",
          detail: "Sits on the hill behind her house",
          related_ids: ["location-hill", "plot-anna-sits", "character-anna"],
          sequence: 2,
          certainty: "stated",
        },
        0,
      ),
    ).toMatchObject({
      id: "character-anna",
      category: "character",
      title: "Anna",
      relatedIds: ["location-hill", "plot-anna-sits"],
      sequence: 2,
      certainty: "stated",
    });
  });

  it("rejects malformed image URLs and untitled captures", () => {
    expect(normalizeBoardCapture({ category: "visual", title: "Hill composition", image_url: "javascript:alert(1)" }, 0)?.imageUrl).toBeUndefined();
    expect(normalizeBoardCapture({ category: "plot" }, 0)).toBeNull();
  });
});
