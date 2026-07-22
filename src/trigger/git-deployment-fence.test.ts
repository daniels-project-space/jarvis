import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GitDeploymentFenceError,
  VERCEL_CONFIG_SCHEMA,
  attestCommittedGitDeploymentFence,
  attestGitDeploymentFenceTree,
  ensureGitDeploymentFence,
  withGitDeploymentFence,
} from "./git-deployment-fence";

function fixture(): string {
  return mkdtempSync(join(tmpdir(), "jarvis-deployment-fence-"));
}

function git(cwd: string, args: string[]): { code: number; out: string } {
  try {
    return { code: 0, out: execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (error) {
    const failed = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failed.status ?? 1, out: `${failed.stdout ?? ""}${failed.stderr ?? ""}` };
  }
}

function gitObject(cwd: string, sha: string): Promise<Buffer> {
  return Promise.resolve(execFileSync("git", ["cat-file", "blob", sha], { cwd, stdio: ["ignore", "pipe", "pipe"] }));
}

describe("controller Git-to-deployment fence", () => {
  it("creates the minimal official config and is byte-stable after attestation", () => {
    const root = fixture();
    expect(ensureGitDeploymentFence(root).changed).toBe(true);
    const first = readFileSync(join(root, "vercel.json"), "utf8");
    expect(JSON.parse(first)).toEqual({
      $schema: VERCEL_CONFIG_SCHEMA,
      git: { deploymentEnabled: false },
    });
    expect(ensureGitDeploymentFence(root).changed).toBe(false);
    expect(readFileSync(join(root, "vercel.json"), "utf8")).toBe(first);
  });

  it("preserves unrelated keys, a present schema, and nested Git options", () => {
    const root = fixture();
    writeFileSync(join(root, "vercel.json"), JSON.stringify({
      $schema: "https://example.test/custom-schema.json",
      framework: "nextjs",
      git: { silent: true, deploymentEnabled: true },
      redirects: [{ source: "/old", destination: "/new" }],
    }));
    ensureGitDeploymentFence(root);
    expect(JSON.parse(readFileSync(join(root, "vercel.json"), "utf8"))).toEqual({
      $schema: "https://example.test/custom-schema.json",
      framework: "nextjs",
      git: { silent: true, deploymentEnabled: false },
      redirects: [{ source: "/old", destination: "/new" }],
    });
  });

  it("does not normalize or recommit already-attested bytes", () => {
    const root = fixture();
    const original = `{ "$schema": "custom", "git": { "deploymentEnabled": false, "silent": true }, "framework": "nextjs" }`;
    writeFileSync(join(root, "vercel.json"), original);
    expect(ensureGitDeploymentFence(root).changed).toBe(false);
    expect(readFileSync(join(root, "vercel.json"), "utf8")).toBe(original);
  });

  it.each([
    ["invalid JSON", "{", "invalid_json"],
    ["array root", "[]", "invalid_root"],
    ["null root", "null", "invalid_root"],
    ["scalar git", JSON.stringify({ git: true }), "invalid_git"],
    ["array git", JSON.stringify({ git: [] }), "invalid_git"],
  ])("fails closed for %s", (_label, content, code) => {
    const root = fixture();
    writeFileSync(join(root, "vercel.json"), content);
    expect(() => ensureGitDeploymentFence(root)).toThrow(expect.objectContaining({ code }));
    expect(readFileSync(join(root, "vercel.json"), "utf8")).toBe(content);
  });

  it("rejects competing programmatic and unsafe filesystem configurations", () => {
    const programmatic = fixture();
    writeFileSync(join(programmatic, "vercel.ts"), "export default {}\n");
    expect(() => ensureGitDeploymentFence(programmatic)).toThrow(expect.objectContaining({ code: "programmatic_config" }));
    expect(() => readFileSync(join(programmatic, "vercel.json"))).toThrow();

    const symlink = fixture();
    writeFileSync(join(symlink, "target.json"), "{}\n");
    symlinkSync("target.json", join(symlink, "vercel.json"));
    expect(() => ensureGitDeploymentFence(symlink)).toThrow(expect.objectContaining({ code: "unsafe_path" }));

    const directory = fixture();
    mkdirSync(join(directory, "vercel.json"));
    expect(() => ensureGitDeploymentFence(directory)).toThrow(GitDeploymentFenceError);
  });

  it("preserves the source bytes when atomic materialization cannot be written", () => {
    const root = fixture();
    const original = JSON.stringify({ framework: "nextjs" });
    writeFileSync(join(root, "vercel.json"), original);
    mkdirSync(join(root, `.vercel.json.jarvis-fence-${process.pid}`));
    expect(() => ensureGitDeploymentFence(root)).toThrow(expect.objectContaining({ code: "write_failed" }));
    expect(readFileSync(join(root, "vercel.json"), "utf8")).toBe(original);
  });

  it("attests the exact committed blob and rejects a later conflicting head", async () => {
    const root = fixture();
    git(root, ["init"]);
    git(root, ["config", "user.email", "test@example.test"]);
    git(root, ["config", "user.name", "Test"]);
    ensureGitDeploymentFence(root);
    writeFileSync(join(root, "proof.txt"), "accepted component\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-m", "fenced"]);
    await expect(attestCommittedGitDeploymentFence((args) => Promise.resolve(git(root, args))))
      .resolves.toMatchObject({ schemaVersion: 1 });

    writeFileSync(join(root, "vercel.ts"), "export default {}\n");
    git(root, ["add", "vercel.ts"]);
    git(root, ["commit", "-m", "conflict"]);
    await expect(attestCommittedGitDeploymentFence((args) => Promise.resolve(git(root, args))))
      .rejects.toMatchObject({ code: "programmatic_config" });
  });

  it("executes the controller delivery seam only after committing and attesting the exact HEAD", async () => {
    const root = fixture();
    git(root, ["init"]);
    git(root, ["config", "user.email", "test@example.test"]);
    git(root, ["config", "user.name", "Test"]);
    writeFileSync(join(root, "proof.txt"), "validated patch\n");
    const calls: string[] = [];
    const runner = async (args: string[]) => {
      calls.push(args.join(" "));
      if (args[0] === "ls-remote" || args[0] === "push") return { code: 0, out: "" };
      return git(root, args);
    };
    await withGitDeploymentFence({
      checkout: root,
      runGit: runner,
      commitMessage: "fenced delivery",
      deliver: async (gate) => {
        await gate.observeRemote(["ls-remote", "fixture", "refs/heads/worker"]);
        await gate.push(["push", "fixture", "HEAD:refs/heads/worker"]);
      },
    });
    const commit = calls.indexOf("commit -m fenced delivery");
    const firstAttestation = calls.indexOf("show HEAD:vercel.json", commit);
    const observe = calls.indexOf("ls-remote fixture refs/heads/worker");
    const finalAttestation = calls.lastIndexOf("show HEAD:vercel.json");
    const push = calls.indexOf("push fixture HEAD:refs/heads/worker");
    expect(commit).toBeGreaterThan(-1);
    expect(commit).toBeLessThan(firstAttestation);
    expect(firstAttestation).toBeLessThan(observe);
    expect(observe).toBeLessThan(finalAttestation);
    expect(finalAttestation).toBeLessThan(push);
    expect(JSON.parse(git(root, ["show", "HEAD:vercel.json"]).out).git.deploymentEnabled).toBe(false);
  });

  it("makes zero remote observations and zero pushes when materialization or committed-tree attestation fails", async () => {
    for (const failure of ["materialization", "attestation"] as const) {
      const root = fixture();
      git(root, ["init"]);
      git(root, ["config", "user.email", "test@example.test"]);
      git(root, ["config", "user.name", "Test"]);
      writeFileSync(join(root, "proof.txt"), "validated patch\n");
      if (failure === "materialization") mkdirSync(join(root, `.vercel.json.jarvis-fence-${process.pid}`));
      let observations = 0;
      let pushes = 0;
      const runner = async (args: string[]) => {
        if (args[0] === "ls-remote") observations += 1;
        if (args[0] === "push") pushes += 1;
        if (failure === "attestation" && args[0] === "show" && args[1] === "HEAD:vercel.json") {
          return { code: 1, out: "injected exact-tree read failure" };
        }
        return git(root, args);
      };
      await expect(withGitDeploymentFence({
        checkout: root,
        runGit: runner,
        commitMessage: "fenced delivery",
        deliver: async (gate) => {
          await gate.observeRemote(["ls-remote", "fixture", "refs/heads/worker"]);
          await gate.push(["push", "fixture", "HEAD:refs/heads/worker"]);
        },
      })).rejects.toBeInstanceOf(GitDeploymentFenceError);
      expect({ observations, pushes }).toEqual({ observations: 0, pushes: 0 });
    }
  });

  it("attests exact candidate tree/blob objects and rejects missing, invalid, conflicting, or unreadable configuration", async () => {
    const root = fixture();
    git(root, ["init"]);
    git(root, ["config", "user.email", "test@example.test"]);
    git(root, ["config", "user.name", "Test"]);
    git(root, ["commit", "--allow-empty", "-m", "missing"]);
    const missingTree = git(root, ["rev-parse", "HEAD^{tree}"]).out.trim();
    const runner = (args: string[]) => Promise.resolve(git(root, args));
    await expect(attestGitDeploymentFenceTree(runner, (sha) => gitObject(root, sha), missingTree))
      .rejects.toMatchObject({ code: "verification_failed" });

    ensureGitDeploymentFence(root);
    git(root, ["add", "vercel.json"]);
    git(root, ["commit", "-m", "valid"]);
    const validTree = git(root, ["rev-parse", "HEAD^{tree}"]).out.trim();
    await expect(attestGitDeploymentFenceTree(runner, (sha) => gitObject(root, sha), validTree))
      .resolves.toMatchObject({ schemaVersion: 1 });
    await expect(attestGitDeploymentFenceTree(runner, async () => { throw new Error("unreadable"); }, validTree))
      .rejects.toMatchObject({ code: "verification_failed" });

    writeFileSync(join(root, "vercel.json"), JSON.stringify({ git: { deploymentEnabled: true } }));
    git(root, ["add", "vercel.json"]);
    git(root, ["commit", "-m", "invalid"]);
    const invalidTree = git(root, ["rev-parse", "HEAD^{tree}"]).out.trim();
    await expect(attestGitDeploymentFenceTree(runner, (sha) => gitObject(root, sha), invalidTree))
      .rejects.toMatchObject({ code: "verification_failed" });

    writeFileSync(join(root, "vercel.json"), readFileSync(join(root, "vercel.json"), "utf8").replace("true", "false"));
    writeFileSync(join(root, "vercel.ts"), "export default {}\n");
    git(root, ["add", "vercel.json", "vercel.ts"]);
    git(root, ["commit", "-m", "conflict"]);
    const conflictingTree = git(root, ["rev-parse", "HEAD^{tree}"]).out.trim();
    await expect(attestGitDeploymentFenceTree(runner, (sha) => gitObject(root, sha), conflictingTree))
      .rejects.toMatchObject({ code: "programmatic_config" });
  });
});
