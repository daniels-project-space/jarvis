import { describe, expect, it } from "vitest";
import { isDeterministicFileFollowUp, isLikelyFileReference, requestedPrivateMediaKind } from "./fileHelpers";

describe("private media follow-up selectors", () => {
  it("keeps natural video and audio follow-ups deterministic", () => {
    expect(isDeterministicFileFollowUp("summarize that video clip")).toBe(true);
    expect(isDeterministicFileFollowUp("transcribe the recording")).toBe(true);
    expect(isDeterministicFileFollowUp("show captions from this video")).toBe(true);
    expect(isDeterministicFileFollowUp("summarize my recording")).toBe(true);
    expect(isDeterministicFileFollowUp("what is the weather tomorrow?")).toBe(false);
    expect(isDeterministicFileFollowUp("what's a good video game?")).toBe(false);
  });

  it("recognizes only supported private media filename references", () => {
    expect(isLikelyFileReference("use arrival-reel.mp4 for the itinerary recap")).toBe(true);
    expect(isLikelyFileReference("listen to flight-note.m4a")).toBe(true);
    expect(isLikelyFileReference("review the walk-through.webm")).toBe(true);
    expect(isLikelyFileReference("what is the weather tomorrow?")).toBe(false);
    expect(isLikelyFileReference("what's a good video game?")).toBe(false);
  });

  it("asks recent fallback selection to respect the requested media kind", () => {
    expect(requestedPrivateMediaKind("summarize that video clip")).toBe("video");
    expect(requestedPrivateMediaKind("transcribe my audio")).toBe("audio");
    expect(requestedPrivateMediaKind("show the last recording")).toBe("media");
    expect(requestedPrivateMediaKind("compare video and audio")).toBe("ambiguous");
    expect(requestedPrivateMediaKind("summarize that file")).toBeNull();
  });
});
