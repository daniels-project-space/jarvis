import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSpecialistSandboxInvocation,
  verifySpecialistSandboxIsolation,
} from "./specialist-sandbox";

const roots: string[] = [];

function sandboxFixture() {
  const root = mkdtempSync(join(tmpdir(), "jarvis-sandbox-test-"));
  roots.push(root);
  return {
    root,
    env: {
      PATH: process.env.PATH,
      CODEX_HOME: root,
      CODEX_ACCESS_TOKEN: "synthetic-subscription-token",
      OPENAI_API_KEY: "",
    } as NodeJS.ProcessEnv,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("specialist OS trust boundary", () => {
  it("constructs a PID/mount namespace and gives bubblewrap no controller authority", () => {
    const fixture = sandboxFixture();
    const invocation = buildSpecialistSandboxInvocation({
      command: process.execPath,
      args: ["-e", "process.stdout.write('ok')"],
      cwd: fixture.root,
      env: fixture.env,
    });
    expect(invocation.command).toBe("/usr/bin/bwrap");
    expect(invocation.args).toEqual(expect.arrayContaining([
      "--unshare-user",
      "--unshare-pid",
      "--proc",
      "/proc",
      "--tmpfs",
      "/tmp",
      "--clearenv",
      "--cap-drop",
      "ALL",
    ]));
    expect(invocation.env.VAULT_ACCESS_TOKEN).toBeUndefined();
    expect(invocation.env.GITHUB_TOKEN).toBeUndefined();
    expect(invocation.env.CODEX_ACCESS_TOKEN).toBeUndefined();
    expect(invocation.args.join("\0")).toContain("CODEX_ACCESS_TOKEN");
  });

  it("rejects a caller regression that tries to pass release authority to Codex", () => {
    const fixture = sandboxFixture();
    expect(() => buildSpecialistSandboxInvocation({
      command: process.execPath,
      args: [],
      cwd: fixture.root,
      env: { ...fixture.env, VAULT_ACCESS_TOKEN: "synthetic-never-live" },
    })).toThrow(/forbidden controller capability VAULT_ACCESS_TOKEN/);
  });

  it("proves the same-container /proc attack succeeds without the sandbox, without emitting the sentinel", () => {
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
      env: { PATH: process.env.PATH, VAULT_ACCESS_TOKEN: "synthetic-never-live" },
      encoding: "utf8",
    });
    expect(result.stdout).toBe("EXPOSED");
    expect(result.stdout).not.toContain("synthetic-never-live");
  });

  it("fails closed when the OS boundary is unavailable", () => {
    const fixture = sandboxFixture();
    expect(verifySpecialistSandboxIsolation({
      cwd: fixture.root,
      env: fixture.env,
      sandboxBinary: join(fixture.root, "missing-bwrap"),
    })).toEqual({ ok: false, reason: "specialist OS sandbox is unavailable" });
  });

  it.runIf(existsSync("/usr/bin/bwrap"))("blocks sentinel reads in the real Bubblewrap boundary", () => {
    const fixture = sandboxFixture();
    expect(verifySpecialistSandboxIsolation({ cwd: fixture.root, env: fixture.env })).toEqual({ ok: true });
  });
});
