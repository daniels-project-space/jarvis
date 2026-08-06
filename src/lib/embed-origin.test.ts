import { describe, expect, it } from "vitest";
import { isTrustedJarvisEmbedOrigin, resolveTrustedJarvisEmbedOrigin } from "./embed-origin";

describe("trusted Jarvis embed origins", () => {
  it("accepts only exact registered production origins", () => {
    expect(isTrustedJarvisEmbedOrigin("https://project-hub-olive-pi.vercel.app")).toBe(true);
    expect(isTrustedJarvisEmbedOrigin("https://rental-manager-v2-nu.vercel.app")).toBe(true);
    expect(isTrustedJarvisEmbedOrigin("https://project-hub-olive-pi.vercel.app.evil.test")).toBe(false);
    expect(isTrustedJarvisEmbedOrigin("https://project-hub-olive-pi.vercel.app/path")).toBe(false);
  });

  it("uses the loader-declared origin when referrer metadata is unavailable", () => {
    expect(resolveTrustedJarvisEmbedOrigin({
      declaredOrigin: "https://project-hub-olive-pi.vercel.app",
      referrer: "",
    })).toBe("https://project-hub-olive-pi.vercel.app");
  });

  it("rejects an arbitrary parent even if it embeds Jarvis directly", () => {
    expect(resolveTrustedJarvisEmbedOrigin({
      declaredOrigin: "https://evil.test",
      referrer: "https://evil.test/page",
      ancestorOrigin: "https://evil.test",
    })).toBeNull();
  });
});
