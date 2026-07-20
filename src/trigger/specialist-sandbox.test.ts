import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
      NODE_ENV: "test",
      CODEX_HOME: root,
      CODEX_ACCESS_TOKEN: "synthetic-subscription-token",
      OPENAI_API_KEY: "",
    } satisfies NodeJS.ProcessEnv,
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
    expect(invocation.args).not.toContain("/app");
    expect(invocation.args).not.toEqual(expect.arrayContaining(["--ro-bind-try", "/etc", "/etc"]));
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
    expect(() => buildSpecialistSandboxInvocation({
      command: process.execPath,
      args: [],
      cwd: fixture.root,
      env: { ...fixture.env, CONVEX_DEPLOY_KEY_JARVIS_CANONICAL: "synthetic-never-live" },
    })).toThrow(/forbidden controller capability CONVEX_DEPLOY_KEY_JARVIS_CANONICAL/);
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
      env: { PATH: process.env.PATH, NODE_ENV: "test", VAULT_ACCESS_TOKEN: "synthetic-never-live" },
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

  it.runIf(existsSync("/usr/bin/bwrap"))("hides a synthetic controller secret from both parent /proc and an unmounted file", () => {
    const fixture = sandboxFixture();
    const controllerRoot = mkdtempSync(join(tmpdir(), "jarvis-controller-secret-test-"));
    roots.push(controllerRoot);
    const sentinelPath = join(controllerRoot, "release-credential");
    writeFileSync(sentinelPath, "synthetic-never-live", { mode: 0o600 });
    const adversary = `
      const fs=require("node:fs");
      let procExposed=false;
      for(const entry of fs.readdirSync("/proc")) {
        if(!/^\\d+$/.test(entry)||Number(entry)===process.pid) continue;
        try {
          const names=fs.readFileSync("/proc/"+entry+"/environ","utf8").split("\\0").map(v=>v.split("=",1)[0]);
          if(names.includes("CONVEX_DEPLOY_KEY_JARVIS_CANONICAL")) procExposed=true;
        } catch {}
      }
      let fileExposed=false;
      try { fileExposed=fs.readFileSync(process.argv[1],"utf8").length>0; } catch {}
      process.stdout.write(JSON.stringify({procExposed,fileExposed}));
    `;
    const invocation = buildSpecialistSandboxInvocation({
      command: process.execPath,
      args: ["-e", adversary, sentinelPath],
      cwd: fixture.root,
      env: fixture.env,
    });
    const wrapper = `
      const {spawnSync}=require("node:child_process");
      const result=spawnSync(${JSON.stringify(invocation.command)},${JSON.stringify(invocation.args)}, {
        cwd:${JSON.stringify(invocation.cwd)}, env:${JSON.stringify(invocation.env)}, encoding:"utf8"
      });
      process.stdout.write(result.stdout||""); process.stderr.write(result.stderr||""); process.exit(result.status??1);
    `;
    const result = spawnSync(process.execPath, ["-e", wrapper], {
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "test",
        CONVEX_DEPLOY_KEY_JARVIS_CANONICAL: "synthetic-never-live",
      },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ procExposed: false, fileExposed: false });
    expect(`${result.stdout}${result.stderr}`).not.toContain("synthetic-never-live");
  });
});
