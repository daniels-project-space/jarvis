import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSpecialistNamespaceProbeInvocation,
  readNamespaceProbeReceipt,
  validateNamespaceProbeReceipt,
  verifySpecialistSandboxIsolation,
} from "./specialist-sandbox";
import { buildPrivateProcNamespaceInvocation, PRIVATE_PROC_NAMESPACE_SETUP } from "./codex-launcher";

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
  const invocation = buildPrivateProcNamespaceInvocation({
    command: "/bin/true",
    args: [],
    cwd: "/tmp",
    env: { NODE_ENV: "test", PATH: process.env.PATH },
  });
  return spawnSync(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    env: invocation.env,
  }).status === 0;
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
      realpathSync("/bin/sh"),
      "-c",
      PRIVATE_PROC_NAMESPACE_SETUP,
      "sh",
    ]);
    expect(invocation.args).toContain(":workspace-write");
    expect(invocation.args).not.toContain(":read-only");
    expect(invocation.args).toContain("features.use_legacy_landlock=true");
    expect(invocation.args).toContain("sandbox_workspace_write.network_access=false");
    expect(invocation.args).toContain("JARVIS_NAMESPACE_CONTROLLER_PID=4242");
    expect(invocation.args).toContain(`JARVIS_NAMESPACE_PROBE_RECEIPT=${invocation.receiptPath.split("/").at(-1)}`);
    expect(invocation.env.CODEX_ACCESS_TOKEN).toMatch(/^eyJ/);
    expect(invocation.env.CODEX_ACCESS_TOKEN).not.toBe(fixture.env.CODEX_ACCESS_TOKEN);
    expect(invocation.env.VAULT_ACCESS_TOKEN).toBeUndefined();
    expect(invocation.env.CONVEX_DEPLOY_KEY_JARVIS_CANONICAL).toBeUndefined();
    expect(invocation.args.join("\0")).not.toContain("synthetic-controller-sentinel");
    expect(invocation.args).not.toContain("--mount-proc=/proc");
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

  it("fails closed when the namespace executable is unavailable", async () => {
    const fixture = sandboxFixture();
    const result = await verifySpecialistSandboxIsolation({
      codexBin,
      cwd: fixture.root,
      env: fixture.env,
      unshareBinary: join(fixture.root, "missing-unshare"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("namespace probe failed");
  });

  it("never treats adversarial piped stdout as a receipt", async () => {
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

    const result = await verifySpecialistSandboxIsolation({
      codexBin,
      cwd: fixture.root,
      env: fixture.env,
      unshareBinary: fakeUnshare,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("namespace probe failed");
  });

  it("either proves the real pinned boundary or fails the worker closed on this kernel", async () => {
    const fixture = sandboxFixture();
    const result = await verifySpecialistSandboxIsolation({ codexBin, cwd: fixture.root, env: fixture.env });
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

  it("rejects missing, empty, malformed, oversized, stale, replayed, and symlink receipts", () => {
    const fixture = sandboxFixture();
    const missing = join(fixture.root, "missing.json");
    expect(() => readNamespaceProbeReceipt(missing)).toThrow("missing");

    const empty = join(fixture.root, "empty.json");
    writeFileSync(empty, "", { mode: 0o600 });
    expect(() => readNamespaceProbeReceipt(empty)).toThrow("empty");

    const oversized = join(fixture.root, "oversized.json");
    writeFileSync(oversized, "x".repeat(16 * 1024 + 1), { mode: 0o600 });
    expect(() => readNamespaceProbeReceipt(oversized)).toThrow("oversized");

    const target = join(fixture.root, "target.json");
    const linked = join(fixture.root, "linked.json");
    writeFileSync(target, "{}", { mode: 0o600 });
    symlinkSync(target, linked);
    expect(() => readNamespaceProbeReceipt(linked)).toThrow("unique regular file");

    const now = Date.now();
    const validReceipt = (nonce: string, issuedAt = now) => JSON.stringify({
      protocol: 1,
      kind: "jarvis-specialist-namespace-preflight",
      nonce,
      issuedAt,
      controllerVisible: false,
      parentReadable: false,
      parentTokenVisible: false,
      foreignEnvironmentVisible: false,
      numericPids: [1],
      selfPid: 1,
      tools: Object.fromEntries(["node", "npm", "npx", "git", "gh", "curl"].map((tool) => [
        tool,
        { available: true, version: `${tool}-synthetic` },
      ])),
    });
    const malformedNonce = "1".repeat(64);
    expect(() => validateNamespaceProbeReceipt({
      raw: "{",
      expectedNonce: malformedNonce,
      startedAt: now - 10,
      closedAt: now + 10,
    })).toThrow("malformed");
    const staleNonce = "2".repeat(64);
    expect(() => validateNamespaceProbeReceipt({
      raw: validReceipt(staleNonce, now - 60_000),
      expectedNonce: staleNonce,
      startedAt: now - 60_000,
      closedAt: now,
    })).toThrow("stale");
    const replayNonce = "3".repeat(64);
    const raw = validReceipt(replayNonce);
    expect(validateNamespaceProbeReceipt({ raw, expectedNonce: replayNonce, startedAt: now - 10, closedAt: now + 10 }).nonce)
      .toBe(replayNonce);
    expect(() => validateNamespaceProbeReceipt({ raw, expectedNonce: replayNonce, startedAt: now - 10, closedAt: now + 10 }))
      .toThrow("replayed");
  });
});
