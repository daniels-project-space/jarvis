import { describe, expect, it } from "vitest";
import { isDeterministicFileFollowUp, isLikelyFileReference } from "./fileHelpers";

describe("private media follow-up selectors", () => {
  it("keeps natural video and audio follow-ups deterministic", () => {
    expect(isDeterministicFileFollowUp("summarize that video clip")).toBe(true);
    expect(isDeterministicFileFollowUp("transcribe the recording")).toBe(true);
    expect(isDeterministicFileFollowUp("show captions from this video")).toBe(true);
    expect(isDeterministicFileFollowUp("what is the weather tomorrow?")).toBe(false);
  });

  it("recognizes only supported private media filename references", () => {
    expect(isLikelyFileReference("use arrival-reel.mp4 for the itinerary recap")).toBe(true);
    expect(isLikelyFileReference("listen to flight-note.m4a")).toBe(true);
    expect(isLikelyFileReference("review the walk-through.webm")).toBe(true);
    expect(isLikelyFileReference("what is the weather tomorrow?")).toBe(false);
  });
});
