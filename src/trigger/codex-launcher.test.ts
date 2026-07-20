import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCodexInvocation } from "./codex-launcher";
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
    expect(invocation.args.slice(0, 8)).toEqual([
      "--user",
      "--map-root-user",
      "--pid",
      "--fork",
      "--kill-child=SIGKILL",
      "--mount-proc=/proc",
      "--propagation",
      "unchanged",
    ]);
    expect(invocation.args).toContain(codexBin);
    expect(invocation.args).not.toContain("danger-full-access");
    expect(invocation.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
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
