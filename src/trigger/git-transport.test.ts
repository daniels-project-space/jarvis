import { describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { githubGitEnv, githubRepoUrl } from "./git-transport";

describe("scoped GitHub transport", () => {
  it("keeps the credential out of repository URLs and the base agent environment", () => {
    const base: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: "/usr/bin", JARVIS_AGENT_PROVIDER: "codex" };
    const token = "github-write-capability";
    const gitEnv = githubGitEnv(base, token);
    expect(githubRepoUrl("daniels-project-space/jarvis")).toBe("https://github.com/daniels-project-space/jarvis.git");
    expect(githubRepoUrl("https://github.com/daniels-project-space/jarvis.git")).toBe("https://github.com/daniels-project-space/jarvis.git");
    expect(githubRepoUrl("daniels-project-space/jarvis")).not.toContain(token);
    expect(() => githubRepoUrl("https://token@github.com/daniels-project-space/jarvis.git")).toThrow(/credential-free/);
    expect(base).not.toHaveProperty("GIT_CONFIG_VALUE_0");
    expect(gitEnv.GIT_CONFIG_VALUE_0).toMatch(/^AUTHORIZATION: basic /);
    expect(gitEnv.GIT_TERMINAL_PROMPT).toBe("0");
    expect(gitEnv.GIT_CONFIG_COUNT).toBe("2");
    expect(gitEnv.GIT_CONFIG_KEY_1).toBe("core.hooksPath");
    expect(gitEnv.GIT_CONFIG_VALUE_1).toBe("/dev/null");
  });

  it("does not execute hooks planted in an agent-owned checkout during an authenticated push", () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-git-transport-"));
    const remote = join(root, "remote.git");
    const checkout = join(root, "checkout");
    const marker = join(root, "hook-ran");
    mkdirSync(checkout);
    execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
    execFileSync("git", ["init"], { cwd: checkout, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "jarvis@example.invalid"], { cwd: checkout });
    execFileSync("git", ["config", "user.name", "JARVIS test"], { cwd: checkout });
    writeFileSync(join(checkout, "proof.txt"), "safe push\n");
    execFileSync("git", ["add", "proof.txt"], { cwd: checkout });
    execFileSync("git", ["commit", "-m", "test"], { cwd: checkout, stdio: "ignore" });
    const hook = join(checkout, ".git", "hooks", "pre-push");
    writeFileSync(hook, `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\n`);
    chmodSync(hook, 0o755);

    execFileSync("git", ["push", remote, "HEAD:refs/heads/main"], {
      cwd: checkout,
      env: githubGitEnv(process.env, "not-a-real-token"),
      stdio: "ignore",
    });

    expect(existsSync(marker)).toBe(false);
  });
});
