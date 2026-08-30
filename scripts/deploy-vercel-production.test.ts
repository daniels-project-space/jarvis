import { describe, expect, it } from "vitest";
import { vercelProductionDeployArgs } from "./deploy-vercel-production";

describe("verified Vercel production deploy", () => {
  it("binds the exact commit to build, runtime health, and provider metadata", () => {
    const sha = "a".repeat(40);
    const args = vercelProductionDeployArgs({ sha, branch: "agent/release-proof" });

    expect(args).toEqual(expect.arrayContaining([
      "--build-env", `RELEASE_SHA=${sha}`,
      "--env", `RELEASE_SHA=${sha}`,
      "--meta", `githubCommitSha=${sha}`,
      "--meta", "githubCommitRef=agent/release-proof",
    ]));
  });

  it("rejects ambiguous revisions and branch traversal", () => {
    expect(() => vercelProductionDeployArgs({ sha: "abc123", branch: "main" })).toThrow(/release SHA/);
    expect(() => vercelProductionDeployArgs({ sha: "b".repeat(40), branch: "agent/../main" })).toThrow(/branch/);
  });
});
