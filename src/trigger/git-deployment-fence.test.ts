import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GitDeploymentFenceError,
  VERCEL_CONFIG_SCHEMA,
  attestCommittedGitDeploymentFence,
  ensureGitDeploymentFence,
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
    chmodSync(root, 0o555);
    try {
      expect(() => ensureGitDeploymentFence(root)).toThrow(expect.objectContaining({ code: "write_failed" }));
      expect(readFileSync(join(root, "vercel.json"), "utf8")).toBe(original);
    } finally {
      chmodSync(root, 0o755);
    }
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

  it("orders materialization and committed-tree attestation before every delivery observation", () => {
    const runner = readFileSync(join(process.cwd(), "src/trigger/agent-runner.ts"), "utf8");
    const apply = runner.indexOf("await applyValidatedPatchToControllerCheckout(");
    const materialize = runner.indexOf("ensureGitDeploymentFence(repoDir)", apply);
    const add = runner.indexOf('["-C", deliveryDir, "add", "-A"]', materialize);
    const committed = runner.indexOf("attestCommittedGitDeploymentFence(runGit)", add);
    const observe = runner.indexOf('["ls-remote", pushUrl', committed);
    const push = runner.indexOf('["push", pushUrl', observe);
    expect(apply).toBeGreaterThan(-1);
    expect(apply).toBeLessThan(materialize);
    expect(materialize).toBeLessThan(add);
    expect(add).toBeLessThan(committed);
    expect(committed).toBeLessThan(observe);
    expect(observe).toBeLessThan(push);
    expect(runner).toContain("if (!deploymentFenceFailure)");
  });
});
