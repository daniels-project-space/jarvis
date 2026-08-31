import { describe, expect, it } from "vitest";
import { SPOKEN_CAPTION_TEXT_CLASS, spokenCaptionStageClassName, spokenCaptionSurfaceClassName } from "./spoken-caption-layout";

describe("spoken caption layout", () => {
  it("uses the requested more compact transcript scale", () => {
    expect(SPOKEN_CAPTION_TEXT_CLASS).toContain("text-[0.95rem]");
    expect(SPOKEN_CAPTION_TEXT_CLASS).toContain("md:text-[1.3rem]");
    expect(SPOKEN_CAPTION_TEXT_CLASS).toContain("lg:text-[1.5rem]");
  });

  it("places transcripts lower in both main and compact stage layouts", () => {
    expect(spokenCaptionStageClassName({ compactAside: false, commandExpanded: false, overlayUp: false }))
      .toBe("top-[63%] inset-x-0");
    expect(spokenCaptionStageClassName({ compactAside: true, commandExpanded: false, overlayUp: false }))
      .toBe("top-[74%] hidden md:flex md:left-[62%] md:right-0");
    expect(spokenCaptionStageClassName({ compactAside: false, commandExpanded: true, overlayUp: false }))
      .toBe("top-[74%] hidden md:flex md:left-[62%] md:right-0");
    expect(spokenCaptionStageClassName({ compactAside: false, commandExpanded: true, overlayUp: true }))
      .toBe("top-[63%] inset-x-0");
  });

  it("keeps an answer above the composer when a tool owns the stage", () => {
    expect(spokenCaptionSurfaceClassName({
      fullBleed: true,
      compactAside: false,
      commandExpanded: false,
      overlayUp: true,
    })).toBe("fixed bottom-[4.75rem] inset-x-0 px-4");
    expect(spokenCaptionSurfaceClassName({
      fullBleed: false,
      compactAside: false,
      commandExpanded: false,
      overlayUp: false,
    })).toBe("absolute top-[63%] inset-x-0 px-6");
  });
});
