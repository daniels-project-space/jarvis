import { describe, expect, it } from "vitest";
import { isJarvisPublicPath } from "./public-path";

describe("Jarvis proxy public-path contract", () => {
  it("keeps the zero-billing release-health endpoint public", () => {
    expect(isJarvisPublicPath("/api/health")).toBe(true);
    expect(isJarvisPublicPath("/api/auth/pair")).toBe(true);
    expect(isJarvisPublicPath("/api/auth/embed-viewer")).toBe(false);
    expect(isJarvisPublicPath("/api/auth/embed-connect")).toBe(false);
  });

  it("does not weaken authenticated control APIs", () => {
    expect(isJarvisPublicPath("/api/goal-mode")).toBe(false);
    expect(isJarvisPublicPath("/api/chat/cancel")).toBe(false);
    expect(isJarvisPublicPath("/api/auth/enroll")).toBe(false);
  });
});
