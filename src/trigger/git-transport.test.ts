import { describe, expect, it } from "vitest";
import { githubGitEnv, githubRepoUrl } from "./git-transport";

describe("scoped GitHub transport", () => {
  it("keeps the credential out of repository URLs and the base agent environment", () => {
    const base: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: "/usr/bin", JARVIS_AGENT_PROVIDER: "codex" };
    const token = "github-write-capability";
    const gitEnv = githubGitEnv(base, token);
    expect(githubRepoUrl("daniels-project-space/jarvis")).toBe("https://github.com/daniels-project-space/jarvis.git");
    expect(githubRepoUrl("daniels-project-space/jarvis")).not.toContain(token);
    expect(base).not.toHaveProperty("GIT_CONFIG_VALUE_0");
    expect(gitEnv.GIT_CONFIG_VALUE_0).toMatch(/^AUTHORIZATION: basic /);
    expect(gitEnv.GIT_TERMINAL_PROMPT).toBe("0");
  });
});
