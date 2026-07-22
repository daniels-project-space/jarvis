import { describe, expect, it } from "vitest";
import { creationLibraryFilter } from "./creation-library";

describe("creation library routing", () => {
  it("resets to a bounded empty filter for malformed panel data", () => {
    expect(creationLibraryFilter("not json")).toEqual({ kind: null, folder: null });
  });

  it("keeps only explicit routed file filters", () => {
    expect(creationLibraryFilter(JSON.stringify({ kind: "pdf", folder: "Projects / Jarvis" })))
      .toEqual({ kind: "pdf", folder: "Projects / Jarvis" });
    expect(creationLibraryFilter(JSON.stringify({ kind: 4, folder: {} })))
      .toEqual({ kind: null, folder: null });
  });
});
