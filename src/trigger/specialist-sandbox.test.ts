import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSpecialistNamespaceProbeInvocation,
  verifySpecialistSandboxIsolation,
} from "./specialist-sandbox";

const roots: string[] = [];
const codexBin = realpathSync(join(process.cwd(), "node_modules/.bin/codex"));

function sandboxFixture() {
  const root = mkdtempSync(join(tmpdir(), "jarvis-sandbox-test-"));
  roots.push(root);
  return {
    root,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "test",
      HOME: root,
      CODEX_HOME: root,
      CODEX_ACCESS_TOKEN: "synthetic-never-live",
      VAULT_ACCESS_TOKEN: "synthetic-controller-sentinel",
      CONVEX_DEPLOY_KEY_JARVIS_CANONICAL: "synthetic-controller-sentinel",
    } satisfies NodeJS.ProcessEnv,
  };
}

function localNamespaceAvailable(): boolean {
  if (!existsSync("/usr/bin/unshare")) return false;
  return spawnSync("/usr/bin/unshare", [
    "--user",
    "--map-root-user",
    "--pid",
    "--fork",
    "--mount-proc=/proc",
    "--propagation",
    "unchanged",
    "--",
    "/bin/true",
  ]).status === 0;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("specialist OS trust boundary", () => {
  it("constructs the exact user/PID/proc namespace before legacy Landlock", () => {
    const fixture = sandboxFixture();
    const invocation = buildSpecialistNamespaceProbeInvocation({
      codexBin,
      cwd: fixture.root,
      env: fixture.env,
      controllerPid: 4242,
    });

    expect(invocation.command).toBe("/usr/bin/unshare");
    expect(invocation.args).toEqual(expect.arrayContaining([
      "--user",
      "--map-root-user",
      "--pid",
      "--fork",
      "--kill-child=SIGKILL",
      "--mount-proc=/proc",
      "sandbox",
      ":read-only",
      "features.use_legacy_landlock=true",
      "/usr/bin/env",
      "-i",
      "4242",
    ]));
    expect(invocation.env.CODEX_ACCESS_TOKEN).toMatch(/^eyJ/);
    expect(invocation.env.CODEX_ACCESS_TOKEN).not.toBe(fixture.env.CODEX_ACCESS_TOKEN);
    expect(invocation.env.VAULT_ACCESS_TOKEN).toBeUndefined();
    expect(invocation.env.CONVEX_DEPLOY_KEY_JARVIS_CANONICAL).toBeUndefined();
    expect(invocation.args.join("\0")).not.toContain("synthetic-controller-sentinel");
  });

  it("proves the unsandboxed same-container /proc attack is real without emitting the sentinel", () => {
    const adversary = `
      const fs=require("node:fs");
      let value;
      try { value=fs.readFileSync("/proc/"+process.ppid+"/environ"); } catch { process.stdout.write("DENIED"); process.exit(); }
      process.stdout.write(value.includes(Buffer.from("VAULT_ACCESS_TOKEN=")) ? "EXPOSED" : "ABSENT");
    `;
    const parent = `
      const {spawnSync}=require("node:child_process");
      const result=spawnSync(process.execPath,["-e",${JSON.stringify(adversary)}],{env:{PATH:process.env.PATH},encoding:"utf8"});
      process.stdout.write(result.stdout);
    `;
    const result = spawnSync(process.execPath, ["-e", parent], {
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "test",
        VAULT_ACCESS_TOKEN: "synthetic-never-live",
      },
      encoding: "utf8",
    });
    expect(result.stdout).toBe("EXPOSED");
    expect(result.stdout).not.toContain("synthetic-never-live");
  });

  it("fails closed when the namespace executable is unavailable", () => {
    const fixture = sandboxFixture();
    const result = verifySpecialistSandboxIsolation({
      codexBin,
      cwd: fixture.root,
      env: fixture.env,
      unshareBinary: join(fixture.root, "missing-unshare"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("namespace probe failed");
  });

  it("rejects an adversarial observation that can see its controller", () => {
    const fixture = sandboxFixture();
    const fakeUnshare = join(fixture.root, "fake-unshare.cjs");
    writeFileSync(fakeUnshare, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  controllerVisible: true,
  parentReadable: false,
  parentTokenVisible: false,
  foreignEnvironmentVisible: false,
  numericPids: [1, 2],
  selfPid: 2,
  tools: { node: true, npm: true, npx: true, git: true, gh: true, curl: true }
}));
`, { mode: 0o700 });
    chmodSync(fakeUnshare, 0o700);

    const result = verifySpecialistSandboxIsolation({
      codexBin,
      cwd: fixture.root,
      env: fixture.env,
      unshareBinary: fakeUnshare,
    });
    expect(result).toEqual({
      ok: false,
      reason: "specialist namespace or legacy Landlock exposed parent authority or an incomplete toolchain; E2B remains the unactivated provider-neutral fallback",
    });
  });

  it("either proves the real pinned boundary or fails the worker closed on this kernel", () => {
    const fixture = sandboxFixture();
    const result = verifySpecialistSandboxIsolation({ codexBin, cwd: fixture.root, env: fixture.env });
    if (localNamespaceAvailable()) {
      expect(result.ok).toBe(true);
    } else {
      expect(result.ok).toBe(false);
    }
    if (result.ok) {
      expect(result.observation.controllerVisible).toBe(false);
      expect(result.observation.foreignEnvironmentVisible).toBe(false);
    } else {
      expect(result.reason).toMatch(/unavailable|failed/);
    }
  });
});
