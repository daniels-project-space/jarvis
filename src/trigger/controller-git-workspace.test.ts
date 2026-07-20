import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureControllerGitWorkspace,
  controllerGitArgs,
  controllerGitEnv,
  controllerMetadataIsOutsideWorkspace,
  createControllerCommit,
} from "./controller-git-workspace";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

describe("controller-owned specialist Git workspace", () => {
  it("ignores hostile model metadata and creates one hook-free controller commit while keeping push controller-only", async () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-controller-git-test-"));
    roots.push(root);
    const seed = join(root, "seed");
    const remote = join(root, "remote.git");
    const workTree = join(root, "model-workspace");
    const controllerRoot = join(root, "controller-only");
    const gitDir = join(controllerRoot, "repository.git");
    const hookMarker = join(root, "model-hook-ran");
    mkdirSync(seed);
    mkdirSync(controllerRoot);
    git(seed, ["init", "-b", "main"]);
    git(seed, ["config", "user.name", "seed"]);
    git(seed, ["config", "user.email", "seed@example.invalid"]);
    writeFileSync(join(seed, "proof.txt"), "before\n");
    git(seed, ["add", "proof.txt"]);
    git(seed, ["commit", "-m", "seed"]);
    git(root, ["clone", "--bare", seed, remote]);
    git(root, ["clone", "--separate-git-dir", gitDir, "--branch", "main", remote, workTree]);

    const executed: string[][] = [];
    const trustedEnv = controllerGitEnv({ NODE_ENV: "test", PATH: process.env.PATH, HOME: root });
    const paths = { gitDir, workTree };
    const runGit = async (args: string[]) => {
      executed.push([...args]);
      const result = spawnSync("git", controllerGitArgs(paths, args), {
        cwd: workTree,
        env: trustedEnv,
        encoding: "utf8",
      });
      return { code: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
    };
    const startHead = git(workTree, ["rev-parse", "HEAD"]);
    const workspace = await captureControllerGitWorkspace({
      gitDir,
      workTree,
      expectedBranch: "main",
      expectedHead: startHead,
      runGit,
    });
    expect(controllerMetadataIsOutsideWorkspace(gitDir, workTree)).toBe(true);

    // The specialist replaces the pointer with model-owned metadata and can do
    // whatever it likes there; none of it is authoritative to the controller.
    rmSync(join(workTree, ".git"), { force: true });
    git(workTree, ["init", "-b", "attacker"]);
    git(workTree, ["config", "user.name", "model attacker"]);
    git(workTree, ["config", "user.email", "model@example.invalid"]);
    git(workTree, ["config", "core.hooksPath", ".git/hooks"]);
    writeFileSync(join(workTree, "proof.txt"), "ordinary edit preserved\n");
    writeFileSync(join(workTree, "model-note.txt"), "ordinary new file\n");
    git(workTree, ["add", "-A"]);
    git(workTree, ["commit", "-m", "model-owned fake commit"]);
    const fakeHead = git(workTree, ["rev-parse", "HEAD"]);
    git(workTree, ["update-ref", "refs/heads/model-ref", fakeHead]);
    const hook = join(workTree, ".git", "hooks", "post-commit");
    writeFileSync(hook, `#!/bin/sh\nprintf ran > ${JSON.stringify(hookMarker)}\n`);
    chmodSync(hook, 0o755);
    git(workTree, ["remote", "add", "origin", "/definitely/not-a-controller-remote"]);
    expect(spawnSync("git", ["push", "origin", "HEAD"], {
      cwd: workTree,
      env: { NODE_ENV: "test", PATH: process.env.PATH, GIT_TERMINAL_PROMPT: "0" },
    }).status).not.toBe(0);

    expect((await runGit(["rev-parse", "HEAD"])).out.trim()).toBe(startHead);
    const result = await createControllerCommit({
      workspace,
      message: "self-repair: controller-owned tree",
      runGit,
    });

    expect(result).toMatchObject({ changed: true, commitCount: 1 });
    expect(existsSync(hookMarker)).toBe(false);
    expect(existsSync(join(workTree, ".git"))).toBe(false);
    expect(readFileSync(join(workTree, "proof.txt"), "utf8")).toBe("ordinary edit preserved\n");
    expect(readFileSync(join(workTree, "model-note.txt"), "utf8")).toBe("ordinary new file\n");
    expect((await runGit(["rev-list", "--count", `${startHead}..HEAD`])).out.trim()).toBe("1");
    expect((await runGit(["show", "-s", "--format=%an <%ae>", "HEAD"])).out.trim())
      .toBe("JARVIS delivery controller <jarvis-controller@daniels-project-space.dev>");
    expect(executed.some((args) => args[0] === "push")).toBe(false);
  });
});
