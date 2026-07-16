import { describe, expect, it } from "vitest";
import { DEFAULT_CONVEX_URL, resolveConvexUrl } from "./convex-url";

describe("resolveConvexUrl", () => {
  it("uses the first valid absolute URL", () => {
    expect(resolveConvexUrl(" ", "https://example.convex.cloud/"))
      .toBe("https://example.convex.cloud");
  });

  it("rejects blank and relative provider values", () => {
    expect(resolveConvexUrl("", "/api/convex", "not-a-url")).toBe(DEFAULT_CONVEX_URL);
  });
});
