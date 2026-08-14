import { describe, expect, it } from "vitest";
import { resolveHostProjectContext } from "./host-project-context";

describe("resolveHostProjectContext", () => {
  it("binds a registered Music House host to its canonical repository", () => {
    expect(resolveHostProjectContext({
      app: "music-house",
      url: "https://music-house-nine.vercel.app/library?filter=new",
      route: "/library?filter=new",
      editTarget: { id: "library", label: "Library", selector: "main" },
    })).toMatchObject({
      project: {
        slug: "music-house",
        repo: "daniels-project-space/music-house",
      },
    });
  });

  it.each([
    { app: "music-house", url: "https://attacker.example/library" },
    { app: "unknown-product", url: "https://music-house-nine.vercel.app/library" },
    { app: "music-house", url: "not a url" },
    { app: "music-house" },
  ])("fails closed for an untrusted host identity: %o", (context) => {
    expect(resolveHostProjectContext(context)).toBeNull();
  });
});
