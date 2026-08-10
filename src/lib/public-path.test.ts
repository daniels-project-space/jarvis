import { describe, expect, it } from "vitest";
import { isJarvisPublicPath } from "./public-path";

describe("public-path boundary", () => {
  it("allows only the independently capability-protected VPS runner endpoint", () => {
    expect(isJarvisPublicPath("/api/local-handover/runner")).toBe(true);
    expect(isJarvisPublicPath("/api/local-handover")).toBe(false);
    expect(isJarvisPublicPath("/api/local-handover/runner/other")).toBe(false);
  });
});
