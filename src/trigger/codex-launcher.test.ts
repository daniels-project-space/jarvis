import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCodexInvocation, PRIVATE_PROC_NAMESPACE_SETUP } from "./codex-launcher";
import { codexExecPrefix, codexReviewExecPrefix } from "./model-policy";

const roots: string[] = [];
const codexBin = realpathSync(join(process.cwd(), "node_modules/.bin/codex"));

function jwt(expSeconds = 4_102_444_800): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url");
  return `${header}.${payload}.synthetic`;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "jarvis-codex-launcher-test-"));
  roots.push(root);
  const env = {
    NODE_ENV: "test",
    PATH: process.env.PATH,
    HOME: root,
    CODEX_HOME: root,
    CODEX_ACCESS_TOKEN: jwt(),
    OPENAI_API_KEY: "",
    CODEX_API_KEY: "",
    ANTHROPIC_API_KEY: "",
  } satisfies NodeJS.ProcessEnv;
  return { root, env };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("central Codex process launcher", () => {
  it("puts every shell-capable specialist behind the outer namespace", () => {
    const { root, env } = fixture();
    const invocation = buildCodexInvocation({
      mode: "specialist",
      command: codexBin,
      args: codexExecPrefix("terra", "medium", root, String(env.PATH ?? "")),
      cwd: root,
      env,
      boundedRuntimeMs: 60_000,
    });

    expect(invocation.command).toBe("/usr/bin/unshare");
    expect(invocation.args.slice(0, 13)).toEqual([
      "--user",
      "--map-root-user",
      "--mount",
      "--pid",
      "--fork",
      "--kill-child=SIGKILL",
      "--propagation",
      "unchanged",
      "--",
      "/bin/sh",
      "-c",
      PRIVATE_PROC_NAMESPACE_SETUP,
      "sh",
    ]);
    expect(invocation.args).toContain(codexBin);
    expect(invocation.args).not.toContain("danger-full-access");
    expect(invocation.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(invocation.args.filter((arg) => arg.includes("mount -t proc"))).toEqual([PRIVATE_PROC_NAMESPACE_SETUP]);
  });

  it("rejects provider authority even when a caller tries to add it to the model parent", () => {
    const { root, env } = fixture();
    for (const capability of [
      "VAULT_ACCESS_TOKEN",
      "GITHUB_TOKEN",
      "CONVEX_DEPLOY_KEY_JARVIS_CANONICAL",
      "TRIGGER_ACCESS_TOKEN_JARVIS",
      "VERCEL_TOKEN",
    ]) {
      expect(() => buildCodexInvocation({
        mode: "specialist",
        command: codexBin,
        args: codexExecPrefix("terra", "medium", root, String(env.PATH ?? "")),
        cwd: root,
        env: { ...env, [capability]: "synthetic-never-live" },
        boundedRuntimeMs: 60_000,
      }), capability).toThrow(`forbidden controller capability ${capability}`);
    }
  });

  it("rejects filesystem authentication material instead of trusting child-env stripping", () => {
    const { root, env } = fixture();
    writeFileSync(join(root, "auth.json"), "synthetic-never-live", { mode: 0o600 });
    expect(() => buildCodexInvocation({
      mode: "specialist",
      command: codexBin,
      args: codexExecPrefix("terra", "medium", root, String(env.PATH ?? "")),
      cwd: root,
      env,
      boundedRuntimeMs: 60_000,
    })).toThrow("must not contain a filesystem authentication credential");
  });

  it("lstats the original home and auth path before realpath and rejects credential-like files", () => {
    const { root, env } = fixture();
    const realHome = join(root, "real-home");
    const linkedHome = join(root, "linked-home");
    mkdirSync(realHome);
    symlinkSync(realHome, linkedHome);
    expect(() => buildCodexInvocation({
      mode: "restricted",
      command: codexBin,
      args: codexReviewExecPrefix("terra"),
      cwd: root,
      env: { ...env, CODEX_HOME: linkedHome },
      boundedRuntimeMs: 60_000,
    })).toThrow("non-symlink directory");
    rmSync(linkedHome, { force: true });
    rmSync(realHome, { recursive: true, force: true });

    symlinkSync(join(root, "missing-auth-target"), join(root, "auth.json"));
    expect(() => buildCodexInvocation({
      mode: "restricted",
      command: codexBin,
      args: codexReviewExecPrefix("terra"),
      cwd: root,
      env,
      boundedRuntimeMs: 60_000,
    })).toThrow("filesystem authentication credential");
    rmSync(join(root, "auth.json"), { force: true });
    writeFileSync(join(root, ".git-credentials"), "never-read");
    expect(() => buildCodexInvocation({
      mode: "restricted",
      command: codexBin,
      args: codexReviewExecPrefix("terra"),
      cwd: root,
      env,
      boundedRuntimeMs: 60_000,
    })).toThrow("unexpected filesystem credential material");
  });

  it("minimizes the parent environment and rejects runtime injection or credentialed proxies", () => {
    const { root, env } = fixture();
    const input = {
      mode: "restricted" as const,
      command: codexBin,
      args: codexReviewExecPrefix("terra"),
      cwd: root,
      boundedRuntimeMs: 60_000,
    };
    const invocation = buildCodexInvocation({
      ...input,
      env: { ...env, HARMLESS_AMBIENT_VALUE: "drop-me", HTTPS_PROXY: "https://proxy.example:8443" },
    });
    expect(invocation.env.HARMLESS_AMBIENT_VALUE).toBeUndefined();
    expect(invocation.env.HTTPS_PROXY).toBe("https://proxy.example:8443");
    for (const [name, value] of [
      ["NODE_OPTIONS", "--require=/tmp/implant.cjs"],
      ["NPM_CONFIG_REGISTRY", "https://registry.example/?token=secret"],
      ["HTTPS_PROXY", "https://user:password@proxy.example"],
      ["HTTP_PROXY", "http://proxy.example/?token=secret"],
      ["https_proxy", "https://proxy.example/#credential"],
    ]) {
      expect(() => buildCodexInvocation({ ...input, env: { ...env, [name]: value } }), name)
        .toThrow(/forbidden|credential-bearing/);
    }
  });

  it("gives reasoning-only review no command tools and no dangerous sandbox mode", () => {
    const { root, env } = fixture();
    const invocation = buildCodexInvocation({
      mode: "restricted",
      command: codexBin,
      args: codexReviewExecPrefix("terra"),
      cwd: root,
      env,
      boundedRuntimeMs: 60_000,
    });
    expect(invocation.command).toBe(codexBin);
    expect(invocation.args).toContain("read-only");
    expect(invocation.args).not.toContain("danger-full-access");
    for (const feature of ["shell_tool", "unified_exec", "apps", "plugins", "hooks", "browser_use", "computer_use", "multi_agent"]) {
      expect(invocation.args[invocation.args.indexOf(feature) - 1]).toBe("--disable");
    }
  });
});
