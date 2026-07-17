import { describe, expect, it } from "vitest";
import { canonicalJarvisRedirect } from "./canonical-origin";

describe("canonical Jarvis origin", () => {
  it("moves production aliases onto the cookie-owning host", () => {
    const target = canonicalJarvisRedirect({
      requestUrl: "http://jarvis-git-main-example.vercel.app:3011/work?tab=live",
      requestHost: "jarvis-git-main-example.vercel.app",
      vercelEnvironment: "production",
      canonicalHost: "jarvis-orcin-six.vercel.app",
    });
    expect(target?.toString()).toBe("https://jarvis-orcin-six.vercel.app/work?tab=live");
  });

  it("does not loop on the canonical host", () => {
    expect(canonicalJarvisRedirect({
      requestUrl: "https://jarvis-orcin-six.vercel.app/",
      requestHost: "jarvis-orcin-six.vercel.app",
      vercelEnvironment: "production",
      canonicalHost: "jarvis-orcin-six.vercel.app",
    })).toBeNull();
  });

  it("leaves local and preview development alone", () => {
    expect(canonicalJarvisRedirect({
      requestUrl: "http://localhost:3000/",
      requestHost: "localhost:3000",
      vercelEnvironment: "development",
    })).toBeNull();
  });
});
