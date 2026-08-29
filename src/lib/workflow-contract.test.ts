import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SCOPED_TEAM_MANIFEST,
  WORKFLOW_CONTRACT,
  canonicalizeRepository,
  githubRepositoryUrl,
  renderCodexAgentToml,
} from "./workflow-contract";
import { PERMANENT_TEAM } from "../mastra/team";

describe("versioned durable-work contract", () => {
  it("uses one secret-free scoped manifest for Mastra and the durable runtime", () => {
    expect(WORKFLOW_CONTRACT.version).toBe("1.0");
    expect(WORKFLOW_CONTRACT.scope).toMatchObject({
      githubHost: "github.com",
      githubProtocol: "https",
      owner: "daniels-project-space",
      credentialPolicy: "controller-held-only",
      sharedWritableState: "forbidden",
    });
    expect(WORKFLOW_CONTRACT).toMatchObject({
      durableRuntime: "trigger.dev",
      controlPlane: "convex",
      behaviorRouter: "mastra",
      intelligenceRuntime: "codex-cli-subscription",
    });
    expect(PERMANENT_TEAM).toEqual(SCOPED_TEAM_MANIFEST.agents);
    expect(SCOPED_TEAM_MANIFEST.agents.map((agent) => agent.slug)).toEqual([
      "jarvis", "paul", "atlas", "iris", "maya", "chloe", "sentry",
    ]);

    const serialized = JSON.stringify(SCOPED_TEAM_MANIFEST);
    expect(serialized).not.toMatch(/(?:gh[pous]_|github_pat_|sk-[a-z\d]|authorization:\s*(?:basic|bearer)|:\/\/[^/\s:@]+:[^/\s@]+@)/i);
  });

  it("generates every project Codex agent TOML without drift", () => {
    for (const agent of SCOPED_TEAM_MANIFEST.agents) {
      const path = join(process.cwd(), ".codex", "agents", `${agent.slug}.toml`);
      expect(readFileSync(path, "utf8")).toBe(renderCodexAgentToml(agent));
    }
  });

  it("canonicalizes equivalent GitHub remotes before persistence", () => {
    for (const value of [
      "daniels-project-space/jarvis",
      "Daniels-Project-Space/Jarvis.git",
      "https://github.com/daniels-project-space/jarvis",
      "https://github.com/Daniels-Project-Space/Jarvis.git",
    ]) {
      expect(canonicalizeRepository(value)).toBe("daniels-project-space/jarvis");
    }
    expect(canonicalizeRepository("jarvis", { allowShortName: true })).toBe("daniels-project-space/jarvis");
    expect(githubRepositoryUrl("https://github.com/daniels-project-space/jarvis.git")).toBe(
      "https://github.com/daniels-project-space/jarvis.git",
    );
  });

  it("rejects credentials, ambiguity, traversal, and non-HTTPS transports", () => {
    for (const hostile of [
      "https://token@github.com/daniels-project-space/jarvis.git",
      "https://token:secret@github.com/daniels-project-space/jarvis.git",
      "http://github.com/daniels-project-space/jarvis",
      "git@github.com:daniels-project-space/jarvis.git",
      "https://github.com/daniels-project-space/jarvis?token=secret",
      "https://github.com/daniels-project-space/jarvis#main",
      "https://github.com/daniels-project-space/jarvis/",
      "https://github.com/daniels-project-space/../jarvis",
      "https://github.com/daniels-project-space/%2fjarvis",
      "https://github.com/daniels-project-space/jarvis.git.git",
      "daniels-project-space//jarvis",
      "../jarvis",
      "/daniels-project-space/jarvis",
      "github.com/daniels-project-space/jarvis",
    ]) {
      expect(canonicalizeRepository(hostile), hostile).toBeNull();
    }
    expect(() => githubRepositoryUrl("https://token@github.com/daniels-project-space/jarvis")).toThrow(/credential-free/);
  });
});
